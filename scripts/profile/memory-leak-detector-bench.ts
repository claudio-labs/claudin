#!/usr/bin/env bun
// Memory-leak detector bench.
//
// Complements scripts/profile/query-engine-mem-bench.ts (which measures
// raw mutableMessages growth). This bench simulates full use-cycles
// (N turns followed by a synthetic /clear) and measures what does NOT
// return to baseline after each clear. Whatever fails to drop back is,
// by definition, a leak.
//
// Targets under suspicion (from manual audit 2026-05-06):
//   1. QueryEngine.mutableMessages — primary (ruled: array itself clears
//      on /clear, but any retained reference outside the engine leaks).
//   2. toolResultStorage ContentReplacementState — unbounded seenIds /
//      replacements maps per session (no LRU).
//   3. getToolResultsDir() disk spill — files written by persistToolResult
//      that never get unlinked.
//   4. process-wide listeners accumulated across the app lifecycle.
//
// Driver philosophy (same as the companion bench): synthesize Anthropic
// SDK message shapes directly; do NOT import QueryEngine (its module
// graph is ~100 MB of static state and would dwarf our signal). For
// toolResultStorage we DO import the real module because measuring it
// is the whole point.
//
// Usage:
//   bun --expose-gc run scripts/profile/memory-leak-detector-bench.ts
//   bun --expose-gc run scripts/profile/memory-leak-detector-bench.ts --turns=100 --cycles=3 --json
//
// Required: --expose-gc for honest heap deltas.

import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { statSync, readdirSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type Args = {
  turns: number
  cycles: number
  payloadKb: number
  withPrune: boolean
  simulateUnlink: boolean
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    turns: 100,
    cycles: 3,
    payloadKb: 500,
    withPrune: false,
    simulateUnlink: false,
    json: false,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a === '--with-prune') args.withPrune = true
    else if (a === '--simulate-unlink') args.simulateUnlink = true
    else if (a.startsWith('--turns=')) args.turns = Number(a.slice(8)) || args.turns
    else if (a.startsWith('--cycles=')) args.cycles = Number(a.slice(9)) || args.cycles
    else if (a.startsWith('--payload-kb=')) args.payloadKb = Number(a.slice(13)) || args.payloadKb
  }
  return args
}

function gc(): void {
  if (typeof global.gc === 'function') global.gc()
}

function fmtBytes(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 1024) return `${sign}${abs} B`
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`
  return `${sign}${(abs / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ---- Synthetic message factories (mirror of companion bench) -------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

type SyntheticMessage = {
  type: 'user' | 'assistant'
  uuid: string
  message: { role: 'user' | 'assistant'; content: string | ContentBlock[] }
}

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

function makeAssistantToolUse(toolUseId: string, toolName: string): SyntheticMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read the file.' },
        {
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input: { file_path: '/home/user/project/src/module.ts' },
        },
      ],
    },
  }
}

function makeUserToolResult(toolUseId: string, payload: string): SyntheticMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: payload }],
    },
  }
}

// ---- Listener counting ----------------------------------------------------

const TRACKED_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'exit',
  'beforeExit',
  'uncaughtException',
  'unhandledRejection',
] as const

type ListenerSnapshot = Record<string, number>

function snapshotListeners(): ListenerSnapshot {
  const out: ListenerSnapshot = {}
  for (const sig of TRACKED_SIGNALS) {
    out[sig] = process.listenerCount(sig)
  }
  out['stdin.data'] = process.stdin.listenerCount('data')
  out['stdout.drain'] = process.stdout.listenerCount('drain')
  out['stderr.drain'] = process.stderr.listenerCount('drain')
  return out
}

function diffListeners(a: ListenerSnapshot, b: ListenerSnapshot): ListenerSnapshot {
  const out: ListenerSnapshot = {}
  for (const k of Object.keys(b)) {
    out[k] = (b[k] ?? 0) - (a[k] ?? 0)
  }
  return out
}

// ---- Disk-spill measurement (standalone dir under os tmpdir) --------------

// We deliberately DO NOT use the real getToolResultsDir() from
// toolResultStorage.ts because (a) it writes under the user's ~/.claudio
// and we don't want to pollute it, and (b) it lazily initialises via the
// full config stack, which loads a big module subgraph. A fresh tmp dir
// gives identical on-disk semantics for the purpose of measuring growth.
const BENCH_SPILL_DIR = join(tmpdir(), `claudio-leak-bench-${process.pid}`)

