#!/usr/bin/env bun
// Read-reminder probe: does the malware <system-reminder> ride only the FIRST
// Read of the session (the default since 2026-09-09) instead of every one
// — and does the answer stay correct?
//
// Two headless runs per rep in a scratch cwd holding a.txt (3 lines),
// b.txt (5) and c.txt (7): the every-read behavior restored through
// CLAUDIN_DISABLE_READ_REMINDER_ONCE=1, then the default. The reminder is
// counted across the tool_results in the stream. Run this with a model that
// is NOT in MITIGATION_EXEMPT_MODELS (Sonnet 5 is the intended one) —
// an exempt model never carries the reminder, so both arms read 0.
//
// Usage:
//   bun run scripts/bench/ab/read-reminder-probe.ts --model=claude-sonnet-5 --reps=3

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, runHeadless } from './headlessProbe.ts'

const REMINDER = 'consider whether it would be considered malware'
const PROMPT =
  'Read a.txt, b.txt and c.txt with the Read tool (one call each) and reply with only the total number of lines.'
const EXPECTED_TOTAL = '15'

type Arm = { label: string; env: Record<string, string>; once: boolean }
const ARMS: Arm[] = [
  { label: 'every-read', env: { CLAUDIN_DISABLE_READ_REMINDER_ONCE: '1' }, once: false },
  { label: 'once (default)', env: {}, once: true },
]

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cwd = mkdtempSync(join(tmpdir(), 'read-reminder-probe-'))
  writeFileSync(join(cwd, 'a.txt'), 'a1\na2\na3\n')
  writeFileSync(join(cwd, 'b.txt'), 'b1\nb2\nb3\nb4\nb5\n')
  writeFileSync(join(cwd, 'c.txt'), 'c1\nc2\nc3\nc4\nc5\nc6\nc7\n')
  let failures = 0
  let armRuns = 0
  for (let rep = 1; rep <= args.reps; rep++) {
    console.log(`\n=== rep ${rep} bin=${args.bin} model=${args.model ?? 'default'} ===`)
    for (const arm of ARMS) {
      const run = await runHeadless({ bin: args.bin, model: args.model, cwd, prompt: PROMPT, env: arm.env, timeoutMs: args.timeoutMs })
      if (run.calls.length === 0) {
        console.log(`  ${arm.label.padEnd(10)} no calls (stderr: ${run.stderr.slice(0, 120)})`)
        failures++
        continue
      }
      armRuns++
      const reads = run.toolResults.filter(r => r.name === 'Read')
      const withReminder = reads.map(r => r.text.includes(REMINDER))
      const count = withReminder.filter(Boolean).length
      const correct = run.finalText.includes(EXPECTED_TOTAL)
      const ok = arm.once
        ? reads.length >= 2 && count === 1 && withReminder[0] === true && correct
        : reads.length >= 2 && count === reads.length && correct
      if (!ok) failures++
      console.log(
        `  ${arm.label.padEnd(10)} ${ok ? 'PASS' : 'FAIL'} reads=${reads.length} reminders=${count} pattern=[${withReminder.map(b => (b ? '1' : '0')).join('')}] answer=${JSON.stringify(run.finalText.slice(0, 40))} calls=${run.calls.length} cost=$${run.totalCostUsd.toFixed(4)}`,
      )
    }
  }
  console.log(`\n=== READ REMINDER PROBE bin=${args.bin} armRuns=${armRuns} failures=${failures} ===`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
