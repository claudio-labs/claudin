// The thinking config a spawned sub-agent runs with.
//
// A fork (useExactTools) takes the parent's as it is: its requests must match
// the parent's prefix to read the parent's cache.
//
// Every other sub-agent used to run with thinking off "to control output token
// costs", which sends no `thinking` field at all. The Claude 5 family thinks
// anyway: the transcripts of Opus 5.5 sub-agents hold thinking blocks, spent at
// the server's default and returned as display "omitted" — nothing was saved,
// and the agent's progress updates never came back (session 9814f902,
// 2026-09-25). So a sub-agent on a model with effort now inherits the parent's
// config, as Claude Code does: adaptive thinking bounded by the agent's effort,
// shown under the session's display. On a model without effort, thinking stays
// off, and there off really is off.
//
// CLAUDIN_DISABLE_SUBAGENT_THINKING=1 turns thinking back off for every
// sub-agent that is not a fork.
//
// A sub-agent runs one effort level below its parent when the parent's is
// raised above its model's default — max → xhigh, xhigh → high, and on Opus 5.5
// (default medium) high → medium — and at the parent's otherwise, so a session
// that never raised its effort sees no change. On since 2026-09-29. A
// sub-agent's thinking is not only billed as output: every token of it stays in
// the context and is re-read by each later call, and fresh Code agents make
// 100-200 of them (census 2026-09-26..28: output tokens are ~46% of a
// sub-agent's final context, under a project pinned at xhigh). On a real
// rewrite unit with the parent at xhigh, running the sub-agent at high cost 24%
// less, ranges disjoint from base and placebo, thinking -48%, same deliverable
// (`scripts/bench/ab/subagent-unit-ab.ts`).
//
// CLAUDIN_SUBAGENT_EFFORT_STEP_DOWN=0 restores plain inheritance. A fork keeps
// the parent's effort, an agent definition that sets `effort` keeps its own,
// and CLAUDIN_EFFORT_LEVEL still pins every request.

import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import {
  EFFORT_LEVELS,
  isEffortLevel,
  type EffortValue,
} from 'src/providers/effort/effort.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'

export function subagentThinkingConfig(
  parent: ThinkingConfig,
  {
    useExactTools,
    modelSupportsEffort,
  }: { useExactTools: boolean; modelSupportsEffort: boolean },
): ThinkingConfig {
  if (useExactTools) return parent
  if (
    modelSupportsEffort &&
    !isEnvTruthy(process.env.CLAUDIN_DISABLE_SUBAGENT_THINKING)
  ) {
    return parent
  }
  return { type: 'disabled' }
}

/**
 * The effort a non-fork sub-agent runs at: one level below the parent's when
 * that is above `parentDefault` (the default of the parent's model), else the
 * parent's. Never lands below the default. Adaptive, numeric and unset parents,
 * and a model whose default is not a named level, pass through unchanged.
 */
export function subagentEffort(
  parent: EffortValue | undefined,
  {
    useExactTools,
    parentDefault,
  }: { useExactTools: boolean; parentDefault: EffortValue | undefined },
): EffortValue | undefined {
  if (useExactTools) return parent
  if (isEnvDefinedFalsy(process.env.CLAUDIN_SUBAGENT_EFFORT_STEP_DOWN)) return parent
  if (typeof parent !== 'string' || !isEffortLevel(parent)) return parent
  if (typeof parentDefault !== 'string' || !isEffortLevel(parentDefault)) return parent
  const at = EFFORT_LEVELS.indexOf(parent)
  return at > EFFORT_LEVELS.indexOf(parentDefault) ? EFFORT_LEVELS[at - 1]! : parent
}
