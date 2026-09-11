#!/usr/bin/env bun
// Non-code Read pivot A/B: does a vanilla Read of a large `.diff` or `.txt`
// cost less when it comes back as an outline / head+tail preview than as
// the whole body — at equal answers?
//
// The 2026-09-10 census found 57 full Reads over 8k chars in two days, 25%
// of every Read char, almost all `/tmp/*.diff` dumps of `git show` and
// `.txt` reports — files the code auto-outline could not touch because the
// language gate said null. Two pivots now cover them: a unified diff
// outlines by file (`symbol='<path>'` returns that file's hunks), and a
// plain-text file over 10k chars returns its head and tail with the line
// count. This bench holds the task fixed and flips only the pivot:
//
//   A  pivot on   CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION=1   (the default)
//   B  pivot off  CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION=1
//
// Fixtures, rebuilt in a scratch cwd per rep:
//   change.diff  `git show e58d3ead -- src/` from this repo (~30k chars,
//                8 files) — a real diff, deterministic as long as the commit
//                is reachable;
//   report.txt   700 generated log lines (~40k chars, ~11k tokens — under
//                the 25k-token Read cap, so the in-band pivot is what fires,
//                not the over-cap arm) with three needles: a line count, an
//                ERROR on line 412, and a TOTAL on the last line.
//
// Each arm answers one question per fixture. The diff question needs the
// file list with counts AND the body of one small file; the text question
// needs the line count, the last line, and one line in the middle — so the
// preview alone answers two thirds and one offset Read answers the rest,
// while arm B pays the whole body for each. Correctness is checked against
// the needles and against `scanDiff` over the real fixture.
//
// `--tools Read --strict-mcp-config`: the first run allowed Grep and Sonnet 5
// answered the text questions with `Grep -c` plus two one-line offset Reads
// in BOTH arms, so the pivot never fired and the arms measured the same
// thing. Read alone is the census shape — the model that dumped `git show`
// to /tmp read the dump, it did not grep it. `--max-turns 30` caps a runaway.
//
// What the first run also showed, and this bench cannot separate: the Read
// tool description now names the diff outline, and with the pivot OFF the
// model asked for `view: 'outline'` itself in 2 of 3 reps. The pivot is the
// safety net; the description does most of the work on this model.
//
// Measured 2026-09-10, Sonnet 5, reps=3, all 12 answers correct:
//   txt   pivot-on $0.0380 [0.0378–0.0382]  vs off $0.1017 [0.1015–0.1017]
//         → −62.6%, ranges disjoint; 5.6k vs 44k Read chars.
//   diff  pivot-on $0.0373 vs off $0.0375 → −0.5%, ranges overlap: both
//         arms read the outline then one file section, on the description
//         alone. The pivot only fired in the one rep the model read the
//         diff plain (rep 1, on), at the same cost.
//
// Usage:
//   bun run scripts/bench/ab/read-text-preview-ab.ts --model=claude-sonnet-5 --reps=3 [--fixture=diff|txt|both]

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDiff } from '../../../src/tools/shared/codeOutline/langs/diff.ts'
import { REPO_ROOT } from '../../repoRoot.ts'
import { median, parseArgs, runHeadless } from './headlessProbe.ts'
import { priceFor } from './forkBench.ts'

const DIFF_COMMIT = 'e58d3ead'
const ERROR_LINE = 412
const ERROR_TEXT = 'ERROR: checksum mismatch on shard 7'
const TOTAL_LINE = 'TOTAL=4217 OK'
const REPORT_LINES = 700

type Arm = { label: string; env: Record<string, string> }
const ARMS: Arm[] = [
  { label: 'pivot-on', env: { CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION: '1' } },
  { label: 'pivot-off', env: { CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION: '1' } },
]

type Fixture = 'diff' | 'txt'

function buildReport(): string {
  const lines: string[] = []
  for (let i = 1; i <= REPORT_LINES; i++) {
    if (i === ERROR_LINE) lines.push(`[${i}] ${ERROR_TEXT}`)
    else if (i === REPORT_LINES) lines.push(TOTAL_LINE)
    else lines.push(`[${i}] shard ${i % 13} step ${i % 7} ok — ${'payload '.repeat(4)}`)
  }
  return lines.join('\n') + '\n'
}

function buildDiff(): string {
  return execFileSync('git', ['show', DIFF_COMMIT, '--format=', '--', 'src/'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
}

function makeCwd(diff: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'read-preview-ab-'))
  writeFileSync(join(cwd, 'change.diff'), diff)
  writeFileSync(join(cwd, 'report.txt'), buildReport())
  return cwd
}

function promptFor(fixture: Fixture, smallFile: string): string {
  if (fixture === 'txt') {
    return [
      'Answer three questions about report.txt in this directory, using the Read tool:',
      '1. How many lines does it have?',
      `2. What is the full text of line ${ERROR_LINE}?`,
      '3. What is the last line?',
      'Reply with the three answers, one per line, nothing else.',
    ].join('\n')
  }
  return [
    'change.diff in this directory is a unified diff. Using the Read tool, answer:',
    '1. List every file it touches, each with its added and removed line counts.',
    `2. What does the change to ${smallFile} do? One or two sentences.`,
    'Reply with the list and the sentence, nothing else.',
  ].join('\n')
}

type Expected = { fixture: Fixture; check: (text: string) => boolean }

