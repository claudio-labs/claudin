/**
 * /goal — session-scoped stopping condition.
 *
 * A goal registers a bare prompt-type Stop session hook (matcher '', no
 * skillRoot) whose prompt is the user's condition. Every time the assistant
 * tries to end its turn, the stop-condition judge (execPromptHook.ts)
 * evaluates the transcript against the condition:
 *   - ok:false            → the stop is blocked; the judge's reason is fed
 *                           back and the assistant keeps working
 *   - ok:true             → the goal auto-clears ("Goal achieved")
 *   - ok:false,impossible → the stop is allowed and the goal clears with an
 *                           "impossible" verdict
 *
 * State lives on AppState.activeGoal / AppState.lastGoalResult; the stop
 * pipeline (src/query/stopHooks.ts) drives iteration counting and the
 * one-time achievement notice.
 */
import type { ActiveGoalState, AppState } from 'src/state/AppStateStore.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getCurrentUsage } from 'src/utils/tokens.js'
import type { HookBlockingError, AggregatedHookResult } from 'src/utils/hooks/types.js'
import { addSessionHook, removeGoalStopHooks } from 'src/utils/hooks/sessionHooks.js'
import { markStopConditionJudge } from 'src/utils/hooks/stopConditionJudge.js'
import type { PromptHook } from 'src/utils/settings/types.js'

export const GOAL_MAX_CONDITION_LENGTH = 4000

/**
 * Judge timeout in seconds. The default prompt-hook timeout (30s) is too
 * tight for the judge on big transcripts (its budget is 50% of the evaluator
 * context window) — a timed-out judge is reported 'cancelled', which would
 * silently allow the stop while the footer still says "Goal active".
 */
export const GOAL_JUDGE_TIMEOUT_SECONDS = 120

/**
 * Iteration caps: maximum consecutive judge-blocked stops before the goal is
 * auto-cleared and the stop allowed. Without a cap, a never-satisfiable goal
 * loops forever — recoverable via ESC in interactive mode, but headless -p
 * has no escape hatch, hence the much lower non-interactive cap.
 */
export const GOAL_ITERATION_CAP_INTERACTIVE = 50
export const GOAL_ITERATION_CAP_NON_INTERACTIVE = 10

export function getGoalIterationCap(isNonInteractiveSession: boolean): number {
  return isNonInteractiveSession
    ? GOAL_ITERATION_CAP_NON_INTERACTIVE
    : GOAL_ITERATION_CAP_INTERACTIVE
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * Token figure shown next to an active goal: the sum of the latest API
 * response's usage (input + output + cache read + cache creation). This is the
 * same accounting the footer `ctx` pill and the Agents panel use, so the goal
 * line matches them. We deliberately do *not* report the cumulative session
 * sum here — that balloons into the millions because cache reads re-accrue on
 * every turn, which looks alarming and disagrees with every other token
 * surface in the UI.
 */
export function getGoalTokenCount(messages: Message[]): number {
  const usage = getCurrentUsage(messages)
  if (!usage) {
    return 0
  }
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  )
}

/**
 * The session hook registered for a goal condition. The judge marker is a
 * session-only symbol brand (see stopConditionJudge.ts) — it is what opts
 * this hook into judge semantics in execPromptHook.ts; user-defined prompt
 * Stop hooks can never carry it.
 */
export function buildGoalHook(condition: string): PromptHook {
  return markStopConditionJudge({
    type: 'prompt',
    prompt: condition,
    timeout: GOAL_JUDGE_TIMEOUT_SECONDS,
  })
}

/**
 * Directive injected into the conversation when a goal is set so the model
 * starts working immediately. Text is verbatim from upstream Claude Code.
 */
