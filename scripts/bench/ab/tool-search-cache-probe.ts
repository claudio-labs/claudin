#!/usr/bin/env bun
// ToolSearch discovery cache probe: does loading a deferred tool via
// ToolSearch rewrite the cached prompt prefix?
//
// One headless `-p` run per rep drives a fixed script — Bash, Bash,
// ToolSearch(select:EnterPlanMode,ExitPlanMode), Bash, "done" — and reports
// cache_read / cache_creation per API call. The call that matters is the one
// right AFTER the ToolSearch result lands: on a healthy prefix its cache_read
// is >= the previous call's; a drop (or a fall to 0) means the discovery
// mutated the prefix and the whole history was rewritten.
//
// Measured 2026-09-03 before the fix (send only discovered deferred tools):
//   Bash        cr=30890 cc=0
//   ToolSearch  cr=30890 cc=0
//   Bash        cr=25770 cc=5213   <- system+tools grew +93 tokens; history rewritten
//
// Runs in a throwaway cwd so the project's rules/memory don't inflate the
// prefix, and never `-c` (headless resume is keyed by project dir).
//
// Usage:
//   bun run scripts/bench/ab/tool-search-cache-probe.ts --bin=claudindev --reps=3
//   bun run scripts/bench/ab/tool-search-cache-probe.ts --bin=claudin --reps=1 --model=claude-opus-5

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, runHeadless } from './headlessProbe.ts'

// "ONE tool call per assistant message" is load-bearing: Sonnet 5 otherwise
// batches all five steps into a single message, the probe sees two API calls,
// and the post-discovery call has nothing warm to compare against.
export const TOOL_SEARCH_SCRIPT =
  'Do these strictly in order, exactly ONE tool call per assistant message, waiting for each result before the next. ' +
  "Step 1: Bash 'echo a'. Step 2: Bash 'echo b'. Step 3: ToolSearch with query select:EnterPlanMode,ExitPlanMode " +
  "(never call EnterPlanMode). Step 4: Bash 'echo c'. Step 5: reply with the single word done."

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cwd = mkdtempSync(join(tmpdir(), 'tool-search-cache-probe-'))
  let breaks = 0
  let reps = 0
  for (let rep = 1; rep <= args.reps; rep++) {
    const run = await runHeadless({ bin: args.bin, model: args.model, cwd, prompt: TOOL_SEARCH_SCRIPT, timeoutMs: args.timeoutMs })
    const calls = run.calls
    if (calls.length === 0) continue
    reps++
    console.log(`\n=== rep ${rep} bin=${args.bin} calls=${calls.length} ===`)
    let afterToolSearch = false
    let prevCr = 0
    let repBroke = false
    for (const c of calls) {
      const tool = c.tools[0] ?? 'text'
      let flag = ''
      if (afterToolSearch) {
        flag = c.cr >= prevCr ? '  <- post-discovery: prefix kept' : '  <- post-discovery: PREFIX REWRITTEN'
        if (c.cr < prevCr) repBroke = true
        afterToolSearch = false
      }
      console.log(`${tool.padEnd(12)} in=${String(c.in).padStart(6)} cr=${String(c.cr).padStart(7)} cc=${String(c.cc).padStart(7)}${flag}`)
      if (c.tools.includes('ToolSearch')) afterToolSearch = true
      prevCr = c.cr
    }
    if (repBroke) breaks++
  }
  console.log(`\n=== TOOL SEARCH CACHE PROBE bin=${args.bin} reps=${reps} discoveryBreaks=${breaks} ===`)
  process.exit(breaks > 0 ? 1 : 0)
}

if (import.meta.main) main()
