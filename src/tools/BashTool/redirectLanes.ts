import { feature } from 'bun:bundle'
import { resolve } from 'path'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { detectBlockedSleepPattern } from 'src/tools/BashTool/bashCommandClassification.js'
import { isBackgroundTasksDisabled, type BashToolInput } from 'src/tools/BashTool/bashSchemas.js'
import type { CreditedRange } from 'src/tools/BashTool/creditShownFiles.js'
import {
  analyzeCommandForRedirect,
  rangedReadsOf,
  renderFileToolsAdvice,
  renderToolRedirect,
  shouldRedirectToTools,
  wholeFileReadsOf,
} from 'src/tools/BashTool/toolRedirect.js'
import { BUILD_TOOL_NAME } from 'src/tools/BuildTool/prompt.js'
import { renderBuildAdvice, renderBuildRedirect, shouldRedirectToBuild } from 'src/tools/BuildTool/redirect.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'
import { renderGitAdvice, renderGitRedirect, shouldRedirectToGit } from 'src/tools/GitTool/redirect.js'
import { RUN_TESTS_TOOL_NAME } from 'src/tools/RunTestsTool/prompt.js'
import { renderRunTestsAdvice, renderRunTestsRedirect, shouldRedirectToRunTests } from 'src/tools/RunTestsTool/redirect.js'
import { TYPECHECK_TOOL_NAME } from 'src/tools/TypecheckTool/prompt.js'
import { renderTypecheckAdvice, renderTypecheckRedirect, shouldRedirectToTypecheck } from 'src/tools/TypecheckTool/redirect.js'
import { WAITFOR_TOOL_NAME } from 'src/tools/WaitForTool/toolName.js'
import {
  detectSleepPoll,
  renderWaitForAdvice,
  renderWaitForRedirect,
  shouldRedirectSleepPoll,
} from 'src/tools/WaitForTool/redirect.js'

/**
 * Bash's pointers to a dedicated tool: tests to RunTests, checks to Typecheck,
 * builds to Build, repository reads to Git, file reads and searches to
 * Read/Grep/Glob, a `sleep` poll to WaitFor, and a blocking `sleep` to
 * run_in_background.
 *
 * Three modes, one set of lanes:
 *
 *  - **advise** (the default since 2026-09-24): the command RUNS, and its result
 *    carries a note naming the tool and the call to make instead
 *    (`Tool.advise`, appended by toolExecution). A deferred tool's note also
 *    names the ToolSearch call that loads it.
 *  - **refuse** (`CLAUDIN_BASH_REDIRECT=refuse`): the command is refused once
 *    with the same pointer and the identical re-send runs — the behaviour
 *    before 2026-09-24, byte for byte, kept as the A/B arm and the way back.
 *  - **off** (`CLAUDIN_BASH_REDIRECT=off`): no pointer at all.
 *
 * Measured before the switch: a pointer that does not block was adopted about
 * zero times in three benches here (team memory
 * `tool-result-nudges-benched-zero-adoption`), and the Read/Grep/Glob refusal
 * converted 84.7%. Advising is a user decision; the refusal arm is what
 * measures its cost. Measured after it (team memory
 * `dev-tools-deferred-advice-ab-2026-09-24`): cost within noise of the
 * refusal, 3 fewer turns, and a generic "prefer the dedicated tools" line in
 * the system prompt instead of the notes changed nothing either.
 *
 * Each lane keeps its own gates and its own one-shot memo: a pointer is given
 * once per distinct command, never for a backgrounded run, only when the tool
 * is in THIS agent's toolset, and each lane's `CLAUDIN_DISABLE_*_REDIRECT`
 * switches it off in both modes. The sleep-poll lane is opt-in in refuse mode
 * (`CLAUDIN_ENABLE_WAITFOR_REDIRECT=1`, as before) and on in advise mode
 * (`CLAUDIN_DISABLE_WAITFOR_REDIRECT=1` turns it off). The blocking-sleep lane
 * has no memo, in either mode, as before.
 *
 * The file-reads lane is off in advise mode since 2026-10-30 and back with
 * `CLAUDIN_FILE_TOOLS_NOTE=1` (`isFileToolsNoteEnabled`); its refusal in
 * refuse mode is unchanged.
 *
 * One note is taken back after the call: the file-reads note on a `cat` whose
 * every file the read credit counted as read (`isReadAdviceMoot`).
 */

