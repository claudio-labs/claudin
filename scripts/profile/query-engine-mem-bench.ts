#!/usr/bin/env bun
// Query engine message-history bench — ROADMAP item 5.6.
//
// Simulates the message growth pattern of QueryEngine.mutableMessages
// (src/QueryEngine.ts:187) without booting the full engine. The engine has
// no cap on this array — every assistant turn, tool_use, and tool_result
// gets pushed and stays until /clear. Realistic tool outputs (FileRead,
// Bash, Grep) easily reach 50-200 KB each.
//
// We measure RSS + heap as the array grows under realistic per-turn
// payloads, and report bytes-per-turn so we know how fast a session
// consumes process memory before any cap kicks in.
//
// Driver philosophy: synthesize Anthropic SDK message shapes directly. NO
// QueryEngine import — its module graph is ~100 MB of static state and
// would dwarf the signal we want to measure.
//
// Usage:
//   bun --expose-gc run scripts/profile/query-engine-mem-bench.ts
//   bun --expose-gc run scripts/profile/query-engine-mem-bench.ts --turns=2000 --payload-kb=100 --json
//
// Required: --expose-gc for honest heap deltas.

import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

type Args = {
  turns: number
  payloadKb: number
  toolsPerTurn: number
  withPrune: boolean
  keepRecent: number
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    turns: 1000,
    payloadKb: 50,
    toolsPerTurn: 2,
    withPrune: false,
    keepRecent: 2,
    json: false,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a === '--with-prune') args.withPrune = true
    else if (a.startsWith('--turns=')) args.turns = Number(a.slice(8)) || args.turns
    else if (a.startsWith('--payload-kb=')) args.payloadKb = Number(a.slice(13)) || args.payloadKb
    else if (a.startsWith('--tools-per-turn=')) args.toolsPerTurn = Number(a.slice(17)) || args.toolsPerTurn
    else if (a.startsWith('--keep-recent=')) args.keepRecent = Number(a.slice(14)) || args.keepRecent
  }
  return args
}

function gc(): void {
  if (typeof global.gc === 'function') global.gc()
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ---- Synthetic message factories (Anthropic SDK shapes only) -------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

type SyntheticMessage = {
  type: 'user' | 'assistant'
  uuid: string
  message: { role: 'user' | 'assistant'; content: string | ContentBlock[] }
}

// FileRead-style payload: realistic source code with line numbers.
function makeFileReadPayload(sizeBytes: number): string {
  const lines: string[] = []
  let total = 0
  let lineNo = 1
  while (total < sizeBytes) {
    const line = `${String(lineNo).padStart(5, ' ')}→  const value_${lineNo} = computeSomething(${lineNo}, "argument-${lineNo}")\n`
    lines.push(line)
    total += line.length
    lineNo++
  }
  return lines.join('')
}

// Bash-style payload: log output.
function makeBashPayload(sizeBytes: number): string {
  const lines: string[] = []
  let total = 0
  let i = 0
  while (total < sizeBytes) {
    const line = `[2026-05-03 12:00:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}] INFO  worker[${i}] processing job batch_${i} (${i % 100} items)\n`
    lines.push(line)
    total += line.length
    i++
  }
  return lines.join('')
}

function makeAssistantTextMessage(text: string): SyntheticMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

function makeAssistantToolUseMessage(toolUses: Array<{ id: string; name: string }>): SyntheticMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      role: 'assistant',
      content: toolUses.map(t => ({
        type: 'tool_use' as const,
        id: t.id,
        name: t.name,
        input: { path: `/tmp/file-${t.id}.ts`, query: 'something' },
      })),
    },
  }
}

function makeUserToolResultMessage(results: Array<{ id: string; content: string }>): SyntheticMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: {
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
      })),
    },
  }
}

function makeUserPromptMessage(text: string): SyntheticMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: text },
  }
}

// ---- Stable-stub simulation (mirrors src/services/compact/stableStubState.ts)
//
// Standalone re-implementation: the bench can't import the real module
// without dragging in ~100 MB of QueryEngine module graph. The contract is
// narrow enough to mirror locally — buildClipStub bytes match exactly so
// the bench reflects production bytes-on-the-array.

const CLIP_STUB_PATTERN = /^\[clipped: ~\d+ tokens from .+\]$/

function buildClipStub(toolName: string, originalTokens: number): string {
  return `[clipped: ~${Math.max(0, Math.round(originalTokens))} tokens from ${toolName}]`
}