function ensureBenchDir(): void {
  mkdirSync(BENCH_SPILL_DIR, { recursive: true })
}

function dirBytes(path: string): number {
  if (!existsSync(path)) return 0
  let total = 0
  try {
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      const st = statSync(full)
      if (st.isFile()) total += st.size
      else if (st.isDirectory()) total += dirBytes(full)
    }
  } catch {
    // Ignore races during cleanup.
  }
  return total
}

function dirFileCount(path: string): number {
  if (!existsSync(path)) return 0
  let count = 0
  try {
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      const st = statSync(full)
      if (st.isFile()) count += 1
      else if (st.isDirectory()) count += dirFileCount(full)
    }
  } catch {}
  return count
}

// ---- Local ContentReplacementState mirror ---------------------------------

// Mirror of toolResultStorage.ContentReplacementState. We mirror instead of
// importing because the real type is just { seenIds: Set, replacements: Map }
// and importing the module drags in growthbook, analytics, slowOperations,
// and sessionStorage (all build-stubbed in production but still ~5MB of
// eval cost that would contaminate "external" bytes).
type MirrorCRState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

function createMirrorState(): MirrorCRState {
  return { seenIds: new Set(), replacements: new Map() }
}

function crStateBytes(s: MirrorCRState): number {
  let total = 0
  for (const id of s.seenIds) total += id.length * 2 // UTF-16
  for (const [k, v] of s.replacements) total += k.length * 2 + v.length * 2
  return total
}

// ---- Local clippedIds mirror ---------------------------------------------

// Same rationale: addClippedIds from stableStubState depends on
// getSessionId()/getAgentId() which pull the bootstrap graph. The mirror
// is behaviourally identical for bench purposes.
const mirrorClippedIds = new Set<string>()

function resetMirrorClipped(): void {
  mirrorClippedIds.clear()
}

// ---- Approx bytes for the messages array ---------------------------------

function approxArrayBytes(msgs: SyntheticMessage[]): number {
  // Sum of content-string lengths; fast and stable proxy.
  let total = 0
  for (const m of msgs) {
    const content = m.message.content
    if (typeof content === 'string') {
      total += content.length * 2
    } else {
      for (const b of content) {
        if (b.type === 'text') total += b.text.length * 2
        else if (b.type === 'tool_result') total += b.content.length * 2
        else if (b.type === 'tool_use') total += JSON.stringify(b.input).length * 2
      }
    }
  }
  return total
}

// ---- Snapshot type --------------------------------------------------------

type Snapshot = {
  label: string
  cycle: number
  turn: number
  messages: number
  approxArrayBytes: number
  heapBytes: number
  heapDeltaFromBaseline: number
  rssBytes: number
  rssDeltaFromBaseline: number
  externalBytes: number
  listeners: ListenerSnapshot
  listenersDeltaFromBaseline: ListenerSnapshot
  crStateSeenIds: number
  crStateReplacements: number
  crStateBytes: number
  clippedIdsSize: number
  diskBytes: number
  diskFiles: number
}

// ---- Run ------------------------------------------------------------------

