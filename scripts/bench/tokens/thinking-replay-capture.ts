#!/usr/bin/env bun
// Thinking-replay capture: what does a CLI send on the SECOND turn, once the
// first turn produced a `thinking` block it now has to echo back?
//
// WHY this exists separately from wire-diff.ts: that harness captures ONE
// request from a `-p` prompt, so the history holds no thinking block and the
// replay machinery is never exercised. Everything about "preserved thinking" —
// the signature validation, `thinking.block_binding`, the server-side
// `context_management` thinking edits — only shows up on turn 2+. The Opus 5.5
// registration shipped with that half unmeasured (docs/tech/opus-5-5/
// wire-capture.md, "Limits of this capture"); this closes it.
//
// HOW: the mock answers request #1 with a thinking block (populated signature,
// which is what display:"omitted" produces) PLUS a tool_use, so the CLI runs the
// tool and comes back for request #2 carrying its own previous assistant turn.
// Request #2 is the interesting one. Zero real API calls, fully deterministic.
//
// Usage:
//   bun run scripts/bench/tokens/thinking-replay-capture.ts
//   bun run scripts/bench/tokens/thinking-replay-capture.ts --bin=claudindev --full
//   bun run scripts/bench/tokens/thinking-replay-capture.ts --models=claude-opus-5-5
//   bun run scripts/bench/tokens/thinking-replay-capture.ts --turns=5
//   bun run scripts/bench/tokens/thinking-replay-capture.ts --user-turns=3
//   bun run scripts/bench/tokens/thinking-replay-capture.ts --tool-result-bytes=4000
//   bun run scripts/bench/tokens/thinking-replay-capture.ts --raw   # dump bodies
//   CLAUDIN_CACHE_PROFILE=aggressive bun run … --bin=claudindev --full --turns=6
//
// `--turns=N` is the part that finds real defects. Two turns only prove the
// replay is byte-faithful; the client paths that INVALIDATE a preserved-thinking
// prefix are the ones that fire deeper into a session — Claudin's
// stripOldThinkingBlocks keeps the last 2 assistant turns and deletes thinking
// from the middle of everything older. At N=5 the first blocks are old enough to
// be dropped, and the report says how many of the N-1 emitted blocks survived.
//
// Whether that strip runs at all depends on the CACHE PROFILE, not on the model:
// a machine with an Anthropic /provider profile resolves to RETAIN (strip off)
// while the default OAuth setup with no profile resolves to AGGRESSIVE (strip
// on) — src/agent/cache/cacheProfile.ts. So a green run here proves nothing
// about other users unless you pin it. CLAUDIN_CACHE_PROFILE is forwarded to
// the child for exactly that reason, and it is the ONE CLAUDIN_* var this
// harness does not strip.
//
// `--turns` alone is NOT enough to reach the strip, and that cost a round to
// learn: stripOldThinkingBlocks skips every assistant turn belonging to the
// user turn currently IN FLIGHT (normalize.ts:2323-2329), because a tool loop
// appends thinking-less continuation messages and stripping the turn-initial
// signed block mid-loop is what produces the "thinking blocks cannot be
// modified" 400. So a five-step tool loop under one prompt replays 5/5 blocks
// no matter how the profile is set. `--user-turns=N` is the flag that reaches
// it: the CLI is invoked N times in one throwaway cwd, runs 2..N with `-c`, so
// earlier turns are genuinely past and eligible.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8802

const DEFAULT_MODELS = [
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-sonnet-5',
]

type Args = {
  bin: string
  models: string[]
  full: boolean
  raw: boolean
  help: boolean
  turns: number
  userTurns: number
  toolResultBytes: number
}

function parseArgs(argv: string[]): Args {
  const o: Args = {
    bin: 'claude',
    models: DEFAULT_MODELS,
    full: false,
    raw: false,
    help: false,
    turns: 2,
    userTurns: 1,
    toolResultBytes: 0,
  }
  for (const x of argv) {
    if (x === '--help' || x === '-h') o.help = true
    else if (x === '--full') o.full = true
    else if (x === '--raw') o.raw = true
    else if (x.startsWith('--bin=')) o.bin = x.slice('--bin='.length)
    else if (x.startsWith('--turns='))
      o.turns = Math.max(2, Number(x.slice('--turns='.length)) || 2)
    else if (x.startsWith('--user-turns='))
      o.userTurns = Math.max(1, Number(x.slice('--user-turns='.length)) || 1)
    else if (x.startsWith('--tool-result-bytes='))
      o.toolResultBytes = Math.max(
        0,
        Number(x.slice('--tool-result-bytes='.length)) || 0,
      )
    else if (x.startsWith('--models='))
      o.models = x
        .slice('--models='.length)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
  }
  return o
}

