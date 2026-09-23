#!/usr/bin/env bun
/**
 * Resume wire probe — does `--resume` re-send the prefix the session had cached?
 *
 * Built to explain what `session-cache-ab.ts` measured on 2026-09-23: after the
 * resume into a new process, Claude Code read back 100% of its cached prefix
 * and claudindev about 40%, writing ~38k tokens again on the first resumed turn.
 * This finds the byte where the two requests part, with zero real API calls.
 *
 * A local mock answers every /v1/messages POST (ANTHROPIC_BASE_URL). Phase A is
 * a first prompt whose first main-loop answer asks for four parallel Reads, so
 * the history carries tool results; phase B is `--resume <id>` in a new process.
 * The report compares the LAST main-loop request of A with the FIRST of B —
 * tools, system, then each shared message — and prints where they diverge, plus
 * the block list of `messages[0]` on both sides, which is where the startup
 * reminders live.
 *
 * Ahead of that it prints what a variant is judged by without a paid run: what
 * each phase's result message reported (`total_cost_usd`, `num_turns` — a
 * resumed process either re-reports the whole session or only itself), and the
 * first main-loop request taken apart — every tool, eager or deferred, every
 * system block and every block of `messages[0]`, in chars and estimated tokens.
 *
 * Both CLIs run with their real config (auth and plugins intact); only the
 * destination moves to the mock. Nothing is billed.
 *
 * Usage:
 *   bun scripts/bench/ab/resume-wire-probe.ts                  # claudindev
 *   bun scripts/bench/ab/resume-wire-probe.ts --bin=claude
 *   bun scripts/bench/ab/resume-wire-probe.ts --model=claude-sonnet-5
 *   bun scripts/bench/ab/resume-wire-probe.ts --env=CLAUDIN_DISABLE_GIT_INSTRUCTIONS=1
 *   bun scripts/bench/ab/resume-wire-probe.ts --settings=hooks.json
 *
 * The host session's CLAUDIN_* / CLAUDE_CODE_* variables never reach the child;
 * `--env=NAME=value` (repeatable) is set after that strip, which makes it the way
 * to measure a variant. `--settings` reaches the CLI as `--settings <file>` in
 * both phases — a file of hooks, say, whose attachments must survive the resume.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'
import { makeWorkspace } from './session-cache-ab'

type Json = Record<string, any>

const FLAGS = ['bin', 'model', 'env', 'settings']
const argv = process.argv.slice(2)
// A typo, or `--env NAME=1` with a space, would otherwise measure the default and say nothing.
const stray = argv.filter(x => !FLAGS.some(name => x.startsWith(`--${name}=`)))
if (stray.length) {
  console.error(`unknown argument ${stray.join(' ')} — flags are ${FLAGS.map(f => `--${f}=…`).join(' ')}`)
  process.exit(2)
}
const flags = (name: string) => argv.filter(x => x.startsWith(`--${name}=`)).map(x => x.slice(name.length + 3))
const flag = (name: string, fallback: string) => flags(name)[0] ?? fallback
const BIN = flag('bin', join(REPO_ROOT, 'bin', 'claudin'))
const MODEL = flag('model', 'claude-opus-5-5')
const EXTRA_ENV: Record<string, string> = {}
for (const pair of flags('env')) {
  const eq = pair.indexOf('=')
  if (eq < 1 || pair.startsWith('ANTHROPIC_BASE_URL=')) {
    console.error(`--env=${pair}: expected --env=NAME=value, and ANTHROPIC_BASE_URL stays on the mock`)
    process.exit(2)
  }
  EXTRA_ENV[pair.slice(0, eq)] = pair.slice(eq + 1)
}
const settingsArg = flag('settings', '')
// Resolved here: the CLI runs in the workspace, where a relative path points at nothing.
const SETTINGS = settingsArg && resolvePath(settingsArg)
if (SETTINGS && !existsSync(SETTINGS)) {
  console.error(`--settings: no file at ${SETTINGS}`)
  process.exit(2)
}
const PORT = 8800 + Math.floor(Math.random() * 100)
const READS = ['README.md', 'src/quote.ts', 'src/cart.ts', 'test/quote.test.ts']

const dir = mkdtempSync(join(tmpdir(), 'resume-wire-probe-'))
const ws = join(dir, 'workspace')
makeWorkspace(ws)

let counter = 0

function frame(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(): string {
  return frame('message_start', {
    type: 'message_start',
    message: {
      id: `msg_mock_${++counter}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
}

function messageEnd(stopReason: string): string {
  return (
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }) + frame('message_stop', { type: 'message_stop' })
  )
}

function textReply(): string {
  return (
    messageStart() +
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    messageEnd('end_turn')
  )
}

function readsReply(): string {
  const blocks = READS.map(
    (rel, i) =>
      frame('content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: `toolu_mock_${counter + 1}_${i}`, name: 'Read', input: {} },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(ws, rel) }) },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: i }),
  )
  return messageStart() + blocks.join('') + messageEnd('tool_use')
}

type Capture = { phase: 'A' | 'B'; body: Json }
const captures: Capture[] = []
let phase: 'A' | 'B' = 'A'
const isMainLoop = (body: Json) => Array.isArray(body?.tools) && body.tools.length > 5

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = req.url ?? ''
    if (path.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 100 }))
      return
    }
    if (!path.includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json
    const firstOfA = phase === 'A' && isMainLoop(body) && !captures.some(c => isMainLoop(c.body))
    captures.push({ phase, body })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(firstOfA ? readsReply() : textReply())
  })
})
await new Promise<void>(resolve => server.listen(PORT, () => resolve()))

/**
 * The CLI's real config, pointed at the mock; the host session's own variables
 * stripped, then --env on top, so a variant may override the defaults below —
 * never the destination, which the flag parser refuses.
 */