function expectedFor(fixture: Fixture, diff: string, smallFile: string): Expected {
  if (fixture === 'txt') {
    return {
      fixture,
      check: t =>
        /\b700\b/.test(t) && t.includes('checksum mismatch on shard 7') && t.includes('TOTAL=4217'),
    }
  }
  const files = scanDiff(diff).filter(e => e.kind === 'file')
  return {
    fixture,
    check: t => {
      const named = files.filter(f => t.includes(f.name.split('/').pop()!)).length
      return named >= files.length - 1 && t.includes(smallFile.split('/').pop()!)
    },
  }
}

type Row = { arm: string; fixture: Fixture; rep: number; cost: number; calls: number; reads: number; readChars: number; correct: boolean }

async function main() {
  const args = parseArgs(process.argv.slice(2), { model: 'claude-sonnet-5', timeoutMs: 600_000 })
  const fixtureArg = process.argv.find(a => a.startsWith('--fixture='))?.slice(10) ?? 'both'
  const fixtures: Fixture[] = fixtureArg === 'both' ? ['diff', 'txt'] : [fixtureArg as Fixture]

  const diff = buildDiff()
  const diffFiles = scanDiff(diff).filter(e => e.kind === 'file')
  if (diffFiles.length < 3 || diff.length < 10_000) {
    throw new Error(`change.diff fixture too small: ${diff.length} chars, ${diffFiles.length} files`)
  }
  // The smallest file section is the one the diff question expands.
  const smallFile = diffFiles
    .slice()
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]!.name
  console.log(`fixtures: change.diff ${diff.length} chars / ${diffFiles.length} files (expand ${smallFile}); report.txt ${buildReport().length} chars`)

  const { price, label: priceLabel } = priceFor(args.model)
  const rows: Row[] = []
  let failures = 0
  for (let rep = 1; rep <= args.reps; rep++) {
    // Alternate arm order per rep so a warm server cache never favours one.
    const order = rep % 2 === 1 ? ARMS : [...ARMS].reverse()
    for (const fixture of fixtures) {
      const expected = expectedFor(fixture, diff, smallFile)
      for (const arm of order) {
        const cwd = makeCwd(diff)
        const run = await runHeadless({
          bin: args.bin,
          model: args.model,
          cwd,
          prompt: promptFor(fixture, smallFile),
          env: { ...arm.env, CLAUDIN_DISABLE_TOOL_RESULT_CACHE: '1' },
          timeoutMs: args.timeoutMs,
          extraArgs: ['--tools', 'Read', '--strict-mcp-config', '--max-turns', '30'],
        })
        if (run.calls.length === 0) {
          console.log(`  rep ${rep} ${fixture} ${arm.label}: no calls (stderr: ${run.stderr.slice(0, 160)})`)
          failures++
          continue
        }
        const reads = run.toolResults.filter(r => r.name === 'Read')
        const readChars = reads.reduce((s, r) => s + r.text.length, 0)
        let cost = 0
        for (const c of run.calls) {
          const w5 = c.usage.cache_creation?.ephemeral_5m_input_tokens ?? c.cc
          const w1h = c.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
          cost += (c.in * price.input + w5 * price.write5m + w1h * price.write1h + c.cr * price.read + c.out * price.output) / 1e6
        }
        const correct = expected.check(run.finalText)
        if (!correct) failures++
        rows.push({ arm: arm.label, fixture, rep, cost, calls: run.calls.length, reads: reads.length, readChars, correct })
        console.log(
          `  rep ${rep} ${fixture.padEnd(4)} ${arm.label.padEnd(9)} ${correct ? 'PASS' : 'FAIL'} calls=${String(run.calls.length).padStart(2)} reads=${reads.length} readChars=${String(readChars).padStart(6)} cost=$${cost.toFixed(4)} answer=${JSON.stringify(run.finalText.slice(0, 80))}`,
        )
      }
    }
  }

  console.log(`\n=== READ TEXT-PREVIEW A/B model=${args.model} (${priceLabel}) reps=${args.reps} ===`)
  for (const fixture of fixtures) {
    for (const arm of ARMS) {
      const r = rows.filter(x => x.fixture === fixture && x.arm === arm.label)
      if (r.length === 0) continue
      const costs = r.map(x => x.cost)
      console.log(
        `${fixture.padEnd(4)} ${arm.label.padEnd(9)} n=${r.length} cost median=$${median(costs).toFixed(4)} [${Math.min(...costs).toFixed(4)}–${Math.max(...costs).toFixed(4)}] calls=${median(r.map(x => x.calls))} reads=${median(r.map(x => x.reads))} readChars=${Math.round(median(r.map(x => x.readChars)))} correct=${r.filter(x => x.correct).length}/${r.length}`,
      )
    }
    const on = rows.filter(x => x.fixture === fixture && x.arm === 'pivot-on').map(x => x.cost)
    const off = rows.filter(x => x.fixture === fixture && x.arm === 'pivot-off').map(x => x.cost)
    if (on.length && off.length) {
      const disjoint = Math.max(...on) < Math.min(...off) || Math.max(...off) < Math.min(...on)
      console.log(`     Δ median cost pivot-on vs off: ${(((median(on) - median(off)) / median(off)) * 100).toFixed(1)}% ${disjoint ? '(ranges disjoint)' : '(ranges OVERLAP)'}`)
    }
  }
  console.log(`failures (no calls or wrong answer): ${failures}`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