// The signature is opaque to the client — it only ever round-trips it — so a
// fixed sentinel is enough, and it makes "was it echoed byte-for-byte?" a
// string comparison rather than a guess.
const SIGNATURE = 'SIG-REPLAY-PROBE-0001'
const THINKING_TEXT = 'Deciding which tool to call.'
const TOOL_USE_ID = 'toolu_replayprobe0001'
// Each turn gets its own signature/id suffix so the report can say WHICH blocks
// survived, not just how many.
const sigFor = (turn: number): string => `${SIGNATURE}-T${turn}`
const toolIdFor = (turn: number): string => `${TOOL_USE_ID}${turn}`

function sse(lines: string[]): string {
  return lines.join('\n') + '\n\n'
}

/**
 * A tool turn: a thinking block (text + signature) followed by a tool_use, so
 * the CLI executes the tool and comes back carrying this assistant turn in its
 * history. `signature_delta` is the event the client reads the signature from;
 * without it the block is unreplayable and some clients drop it. Each turn gets
 * its own signature so the report can name which blocks survived.
 */
function toolTurnSse(model: string, turn: number): string {
  // The age prune only stubs a tool_result at or above MIN_STUB_TOKENS (100,
  // ~400 chars), so the default `echo` output is far too small to ever be
  // clipped — which is how a probe can run for many turns and conclude
  // "nothing is rewritten" while the real path needs only two tool iterations
  // and a Read-sized result.
  const padding = toolResultBytes > 0 ? ' ' + 'x'.repeat(toolResultBytes) : ''
  const command = `echo replay-probe-${turn}${padding}`
  return sse([
    'event: message_start',
    `data: {"type":"message_start","message":{"id":"msg_replay_1","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"${THINKING_TEXT} (turn ${turn})"}}`,
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${sigFor(turn)}"}}`,
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: content_block_start',
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"${toolIdFor(turn)}","name":"Bash","input":{}}}`,
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(JSON.stringify({ command, description: 'probe' }))}}}`,
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":12}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
  ])
}

