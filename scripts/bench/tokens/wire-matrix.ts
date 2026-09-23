#!/usr/bin/env bun
// Wire matrix: what each CLI actually sends to the Anthropic Messages API —
// every header and the whole body — across CLIs, models, auth modes and
// session types, against a local mock. Zero real API calls to /v1/messages.
//
// Usage:
//   bun run scripts/bench/tokens/wire-matrix.ts capture                  # headless -p
//   bun run scripts/bench/tokens/wire-matrix.ts interactive              # the TUI, via tmux
//   bun run scripts/bench/tokens/wire-matrix.ts report [--match=oauth]   # the matrix
//
//   --bins=claude,claudindev   --models=claude-opus-5-5,claude-fable-5-1,claude-sonnet-5
//   --auth=oauth,apikeyfull,apikey (capture only)   --out=<dir>   --tag=<label>
//   --no-assume-1p   see THE CONFOUND below
//
// WHY this exists beside wire-diff.ts: that one diffs two CLIs on one model,
// one headless turn, and keeps only the anthropic-beta header. The beta round
// of 2026-09-22 needed every header, three models, both auth modes, and the
// interactive path — the only one where Claude Code sends
// `thinking.display: "updates"`. docs/tech/anthropic-betas/wire-matrix.md is
// what it measured.
//
// THE CONFOUND. With ANTHROPIC_BASE_URL on localhost, Claude Code classifies
// the session as not first-party (its base-URL check is a host allowlist of
// api.anthropic.com). That silently turns the dangerous-tool-use `safeguards`
// arbiter ON and turns thinking-binding-controls, `scope:"global"`, tool search
// and `display:"updates"` OFF — a capture that reads like a divergence and is
// an artifact of the mock. Both CLIs have an override for exactly this, and
// `--assume-1p` (the default) sets it in the child:
// `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` for Claude Code,
// `CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL` for Claudin.
//
// Auth modes (capture): `oauth` drops ANTHROPIC_API_KEY so each CLI uses its
// normal login; `apikeyfull` puts a mock key in the env with the normal
// session; `apikey` is `--bare`, which is also Claude Code's simple mode and
// so changes more than the auth — read that column with that in mind.
//
// Env hygiene: CLAUDECODE, CLAUDE_CODE_* and CLAUDIN_* leak from whichever
// Claude-Code-family CLI runs this script and move the very bytes being
// compared, so the child gets none of them — interactive runs go further and
// start from `env -i`. Credentials are redacted before anything is written.
// Children run in a throwaway cwd: `-p` would otherwise land in this repo's
// session list, and `-c` resumes by project directory.

import { createServer, type IncomingHttpHeaders } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const MODE = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help'
const opt = (name: string, dflt: string): string =>
  argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const has = (name: string): boolean => argv.includes(`--${name}`)
const list = (name: string, dflt: string): string[] =>
  opt(name, dflt)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

const OUT = opt('out', join(tmpdir(), 'wire-matrix'))
const CWD = opt('cwd', join(tmpdir(), 'wire-matrix-cwd'))
const PORT = Number(opt('port', '8811'))
const BINS = list('bins', 'claude,claudindev')
const MODELS = list('models', 'claude-opus-5-5,claude-fable-5-1,claude-sonnet-5')
const AUTHS = list('auth', 'oauth,apikeyfull')
const PROMPT = opt('prompt', 'hi')
const ASSUME_1P = !has('no-assume-1p')
const MOCK_KEY = 'sk-ant-api03-mock-capture-key'
// Tmux socket of our own: never the user's server, and one kill-server ends it.
const TMUX_SOCKET = 'wire-matrix'
const SESSION_VARS = [
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'DISPLAY',
  'WAYLAND_DISPLAY',
]

type Capture = {
  method: string
  path: string
  headers: Record<string, unknown>
  body: any
}
let captures: Capture[] = []

