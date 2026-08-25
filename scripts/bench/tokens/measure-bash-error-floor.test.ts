/**
 * Prices the stages `ERROR_FLOOR` does NOT run, over the failing commands the
 * agent actually ran.
 *
 * A Bash result with a non-zero exit takes a different path in
 * `applyBashFilterToStdout`: not the matched spec, not even the generic floor,
 * but `ERROR_FLOOR` — `collapseRuns` and nothing else. Every exclusion has a
 * written reason (`floor.ts`), and every reason is about not hiding the cause of
 * a failure. None of them had a number.
 *
 * The number matters because the lane is not small: over the sessions since
 * 2026-08-21, failing commands were 107 of 621 Bash calls and 13.5% of the
 * result characters, none of them carrying a filter marker. This file is what
 * says whether that 13.5% has anything left to take.
 *
 * Build the corpus first (it lands outside the repo, see the extractor):
 *
 *   bun scripts/bench/tokens/extract-bash-corpus.ts --days 60
 *   bun test scripts/bench/tokens/measure-bash-error-floor.test.ts
 *
 * With no corpus on disk the test logs how to make one and returns. It ALWAYS
 * PASSES — a report, not a gate, for the same reason as its sibling replay: a
 * gate keyed on a corpus that exists on one machine fails for everyone else.
 *
 * ## Read the baseline arm correctly
 *
 * The recorded text is what the model RECEIVED, so `collapseRuns` has already
 * run on it in production. Replaying it therefore measures ~0, and that is the
 * expected reading rather than a bug: every arm below is MARGINAL over what
 * production already does. That is also exactly the question being asked —
 * "what would adding this stage buy" — so no un-collapsing is attempted, which
 * could not be done faithfully anyway (` (×N)` does not say what the N lines
 * were).
 *
 * The `stripAnsi` arm is measured but is not a candidate. It was rejected on
 * grounds the number cannot overturn: an error string is printed VERBATIM to the
 * user's terminal, where the red on `ERROR` is doing its job. It is here as the
 * scale reference the rejection cited (0.2%).
 */
import { test } from 'bun:test'
import { existsSync } from 'fs'
import { applyPipeline } from 'src/tools/shared/outputFilter/Bash/pipeline.js'
import {
  ERROR_FLOOR,
  FLOOR_CAP_LINES,
  isCappableBody,
  looksLikeDiagnostics,
  looksLikeLocationList,
} from 'src/tools/shared/outputFilter/Bash/floor.js'
import type { FilterSpec } from 'src/tools/shared/outputFilter/Bash/types.js'
import {
  CORPUS_PATH,
  type CorpusEntry,
  pad,
  padLeft,
  pct,
  readCorpus,
} from './transcriptCorpus.js'

/** A candidate stage: the spec to run, and whether this body may take it. */
type Arm = {
  readonly id: string
  readonly why: string
  readonly spec: (body: string) => FilterSpec | null
}

const ARMS: readonly Arm[] = [
  {
    id: 'collapseRuns (today)',
    why: 'already ran in production — a ~0 here is the control, not a finding',
    spec: () => ERROR_FLOOR,
  },
  {
    id: '+ collapseDigitTemplates',
    why: 'fenced exactly as the success floor fences it',
    spec: body =>
      looksLikeDiagnostics(body) || looksLikeLocationList(body)
        ? null
        : { ...ERROR_FLOOR, collapseDigitTemplates: true },
  },
  {
    id: `+ cap ${FLOOR_CAP_LINES}`,
    why: 'head/tail cap, vetoed on a structured or diagnostic body',
    spec: body =>
      !isCappableBody(body) || looksLikeDiagnostics(body)
        ? null
        : {
            ...ERROR_FLOOR,
            maxLines: FLOOR_CAP_LINES,
            headLines: Math.floor(FLOOR_CAP_LINES / 2),
            tailLines: Math.ceil(FLOOR_CAP_LINES / 2),
          },
  },
  {
    id: '+ stripAnsi',
    why: 'NOT a candidate — the user reads this string; here as the 0.2% reference',
    spec: () => ({ ...ERROR_FLOOR, stripAnsi: true }),
  },
]

function isFailure(entry: CorpusEntry): boolean {
  return entry.isError || (entry.exitCode !== null && entry.exitCode !== 0)
}

test('bash error-floor — what the excluded stages would buy', () => {
  if (!existsSync(CORPUS_PATH)) {
    console.log(
      `no corpus at ${CORPUS_PATH}\n` +
        '  build one: bun scripts/bench/tokens/extract-bash-corpus.ts --days 60',
    )
    return
  }

  // `truncatedUpstream` bodies are the summarizer's text, not the command's.
  const failures = readCorpus().filter(e => isFailure(e) && !e.truncatedUpstream)
  const chars = failures.reduce((a, e) => a + e.chars, 0)
  const all = readCorpus().length

  const lines: string[] = []
  lines.push(
    `failing Bash results: ${failures.length} of ${all} corpus entries, ${chars} chars`,
  )
  lines.push('')
  lines.push(
    `${pad('arm', 26)}${padLeft('eligible', 10)}${padLeft('fired', 8)}${padLeft('chars saved', 14)}${padLeft('of lane', 9)}`,
  )

  for (const arm of ARMS) {
    let eligible = 0
    let fired = 0
    let saved = 0
    for (const entry of failures) {
      const spec = arm.spec(entry.text)
      if (!spec) continue
      eligible++
      const result = applyPipeline(spec, entry.text, {
        allowShortCircuit: false,
        allowRenderBody: false,
      })
      const delta = entry.chars - result.body.length
      if (delta > 0) {
        fired++
        saved += delta
      }
    }
    lines.push(
      `${pad(arm.id, 26)}${padLeft(String(eligible), 10)}${padLeft(String(fired), 8)}${padLeft(String(saved), 14)}${padLeft(pct(saved, chars), 9)}`,
    )
    lines.push(`${pad('', 26)}${arm.why}`)
  }

  // Where the lane's characters actually are — a stage can only reach a body it
  // is allowed to touch, so the veto counts explain the numbers above.
  const structured = failures.filter(e => !isCappableBody(e.text))
  const diagnostics = failures.filter(e => looksLikeDiagnostics(e.text))
  const tall = failures.filter(e => e.text.split('\n').length > FLOOR_CAP_LINES)
  lines.push('')
  lines.push('why the vetoes fire:')
  lines.push(
    `  structured body (JSON/array/one-line): ${structured.length} entries, ${structured.reduce((a, e) => a + e.chars, 0)} chars`,
  )
  lines.push(
    `  reads as diagnostics:                  ${diagnostics.length} entries, ${diagnostics.reduce((a, e) => a + e.chars, 0)} chars`,
  )
  lines.push(
    `  taller than the cap:                   ${tall.length} entries, ${tall.reduce((a, e) => a + e.chars, 0)} chars`,
  )

  console.log(lines.join('\n'))
})