/** Turn 2+: plain text, end_turn, so the run terminates. */
function finalTurnSse(model: string): string {
  return sse([
    'event: message_start',
    `data: {"type":"message_start","message":{"id":"msg_replay_2","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":20,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
  ])
}

type Capture = { body: Record<string, unknown>; beta: string | null }

let captures: Capture[] = []
let currentModel = DEFAULT_MODELS[0]!
let toolTurns = 1
// Requests seen within the CURRENT cli invocation. A multi-user-turn run
// invokes the CLI several times against one mock, and each invocation has to
// get its own tool loop rather than falling straight through to the final turn.
let requestsThisRun = 0
// Signatures must be unique across the whole model run, not per invocation, or
// "which block survived" cannot be answered.
let signedBlocksEmitted = 0
// Padding applied to the probe tool's output, set from --tool-result-bytes.
let toolResultBytes = 0

function startServer(): Promise<{ close: () => void }> {
  return new Promise(resolveStart => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        const path = req.url ?? ''
        const raw = Buffer.concat(chunks).toString('utf8')
        if (path.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ input_tokens: 100 }))
          return
        }
        if (path.includes('/v1/messages')) {
          let body: Record<string, unknown> = {}
          try {
            body = JSON.parse(raw) as Record<string, unknown>
          } catch {
            body = { _unparsed: raw.slice(0, 200) }
          }
          captures.push({
            body,
            beta: (req.headers['anthropic-beta'] as string) ?? null,
          })
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          })
          // First real request drives the tool loop; everything after ends it.
          requestsThisRun += 1
          if (requestsThisRun <= toolTurns) {
            signedBlocksEmitted += 1
            res.end(toolTurnSse(currentModel, signedBlocksEmitted))
          } else {
            res.end(finalTurnSse(currentModel))
          }
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(PORT, () => resolveStart({ close: () => server.close() }))
  })
}

// Same auth/determinism split wire-diff.ts documents: --bare pins Claude Code to
// ANTHROPIC_API_KEY and drops hooks/plugins/MCP, while claudin's bare mode reads
// only an active Anthropic profile, so a claudin run on an unconfigured machine
// needs --full.
const BARE_ARGS = [
  '--bare',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
]

function runCli(
  bin: string,
  model: string,
  full: boolean,
  cwd: string,
  resume: boolean,
): Promise<{ code: number; why: string }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: process.env.HOME ?? '',
    ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
    ANTHROPIC_MODEL: model,
  }
  if (!full) {
    env.ANTHROPIC_API_KEY = 'sk-ant-api03-mock-capture-key'
  } else {
    delete env.ANTHROPIC_API_KEY
  }
  for (const key of Object.keys(env)) {
    if (
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDIN_') ||
      key.startsWith('CLAUDE_CODE_')
    ) {
      // Forwarded on purpose: it selects which client-side history rewriting
      // runs, which is the behaviour under test.
      if (key === 'CLAUDIN_CACHE_PROFILE') continue
      delete env[key]
    }
  }
  delete env.ANTHROPIC_AUTH_TOKEN

  const argv = [
    '-p',
    resume ? 'run the probe again' : 'run the probe',
    '--model',
    model,
    // Resume the session this cwd already holds, so the earlier assistant turns
    // are PAST user turns rather than steps of the one in flight — the only
    // shape stripOldThinkingBlocks will act on.
    ...(resume ? ['--continue'] : []),
    ...(full ? [] : BARE_ARGS),
    // The tool loop is the whole point — without an allowlist the tool_use is
    // denied, the CLI answers in one turn and there is no replay to capture.
    // Scoped to the exact command the mock asks for.
    '--allowedTools',
    'Bash(echo:*)',
    '--output-format',
    'text',
  ]
  return new Promise(resolve => {
    const child = spawn(bin, argv, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', d => (stderr += String(d)))
    child.stdout.on('data', d => (stdout += String(d)))
    const kill = setTimeout(() => child.kill('SIGTERM'), 90_000)
    child.on('close', code => {
      clearTimeout(kill)
      resolve({
        code: code ?? -1,
        why: [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ').slice(-400),
      })
    })
  })
}

type ThinkingBlock = {
  type: string
  thinking?: string
  signature?: string
}

type ReplayReport = {
  requests: number
  thinking: string | null
  contextManagement: string | null
  betas: string[]
  /** assistant turns in request #2 that carry a thinking/redacted block */
  replayedBlocks: ThinkingBlock[]
  signatureEchoed: boolean | null
  thinkingTextEchoed: boolean | null
  /** signatures the mock emitted, in order */
  emittedSignatures: string[]
  /** of those, the ones still present in the LAST request's history */
  survivingSignatures: string[]
  /** assistant turns that lost their thinking block entirely */
  droppedFromMiddle: number
  /** tool_result blocks in the last request, and how many are clip stubs */
  toolResults: number
  stubbedToolResults: number
}

function analyze(): ReplayReport {
  const first = captures[0]
  const second = captures[1]
  const last = captures[captures.length - 1]
  const body = (last ?? first)?.body ?? {}
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<{ role: string; content: unknown }>)
    : []

  const replayedBlocks: ThinkingBlock[] = []
  // An assistant turn that arrives back with NO thinking block is one the
  // client stripped — the shape that invalidates every later signature.
  let droppedTurns = 0
  // The OTHER prefix rewriter: the age prune / relief clip replacing an
  // already-sent tool_result with `[clipped: ~N tokens from Tool]`.
  let toolResults = 0
  let stubbedToolResults = 0
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const block of m.content as Array<{
        type?: string
        content?: unknown
      }>) {
        if (block?.type !== 'tool_result') continue
        toolResults += 1
        if (JSON.stringify(block.content ?? '').includes('[clipped:')) {
          stubbedToolResults += 1
        }
      }
    }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    let hasThinking = false
    for (const block of m.content as ThinkingBlock[]) {
      if (
        block &&
        typeof block === 'object' &&
        (block.type === 'thinking' || block.type === 'redacted_thinking')
      ) {
        replayedBlocks.push(block)
        hasThinking = true
      }
    }
    if (!hasThinking) droppedTurns += 1
  }

  const thinkingCfg = (last ?? first)?.body.thinking
  // The mock emits one signed block per tool turn; anything missing from the
  // final request's history was removed CLIENT-SIDE, which is exactly what
  // invalidates a preserved-thinking prefix.
  const emitted = Array.from({ length: signedBlocksEmitted }, (_, i) =>
    sigFor(i + 1),
  )
  const present = new Set(
    replayedBlocks.map(b => b.signature).filter((s): s is string => Boolean(s)),
  )
  return {
    requests: captures.length,
    thinking: thinkingCfg ? JSON.stringify(thinkingCfg) : null,
    contextManagement: body.context_management
      ? JSON.stringify(body.context_management)
      : null,
    betas: ((last ?? first)?.beta ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    replayedBlocks,
    signatureEchoed: second
      ? replayedBlocks.some(b => b.signature === sigFor(1))
      : null,
    thinkingTextEchoed: second
      ? replayedBlocks.some(b => b.thinking?.startsWith(THINKING_TEXT) === true)
      : null,
    emittedSignatures: emitted,
    survivingSignatures: emitted.filter(s => present.has(s)),
    droppedFromMiddle: droppedTurns,
    toolResults,
    stubbedToolResults,
  }
}

function printReport(model: string, r: ReplayReport, exitCode: number): void {
  console.log(`\n=== ${model} ===`)
  console.log(`  requests captured: ${r.requests}  (cli exit ${exitCode})`)
  if (r.requests < 2) {
    console.log(
      '  ⚠ no second request — the tool loop did not run, so nothing about',
    )
    console.log('    thinking REPLAY can be concluded from this row.')
    return
  }
  console.log(`  thinking (turn 2): ${r.thinking ?? '(absent)'}`)
  console.log(`  context_management: ${r.contextManagement ?? '(absent)'}`)
  console.log(`  thinking blocks replayed: ${r.replayedBlocks.length}`)
  for (const b of r.replayedBlocks) {
    const text = b.thinking === undefined ? '(no field)' : JSON.stringify(b.thinking)
    const sig = b.signature === undefined ? '(no field)' : JSON.stringify(b.signature)
    console.log(`    · ${b.type}  thinking=${text}  signature=${sig}`)
  }
  const lost = r.emittedSignatures.filter(
    s => !r.survivingSignatures.includes(s),
  )
  console.log(
    `  signed blocks surviving: ${r.survivingSignatures.length}/${r.emittedSignatures.length}` +
      (lost.length ? `  — LOST: ${lost.join(', ')}` : ''),
  )
  if (r.droppedFromMiddle > 0) {
    console.log(
      `  ⚠ ${r.droppedFromMiddle} assistant turn(s) came back with no thinking block —` +
        ' a client-side strip, which invalidates every signature after it.',
    )
  }
  console.log(`  signature echoed verbatim: ${r.signatureEchoed}`)
  console.log(`  thinking text echoed verbatim: ${r.thinkingTextEchoed}`)
  console.log(
    `  tool_results: ${r.toolResults}, replaced by a clip stub: ${r.stubbedToolResults}`,
  )
  const binding = r.betas.filter(b => b.startsWith('thinking-'))
  console.log(
    `  thinking-* betas: ${binding.length ? binding.join(', ') : '(none)'}`,
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'thinking-replay-capture: capture the SECOND turn, where thinking blocks are replayed.',
    )
    console.log(
      '  --bin=<claude|claudindev>  --models=a,b,c  --turns=N  --user-turns=N  --full  --raw',
    )
    return
  }

  const srv = await startServer()
  toolTurns = args.turns - 1
  toolResultBytes = args.toolResultBytes
  // A throwaway cwd PER MODEL: `-p` writes a session keyed by project
  // directory, so running in the repo would drop probe transcripts into the
  // working session's history — and `--continue` is keyed the same way, so a
  // shared cwd would resume the PREVIOUS model's conversation.
  console.log(`mock on :${PORT} · bin=${args.bin}`)
  console.log(
    `models: ${args.models.join(', ')} · ${args.userTurns} user turn(s) × ${toolTurns} tool step(s)\n`,
  )

  const reports: Array<{ model: string; r: ReplayReport }> = []
  try {
    for (const model of args.models) {
      captures = []
      signedBlocksEmitted = 0
      currentModel = model
      const cwd = mkdtempSync(join(tmpdir(), 'thinking-replay-'))
      process.stdout.write(`▶ ${model} ...`)
      let res = { code: 0, why: '' }
      try {
        for (let turn = 1; turn <= args.userTurns; turn++) {
          requestsThisRun = 0
          res = await runCli(args.bin, model, args.full, cwd, turn > 1)
          if (res.code !== 0) break
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
      process.stdout.write(` ${captures.length} request(s)\n`)
      if (res.code !== 0 && res.why) console.log(`  note: ${res.why}`)
      const r = analyze()
      reports.push({ model, r })
      printReport(model, r, res.code)
      if (args.raw) {
        captures.forEach((c, i) => {
          writeFileSync(
            `/tmp/thinking-${model}-${i + 1}.json`,
            JSON.stringify({ beta: c.beta, body: c.body }, null, 2),
          )
        })
      }
    }
  } finally {
    srv.close()
  }

  console.log(`\n${'─'.repeat(72)}\nSUMMARY\n${'─'.repeat(72)}`)
  console.log(
    `  ${'model'.padEnd(20)} ${'survived'.padEnd(9)} ${'sig kept'.padEnd(9)} thinking / betas`,
  )
  for (const { model, r } of reports) {
    if (r.requests < 2) {
      console.log(`  ${model.padEnd(20)} (no second request)`)
      continue
    }
    const binding = r.betas.filter(b => b.startsWith('thinking-')).join(' ')
    console.log(
      `  ${model.padEnd(20)} ${`${r.survivingSignatures.length}/${r.emittedSignatures.length}`.padEnd(9)} ${String(r.signatureEchoed).padEnd(9)} ${r.thinking ?? '(absent)'}${binding ? `  [${binding}]` : ''}`,
    )
  }
  if (args.raw) console.log('\n  bodies: /tmp/thinking-<model>-<n>.json')
}

void main()