export type BashRedirectMode = 'advise' | 'refuse' | 'off'

export function getBashRedirectMode(): BashRedirectMode {
  const mode = process.env.CLAUDIN_BASH_REDIRECT
  return mode === 'refuse' || mode === 'off' ? mode : 'advise'
}

/**
 * Whether advise mode appends the "only reads or searches files" note.
 * `CLAUDIN_FILE_TOOLS_NOTE=1` turns it back on; read per call so a test can
 * set it.
 *
 * In 10-25..30 the model took the tool it named after 23% of 88 notes. In the
 * two A/Bs that followed (Sonnet 5.5 and Opus 5.5, 4 arms × 5 each, team
 * memory `census-10-30-tool-levers`) it took it 0 times in 17,
 * and without the note the Read/Grep/Glob share did not drop. The refusal in
 * refuse mode is another matter: it converted 84.7%, so it stays.
 */
export function isFileToolsNoteEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_FILE_TOOLS_NOTE)
}

export type BashRedirect = {
  /** The refusal in refuse mode, the note appended to the result in advise mode. */
  message: string
  /** validateInput's error code when refused. */
  errorCode: number
  /** The dedicated tool the message points at, when it points at one. */
  suggests?: string
}

/**
 * The first lane that claims the command, rendered for `mode`. Consumes that
 * lane's one-shot memo, so call it once per tool call.
 */