function simulateApplyStableStubs(
  messages: SyntheticMessage[],
  clippedIds: Set<string>,
  toolNames: Map<string, string>,
): SyntheticMessage[] {
  if (clippedIds.size === 0) return messages

  let touched = false
  const out = messages.map(msg => {
    const content = msg.message.content
    if (!Array.isArray(content)) return msg
    let blockTouched = false
    const newContent = content.map(block => {
      if (block.type !== 'tool_result' || !clippedIds.has(block.tool_use_id)) {
        return block
      }
      if (typeof block.content === 'string' && CLIP_STUB_PATTERN.test(block.content)) {
        return block
      }
      if (block.content == null || block.content === '') return block
      // Approx tokens: ASCII bytes / 4. Mirrors roughTokenCountEstimation 1:4.
      const approxTokens = Math.ceil(block.content.length / 4)
      blockTouched = true
      return {
        ...block,
        content: buildClipStub(toolNames.get(block.tool_use_id) ?? 'tool', approxTokens),
      }
    })
    if (!blockTouched) return msg
    touched = true
    return {
      ...msg,
      message: { ...msg.message, content: newContent },
    }
  })
  return touched ? out : messages
}

// ---- Approximate in-memory size of the messages array --------------------

function approxArrayBytes(messages: SyntheticMessage[]): number {
  // V8 stores ASCII strings as 1-byte/char (kOneByteString). Realistic since
  // tool_result payloads here are 100% ASCII. Add ~200 B/message overhead
  // for object shape + UUID.
  let bytes = 0
  for (const m of messages) {
    bytes += 200
    const c = m.message.content
    if (typeof c === 'string') {
      bytes += c.length
    } else {
      for (const block of c) {
        if (block.type === 'text') bytes += block.text.length
        else if (block.type === 'tool_result') bytes += block.content.length + 50
        else if (block.type === 'tool_use') bytes += JSON.stringify(block.input).length + 100
      }
    }
  }
  return bytes
}

// ---- Bench --------------------------------------------------------------

type Snapshot = {
  turn: number
  messages: number
  approxArrayBytes: number
  heapBytes: number
  heapDeltaBytes: number
  rssBytes: number
  rssDeltaBytes: number
  externalBytes: number
}

