import { splitCommandWithOperators } from 'src/platform/bash/commands.js'
import { createOneShotMemo, MEMO_LIMIT } from 'src/tools/shared/redirect.js'
import { WAITFOR_TOOL_NAME } from 'src/tools/WaitForTool/toolName.js'

/**
 * Bash → WaitFor redirect for the `sleep N` poll loop.
 *
 * The 2026-09-04..08 census counted 134 of 1,044 API calls spent on
 * `sleep N; tmux capture-pane …` / `sleep N; cat task.output` — one full
 * round-trip at 200k+ context per poll. BashTool already refused a LEADING
 * sleep, but the message pointed at Monitor/run_in_background, which don't
 * answer "wait until X shows up", so the model varied the pipeline and kept
 * polling. WaitFor does the polling internally and returns one result.
 *
 * OFF by default until the Sonnet 5 adoption A/B passes:
 * `CLAUDIN_ENABLE_WAITFOR_REDIRECT=1` turns the lane on. With it off, BashTool's
 * sleep handling is byte-identical to before this module existed (leading
 * sleep only, Monitor message). The refusal is ONE-SHOT per command — an
 * identical resend runs — so a genuine sleep is never walled off.
 *
 * Only a TOP-LEVEL `sleep N` segment (integer N ≥ 2) with commands after it
 * counts as a poll: a sleep inside a pipeline, a subshell or a `for` body is
 * not a segment of its own and stays untouched. Sub-2s and fractional sleeps
 * are pacing, not polling, and are not redirected either.
 */

export type SleepPoll = {
  secs: number
  /** Everything before the sleep, run once — `tmux send-keys …`. */
  setup: string
  /** Everything after the sleep — the check WaitFor should poll. */
  command: string
}

const SLEEP_SEGMENT_RE = /^sleep\s+(\d+)\s*$/
// Locates the same sleep in the RAW text so pipes, redirections and quoting
// survive into the suggestion; the tokenized split is only the top-level gate.
const RAW_SLEEP_SPLIT_RE = /(?:^|&&|;|\|\|)\s*sleep\s+\d+\s*(?:&&|;)\s*/
const TRAILING_OPERATOR_RE = /\s*(?:&&|;|\|\|)\s*$/
const SEQUENCE_OPERATORS: ReadonlySet<string> = new Set(['&&', ';', '||'])

export function detectSleepPoll(command: string): SleepPoll | null {
  const parts = splitCommandWithOperators(command)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    const m = SLEEP_SEGMENT_RE.exec(part.trim())
    if (!m) continue
    const secs = parseInt(m[1]!, 10)
    if (secs < 2) continue
    // The sleep must be a segment of its own: preceded by nothing or a
    // sequencing operator, and followed by a sequencing operator and a command.
    const before = i > 0 ? parts[i - 1] : undefined
    if (before !== undefined && !SEQUENCE_OPERATORS.has(before)) continue
    const after = parts[i + 1]
    if (after === undefined || !SEQUENCE_OPERATORS.has(after)) continue
    if (parts[i + 2] === undefined) continue
    return { secs, ...splitRaw(command, parts, i) }
  }
  return null
}

function splitRaw(
  command: string,
  parts: string[],
  sleepIndex: number,
): { setup: string; command: string } {
  const m = RAW_SLEEP_SPLIT_RE.exec(command)
  if (m) {
    const setup = command.slice(0, m.index).replace(TRAILING_OPERATOR_RE, '').trim()
    const rest = command.slice(m.index + m[0].length).trim()
    if (rest) return { setup, command: rest }
  }
  // Raw text did not split cleanly (unusual quoting): fall back to the
  // tokenized segments, which lose pipes but still name the check.
  return {
    setup: parts.slice(0, sleepIndex).join(' ').replace(TRAILING_OPERATOR_RE, '').trim(),
    command: parts.slice(sleepIndex + 2).join(' ').trim(),
  }
}

/**
 * This lane's own refusal memo — separate from the RunTests/Typecheck/Git
 * memos so a refused poll does not spend another command's escape hatch.
 */
const memo = createOneShotMemo(MEMO_LIMIT)

/** Stateful: the SECOND identical call runs, which is what the message promises. */
export function shouldRedirectSleepPoll(command: string): boolean {
  return memo.shouldRefuse(command)
}

export function resetWaitForRedirectMemoForTesting(): void {
  memo.reset()
}

export function renderWaitForRedirect(poll: SleepPoll): string {
  const call = JSON.stringify({
    ...(poll.setup ? { setup: poll.setup } : {}),
    command: poll.command,
    until: '<regex you are waiting for>',
    timeout_s: Math.max(30, poll.secs * 6),
  })
  return `Blocked: sleep ${poll.secs} followed by a check. Use the ${WAITFOR_TOOL_NAME} tool instead: ${WAITFOR_TOOL_NAME}(${call}) — it polls internally and returns only the final output. Re-send this exact command if you genuinely need the sleep.`
}
