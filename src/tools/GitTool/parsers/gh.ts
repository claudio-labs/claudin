/**
 * `gh` output rendering.
 *
 * `gh run` is the measured third-largest shape (117 calls, 201,669 chars over
 * 760 sessions) and almost all of it is `gh run view --log`, whose every line
 * carries the same two redundancies:
 *
 *     smoke-and-tests\tRun tests\t2026-07-24T21:19:54.2638189Z ##[group]Run bun test
 *     |__ job, repeated __|        |__ 28-char timestamp __|   |__ actions marker
 *
 * Stripping the repeated job/step prefix (hoisting it to a group header) and
 * the per-line timestamp is close to lossless and removes roughly half of every
 * line. That is why this parser leads with the boring transformation rather
 * than with truncation: the cheap lossless win is bigger than the lossy one.
 *
 * `gh pr view` / `gh issue view` bodies are dominated by a long description and
 * a comment thread, so those are truncated with the elision named.
 */

/** Keep at most this many chars of a PR/issue body. */
export const BODY_CHAR_BUDGET = 1_200
/** Keep this many trailing lines when a log is still oversized after cleanup. */
export const LOG_TAIL_LINES = 60
/** Only start dropping log lines past this many. */
export const LOG_LINE_BUDGET = 120

/**
 * `job<TAB>step<TAB>2026-07-24T21:19:54.2638189Z rest`
 *
 * The timestamp is REQUIRED, not optional. `gh run list` is also tab-separated
 * (`completed<TAB>success<TAB>CI`), and an optional timestamp made this pattern
 * match it — turning a run list into a bogus `## completed › success` header.
 * The timestamp is what actually distinguishes a log from a table.
 */
const LOG_LINE_RE = /^([^\t]*)\t([^\t]*)\t(?:\uFEFF)?(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]|\^\[\[[0-9;]*[A-Za-z]/g
const ACTIONS_MARKER_RE = /^##\[(?:group|endgroup|debug)\]/
const BOM_RE = /^\uFEFF/

/** True when the text looks like `gh run view --log` output. */
export function isRunLog(text: string): boolean {
  const first = text.split('\n', 1)[0] ?? ''
  return LOG_LINE_RE.test(first) && first.includes('\t')
}

type LogLine = { job: string; step: string; text: string }

function parseRunLog(text: string): LogLine[] | null {
  const out: LogLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw) continue
    const m = raw.match(LOG_LINE_RE)
    if (!m) {
      // A line that does not fit the shape means this is not (only) a run log;
      // keep it verbatim under the current job so nothing is invented.
      out.push({ job: '', step: '', text: raw })
      continue
    }
    const body = (m[4] ?? '').replace(ANSI_RE, '').replace(BOM_RE, '')
    if (ACTIONS_MARKER_RE.test(body)) continue
    out.push({ job: m[1] ?? '', step: m[2] ?? '', text: body })
  }
  return out.length > 0 ? out : null
}

/**
 * Hoist the job/step prefix into a header that only prints when it changes,
 * drop the timestamps, then cap the length keeping the tail — a CI log is read
 * bottom-up, because the failure is at the end.
 */
export function renderRunLog(text: string): string | null {
  if (!isRunLog(text)) return null
  const lines = parseRunLog(text)
  if (!lines) return null

  const out: string[] = []
  let job = ''
  let step = ''
  for (const line of lines) {
    if (line.job !== job || line.step !== step) {
      job = line.job
      step = line.step
      if (job || step) out.push(`## ${job} › ${step}`)
    }
    out.push(line.text)
  }

  if (out.length <= LOG_LINE_BUDGET) return out.join('\n')
  const dropped = out.length - LOG_TAIL_LINES
  return [
    `… ${dropped} earlier log lines omitted — re-run with the step name to see them.`,
    ...out.slice(-LOG_TAIL_LINES),
  ].join('\n')
}

const COMMENT_SPLIT_RE = /\n(?=[-–—]{2,}\s*\n)/

/**
 * `gh pr view` / `gh issue view` plain-text output: a header block, then the
 * body, then comments. Only the body is budgeted — the header carries the
 * state the model asked for, and the comments are usually the point.
 */
export function renderIssueView(text: string): string | null {
  if (text.length <= BODY_CHAR_BUDGET * 2) return null
  const parts = text.split(COMMENT_SPLIT_RE)
  const head = parts[0] ?? text
  if (head.length <= BODY_CHAR_BUDGET) return null
  const cut = head.length - BODY_CHAR_BUDGET
  return [
    head.slice(0, BODY_CHAR_BUDGET),
    `… ${cut} chars of the description omitted — Git({commands:["gh pr view <n> --json body"]}) for all of it.`,
    ...parts.slice(1),
  ].join('\n')
}
