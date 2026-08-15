#!/usr/bin/env bun
// Lockstep cache bench: drive a CLI one user turn per file via
// --input-format stream-json, guaranteeing IDENTICAL pacing across CLIs —
// the model cannot batch reads because it only ever sees one file request
// at a time. Complements cache-ab-bench.ts, whose single-prompt sequential
// mode depends on the model obeying a "one Read per message" instruction
// (Claude Code ignores it ~half the time and batches to ~16 requests).
//
// Per turn: user message "Read <file> and reply with a one-line summary"
// → the CLI does one Read request + one summary request (same shape on
// both sides). Usage rows are deduped by assistant message id, last
// nonzero wins (both CLIs emit final same-id usage events).
//
// Usage:
//   bun run scripts/profile/cache-lockstep-bench.ts --bin=claudindev --revisits=8
//   bun run scripts/profile/cache-lockstep-bench.ts --bin=claude --files=10

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

const ALL_FILES = [
  'src/services/api/client.ts',
  'src/services/api/providerConfig.ts',
  'src/agent/QueryEngine.ts',
  'src/commands.ts',
  'src/Tool.ts',
  'src/agent/messages/messages.ts',
  'src/platform/config/config.ts',
  'src/services/api/withRetry.ts',
  'src/services/api/errors.ts',
  'src/services/mcp/client.ts',
  'src/utils/model/model.ts',
  'src/services/api/providerModels.ts',
  'src/agent/context.ts',
  'src/agent/query.ts',
  'src/shared/errors.ts',
  'src/shared/log.ts',
  'src/shared/fs/path.ts',
  'src/shared/envUtils.ts',
  'src/shared/proc/Shell.ts',
  'src/platform/bootstrap/state.ts',
  'src/constants/messages.ts',
  'src/constants/keys.ts',
  'src/terminal/ink/constants.ts',
  'src/utils/protectedNamespace.ts',
  'src/shared/data/array.ts',
  'src/shared/withResolvers.ts',
  'src/shared/data/lazySchema.ts',
  'src/shared/data/yaml.ts',
  'src/agent/compact/snipCompact.ts',
  'src/shared/data/objectGroupBy.ts',
  'src/services/api/openaiShim.ts',
  'src/services/api/codexShim.ts',
  'src/agent/repl/REPL.tsx',
  'src/services/api/claude/streaming.ts',
  'src/services/api/claude/paramBuilders.ts',
  'src/agent/messages/normalize.ts',
  'src/agent/compact/stableStubState.ts',
  'src/agent/compact/microCompact.ts',
  'src/agent/cache/cacheProfile.ts',
  'src/agent/cost-tracker.ts',
  'src/services/api/modelCost.ts',
  'src/utils/model/modelAllowlist.ts',
  'src/services/api/promptCacheBreakDetection.ts',
  'src/agent/compact/autoCompact.ts',
  'src/services/api/api.ts',
  'src/services/api/betas.ts',
  'src/services/api/activeProvider.ts',
  'src/agent/context/thinking.ts',
  'src/shared/debug.ts',
  'src/shared/data/json.ts',
]

const REVISITS = [
  'src/services/api/client.ts',
  'src/agent/QueryEngine.ts',
  'src/agent/messages/messages.ts',
  'src/platform/config/config.ts',
  'src/services/api/withRetry.ts',
  'src/utils/model/model.ts',
  'src/constants/keys.ts',
  'src/shared/data/array.ts',
]

type Args = { bin: string; model: string; files: number; revisits: number; turnTimeoutMs: number }
function parseArgs(argv: string[]): Args {
  const a: Args = { bin: 'claudindev', model: 'claude-sonnet-4-6', files: ALL_FILES.length, revisits: 8, turnTimeoutMs: 180_000 }
  for (const x of argv) {
    if (x.startsWith('--bin=')) a.bin = x.slice(6)
    else if (x.startsWith('--model=')) a.model = x.slice(8)
    else if (x.startsWith('--files=')) a.files = Number(x.slice(8))
    else if (x.startsWith('--revisits=')) a.revisits = Number(x.slice(11))
    else if (x.startsWith('--turn-timeout=')) a.turnTimeoutMs = Number(x.slice(15))
  }
  return a
}