function env(): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'CLAUDECODE' || k.startsWith('CLAUDIN_') || k.startsWith('CLAUDE_CODE_')) continue
    e[k] = v
  }
  delete e.ANTHROPIC_API_KEY
  delete e.ANTHROPIC_AUTH_TOKEN
  return {
    ...e,
    ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
    // A localhost base URL otherwise flips both CLIs into their non-first-party shape.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
    DISABLE_AUTOUPDATER: '1',
    ...EXTRA_ENV,
  }
}

function run(args: string[]): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(BIN, args, { cwd: ws, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    const kill = setTimeout(() => child.kill('SIGTERM'), 120_000)
    child.on('close', code => {
      clearTimeout(kill)
      if (code !== 0) console.error(`${BIN} exited ${code}: ${(err || out).slice(-400)}`)
      resolve(out)
    })
  })
}

function events(stdout: string): Json[] {
  return stdout.split('\n').flatMap(line => {
    try {
      return [JSON.parse(line) as Json]
    } catch {
      return []
    }
  })
}

const common = ['--model', MODEL, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']
if (SETTINGS) common.push('--settings', SETTINGS)
const phaseA = events(await run(['-p', 'Read the main files and tell me what this project does.', ...common]))
const sessionId = phaseA.find(e => e.type === 'system' && e.subtype === 'init')?.session_id as string | undefined
if (!sessionId) {
  server.close()
  throw new Error('no session id from phase A — did the CLI reach the mock?')
}
phase = 'B'
const phaseB = events(await run(['-p', 'Thanks. Now list the source files.', '--resume', sessionId, ...common]))
server.close()
writeFileSync(join(dir, 'captures.json'), JSON.stringify(captures, null, 1))

const firstA = captures.find(c => c.phase === 'A' && isMainLoop(c.body))?.body
const a = captures.filter(c => c.phase === 'A' && isMainLoop(c.body)).at(-1)?.body
const b = captures.find(c => c.phase === 'B' && isMainLoop(c.body))?.body
if (!firstA || !a || !b) throw new Error(`missing a main-loop capture (${captures.length} captured) — see ${dir}/captures.json`)

/** cache_control moves with the marker every turn by design; it is not a prefix change. */
function stripMarkers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripMarkers)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, stripMarkers(x)]))
  }
  return v
}

function compare(label: string, x: unknown, y: unknown): boolean {
  const sx = JSON.stringify(stripMarkers(x)) ?? ''
  const sy = JSON.stringify(stripMarkers(y)) ?? ''
  let at = 0
  while (at < sx.length && at < sy.length && sx[at] === sy[at]) at++
  if (at === sx.length && at === sy.length) {
    console.log(`  ${label}: identical (${sx.length} chars)`)
    return false
  }
  console.log(`  ${label}: DIFFERS at char ${at} (${sx.length} → ${sy.length} chars)`)
  console.log(`    before : …${sx.slice(Math.max(0, at - 160), at + 200)}…`)
  console.log(`    resumed: …${sy.slice(Math.max(0, at - 160), at + 200)}…`)
  return true
}

function blocks(message: Json | undefined): string[] {
  if (!message) return []
  if (typeof message.content === 'string') return [`[string] ${message.content.slice(0, 70)}`]
  return (message.content as Json[]).map(block => {
    const text = String(block.text ?? JSON.stringify(block.content ?? block.input ?? '')).replace(/\s+/g, ' ')
    return `[${block.type}] ${text.slice(0, 70)} (${text.length} ch)`
  })
}

/**
 * ~2.8 chars per token, calibrated on Opus 5.5 — the 21,021-token cross-session
 * read was the eager tools plus 120 chars of system; chars/4 undercounts by
 * ~30%. A deferred schema is sent whole but not billed at its size: two of them
 * (~7.4k chars) measured +93 tokens. Both in
 * .claudin/memory/team/request-prefix-size-2026-09-23.md.
 */
const CHARS_PER_TOKEN = 2.8
const DEFERRED_TOOL_TOKENS = 46
const REMINDER_TAG_RE = /^<\/?system-reminder>$/
const CONTEXT_PREAMBLE = "As you answer the user's questions, you can use the following context:"