export function buildGoalDirective(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`
}

/**
 * Register a goal: replaces any previously registered bare prompt Stop hook
 * (only one goal can be active), registers the judge hook, and records
 * activeGoal state. The hook's onHookSuccess callback auto-clears the goal
 * when the judge returns ok:true or impossible:true.
 */
export function setActiveGoal(
  setAppState: SetAppState,
  sessionId: string,
  condition: string,
): void {
  // Replacing a goal overwrites the old one — remove the previous judge
  // hook so only one is registered.
  removeGoalStopHooks(setAppState, sessionId)

  const hook = buildGoalHook(condition)
  addSessionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    hook,
    (_succeededHook, result) =>
      onGoalJudgeSuccess(setAppState, sessionId, condition, result),
  )

  setAppState(prev => ({
    ...prev,
    activeGoal: {
      condition,
      iterations: 0,
      setAt: Date.now(),
    },
    lastGoalResult: undefined,
  }))
  logForDebugging(`Goal set for session ${sessionId}`)
}

/**
 * Invoked by the session-hook success callback when the judge allows the
 * stop (condition met, or judged impossible). Clears the hook + activeGoal
 * and records the outcome for the stop pipeline's one-time notice.
 */
function onGoalJudgeSuccess(
  setAppState: SetAppState,
  sessionId: string,
  condition: string,
  result: AggregatedHookResult,
): void {
  // Stale callback (goal already replaced or cleared) — must not touch the
  // currently registered hook. Read current state via the updater (the store
  // applies updaters synchronously).
  let isCurrent = false
  setAppState(prev => {
    isCurrent = prev.activeGoal?.condition === condition
    return prev
  })
  if (!isCurrent) {
    return
  }

  removeGoalStopHooks(setAppState, sessionId)
  setAppState(prev => {
    if (prev.activeGoal?.condition !== condition) {
      return prev
    }
    return {
      ...prev,
      activeGoal: undefined,
      lastGoalResult: {
        condition,
        reason: result.stopReason,
        impossible: result.impossible === true,
        at: Date.now(),
      },
    }
  })
  logForDebugging(
    `Goal ${result.impossible ? 'judged impossible' : 'achieved'} for session ${sessionId}`,
  )
}

/**
 * /goal clear — remove the judge hook(s) and clear activeGoal.
 * @returns true if there was anything to clear.
 */
export function clearActiveGoal(
  setAppState: SetAppState,
  sessionId: string,
): boolean {
  const removed = removeGoalStopHooks(setAppState, sessionId)
  let hadGoal = false
  setAppState(prev => {
    hadGoal = prev.activeGoal !== undefined
    if (!hadGoal) {
      return prev
    }
    return { ...prev, activeGoal: undefined }
  })
  return hadGoal || removed > 0
}

/**
 * Session-end reset: clear the goal app state (activeGoal + lastGoalResult)
 * without touching the hooks registry. Called from executeSessionEndHooks
 * (src/utils/hooks/events.ts) right where clearSessionHooks deletes the judge
 * hook — /clear and in-process /resume both end the outgoing session through
 * that path. Without this reset they orphan activeGoal: the footer keeps
 * showing "Goal active" in the new/resumed session and, with the judge hook
 * gone, every turn-end emits the "Goal check did not complete" warning.
 *
 * Hook deletion (clearSessionHooks) and this state reset are independent and
 * compose in either order; neither reads what the other clears.
 */
export function resetGoalStateForSessionEnd(setAppState: SetAppState): void {
  setAppState(prev => {
    if (prev.activeGoal === undefined && prev.lastGoalResult === undefined) {
      return prev
    }
    return { ...prev, activeGoal: undefined, lastGoalResult: undefined }
  })
}

/**
 * Stop pipeline (M3): true when a goal that was active before the Stop hooks
 * ran is still active afterwards, yet the judge produced neither a blocking
 * verdict nor a goal transition this turn — i.e. the judge run silently
 * failed (timed out or errored). Never warns when the turn was aborted: ESC
 * during a judge run cancels it deliberately (the judge yields nothing), and
 * that is user intent, not a judge failure.
 */
export function shouldWarnGoalCheckIncomplete(args: {
  goalBefore: Pick<ActiveGoalState, 'condition'> | undefined
  goalAfter: Pick<ActiveGoalState, 'condition'> | undefined
  goalJudgeBlocked: boolean
  aborted: boolean
}): boolean {
  if (!args.goalBefore || args.goalJudgeBlocked || args.aborted) {
    return false
  }
  return args.goalAfter?.condition === args.goalBefore.condition
}

/**
 * Extract the judge's reason from a goal blocking error of the form
 * `[<condition>]: <reason>` (see execPromptHook.ts).
 */
export function extractGoalReason(
  blockingErrorText: string,
  condition: string,
): string | undefined {
  const prefix = `[${condition}]: `
  return blockingErrorText.startsWith(prefix)
    ? blockingErrorText.slice(prefix.length)
    : undefined
}

/** Outcome of feeding a Stop-hook blocking error to the goal tracker. */
export type GoalBlockOutcome =
  /** The blocking error did not belong to the active goal's judge. */
  | { kind: 'not-goal' }
  /** Iteration counted; the block proceeds (model keeps working). */
  | { kind: 'counted'; iterations: number }
  /**
   * The iteration cap was reached: the goal has been cleared, the block must
   * be suppressed so the stop is allowed, and `reason` is the judge's last
   * check for the user-facing notice.
   */
  | { kind: 'cap-reached'; cap: number; reason: string }

/**
 * Stop pipeline: a Stop hook produced a blocking error. If it came from the
 * active goal's judge, count the iteration and record the reason as the
 * goal's last check. When the iteration count reaches the cap (M2: a
 * never-satisfiable goal must not loop forever — especially in headless -p,
 * which has no ESC), the goal is auto-cleared and the caller must allow the
 * stop.
 */
export function handleGoalBlockingError(
  setAppState: SetAppState,
  sessionId: string,
  goalCondition: string,
  blockingError: HookBlockingError,
  isNonInteractiveSession: boolean,
): GoalBlockOutcome {
  if (blockingError.command !== goalCondition) {
    return { kind: 'not-goal' }
  }
  const reason =
    extractGoalReason(blockingError.blockingError, goalCondition) ??
    blockingError.blockingError
  let iterations: number | undefined
  setAppState(prev => {
    if (prev.activeGoal?.condition !== goalCondition) {
      return prev
    }
    iterations = prev.activeGoal.iterations + 1
    return {
      ...prev,
      activeGoal: {
        ...prev.activeGoal,
        iterations,
        lastCheckReason: reason,
      },
    }
  })
  if (iterations === undefined) {
    // activeGoal no longer matches the condition — treat as not ours.
    return { kind: 'not-goal' }
  }

  const cap = getGoalIterationCap(isNonInteractiveSession)
  if (iterations >= cap) {
    clearActiveGoal(setAppState, sessionId)
    logForDebugging(
      `Goal iteration cap (${cap}) reached for session ${sessionId} — goal cleared`,
    )
    return { kind: 'cap-reached', cap, reason }
  }
  return { kind: 'counted', iterations }
}
