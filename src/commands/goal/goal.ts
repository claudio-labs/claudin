import { getSessionId } from 'src/bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import type { ToolUseContext } from 'src/Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from 'src/types/command.js'
import { formatDuration } from 'src/utils/text/format.js'
import {
  buildGoalDirective,
  clearActiveGoal,
  GOAL_MAX_CONDITION_LENGTH,
  getGoalTokenCount,
  setActiveGoal,
} from 'src/services/goal/goal.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from 'src/services/lifecycleHooks/hooksConfigSnapshot.js'
import { shouldSkipHookDueToTrust } from 'src/services/lifecycleHooks/shared.js'

const USAGE = [
  'No active goal.',
  '',
  'Usage:',
  '  /goal <condition>   Set a stopping condition. Every time the assistant tries to stop, an LLM judge checks the transcript against the condition and blocks the stop until it holds. The goal auto-clears once met.',
  '  /goal clear         Clear the active goal early.',
  '  /goal               Show the active goal status.',
].join('\n')

/**
 * Parse /goal arguments. Exported for tests.
 */
export function parseGoalArgs(
  args: string,
):
  | { kind: 'status' }
  | { kind: 'clear' }
  | { kind: 'too-long'; length: number }
  | { kind: 'set'; condition: string } {
  const trimmed = args.trim()
  if (!trimmed) {
    return { kind: 'status' }
  }
  if (trimmed === 'clear') {
    return { kind: 'clear' }
  }
  if (trimmed.length > GOAL_MAX_CONDITION_LENGTH) {
    return { kind: 'too-long', length: trimmed.length }
  }
  return { kind: 'set', condition: trimmed }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const parsed = parseGoalArgs(args)
  const sessionId = getSessionId()

  switch (parsed.kind) {
    case 'status': {
      const goal = context.getAppState().activeGoal
      if (!goal) {
        onDone(USAGE, { display: 'system' })
        return null
      }
      const elapsed = formatDuration(Date.now() - goal.setAt)
      const tokensUsed = getGoalTokenCount(context.messages)
      const lines = [
        `Goal active: ${goal.condition}`,
        `Iterations: ${goal.iterations} · Elapsed: ${elapsed} · Tokens: ${tokensUsed.toLocaleString()}`,
        ...(goal.lastCheckReason ? [`Last check: ${goal.lastCheckReason}`] : []),
        '/goal clear to stop early',
      ]
      onDone(lines.join('\n'), { display: 'system' })
      return null
    }

    case 'clear': {
      const cleared = clearActiveGoal(context.setAppState, sessionId)
      logEvent('tengu_goal_clear', {
        had_goal: String(
          cleared,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      onDone(cleared ? 'Goal cleared.' : 'No active goal to clear.', {
        display: 'system',
      })
      return null
    }

    case 'too-long': {
      onDone(
        `Goal condition is too long (${parsed.length} characters). Maximum is ${GOAL_MAX_CONDITION_LENGTH}.`,
        { display: 'system' },
      )
      return null
    }

    case 'set': {
      // Goals are session Stop hooks — refuse when hooks are restricted by
      // policy or the workspace hasn't been trusted (the hook would silently
      // never run, making the goal a no-op).
      if (shouldDisableAllHooksIncludingManaged()) {
        onDone(
          'Cannot set a goal: all hooks are disabled by managed policy settings (disableAllHooks).',
          { display: 'system' },
        )
        return null
      }
      if (shouldAllowManagedHooksOnly()) {
        onDone(
          'Cannot set a goal: only managed hooks are allowed by policy settings, and goals require a session-scoped Stop hook.',
          { display: 'system' },
        )
        return null
      }
      if (shouldSkipHookDueToTrust()) {
        onDone(
          'Cannot set a goal: workspace trust has not been accepted, so hooks (including the goal judge) will not run.',
          { display: 'system' },
        )
        return null
      }

      const isReplacing = context.getAppState().activeGoal !== undefined
      setActiveGoal(context.setAppState, sessionId, parsed.condition)
      logEvent('tengu_goal_set', {
        replaced: String(
          isReplacing,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        condition_length: parsed.condition.length,
      })
      onDone(
        `${isReplacing ? 'Goal replaced' : 'Goal set'}: ${parsed.condition}\nThe assistant will keep working until the condition is met. /goal clear to stop early.`,
        {
          display: 'system',
          shouldQuery: true,
          metaMessages: [buildGoalDirective(parsed.condition)],
        },
      )
      return null
    }
  }
}