function redactHeaders(h: IncomingHttpHeaders): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(h)) {
    if (k === 'authorization') out[k] = `${String(v).split(' ')[0]} <redacted>`
    else if (k === 'x-api-key' || k === 'cookie') out[k] = '<redacted>'
    else out[k] = v
  }
  return out
}

function textTurnSse(model: string): string {
  return [
    'event: message_start',
    `data: {"type":"message_start","message":{"id":"msg_wire_matrix","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n')
}

function startServer(): Promise<{ close: () => void }> {
  return new Promise(resolveStart => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const path = req.url ?? ''
        let body: any = null
        if (raw) {
          try {
            body = JSON.parse(raw)
          } catch {
            body = { _unparsed: raw.slice(0, 300) }
          }
        }
        captures.push({ method: req.method ?? '', path, headers: redactHeaders(req.headers), body })
        if (path.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ input_tokens: 100 }))
          return
        }
        if (path.includes('/v1/messages')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(textTurnSse(typeof body?.model === 'string' ? body.model : 'claude-sonnet-5'))
          return
        }
        // quota, /api/hello, profile lookups: a benign 200.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(PORT, () => resolveStart({ close: () => server.close() }))
  })
}

// ASYNC on purpose, for every child: the mock lives in THIS process, and a
// synchronous spawn blocks the event loop that would accept the connection —
// the bug that made wire-diff.ts capture nothing for two months.
function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (out += String(d)))
    const kill = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : undefined
    child.on('close', code => {
      if (kill) clearTimeout(kill)
      resolve({ code: code ?? -1, out })
    })
  })
}

function overrideEnv(): Record<string, string> {
  return ASSUME_1P
    ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1', CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL: '1' }
    : {}
}

function headlessEnv(model: string, auth: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDIN_') || key.startsWith('CLAUDE_CODE_') || key.startsWith('_CLAUDE_CODE_')) {
      delete env[key]
    }
  }
  // An OAuth token in the environment outranks everything and skips the mock.
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_API_KEY
  if (auth === 'apikey' || auth === 'apikeyfull') env.ANTHROPIC_API_KEY = MOCK_KEY
  return { ...env, ANTHROPIC_BASE_URL: `http://localhost:${PORT}`, ANTHROPIC_MODEL: model, ...overrideEnv() }
}

const BARE_ARGS = ['--bare', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']

function fileFor(bin: string, tag: string, auth: string, model: string): string {
  return join(OUT, `${bin}-${tag}-${auth}-${model}.json`)
}

async function capture(): Promise<void> {
  const tag = opt('tag', ASSUME_1P ? 'p1p' : 'pmock')
  const srv = await startServer()
  console.log(`mock on :${PORT} · headless · bins=${BINS.join(',')} · assume-1p=${ASSUME_1P} · out=${OUT}`)
  try {
    for (const bin of BINS) {
      for (const auth of AUTHS) {
        for (const model of MODELS) {
          captures = []
          const args = [
            '-p', PROMPT,
            '--model', model,
            '--output-format', 'text',
            '--no-session-persistence',
            ...(auth === 'apikey' ? BARE_ARGS : []),
          ]
          const r = await run(bin, args, { env: headlessEnv(model, auth), cwd: CWD, timeoutMs: 90_000 })
          const file = fileFor(bin, tag, auth, model)
          writeFileSync(file, JSON.stringify({ bin, tag, auth, model, exit: r.code, requests: captures }, null, 2))
          const n = captures.filter(isMessages).length
          console.log(`▶ ${bin} · ${auth} · ${model}: exit ${r.code}, ${n} /v1/messages request(s)`)
          if (r.code !== 0) console.log(`  ${r.out.trim().replace(/\s+/g, ' ').slice(-400)}`)
        }
      }
    }
  } finally {
    srv.close()
  }
}

const tmux = (...args: string[]) => run('tmux', ['-L', TMUX_SOCKET, ...args])
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const SELECTED_OPTION_RE = /❯\s*(?:\d+\.\s*)?(.+)$/m
const TRUST_DIALOG_RE = /trust (the files|this folder)/i
const READY_RE = /for shortcuts|shift\+tab to cycle|\? for/i

// Trust dialogs differ between the two CLIs AND between versions — Claude Code
// 2.1.280 defaults to "No, exit" — so walk the cursor until it sits on a "Yes"
// option instead of assuming its position.
async function answerTrust(pane: () => Promise<string>): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const selected = SELECTED_OPTION_RE.exec(await pane())?.[1] ?? ''
    if (/^yes/i.test(selected.trim())) {
      await tmux('send-keys', '-t', 'wm', 'Enter')
      return
    }
    await tmux('send-keys', '-t', 'wm', 'Down')
    await sleep(300)
  }
}

