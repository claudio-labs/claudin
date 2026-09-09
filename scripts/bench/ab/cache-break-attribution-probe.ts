#!/usr/bin/env bun
// Cache-break attribution probe: when the prefix IS rewritten, does the
// break detector name the cause — and stay silent when it is not?
//
// Two headless runs per rep on the ToolSearch script:
//   (a) clean env — the discovery must not break the prefix and the detector
//       must not report one (no false positive);
//   (b) CLAUDIN_DEFERRED_TOOLS_DISCOVERED_ONLY=1 — the legacy "send only the
//       discovered deferred tools" filter, the one reproducible prefix
//       rewrite we have (cache.md §5). The call after ToolSearch must be
//       attributed as `tools changed (+2/-0 tools: +EnterPlanMode,+ExitPlanMode)`.
//
// Observation caveat, measured 2026-09-08: headless `-p` never emits the
// REPL's `[Cache: …]` line (it is useOnQuery code), so the attribution is
// read from the `--debug` log (`[PROMPT CACHE BREAK] …`) and from the
// `cache-break-*.diff` the detector writes to the temp dir. The persisted
// `[Cache: … cache break: …]` line is checked live in the REPL (plan
// Verification §3), not here.
//
// Usage:
//   bun run scripts/bench/ab/cache-break-attribution-probe.ts --model=claude-sonnet-5 --reps=3

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheBreakDiffs, parseArgs, readDebugLog, runHeadless, type HeadlessRun } from './headlessProbe.ts'
import { TOOL_SEARCH_SCRIPT } from './tool-search-cache-probe.ts'

const BREAK_LINE_RE = /\[PROMPT CACHE BREAK\] ([^\n]*)/g

type Arm = { label: string; env: Record<string, string>; expectBreak: boolean }
const ARMS: Arm[] = [
  { label: 'clean', env: {}, expectBreak: false },
  { label: 'legacy-filter', env: { CLAUDIN_DEFERRED_TOOLS_DISCOVERED_ONLY: '1' }, expectBreak: true },
]

function postDiscoveryDrop(run: HeadlessRun): { drop: boolean; prevCr: number; cr: number } | null {
  const i = run.calls.findIndex(c => c.tools.includes('ToolSearch'))
  if (i < 0 || i + 1 >= run.calls.length) return null
  const prevCr = run.calls[i]!.cr
  const cr = run.calls[i + 1]!.cr
  return { drop: cr < prevCr, prevCr, cr }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let failures = 0
  let reps = 0
  for (let rep = 1; rep <= args.reps; rep++) {
    console.log(`\n=== rep ${rep} bin=${args.bin} model=${args.model ?? 'default'} ===`)
    for (const arm of ARMS) {
      // A fresh cwd per run: the cwd is in the system prompt, so it is what
      // keeps one arm's server-side cache entry from answering the other's
      // request (measured: with a shared cwd the legacy arm's post-discovery
      // prefix was served from the clean arm's entry and no break happened).
      const cwd = mkdtempSync(join(tmpdir(), `cache-break-probe-${arm.label}-`))
      const startedAt = Date.now()
      const run = await runHeadless({
        bin: args.bin,
        model: args.model,
        cwd,
        prompt: TOOL_SEARCH_SCRIPT,
        env: arm.env,
        extraArgs: ['--debug'],
        timeoutMs: args.timeoutMs,
      })
      if (run.calls.length === 0) {
        console.log(`  ${arm.label.padEnd(14)} no calls (stderr: ${run.stderr.slice(0, 120)})`)
        failures++
        continue
      }
      reps++
      const drop = postDiscoveryDrop(run)
      const log = readDebugLog(run.sessionId)
      const breakLines = [...log.matchAll(BREAK_LINE_RE)].map(m => m[1]!)
      const diffs = cacheBreakDiffs(startedAt)
      const attributed = breakLines.some(l => l.includes('tools changed') && l.includes('+EnterPlanMode'))
      let ok: boolean
      if (arm.expectBreak) {
        ok = drop?.drop === true && attributed && diffs.length > 0
      } else {
        ok = drop?.drop === false && breakLines.length === 0 && diffs.length === 0
      }
      if (!ok) failures++
      const seq = run.calls.map(c => `${c.tools[0] ?? 'text'}:cr=${c.cr}`).join(' ')
      console.log(`  ${arm.label.padEnd(14)} ${ok ? 'PASS' : 'FAIL'} calls=${run.calls.length} postDiscovery=${drop ? `${drop.prevCr}→${drop.cr}` : 'n/a'} breaks=${breakLines.length} diffs=${diffs.length}`)
      console.log(`    ${seq}`)
      for (const l of breakLines) console.log(`    break: ${l.slice(0, 200)}`)
      if (!run.sessionId || !log) console.log(`    (no --debug log at session ${run.sessionId || '?'})`)
    }
  }
  console.log(`\n=== CACHE BREAK ATTRIBUTION PROBE bin=${args.bin} armRuns=${reps} failures=${failures} ===`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