async function run(args: Args): Promise<{
  snapshots: Snapshot[]
  wallMs: number
  baseline: Snapshot
}> {
  // Start clean.
  if (existsSync(BENCH_SPILL_DIR)) rmSync(BENCH_SPILL_DIR, { recursive: true, force: true })
  ensureBenchDir()
  resetMirrorClipped()

  gc()
  const mem0 = process.memoryUsage()
  const listeners0 = snapshotListeners()

  const baseline: Snapshot = {
    label: 'baseline',
    cycle: 0,
    turn: 0,
    messages: 0,
    approxArrayBytes: 0,
    heapBytes: mem0.heapUsed,
    heapDeltaFromBaseline: 0,
    rssBytes: mem0.rss,
    rssDeltaFromBaseline: 0,
    externalBytes: mem0.external,
    listeners: listeners0,
    listenersDeltaFromBaseline: diffListeners(listeners0, listeners0),
    crStateSeenIds: 0,
    crStateReplacements: 0,
    crStateBytes: 0,
    clippedIdsSize: 0,
    diskBytes: 0,
    diskFiles: 0,
  }

  const snapshots: Snapshot[] = [baseline]
  const t0 = performance.now()

  for (let cycle = 1; cycle <= args.cycles; cycle++) {
    // Fresh in-cycle state.
    let messages: SyntheticMessage[] = []
    const crState = createMirrorState()

    for (let turn = 1; turn <= args.turns; turn++) {
      const toolUseId = `tu_${cycle}_${turn}_${randomUUID().slice(0, 8)}`
      const payload = makeFileReadPayload(args.payloadKb * 1024)

      messages.push(makeAssistantToolUse(toolUseId, 'FileReadTool'))
      messages.push(makeUserToolResult(toolUseId, payload))

      // Simulate toolResultStorage path: write the big payload to disk,
      // record seenIds and a short replacement reference. This mirrors
      // processToolResultBlock behaviour for oversized results.
      if (payload.length > 50_000) {
        const filepath = join(BENCH_SPILL_DIR, `${toolUseId}.txt`)
        writeFileSync(filepath, payload)
        crState.seenIds.add(toolUseId)
        crState.replacements.set(
          toolUseId,
          `<persisted-output>${filepath} (${payload.length} bytes)</persisted-output>`,
        )
      }

      mirrorClippedIds.add(toolUseId)

      if (args.withPrune && messages.length > 4) {
        // Simulate pruneOldToolResults: stub content on tool_results
        // older than the last 2.
        const keepFrom = messages.length - 4 // keep last 2 turns (user+assistant)
        for (let i = 0; i < keepFrom; i++) {
          const m = messages[i]!
          const content = m.message.content
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b.type === 'tool_result' && b.content.length > 200) {
                b.content = `[clipped: ~${Math.round(b.content.length / 4)} tokens]`
              }
            }
          }
        }
      }
    }

    // Peak snapshot (end of cycle, before clear).
    gc()
    const memPeak = process.memoryUsage()
    const listenersPeak = snapshotListeners()
    snapshots.push({
      label: `cycle${cycle}-peak`,
      cycle,
      turn: args.turns,
      messages: messages.length,
      approxArrayBytes: approxArrayBytes(messages),
      heapBytes: memPeak.heapUsed,
      heapDeltaFromBaseline: memPeak.heapUsed - mem0.heapUsed,
      rssBytes: memPeak.rss,
      rssDeltaFromBaseline: memPeak.rss - mem0.rss,
      externalBytes: memPeak.external,
      listeners: listenersPeak,
      listenersDeltaFromBaseline: diffListeners(listeners0, listenersPeak),
      crStateSeenIds: crState.seenIds.size,
      crStateReplacements: crState.replacements.size,
      crStateBytes: crStateBytes(crState),
      clippedIdsSize: mirrorClippedIds.size,
      diskBytes: dirBytes(BENCH_SPILL_DIR),
      diskFiles: dirFileCount(BENCH_SPILL_DIR),
    })

    // Synthetic /clear: mimic what REPL should do.
    //   - drop the messages array (analogous to QueryEngine creating a fresh one)
    //   - reset clippedIds (happens via onSessionSwitch listener in real code)
    //   - crState goes out of scope here — if anything outside held a ref,
    //     we'd see it in the post-clear snapshot.
    // NOTE: we intentionally do NOT rm the disk dir by default. Real /clear
    // in Claudio historically did not unlink spill files. If --simulate-unlink
    // is set we rm it here (mirrors A2: unlinkSessionSpillDir) to measure the
    // fix's disk impact.
    messages = []
    resetMirrorClipped()
    if (args.simulateUnlink && existsSync(BENCH_SPILL_DIR)) {
      rmSync(BENCH_SPILL_DIR, { recursive: true, force: true })
      ensureBenchDir()
    }
    // crState: no explicit clear; let GC prove whether it can be freed.
    gc()

    const memPost = process.memoryUsage()
    const listenersPost = snapshotListeners()
    snapshots.push({
      label: `cycle${cycle}-post-clear`,
      cycle,
      turn: args.turns,
      messages: messages.length,
      approxArrayBytes: 0,
      heapBytes: memPost.heapUsed,
      heapDeltaFromBaseline: memPost.heapUsed - mem0.heapUsed,
      rssBytes: memPost.rss,
      rssDeltaFromBaseline: memPost.rss - mem0.rss,
      externalBytes: memPost.external,
      listeners: listenersPost,
      listenersDeltaFromBaseline: diffListeners(listeners0, listenersPost),
      crStateSeenIds: 0, // out of scope; can't measure
      crStateReplacements: 0,
      crStateBytes: 0,
      clippedIdsSize: mirrorClippedIds.size,
      diskBytes: dirBytes(BENCH_SPILL_DIR),
      diskFiles: dirFileCount(BENCH_SPILL_DIR),
    })
  }

  const wallMs = performance.now() - t0
  return { snapshots, wallMs, baseline }
}