type Row = { in: number; out: number; cR: number; cW: number }

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const workload = [...ALL_FILES.slice(0, args.files), ...REVISITS.slice(0, args.revisits)]

  const child = spawn(
    args.bin,
    [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--print',
      '--model', args.model,
      '--allowedTools', 'Read',
    ],
    { cwd: resolve(import.meta.dir, '../..'), stdio: ['pipe', 'pipe', 'pipe'] },
  )

  const rows = new Map<string, Row>()
  const order: string[] = []
  let servedModel: string | null = null
  let costUsd = 0
  let turn = 0
  let resolveTurn: (() => void) | null = null

  const rl = createInterface({ input: child.stdout! })
  rl.on('line', line => {
    const s = line.trim()
    if (!s.startsWith('{')) return
    let v: Record<string, unknown>
    try { v = JSON.parse(s) } catch { return }
    if (v.type === 'assistant') {
      const m = (v.message ?? {}) as Record<string, unknown>
      if (!servedModel && typeof m.model === 'string') servedModel = m.model
      const u = (m.usage ?? {}) as Record<string, number>
      const id = String(m.id ?? '')
      if (!id) return
      const row: Row = {
        in: u.input_tokens ?? 0,
        out: u.output_tokens ?? 0,
        cR: u.cache_read_input_tokens ?? 0,
        cW: u.cache_creation_input_tokens ?? 0,
      }
      const prev = rows.get(id)
      if (!prev) order.push(id)
      // last nonzero wins (same-id refresh events)
      if (!prev || row.in + row.out + row.cR + row.cW > 0) rows.set(id, row)
    } else if (v.type === 'result') {
      if (typeof v.total_cost_usd === 'number') costUsd = v.total_cost_usd
      resolveTurn?.()
    }
  })

  const stderrChunks: string[] = []
  child.stderr!.on('data', d => stderrChunks.push(String(d)))

  const send = (text: string) => {
    child.stdin!.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n',
    )
  }

  const exitPromise = new Promise<number>(res => child.on('close', c => res(c ?? -1)))

  for (const file of workload) {
    turn++
    const isRevisit = workload.indexOf(file) < turn - 1
    let turnTimer: ReturnType<typeof setTimeout> | undefined
    const turnDone = new Promise<void>((res, rej) => {
      resolveTurn = () => {
        clearTimeout(turnTimer)
        res()
      }
      turnTimer = setTimeout(() => rej(new Error(`turn ${turn} timed out`)), args.turnTimeoutMs)
    })
    send(
      `Read the file ${file} using the Read tool${isRevisit ? ' (yes, again — re-read it in full)' : ''}, then reply with a one-line summary of it.`,
    )
    try {
      await turnDone
    } catch (e) {
      console.error(String(e))
      clearTimeout(turnTimer)
      break
    }
    process.stderr.write(`\rturn ${turn}/${workload.length} done   `)
  }
  child.stdin!.end()
  await Promise.race([exitPromise, new Promise(r => setTimeout(r, 10_000))])
  child.kill()

  let tin = 0, tout = 0, tcr = 0, tcw = 0
  let prevCr = 0, resets = 0
  for (const id of order) {
    const r = rows.get(id)!
    tin += r.in; tout += r.out; tcr += r.cR; tcw += r.cW
    if (r.cR < prevCr - 20_000) resets++
    prevCr = r.cR
  }
  const rw = tcw > 0 ? (tcr / tcw).toFixed(2) : 'inf'
  console.log(`\n=== LOCKSTEP RESULT bin=${args.bin} model=${servedModel} ===`)
  console.log(`turns=${turn} apiRequests=${order.length} in=${tin} out=${tout} cR=${tcr} cW=${tcw} r:w=${rw}:1 resets=${resets} cost=$${costUsd.toFixed(4)}`)
  if (stderrChunks.length && order.length === 0) {
    console.log('STDERR (head):', stderrChunks.join('').slice(0, 600))
  }
}

main()