async function interactive(): Promise<void> {
  const tag = opt('tag', ASSUME_1P ? 'i1p' : 'imock')
  const srv = await startServer()
  console.log(`mock on :${PORT} · interactive (tmux -L ${TMUX_SOCKET}) · assume-1p=${ASSUME_1P} · out=${OUT}`)
  const pane = async (): Promise<string> => (await tmux('capture-pane', '-p', '-t', 'wm')).out
  try {
    for (const bin of BINS) {
      for (const model of MODELS) {
        captures = []
        const env = [
          `HOME=${process.env.HOME}`,
          `PATH=${process.env.PATH}`,
          `USER=${process.env.USER ?? ''}`,
          `SHELL=${process.env.SHELL ?? '/bin/bash'}`,
          `LANG=${process.env.LANG ?? 'C.UTF-8'}`,
          'TERM=xterm-256color',
          // The desktop session, for credential stores behind D-Bus: without
          // it Claudin's OAuth lookup fails and the TUI says "Not logged in".
          ...SESSION_VARS.filter(k => process.env[k]).map(k => `${k}=${process.env[k]}`),
          `ANTHROPIC_BASE_URL=http://localhost:${PORT}`,
          ...Object.entries(overrideEnv()).map(([k, v]) => `${k}=${v}`),
        ]
        // `; sleep` keeps the pane readable after the CLI exits early.
        const cmd = `env -i ${env.map(shq).join(' ')} ${shq(bin)} --model ${shq(model)}; echo __EXIT__ $?; sleep 120`
        await tmux('kill-server')
        const started = await tmux('new-session', '-d', '-s', 'wm', '-x', '200', '-y', '50', '-c', CWD, cmd)
        if (started.code !== 0) {
          console.log(`▶ ${bin} · ${model}: tmux failed: ${started.out.trim()}`)
          continue
        }
        let typed = false
        let trusted = false
        let sawMain = 0
        let last = ''
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          await sleep(700)
          last = await pane()
          if (last.includes('__EXIT__')) break
          if (!typed && !trusted && TRUST_DIALOG_RE.test(last)) {
            await answerTrust(pane)
            trusted = true
            continue
          }
          if (!typed && READY_RE.test(last)) {
            await sleep(1500)
            await tmux('send-keys', '-t', 'wm', '-l', PROMPT)
            await sleep(300)
            await tmux('send-keys', '-t', 'wm', 'Enter')
            typed = true
            continue
          }
          if (typed && !sawMain && captures.some(c => isMainTurn(c, model))) sawMain = Date.now()
          // Linger a few seconds: some requests (quota probe, title) trail the turn.
          if (sawMain && Date.now() - sawMain > 4000) break
        }
        const file = fileFor(bin, tag, 'oauth', model)
        writeFileSync(file, JSON.stringify({ bin, tag, auth: 'oauth', model, exit: 0, requests: captures }, null, 2))
        console.log(`▶ ${bin} · ${model}: trusted=${trusted} typed=${typed}, ${captures.filter(isMessages).length} /v1/messages request(s)`)
        if (!sawMain) {
          console.log('  ⚠ no main-loop request captured; last pane:')
          console.log(last.split('\n').filter(l => l.trim()).slice(-20).map(l => `    | ${l}`).join('\n'))
        }
        await tmux('kill-server')
      }
    }
  } finally {
    await tmux('kill-server')
    srv.close()
  }
}

