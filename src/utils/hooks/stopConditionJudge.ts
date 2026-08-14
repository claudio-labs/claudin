/**
 * Session-only marker identifying the /goal stop-condition judge hook.
 *
 * The judge gets different semantics in execPromptHook.ts (transcript-evidence
 * system prompt, required `reason`, `impossible` verdicts, blocking results
 * that do NOT prevent continuation). Those semantics must never leak onto
 * user-defined prompt Stop hooks from settings.json or agent/skill
 * frontmatter, so the judge is identified by hook IDENTITY, not by event.
 *
 * The marker is a symbol-keyed property: JSON parsing (settings.json,
 * frontmatter YAML→JSON) can never produce a symbol key, so the marker is
 * unforgeable from any persisted configuration and is non-serializable by
 * construction — consistent with how session-only FunctionHooks embed
 * non-persistable callbacks (see sessionHooks.ts). Only buildGoalHook
 * (src/utils/goal/goal.ts) sets it, on the in-memory session hook object,
 * which flows by reference through matching/dedup to execution.
 */
import type { PromptHook } from 'src/utils/settings/types.js'

const STOP_CONDITION_JUDGE_MARKER: unique symbol = Symbol(
  'claudin.stopConditionJudge',
)

/**
 * Brand an in-memory prompt hook as the /goal stop-condition judge.
 * Only buildGoalHook should call this.
 */
export function markStopConditionJudge(hook: PromptHook): PromptHook {
  return Object.assign(hook, { [STOP_CONDITION_JUDGE_MARKER]: true as const })
}

/** True when `hook` is a /goal judge branded by markStopConditionJudge. */
export function isStopConditionJudge(hook: unknown): boolean {
  return (
    typeof hook === 'object' &&
    hook !== null &&
    (hook as Record<symbol, unknown>)[STOP_CONDITION_JUDGE_MARKER] === true
  )
}
