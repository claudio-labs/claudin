#!/usr/bin/env bun
/**
 * Extracts the real Bash calls out of the recorded session transcripts so the
 * output filter can be replayed against them.
 *
 * The 142 fixtures in `src/tools/shared/outputFilter/Bash/__fixtures__/samples/`
 * answer "how well does filter X do on output shaped like X". They cannot answer
 * "what fraction of what the agent actually ran gets filtered at all" — the
 * fixtures are one command each, and the traffic is 66.5% piped and chained.
 * This corpus is what answers that, and `measure-bash-filter-replay.test.ts`
 * reads it.
 *
 *   bun scripts/bench/tokens/extract-bash-corpus.ts [--days 60] [--project <slug>]
 *
 * ## Where it lands, and why not in the repo
 *
 * `~/.claudin/bench/bash-corpus/corpus.jsonl` — OUTSIDE the repository; the
 * reasoning lives on `CORPUS_PATH` in `transcriptCorpus.ts`. Only aggregate
 * numbers from the replay belong in a commit.
 *
 * ## What is thrown away, and why
 *
 * A `tool_result` for a Bash call is not always command output. A refused call
 * never executed, so its result is the refusal TEXT — and 466 redirect blocks
 * plus 162 permission denials and 121 plan-mode refusals is 424k chars of
 * prose that the filter never sees in production. Counting them as Bash output
 * inflates the denominator and makes every filter look like a no-op on traffic
 * it was never offered. They are dropped, and counted in the summary.
 *
 * A genuine failure IS kept: `Exit code N` followed by the real output is what
 * the error path has to deal with, and it is one of the arms being measured.
 * The prefix is parsed off into `exitCode` so the replay feeds the filter the
 * same string the filter saw.
 *
 * ## Three flags that keep the headline number honest
 *
 * A transcript does not always hold the raw output, and counting the ones that
 * do not would understate what is left to save:
 *
 * - `alreadyFiltered` — the Bash filter ran, so the text is its OUTPUT. Replaying
 *   over it measures only the stages that did not fire the first time.
 * - `truncatedUpstream` — `toolResultStorage`/`toolResultSummarizer` replaced the
 *   body before it was recorded. The raw text is not in the transcript at all.
 * - `hardCapped` — `formatOutput` (`BashTool/utils.ts`) cut it at
 *   `getMaxOutputLength()`, so the tail is missing.
 */
import { mkdirSync, writeFileSync } from 'fs'
import {
  configDir,
  CORPUS_DIR,
  CORPUS_PATH,
  type CorpusEntry,
  pad,
  padLeft,
  pct,
  projectDirs,
  toolCalls,
  transcriptFiles,
} from './transcriptCorpus.js'

/** Our own marker — the filter ran and this text is what it emitted. */
const BASH_MARKER_RE = /^<bash-output-(?:filtered|rewritten)[\s>]/
/** The upstream storage/summarizer wrappers — the raw body is gone. */
const UPSTREAM_WRAPPER_RE = /^<(?:persisted-output|tool-result-summary)[\s>]/
/** `formatOutput`'s tail marker. */
const HARD_CAP_RE = /\n\n\.\.\. \[\d+ lines truncated\] \.\.\.$/
/** The error renderer's prefix on a genuine non-zero exit. */
const EXIT_CODE_RE = /^Exit code (\d+)\n/
/**
 * Results the command never produced: the tool refused, the user denied it, plan
 * mode blocked it, or the request was interrupted. Anchored at the start, since
 * every one of these is generated text that owns the whole result.
 */
