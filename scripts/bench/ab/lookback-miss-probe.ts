#!/usr/bin/env bun
// Lookback-miss probe: does a deferred cache marker that jumps past the API's
// 20-position lookback window rewrite the whole history, and does the lagging
// marker (src/providers/shims/claude/lagCacheMarker.ts) stop it?
//
// One headless `-p` run per rep drives a fixed script — Read big1 (~9.5k
// chars, just under the auto-outline pivot), fourteen `Bash 'echo N'` turns,
// Read big2, "done" — and reports cache_read / cache_creation per API call.
// After the first Read the deferred marker sits on its tool_result and stays
// there through the tiny turns (their suffix never reaches the 2048-token
// defer threshold), so the uncached tail grows to ~30 positions. The second
// Read's result makes the marker jump to the end in one step. The call that
// matters is the one right AFTER that result lands:
//   arm A (CLAUDIN_DISABLE_LAG_CACHE_MARKER=1): the lookback from the new
//          marker finds nothing within 20 positions, resumes at the system
//          breakpoint, and cache_read DROPS below the previous call's;
//   arm B (default): the lag marker on big1's result is where the lookback
//          resumes, so cache_read is >= the previous call's.
//
// Session ab1e69e8 (2026-09-13) paid seven of these misses — 3.06M cache-write
// tokens — every one labeled "likely server-side (prompt unchanged)".
//
// Measured 2026-09-13, Sonnet 5, 3 reps each arm (alternating order):
//   arm A  text  in=2 cr=37951→27592 cc=16387   <- 3/3 reps: history rewritten
//   arm B  text  in=2 cr=37971→37971 cc=6104    <- 3/3 reps: only the tail written
// The 14 tiny turns sat entirely in the uncached tail both ways (in= 83→1136,
// cc=0) — the marker never moved off big1's result until big2 landed.
//
// Runs on Sonnet 5 by default (the rule is model-independent; Opus only via
// --model), in a throwaway cwd so no rules/memory inflate the prefix, and
// never `-c` (headless resume is keyed by project dir).
//
// Both arms pin CLAUDIN_DEFER_CACHE_MARKER=2048. The miss only exists under
// the deferred placement, which stopped being the default on 2026-09-23 —
// without the pin arm A would never collapse and the probe would exit 2.
//
// Usage:
//   bun run scripts/bench/ab/lookback-miss-probe.ts --bin=claudindev --reps=3
//   bun run scripts/bench/ab/lookback-miss-probe.ts --bin=claudindev --reps=1 --model=claude-opus-5
//
// Exit 1 if arm B collapsed in any rep; exit 2 if arm A never collapsed (the
// probe did not reproduce the miss, so arm B proves nothing).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Call, parseArgs, runHeadless } from './headlessProbe.ts'

const TINY_TURNS = 14

// Under READ_AUTO_OUTLINE_THRESHOLD_CHARS (10_000) so a vanilla Read returns
// the body rather than the head/tail pivot, and above the 2048-token defer
// threshold so the marker lands on it.
function bigText(seed: string): string {
  const lines: string[] = []
  for (let i = 0; i < 60; i += 1) {
    lines.push(`${seed} line ${String(i).padStart(2, '0')}: ${'lorem ipsum dolor sit amet '.repeat(5)}`.slice(0, 158))
  }
  return lines.join('\n') + '\n'
}

export function buildScript(cwd: string): string {
  const steps: string[] = []
  steps.push(`Read the file ${join(cwd, 'big1.txt')} (a plain Read, no offset or limit).`)
  for (let i = 1; i <= TINY_TURNS; i += 1) steps.push(`Bash 'echo ${i}'.`)
  steps.push(`Read the file ${join(cwd, 'big2.txt')} (a plain Read, no offset or limit).`)
  steps.push('reply with the single word done.')
  return (
    'Do these strictly in order, exactly ONE tool call per assistant message, waiting for each result before the next. ' +
    'Do not summarize or comment between steps. ' +
    steps.map((s, i) => `Step ${i + 1}: ${s}`).join(' ')
  )
}

