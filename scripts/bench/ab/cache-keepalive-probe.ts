#!/usr/bin/env bun
// Cache keep-alive probe: does a TTL-refreshing ping keep a 5m-tier prefix
// alive across a pause longer than five minutes, and what does the session
// cost under each policy?
//
// ONE session per arm, driven turn by turn over `--input-format stream-json`
// so the process — and the keep-alive timer inside it — survives the pause
// (a `--resume` chain would restart the process and kill the timer). Three
// turns: two Reads of ~50 KB fixture files to build a prefix worth keeping
// (~30k tokens), a PAUSE of `--pause-min` (default 6, past the 5m TTL), then
// one more Read. The third turn's usage is the verdict:
//
//   1h    default              the 1h tier survives the pause on its own
//   5m    CLAUDIN_MAIN_CACHE_TTL=5m
//                              the control: the prefix expires and the third
//                              turn REWRITES it (cache_creation ≈ the prefix)
//   5m+ka CLAUDIN_MAIN_CACHE_TTL=5m + CLAUDIN_CACHE_KEEPALIVE=1
//                              the ping at 4m30s refreshes it; the third
//                              turn READS it (cache_read ≥ turn 2's)
//
// Cost is priced from the stream's usage plus the ping (read off the debug
// log: `[cache keep-alive] main: read N created M ($x)`; the ping is not an
// assistant message, so the stream never shows it). Three runs of ~8 minutes
// each; `--reps` defaults to 1 because the outcome is binary per arm.
//
// The nested-Agent case (a fresh sub-agent waiting >5 min on a child) is the
// same mechanism keyed by agentId and is not driven here — a 6-minute nested
// wait costs a run per arm and the parent-side verdict is identical.
//
// Measured 2026-09-10, Sonnet 5, 6-minute pause, one run per arm (each turn
// is two API calls; the pause sits before the fifth). First request after
// the pause, over a 75k-token prefix:
//   1h      read 75,064  created 0        $0.447 total
//   5m      read 21,417  created 53,641   $0.376  — expired; the 21k that
//           survived is the system+tools block every session shares
//   5m+ka   read 75,070  created 0        $0.317  — one ping at 4m30s read
//           the 75k prefix for $0.015; max_tokens:1 with adaptive thinking
//           was accepted
// So on this shape 5m+keep-alive < 5m < 1h. What it does not measure is the
// subscription quota's weighting of the ping (docs/tech/cache/keep-alive.md).
//
// Usage:
//   bun run scripts/bench/ab/cache-keepalive-probe.ts --model=claude-sonnet-5 [--pause-min=6] [--reps=1] [--arms=1h,5m,5m+ka]

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fixture, priceFor } from './forkBench.ts'
import { debugLogPath, parseArgs } from './headlessProbe.ts'

type ArmLabel = '1h' | '5m' | '5m+ka'
const ARMS: Record<ArmLabel, Record<string, string>> = {
  '1h': {},
  '5m': { CLAUDIN_MAIN_CACHE_TTL: '5m' },
  '5m+ka': { CLAUDIN_MAIN_CACHE_TTL: '5m', CLAUDIN_CACHE_KEEPALIVE: '1' },
}

type Row = { in: number; out: number; cR: number; cW: number }
type ArmResult = { arm: ArmLabel; rep: number; turns: Row[]; sessionId: string; pings: { read: number; created: number; usd: number }[]; costUsd: number; ok: boolean; note: string }

const PING_RE = /\[cache keep-alive\] main: read (\d+) created (\d+) \(\$([\d.]+)\)/g