const HARNESS_MESSAGE_RE =
  /^(?:<tool_use_error>|Permission (?:for this action|to use \w+) has been denied|Plan mode is active|\[Request interrupted)/

function main(): void {
  const argv = process.argv.slice(2)
  const daysArg = argv.indexOf('--days')
  const projectArg = argv.indexOf('--project')
  const days = daysArg >= 0 ? Number(argv[daysArg + 1] ?? '60') : 60
  const project = projectArg >= 0 ? (argv[projectArg + 1] ?? null) : null

  const files = transcriptFiles(projectDirs(project), days)
  if (files.length === 0) {
    console.error(`no transcripts under ${join(configDir(), 'projects')}`)
    process.exit(1)
  }

  const entries: CorpusEntry[] = []
  let allToolChars = 0
  let bashChars = 0
  let bashCalls = 0
  let emptyResults = 0
  let harnessMessages = 0
  let harnessChars = 0
  const byTool = new Map<string, number>()

  for (const call of toolCalls(files)) {
    allToolChars += call.chars
    byTool.set(call.tool, (byTool.get(call.tool) ?? 0) + call.chars)
    if (call.tool !== 'Bash') continue
    bashCalls += 1
    bashChars += call.chars
    const command =
      typeof call.input.command === 'string' ? call.input.command.trim() : ''
    if (!command) continue
    if (call.text === '') {
      emptyResults += 1
      continue
    }
    if (HARNESS_MESSAGE_RE.test(call.text)) {
      harnessMessages += 1
      harnessChars += call.chars
      continue
    }
    const exitMatch = EXIT_CODE_RE.exec(call.text)
    const text = exitMatch ? call.text.slice(exitMatch[0].length) : call.text
    entries.push({
      command,
      text,
      chars: text.length,
      isError: call.isError,
      exitCode: exitMatch ? Number(exitMatch[1]) : null,
      alreadyFiltered: BASH_MARKER_RE.test(text),
      truncatedUpstream: UPSTREAM_WRAPPER_RE.test(text),
      hardCapped: HARD_CAP_RE.test(text),
    })
  }

  mkdirSync(CORPUS_DIR, { recursive: true })
  writeFileSync(CORPUS_PATH, entries.map(e => JSON.stringify(e)).join('\n'))

  const oldest = files[files.length - 1]?.mtimeMs ?? 0
  const newest = files[0]?.mtimeMs ?? 0
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const flagged = (key: keyof CorpusEntry) => entries.filter(e => e[key]).length
  const flaggedChars = (key: keyof CorpusEntry) =>
    entries.reduce((n, e) => (e[key] ? n + e.chars : n), 0)
  const subagentFiles = files.filter(f => f.isSubagent).length

  console.log(
    `transcripts:  ${files.length} files (${subagentFiles} subagent), ${iso(oldest)} → ${iso(newest)} (${days}d)`,
  )
  console.log(`tool_result:  ${allToolChars} chars across all tools`)
  console.log(
    `Bash:         ${bashCalls} calls, ${bashChars} chars (${pct(bashChars, allToolChars)} of all)`,
  )
  console.log(`  usable:     ${entries.length} entries, ${emptyResults} empty results skipped`)
  console.log(
    `  dropped:    ${harnessMessages} harness messages (refusals, denials, plan mode, interrupts), ` +
      `${harnessChars} chars — the command never ran`,
  )
  const usableChars = entries.reduce((n, e) => n + e.chars, 0)
  console.log(`  measured:   ${usableChars} chars of real command output`)
  for (const key of ['alreadyFiltered', 'truncatedUpstream', 'hardCapped'] as const) {
    console.log(
      `  ${pad(key, 18)}${padLeft(String(flagged(key)), 6)} entries  ${padLeft(String(flaggedChars(key)), 9)} chars  ${pct(flaggedChars(key), usableChars)} of measured`,
    )
  }

  console.log('\ntop tools by tool_result chars')
  for (const [name, chars] of [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(
      `  ${pad(name || '(unnamed)', 16)} ${padLeft(String(chars), 10)}  ${pct(chars, allToolChars)}`,
    )
  }

  console.log(`\ncorpus: ${entries.length} entries → ${CORPUS_PATH}`)
}

// Guarded: the replay test imports nothing from here any more, but a script
// whose side effect is a 1,642-file walk must never run just because something
// reached for a symbol in it.
if (import.meta.main) main()
