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
 * Both CLIs run with their real config (auth and plugins intact); only the
 * destination moves to the mock. Nothing is billed.
 *
 * Usage:
 *   bun scripts/bench/ab/resume-wire-probe.ts                  # claudindev
 *   bun scripts/bench/ab/resume-wire-probe.ts --bin=claude
 *   bun scripts/bench/ab/resume-wire-probe.ts --model=claude-sonnet-5
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'
import { makeWorkspace } from './session-cache-ab'

type Json = Record<string, any>

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string) =>
  argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const BIN = flag('bin', join(REPO_ROOT, 'bin', 'claudin'))
const MODEL = flag('model', 'claude-opus-5-5')
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

/** The CLI's real config, pointed at the mock; the host session's own variables stripped. */
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

const common = ['--model', MODEL, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']
const first = await run(['-p', 'Read the main files and tell me what this project does.', ...common])
const sessionId = first
  .split('\n')
  .flatMap(line => {
    try {
      return [JSON.parse(line) as Json]
    } catch {
      return []
    }
  })
  .find(e => e.type === 'system' && e.subtype === 'init')?.session_id as string | undefined
if (!sessionId) {
  server.close()
  throw new Error('no session id from phase A — did the CLI reach the mock?')
}
phase = 'B'
await run(['-p', 'Thanks. Now list the source files.', '--resume', sessionId, ...common])
server.close()
writeFileSync(join(dir, 'captures.json'), JSON.stringify(captures, null, 1))

const a = captures.filter(c => c.phase === 'A' && isMainLoop(c.body)).at(-1)?.body
const b = captures.find(c => c.phase === 'B' && isMainLoop(c.body))?.body
if (!a || !b) throw new Error(`missing a main-loop capture (${captures.length} captured) — see ${dir}/captures.json`)

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

console.log(`\n${BIN} — ${MODEL}; captures in ${dir}/captures.json`)
console.log(`last request of the first process: ${a.messages.length} messages; first of the resumed one: ${b.messages.length}`)
compare('tools', a.tools, b.tools)
compare('system', a.system, b.system)
for (let i = 0; i < a.messages.length; i++) compare(`messages[${i}] (${a.messages[i].role})`, a.messages[i], b.messages[i])
console.log('\nmessages[0] before the resume:')
for (const line of blocks(a.messages[0])) console.log(`  ${line}`)
console.log('messages[0] after the resume:')
for (const line of blocks(b.messages[0])) console.log(`  ${line}`)
