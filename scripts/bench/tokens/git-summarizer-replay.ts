#!/usr/bin/env bun
/**
 * Replays the Git tool's budget over real recorded git/gh results.
 *
 * The bodies in the corpus are genuine output the model actually received, so
 * this is a deterministic measurement rather than a sampled A/B: it answers
 * "what would this build have saved on the git commands we actually ran".
 *
 * Usage:
 *   bun scripts/bench/tokens/git-tool-baseline.ts --json /tmp/git-corpus.json
 *   bun scripts/bench/tokens/git-summarizer-replay.ts [--corpus <path>] [--all]
 *
 * Two honesty rules are built in, both of which move the number DOWN:
 *
 *  - **Only addressable calls count.** By default a recorded call is replayed
 *    only when `acceptsGitCommand` would let the Git tool run it. Most of the
 *    largest recorded bodies come from compound commands (`git status --short
 *    && git diff`), which the tool refuses outright — counting their chars as
 *    "saved" would be measuring a command that never reaches the tool. `--all`
 *    lifts the filter, for comparison only.
 *  - **Already-summarized bodies are skipped.** A result carrying a
 *    `<tool-result-summary>` wrapper was compacted before it was recorded;
 *    replaying it would double-count someone else's saving.
 *
 * `--strip-tails` answers a different, forward-looking question. Most of the
 * biggest recorded bodies are piped (`gh run view --log | tail -80` — 98 of 117
 * `gh run` calls), and the Bash→Git redirect strips that output-trim tail
 * before deciding, exactly as the Typecheck redirect does. So those commands
 * WILL reach the tool unpiped once the redirect lands, even though they are
 * unaddressable as recorded. That mode measures the surface the redirect
 * delivers; it is a projection, not a measurement of the past, and must be
 * reported as such.
 */
import { readFileSync } from 'fs'

import { acceptsGitCommand } from '../../../src/tools/GitTool/grammar.js'
import { summarizeGitOutput } from '../../../src/tools/GitTool/budget.js'
import { createOutputTrimTailStripper } from '../../../src/tools/shared/redirect.js'

type Sample = {
  command: string
  binary: string
  key: string
  chars: number
  text: string
}

type Row = {
  calls: number
  fired: number
  noWin: number
  before: number
  after: number
}

const SUMMARY_MARKER = '<tool-result-summary'
const stripOutputTrimTail = createOutputTrimTailStripper()

function pct(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((100 * part) / whole).toFixed(1)}%`
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

function main(): void {
  const argv = process.argv.slice(2)
  const corpusArg = argv.indexOf('--corpus')
  const corpusPath =
    corpusArg >= 0 ? (argv[corpusArg + 1] ?? '') : '/tmp/git-corpus.json'
  const all = argv.includes('--all')
  const stripTails = argv.includes('--strip-tails')

  let samples: Sample[]
  try {
    samples = JSON.parse(readFileSync(corpusPath, 'utf8')) as Sample[]
  } catch (e) {
    console.error(
      `Could not read the corpus at ${corpusPath} — regenerate it with:\n` +
        `  bun scripts/bench/tokens/git-tool-baseline.ts --json ${corpusPath}\n${String(e)}`,
    )
    process.exit(1)
    return
  }

  const rows = new Map<string, Row>()
  let skippedSummarized = 0
  let skippedUnaddressable = 0

  for (const sample of samples) {
    if (sample.text.includes(SUMMARY_MARKER)) {
      skippedSummarized++
      continue
    }
    const command = stripTails
      ? stripOutputTrimTail(sample.command)
      : sample.command
    if (!all && !acceptsGitCommand(command)) {
      skippedUnaddressable++
      continue
    }
    const after = summarizeGitOutput(command, sample.text)
    const row = rows.get(sample.key) ?? {
      calls: 0,
      fired: 0,
      noWin: 0,
      before: 0,
      after: 0,
    }
    row.calls++
    row.before += sample.text.length
    row.after += after.length
    if (after !== sample.text) row.fired++
    else row.noWin++
    rows.set(sample.key, row)
  }

  const totals = [...rows.values()].reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      fired: acc.fired + r.fired,
      noWin: acc.noWin + r.noWin,
      before: acc.before + r.before,
      after: acc.after + r.after,
    }),
    { calls: 0, fired: 0, noWin: 0, before: 0, after: 0 },
  )

  console.log(`corpus: ${corpusPath} (${samples.length} recorded calls)`)
  console.log(
    `skipped: ${skippedSummarized} already summarized, ${skippedUnaddressable} not accepted by the tool` +
      `${all ? ' (--all: filter lifted)' : ''}` +
      `${stripTails ? ' (--strip-tails: PROJECTION, output-trim tails removed first)' : ''}`,
  )
  console.log(
    `\nreplayed ${totals.calls} calls — ${totals.before} → ${totals.after} chars, ` +
      `take ${pct(totals.before - totals.after, totals.before)}`,
  )

  console.log(
    `\n  ${pad('command', 18)} ${padLeft('calls', 6)} ${padLeft('fired', 6)} ${padLeft('before', 9)} ${padLeft('after', 9)} ${padLeft('take', 7)}`,
  )
  const ordered = [...rows.entries()].sort(
    (a, b) => b[1].before - b[1].after - (a[1].before - a[1].after),
  )
  for (const [key, row] of ordered) {
    if (row.before === row.after && row.fired === 0) continue
    console.log(
      `  ${pad(key, 18)} ${padLeft(String(row.calls), 6)} ${padLeft(String(row.fired), 6)} ` +
        `${padLeft(String(row.before), 9)} ${padLeft(String(row.after), 9)} ` +
        `${padLeft(pct(row.before - row.after, row.before), 7)}`,
    )
  }

  const silent = ordered.filter(([, r]) => r.fired === 0)
  if (silent.length > 0) {
    console.log(
      `\nno summarizer fired for: ${silent.map(([k]) => k).join(', ')}`,
    )
  }
}

main()