/** Index of the call right after the second Read's result landed. */
function callAfterSecondRead(calls: Call[]): number | undefined {
  let reads = 0
  for (let i = 0; i < calls.length; i += 1) {
    if (calls[i]!.tools.includes('Read')) {
      reads += 1
      if (reads === 2) return i + 1 < calls.length ? i + 1 : undefined
    }
  }
  return undefined
}

type Arm = { name: string; env: Record<string, string> }
const DEFERRED = { CLAUDIN_DEFER_CACHE_MARKER: '2048' }
const ARMS: Arm[] = [
  { name: 'A lag-off', env: { ...DEFERRED, CLAUDIN_DISABLE_LAG_CACHE_MARKER: '1' } },
  { name: 'B lag-on ', env: DEFERRED },
]

async function main() {
  const args = parseArgs(process.argv.slice(2), { model: 'claude-sonnet-5' })
  const cwd = mkdtempSync(join(tmpdir(), 'lookback-miss-probe-'))
  writeFileSync(join(cwd, 'big1.txt'), bigText('alpha'))
  writeFileSync(join(cwd, 'big2.txt'), bigText('omega'))
  const prompt = buildScript(cwd)

  const collapsed: Record<string, number> = {}
  const measured: Record<string, number> = {}
  for (let rep = 1; rep <= args.reps; rep++) {
    // Alternate arm order per rep so neither always runs on a colder prefix.
    const order = rep % 2 === 1 ? ARMS : [...ARMS].reverse()
    for (const arm of order) {
      const run = await runHeadless({
        bin: args.bin,
        model: args.model,
        cwd,
        prompt,
        env: arm.env,
        timeoutMs: args.timeoutMs,
      })
      const calls = run.calls
      console.log(`\n=== rep ${rep} arm ${arm.name} bin=${args.bin} model=${args.model} calls=${calls.length} ===`)
      if (calls.length === 0) {
        console.log(`no API calls parsed (exit ${run.exitCode}); stderr tail: ${run.stderr.slice(-400)}`)
        continue
      }
      const target = callAfterSecondRead(calls)
      if (target === undefined) {
        console.log('second Read not found — the model did not follow the script; rep discarded')
        continue
      }
      measured[arm.name] = (measured[arm.name] ?? 0) + 1
      let armCollapsed = false
      for (let i = 0; i < calls.length; i += 1) {
        const c = calls[i]!
        const tool = c.tools[0] ?? 'text'
        let flag = ''
        if (i === target) {
          const prev = calls[i - 1]!
          armCollapsed = c.cr < prev.cr
          flag = armCollapsed
            ? `  <- after big2: cache_read FELL ${prev.cr}→${c.cr}, rewrote ${c.cc} (lookback miss)`
            : `  <- after big2: prefix kept (${prev.cr}→${c.cr})`
        }
        console.log(`${tool.padEnd(12)} in=${String(c.in).padStart(6)} cr=${String(c.cr).padStart(7)} cc=${String(c.cc).padStart(7)}${flag}`)
      }
      if (armCollapsed) collapsed[arm.name] = (collapsed[arm.name] ?? 0) + 1
    }
  }

  const a = ARMS[0]!.name
  const b = ARMS[1]!.name
  console.log(
    `\n=== LOOKBACK MISS PROBE bin=${args.bin} model=${args.model} ` +
      `armA collapsed ${collapsed[a] ?? 0}/${measured[a] ?? 0}, armB collapsed ${collapsed[b] ?? 0}/${measured[b] ?? 0} ===`,
  )
  if ((collapsed[b] ?? 0) > 0) process.exit(1)
  if ((measured[a] ?? 0) > 0 && (collapsed[a] ?? 0) === 0) {
    console.log('arm A never collapsed: the probe did not reproduce the miss, so arm B proves nothing')
    process.exit(2)
  }
  process.exit(0)
}

if (import.meta.main) main()