async function runArm(arm: ArmLabel, rep: number, args: ReturnType<typeof parseArgs>, pauseMin: number): Promise<ArmResult> {
  const cwd = mkdtempSync(join(tmpdir(), `cache-keepalive-${arm.replace('+', '-')}-`))
  for (let i = 1; i <= 3; i++) writeFileSync(join(cwd, `f${i}.txt`), fixture(7000 * rep + i).text)

  const child = spawn(
    args.bin,
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--print', '--model', args.model!, '--permission-mode', 'bypassPermissions', '--debug'],
    {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...ARMS[arm],
        CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
        // A ~20k-token Read would otherwise wait on the rate-limited count_tokens endpoint.
        CLAUDIN_FILE_READ_MAX_OUTPUT_TOKENS: '100000',
      },
    },
  )
  const rows = new Map<string, Row>()
  const order: string[] = []
  let sessionId = ''
  let costUsd = 0
  let resolveTurn: (() => void) | null = null
  const rl = createInterface({ input: child.stdout! })
  rl.on('line', line => {
    const s = line.trim()
    if (!s.startsWith('{')) return
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { return }
    if (typeof v.session_id === 'string' && !sessionId) sessionId = v.session_id
    if (v.type === 'assistant') {
      const m = (v.message ?? {}) as Record<string, unknown>
      const u = (m.usage ?? {}) as Record<string, number>
      const id = String(m.id ?? '')
      if (!id) return
      const row: Row = { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cR: u.cache_read_input_tokens ?? 0, cW: u.cache_creation_input_tokens ?? 0 }
      const prev = rows.get(id)
      if (!prev) { order.push(id); rows.set(id, row); return }
      rows.set(id, { in: Math.max(prev.in, row.in), out: Math.max(prev.out, row.out), cR: Math.max(prev.cR, row.cR), cW: Math.max(prev.cW, row.cW) })
    } else if (v.type === 'result') {
      if (typeof v.total_cost_usd === 'number') costUsd = v.total_cost_usd
      resolveTurn?.()
    }
  })
  const stderr: string[] = []
  child.stderr!.on('data', d => stderr.push(String(d)))
  const exit = new Promise<void>(res => child.on('close', () => res()))

  const turn = (text: string) =>
    new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('turn timed out')), args.timeoutMs)
      resolveTurn = () => { clearTimeout(timer); res() }
      child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
    })

  let note = ''
  // Index of the first assistant row AFTER the pause: each turn is two API
  // calls (the Read, then the answer), so "turn 3" is not row 3.
  let firstAfterPause = -1
  try {
    await turn('Read f1.txt with the Read tool (one full read, no offset/limit) and reply with its line count only.')
    await turn('Read f2.txt the same way and reply with its line count only.')
    process.stderr.write(`  ${arm} rep ${rep}: pausing ${pauseMin} min…\n`)
    await new Promise(res => setTimeout(res, pauseMin * 60 * 1000))
    firstAfterPause = order.length
    await turn('Read f3.txt the same way and reply with its line count only.')
  } catch (e) {
    note = String(e)
  }
  child.stdin!.end()
  await exit

  const turns = order.map(id => rows.get(id)!)
  const pings: ArmResult['pings'] = []
  try {
    const log = readFileSync(debugLogPath(sessionId), 'utf8')
    for (const m of log.matchAll(PING_RE)) pings.push({ read: Number(m[1]), created: Number(m[2]), usd: Number(m[3]) })
  } catch { /* no debug log */ }
  const before = firstAfterPause > 0 ? turns[firstAfterPause - 1] : undefined
  const after = firstAfterPause >= 0 ? turns[firstAfterPause] : undefined
  // The verdict per arm, from the first request after the pause: a prefix
  // that survived is READ (cache_read ≥ what the last pre-pause request
  // read); one that expired is REWRITTEN (cache_creation ≈ that prefix).
  let ok = false
  if (before && after) {
    const survived = after.cR >= before.cR && after.cW < before.cR / 2
    ok = arm === '5m' ? !survived : survived
    if (arm === '5m+ka' && pings.length === 0) { ok = false; note += ' no ping in the debug log' }
  } else {
    note += ` only ${turns.length} turns`
  }
  return { arm, rep, turns, sessionId, pings, costUsd, ok, note: note.trim() }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { model: 'claude-sonnet-5', reps: 1, timeoutMs: 300_000 })
  const pauseMin = Number(process.argv.find(a => a.startsWith('--pause-min='))?.slice(12) ?? '6')
  const armsArg = process.argv.find(a => a.startsWith('--arms='))?.slice(7)
  const arms = (armsArg ? armsArg.split(',') : ['1h', '5m', '5m+ka']) as ArmLabel[]
  const { price, label } = priceFor(args.model)
  let failures = 0
  const results: ArmResult[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    for (const arm of arms) {
      const r = await runArm(arm, rep, args, pauseMin)
      results.push(r)
      if (!r.ok) failures++
      const t = r.turns.map((x, i) => `t${i + 1}[in=${x.in} cR=${x.cR} cW=${x.cW}]`).join(' ')
      const pingUsd = r.pings.reduce((s, p) => s + p.usd, 0)
      const priced = r.turns.reduce((s, x) => s + (x.in * price.input + x.cW * (arm === '1h' ? price.write1h : price.write5m) + x.cR * price.read + x.out * price.output) / 1e6, 0)
      console.log(`  ${arm.padEnd(6)} rep=${rep} ${r.ok ? 'PASS' : 'FAIL'} ${t} pings=${r.pings.length}${r.pings.length ? ` (read ${r.pings.map(p => p.read).join('/')}, $${pingUsd.toFixed(4)})` : ''} turns=$${priced.toFixed(4)} +pings=$${(priced + pingUsd).toFixed(4)} reported=$${r.costUsd.toFixed(4)} ${r.note}`)
    }
  }
  console.log(`\n=== CACHE KEEP-ALIVE PROBE model=${args.model} (${label}) pause=${pauseMin}min reps=${args.reps} failures=${failures} ===`)
  process.exit(failures ? 1 : 0)
}

main()