async function run(args: Args): Promise<{ snapshots: Snapshot[]; wallMs: number; final: Snapshot }> {
  let messages: SyntheticMessage[] = []
  const payloadBytes = args.payloadKb * 1024

  // Track all tool_use_ids in encounter order; apply prune by clipping all
  // but the most recent `keepRecent` ids each turn. Mirrors microcompact's
  // size-based trigger contract: oldest tool_results become stubs, newest
  // stay live for the model's working context.
  const allToolUseIds: string[] = []
  const toolNames = new Map<string, string>()
  const clippedIds = new Set<string>()

  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const baselineHeap = process.memoryUsage().heapUsed
  const baselineRss = process.memoryUsage().rss
  const t0 = performance.now()

  const snapshots: Snapshot[] = []
  const interval = Math.max(1, Math.floor(args.turns / 10))

  for (let turn = 0; turn < args.turns; turn++) {
    // Realistic turn: user prompt → assistant tool_use → user tool_result → assistant text.
    messages.push(makeUserPromptMessage(`turn ${turn}: please investigate item ${turn}`))

    const toolUses = Array.from({ length: args.toolsPerTurn }, (_, i) => ({
      id: `toolu_${turn}_${i}`,
      name: i % 2 === 0 ? 'Read' : 'Bash',
    }))
    for (const t of toolUses) {
      allToolUseIds.push(t.id)
      toolNames.set(t.id, t.name)
    }
    messages.push(makeAssistantToolUseMessage(toolUses))

    // Generate fresh payload per turn so V8 cannot pool references.
    // Real sessions emit unique tool_result content every call.
    const results = toolUses.map((t, i) => ({
      id: t.id,
      content:
        (turn + i) % 2 === 0
          ? makeFileReadPayload(payloadBytes) + `\n// turn ${turn} idx ${i}`
          : makeBashPayload(payloadBytes) + `\n// turn ${turn} idx ${i}`,
    }))
    messages.push(makeUserToolResultMessage(results))

    messages.push(
      makeAssistantTextMessage(`Based on turn ${turn} I see the value is ${turn * 7}. Moving on.`),
    )

    // Mirrors QueryEngine.submitMessage: at the top of each new turn (after
    // the prior turn's transcript has flushed), substitute the array with
    // applyStableStubs(...). Identity guard preserves the ref when the set
    // is unchanged and no rewrite was needed.
    if (args.withPrune && allToolUseIds.length > args.keepRecent) {
      const candidates = allToolUseIds.slice(0, -args.keepRecent)
      let added = false
      for (const id of candidates) {
        if (!clippedIds.has(id)) {
          clippedIds.add(id)
          added = true
        }
      }
      if (added) {
        messages = simulateApplyStableStubs(messages, clippedIds, toolNames)
      }
    }

    if ((turn + 1) % interval === 0 || turn === args.turns - 1) {
      gc()
      const m = process.memoryUsage()
      snapshots.push({
        turn: turn + 1,
        messages: messages.length,
        approxArrayBytes: approxArrayBytes(messages),
        heapBytes: m.heapUsed,
        heapDeltaBytes: m.heapUsed - baselineHeap,
        rssBytes: m.rss,
        rssDeltaBytes: m.rss - baselineRss,
        externalBytes: m.external,
      })
    }
  }

  const wallMs = performance.now() - t0
  return { snapshots, wallMs, final: snapshots[snapshots.length - 1]! }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage: bun --expose-gc run scripts/profile/query-engine-mem-bench.ts [options]

Options:
  --turns=N            number of turns to simulate (default 1000)
  --payload-kb=N       size of each tool_result payload in KB (default 50)
  --tools-per-turn=N   tool_use blocks per turn (default 2)
  --with-prune         simulate roadmap 5.7 substitution: each turn,
                       applyStableStubs rewrites tool_results older than
                       --keep-recent into stubs, freeing the original payloads
  --keep-recent=N      number of most-recent tool_use ids to leave intact
                       under --with-prune (default 2)
  --json               emit JSON instead of human-readable table
  --help               this message
`)
    return
  }

  if (typeof global.gc !== 'function') {
    console.warn('WARN: --expose-gc not enabled; heap deltas will be noisy.\n')
  }

  const { snapshots, wallMs, final } = await run(args)

  if (args.json) {
    console.log(JSON.stringify({ args, wallMs, snapshots, final }, null, 2))
    return
  }

  console.log(`QueryEngine message-history simulation`)
  console.log(
    `  ${args.turns} turns, ${args.payloadKb} KB/tool_result, ${args.toolsPerTurn} tools/turn${args.withPrune ? ` [PRUNE keep-recent=${args.keepRecent}]` : ''}`,
  )
  console.log(`  wall: ${wallMs.toFixed(1)}ms\n`)
  console.log('turn      msgs   approx       heap        Δheap        RSS        ΔRSS       external')
  for (const s of snapshots) {
    console.log(
      `${String(s.turn).padStart(5)}  ${String(s.messages).padStart(5)}  ${fmtBytes(s.approxArrayBytes).padStart(8)}  ${fmtBytes(s.heapBytes).padStart(9)}  ${fmtBytes(s.heapDeltaBytes).padStart(9)}  ${fmtBytes(s.rssBytes).padStart(9)}  ${fmtBytes(s.rssDeltaBytes).padStart(9)}  ${fmtBytes(s.externalBytes).padStart(9)}`,
    )
  }

  const bytesPerTurnHeap = final.heapDeltaBytes / args.turns
  const bytesPerTurnRss = final.rssDeltaBytes / args.turns
  const bytesPerTurnApprox = final.approxArrayBytes / args.turns
  console.log('')
  console.log(`per-turn growth:`)
  console.log(`  approx array bytes: ${fmtBytes(bytesPerTurnApprox)}/turn`)
  console.log(`  heap delta:         ${fmtBytes(bytesPerTurnHeap)}/turn`)
  console.log(`  RSS delta:          ${fmtBytes(bytesPerTurnRss)}/turn`)
  console.log('')
  console.log(`final:`)
  console.log(`  ${final.messages} messages`)
  console.log(`  array (approx): ${fmtBytes(final.approxArrayBytes)}`)
  console.log(`  heap delta:     ${fmtBytes(final.heapDeltaBytes)}`)
  console.log(`  RSS delta:      ${fmtBytes(final.rssDeltaBytes)}`)
  console.log('')
  console.log(`Note: mutableMessages has no cap. A 2-hour session at this rate would consume`)
  console.log(`~${fmtBytes(bytesPerTurnRss * 240)} RSS for the message array alone (assuming ~2 turns/min × 120 min).`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