/** The JSON the API receives, minus the markers that move every turn. */
const size = (v: unknown) => (JSON.stringify(stripMarkers(v)) ?? '').length
const tok = (chars: number) => Math.round(chars / CHARS_PER_TOKEN)
const n = (x: number) => x.toLocaleString('en-US')
const bySize = (x: Json, y: Json) => size(y) - size(x)

/** A block's first line — past the reminder tag and the preamble every context block shares, which name nothing. */
function label(block: Json): string {
  if (typeof block.text !== 'string') return `(${block.type})`
  const line = block.text.split('\n').map(l => l.trim()).find(l => l && !REMINDER_TAG_RE.test(l) && l !== CONTEXT_PREAMBLE) ?? ''
  return line.length > 56 ? `${line.slice(0, 55)}…` : line
}

function row(name: string, chars: string, tokens: string): string {
  return `  ${name.padEnd(62)} ${chars.padStart(8)} ${tokens.padStart(7)}`
}

/** The prefix every turn re-sends, part by part: what a variant adds to it or takes off. */
function prefixReport(body: Json): void {
  const tools = (body.tools ?? []) as Json[]
  const eager = tools.filter(t => !t.defer_loading).sort(bySize)
  const deferred = tools.filter(t => t.defer_loading).sort(bySize)
  const system = (typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : (body.system ?? [])) as Json[]
  const messages = (body.messages ?? []) as Json[]
  const contentOf = (m: Json): Json[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)
  const sum = (xs: Json[]) => xs.reduce((acc, x) => acc + size(x), 0)
  const part = (name: string, x: Json) => row(name, n(size(x)), n(tok(size(x))))

  console.log(`\nfirst main-loop request — chars of JSON on the wire without cache_control, ≈ tokens at ${CHARS_PER_TOKEN} chars/token`)
  console.log(row('tools', 'chars', '≈ tok'))
  for (const t of eager) console.log(part(`  eager     ${t.name}`, t))
  for (const t of deferred) console.log(row(`  deferred  ${t.name}`, n(size(t)), `~${DEFERRED_TOOL_TOKENS}`))
  console.log('  system')
  system.forEach((block, i) => console.log(part(`  [${i}] ${label(block)}`, block)))
  messages.forEach((m, i) => {
    console.log(`  messages[${i}] (${m.role})`)
    contentOf(m).forEach((block, j) => console.log(part(`  [${j}] ${label(block)}`, block)))
  })
  const eagerChars = sum(eager)
  const systemChars = sum(system)
  const messageBlocks = messages.flatMap(contentOf)
  const messageChars = sum(messageBlocks)
  const deferredTokens = deferred.length * DEFERRED_TOOL_TOKENS
  console.log('  totals')
  console.log(row(`  ${eager.length} eager tools`, n(eagerChars), n(tok(eagerChars))))
  console.log(row(`  ${deferred.length} deferred tools, not billed at their size`, n(sum(deferred)), n(deferredTokens)))
  console.log(row(`  ${system.length} system blocks`, n(systemChars), n(tok(systemChars))))
  console.log(row(`  ${messageBlocks.length} message blocks`, n(messageChars), n(tok(messageChars))))
  console.log(
    row(
      '  first request',
      n(eagerChars + sum(deferred) + systemChars + messageChars),
      n(tok(eagerChars + systemChars + messageChars) + deferredTokens),
    ),
  )
}

/** After a resume, a CLI either re-reports the whole session or only this process; the mock bills every request alike. */
function phaseResult(p: 'A' | 'B', stream: Json[]): string {
  const result = stream.findLast(e => e.type === 'result')
  const served = captures.filter(c => c.phase === p)
  const cost = typeof result?.total_cost_usd === 'number' ? `$${result.total_cost_usd.toFixed(6)}` : '?'
  return (
    `  phase ${p}${p === 'B' ? ' (resumed)' : ''}: ${result?.subtype ?? 'no result message'}, ` +
    `num_turns ${result?.num_turns ?? '?'}, total_cost_usd ${cost} — ` +
    `the mock answered ${served.length} request(s) here, ${served.filter(c => isMainLoop(c.body)).length} main-loop`
  )
}

const variant = [...Object.entries(EXTRA_ENV).map(([k, v]) => `${k}=${v}`), ...(SETTINGS ? [`--settings ${SETTINGS}`] : [])]
console.log(`\n${BIN} — ${MODEL}${variant.length ? `; ${variant.join(' ')}` : ''}; captures in ${dir}/captures.json`)
console.log(phaseResult('A', phaseA))
console.log(phaseResult('B', phaseB))
prefixReport(firstA)
console.log('')
console.log(`last request of the first process: ${a.messages.length} messages; first of the resumed one: ${b.messages.length}`)
compare('tools', a.tools, b.tools)
compare('system', a.system, b.system)
for (let i = 0; i < a.messages.length; i++) compare(`messages[${i}] (${a.messages[i].role})`, a.messages[i], b.messages[i])
console.log('\nmessages[0] before the resume:')
for (const line of blocks(a.messages[0])) console.log(`  ${line}`)
console.log('messages[0] after the resume:')
for (const line of blocks(b.messages[0])) console.log(`  ${line}`)