const isMessages = (c: Capture): boolean => c.path.includes('/v1/messages') && !c.path.includes('count_tokens')
const isMainTurn = (c: Capture, model: string): boolean =>
  isMessages(c) && c.body?.model === model && JSON.stringify(c.body?.messages ?? '').includes(PROMPT)
const betasOf = (c?: Capture): string[] =>
  String(c?.headers['anthropic-beta'] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
const j = (v: unknown, n = 200): string => (v === undefined ? '-' : JSON.stringify(v).slice(0, n))

function report(): void {
  const dir = opt('dir', OUT)
  const match = opt('match', '')
  const rows = readdirSync(dir)
    .filter(f => f.endsWith('.json') && f.includes(match))
    .sort()
    .map(f => {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { model: string; requests: Capture[] }
      const msgs = d.requests.filter(isMessages)
      const main = msgs.find(c => c.body?.model === d.model) ?? msgs[0]
      return { name: f.replace(/\.json$/, ''), main, others: msgs.filter(c => c !== main) }
    })
  const allBetas = [...new Set(rows.flatMap(r => betasOf(r.main)))].sort()
  console.log('columns:')
  rows.forEach((r, i) => console.log(`  [${i}] ${r.name}${r.main ? '' : '  (no /v1/messages request)'}`))
  console.log(`\n  ${'beta'.padEnd(42)} ${rows.map((_, i) => String(i).padEnd(3)).join('')}`)
  for (const b of allBetas) {
    console.log(`  ${b.padEnd(42)} ${rows.map(r => (betasOf(r.main).includes(b) ? 'x' : '·').padEnd(3)).join('')}`)
  }
  console.log('')
  rows.forEach((r, i) => {
    const b = r.main?.body ?? {}
    const sys = Array.isArray(b.system) ? b.system : []
    const tools = Array.isArray(b.tools) ? b.tools : []
    const msgs = Array.isArray(b.messages) ? b.messages : []
    console.log(`[${i}] ${r.name}`)
    console.log(`    max_tokens=${b.max_tokens} thinking=${j(b.thinking)} output_config=${j(b.output_config)}`)
    console.log(`    context_management=${j(b.context_management)} safeguards=${b.safeguards ? 'yes' : 'no'} diagnostics=${j(b.diagnostics, 160)}`)
    console.log(`    keys=${Object.keys(b).sort().join(',')}`)
    console.log(`    system=${sys.length} blocks/${sys.reduce((n: number, s: any) => n + String(s?.text ?? '').length, 0)}ch cc=[${sys.map((s: any) => (s?.cache_control ? `${s.cache_control.ttl ?? '5m'}${s.cache_control.scope ? '/' + s.cache_control.scope : ''}` : '-')).join(' ')}]`)
    console.log(`    tools=${tools.length} defer=${tools.filter((t: any) => t?.defer_loading).length} eager=${tools.filter((t: any) => t?.eager_input_streaming).length} typed=${tools.filter((t: any) => t?.type).map((t: any) => `${t.type}${t.model ? `(${t.model})` : ''}`).join(',') || '-'}`)
    console.log(`    messages=${msgs.map((m: any) => `${m.role}[${Array.isArray(m.content) ? m.content.map((x: any) => x?.type).join('+') : 'str'}]${m.output_config ? `{oc:${JSON.stringify(m.output_config)}}` : ''}`).join(' ')}`)
    if (r.others.length) console.log(`    other /v1/messages: ${r.others.map(c => `${c.body?.model} max=${c.body?.max_tokens} betas=${betasOf(c).length}`).join(' ; ')}`)
  })
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  if (MODE === 'capture') return capture()
  if (MODE === 'interactive') return interactive()
  if (MODE === 'report') return report()
  console.log('wire-matrix: capture | interactive | report — see the header of this file for flags.')
}

void main()