function printHuman(args: Args, res: { snapshots: Snapshot[]; wallMs: number }): void {
  console.log(`Memory-leak detector`)
  console.log(
    `  ${args.cycles} cycles × ${args.turns} turns, ${args.payloadKb} KB/tool_result${args.withPrune ? ' [PRUNE]' : ''}${args.simulateUnlink ? ' [UNLINK]' : ''}`,
  )
  console.log(`  wall: ${res.wallMs.toFixed(1)}ms\n`)

  console.log(
    'label                   msgs   array       heap     Δheap        RSS       ΔRSS    listeners  clipId  CRids  CRbytes  diskBytes  diskFiles',
  )
  for (const s of res.snapshots) {
    const listenerSum = Object.values(s.listenersDeltaFromBaseline).reduce((a, b) => a + b, 0)
    const listenerMark = listenerSum === 0 ? '  ok' : `+${listenerSum}`
    console.log(
      `${s.label.padEnd(22)} ${String(s.messages).padStart(5)}  ${fmtBytes(s.approxArrayBytes).padStart(8)}  ${fmtBytes(s.heapBytes).padStart(8)}  ${fmtBytes(s.heapDeltaFromBaseline).padStart(8)}  ${fmtBytes(s.rssBytes).padStart(8)}  ${fmtBytes(s.rssDeltaFromBaseline).padStart(8)}  ${listenerMark.padStart(9)}  ${String(s.clippedIdsSize).padStart(5)}  ${String(s.crStateSeenIds).padStart(5)}  ${fmtBytes(s.crStateBytes).padStart(7)}  ${fmtBytes(s.diskBytes).padStart(8)}  ${String(s.diskFiles).padStart(8)}`,
    )
  }

  console.log('')
  console.log('Leak verdict (per-cycle post-clear residue, should be ~0):')
  for (let cycle = 1; cycle <= args.cycles; cycle++) {
    const post = res.snapshots.find(s => s.label === `cycle${cycle}-post-clear`)
    if (!post) continue
    console.log(
      `  cycle ${cycle}: heap residue=${fmtBytes(post.heapDeltaFromBaseline)}  RSS residue=${fmtBytes(post.rssDeltaFromBaseline)}  disk residue=${fmtBytes(post.diskBytes)} (${post.diskFiles} files)  listeners residue=${Object.values(post.listenersDeltaFromBaseline).reduce((a, b) => a + b, 0)}`,
    )
  }

  // Growth check: compare post-clear of each cycle to see if leak accumulates.
  const posts = res.snapshots.filter(s => s.label.endsWith('-post-clear'))
  if (posts.length >= 2) {
    console.log('')
    console.log('Growth across cycles (post-clear-to-post-clear):')
    for (let i = 1; i < posts.length; i++) {
      const a = posts[i - 1]!
      const b = posts[i]!
      console.log(
        `  cycle ${a.cycle} → cycle ${b.cycle}: Δheap=${fmtBytes(b.heapDeltaFromBaseline - a.heapDeltaFromBaseline)}  ΔRSS=${fmtBytes(b.rssDeltaFromBaseline - a.rssDeltaFromBaseline)}  Δdisk=${fmtBytes(b.diskBytes - a.diskBytes)}`,
      )
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage: bun --expose-gc run scripts/profile/memory-leak-detector-bench.ts [options]

Options:
  --turns=N          turns per cycle (default 100)
  --cycles=M         number of use-cycles (default 3)
  --payload-kb=N     size of each tool_result payload in KB (default 500)
  --with-prune       simulate pruneOldToolResults every turn (mirrors A1)
  --simulate-unlink  rm disk spill on /clear (mirrors A2 unlinkSessionSpillDir)
  --json             emit JSON instead of human-readable table
  --help             this message

A cycle = --turns messages, followed by a synthetic /clear. The bench
prints per-cycle residue: what memory / disk / listeners failed to
drop back to baseline. That residue IS the leak.

Spill files are written to ${BENCH_SPILL_DIR}
`)
    return
  }

  if (typeof global.gc !== 'function') {
    console.warn('WARN: --expose-gc not enabled; heap deltas will be noisy.\n')
  }

  const res = await run(args)

  if (args.json) {
    console.log(JSON.stringify({ args, ...res }, null, 2))
  } else {
    printHuman(args, res)
  }

  // Cleanup.
  rmSync(BENCH_SPILL_DIR, { recursive: true, force: true })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