export function pickBashRedirect(
  input: Pick<BashToolInput, 'command' | 'run_in_background'>,
  hasTool: (name: string) => boolean,
  cwd: string,
  mode: BashRedirectMode,
): BashRedirect | null {
  if (input.run_in_background) return null
  const { command } = input
  const advise = mode === 'advise'

  const waitForLaneOn = advise
    ? !isEnvTruthy(process.env.CLAUDIN_DISABLE_WAITFOR_REDIRECT)
    : isEnvTruthy(process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT)
  if (waitForLaneOn && hasTool(WAITFOR_TOOL_NAME)) {
    const poll = detectSleepPoll(command)
    if (poll !== null && shouldRedirectSleepPoll(command)) {
      return {
        message: advise ? renderWaitForAdvice(poll) : renderWaitForRedirect(poll),
        errorCode: 16,
        suggests: WAITFOR_TOOL_NAME,
      }
    }
  }
  // `feature()` must sit directly in an if/ternary for the build preprocessor.
  if (feature('MONITOR_TOOL')) {
    if (!isBackgroundTasksDisabled) {
      const sleepPattern = detectBlockedSleepPattern(command)
      if (sleepPattern !== null) {
        return {
          message: advise
            ? renderBlockingSleepAdvice(sleepPattern, hasTool(WAITFOR_TOOL_NAME))
            : `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — you'll get a completion notification when done. For streaming events (watching logs, polling APIs), use the Monitor tool. If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
          errorCode: 10,
          ...(hasTool(WAITFOR_TOOL_NAME) && { suggests: WAITFOR_TOOL_NAME }),
        }
      }
    }
  }
  if (
    !isEnvTruthy(process.env.CLAUDIN_DISABLE_RUNTESTS_REDIRECT) &&
    hasTool(RUN_TESTS_TOOL_NAME) &&
    shouldRedirectToRunTests(command)
  ) {
    return {
      message: advise ? renderRunTestsAdvice(command) : renderRunTestsRedirect(command),
      errorCode: 11,
      suggests: RUN_TESTS_TOOL_NAME,
    }
  }
  // Narrowed to the pure checkers, so `go build`/`dotnet build`/`mvn` stay out.
  if (
    !isEnvTruthy(process.env.CLAUDIN_DISABLE_TYPECHECK_REDIRECT) &&
    hasTool(TYPECHECK_TOOL_NAME) &&
    shouldRedirectToTypecheck(command)
  ) {
    return {
      message: advise ? renderTypecheckAdvice(command) : renderTypecheckRedirect(command),
      errorCode: 13,
      suggests: TYPECHECK_TOOL_NAME,
    }
  }
  // Narrowed to the toolchains that print hundreds of progress lines, and never
  // a command that also installs, publishes or runs something.
  if (
    !isEnvTruthy(process.env.CLAUDIN_DISABLE_BUILD_REDIRECT) &&
    hasTool(BUILD_TOOL_NAME) &&
    shouldRedirectToBuild(command)
  ) {
    return {
      message: advise ? renderBuildAdvice(command) : renderBuildRedirect(command),
      errorCode: 15,
      suggests: BUILD_TOOL_NAME,
    }
  }
  // Repository READS only: a mutation runs fine through Git, and pointing at
  // it buys nothing.
  if (
    !isEnvTruthy(process.env.CLAUDIN_DISABLE_GIT_REDIRECT) &&
    hasTool(GIT_TOOL_NAME) &&
    shouldRedirectToGit(command)
  ) {
    return {
      message: advise ? renderGitAdvice(command) : renderGitRedirect(command),
      errorCode: 14,
      suggests: GIT_TOOL_NAME,
    }
  }
  // A command that only reads or searches files; all-or-nothing across a
  // compound command, and every target tool must be in this toolset. Advise
  // mode leaves the note out unless asked (`isFileToolsNoteEnabled`).
  if (!isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REDIRECT) && (!advise || isFileToolsNoteEnabled())) {
    const analysis = shouldRedirectToTools(command, cwd, hasTool)
    if (analysis) {
      return {
        message: advise ? renderFileToolsAdvice(analysis) : renderToolRedirect(analysis),
        errorCode: 12,
      }
    }
  }
  return null
}

/** The blocking-sleep lane's note: the sleep has already held the turn. */
function renderBlockingSleepAdvice(sleepPattern: string, hasWaitFor: boolean): string {
  const waitFor = hasWaitFor ? `, and to wait until something appears use ${WAITFOR_TOOL_NAME}` : ''
  return `That ${sleepPattern} held the turn while it slept. A command that takes a while belongs in run_in_background: true — you get a notification when it finishes. To follow output as it streams use Monitor${waitFor}.`
}

/**
 * Whether the file-reads note on `command` would only send the model to Read
 * again what this very call counted as read: every call it names is a
 * whole-file Read of a path in `creditedFiles`, the files the Bash read credit
 * registered for the call (CLAUDIN_BASH_READ_CREDIT, creditShownFiles.ts).
 * Asked by toolExecution once the call is back, which then drops the note.
 * With the credit off there are no paths, and every note stands.
 *
 * The note was rendered before the call ran; this runs the lane's analysis
 * again — pure, without its one-shot memo — rather than carry it across. No
 * earlier lane claims a command that analysis maps to Reads alone.
 *
 * A note made only of ranged Reads (`sed -n A,Bp f`) is moot when each one
 * lies inside a slice the credit registered (`creditedRanges`).
 */
export function isReadAdviceMoot(
  command: string,
  cwd: string,
  creditedFiles: readonly string[] | undefined,
  creditedRanges: readonly CreditedRange[] = [],
): boolean {
  if (!creditedFiles?.length && creditedRanges.length === 0) return false
  const analysis = analyzeCommandForRedirect(command, cwd)
  if (!analysis) return false
  const reads = wholeFileReadsOf(analysis)
  if (reads) {
    const credited = new Set((creditedFiles ?? []).map(path => resolve(path)))
    return reads.every(path => credited.has(resolve(path)))
  }
  const slices = rangedReadsOf(analysis)
  if (!slices) return false
  return slices.every(call =>
    creditedRanges.some(
      range =>
        resolve(range.path) === resolve(call.file_path) &&
        range.offset <= call.offset &&
        call.offset + call.limit <= range.offset + range.limit,
    ),
  )
}
