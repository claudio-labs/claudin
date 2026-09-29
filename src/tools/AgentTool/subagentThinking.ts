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
// The effort a sub-agent inherits is capped at `high` — on by default since
// 2026-09-29. A sub-agent's thinking is not only billed as output: every token
// of it stays in the context and is re-read by each later call, and fresh Code
// agents make 100-200 of them (census 2026-09-26..28: output tokens are ~46% of
// a sub-agent's final context, under a project pinned at xhigh). On a real
// rewrite unit with the parent at xhigh, the cap cost 24% less than the
// inherited effort, ranges disjoint from base and placebo, thinking -48%, same
// deliverable (`scripts/bench/ab/subagent-unit-ab.ts`). It only bites below a
// parent pinned above `high`: the Opus 5.5 default is `medium`.
//
// CLAUDIN_SUBAGENT_EFFORT_CAP=off restores the inherited effort; a level
// (low|medium|high|xhigh|max) moves the cap. A fork keeps the parent's effort,
// an agent definition that sets `effort` keeps its own, and CLAUDIN_EFFORT_LEVEL
// still pins every request.

import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import {
  EFFORT_LEVELS,
  isEffortLevel,
  type EffortLevel,
  type EffortValue,
} from 'src/providers/effort/effort.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'

const DEFAULT_SUBAGENT_EFFORT_CAP: EffortLevel = 'high'

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

/** The cap from CLAUDIN_SUBAGENT_EFFORT_CAP: unset or not a level is the
 * default, `off` (or 0/false/no) is none. */
function subagentEffortCap(): EffortLevel | null {
  const raw = process.env.CLAUDIN_SUBAGENT_EFFORT_CAP?.toLowerCase().trim()
  if (!raw) return DEFAULT_SUBAGENT_EFFORT_CAP
  if (raw === 'off' || isEnvDefinedFalsy(raw)) return null
  return isEffortLevel(raw) ? raw : DEFAULT_SUBAGENT_EFFORT_CAP
}

/**
 * The effort a non-fork sub-agent runs at: the parent's, lowered to the cap
 * when both are named levels and the parent's is above it. Adaptive, numeric
 * and unset parents pass through unchanged.
 */
export function subagentEffort(
  parent: EffortValue | undefined,
  { useExactTools }: { useExactTools: boolean },
): EffortValue | undefined {
  if (useExactTools) return parent
  const cap = subagentEffortCap()
  if (cap === null) return parent
  if (typeof parent !== 'string' || !isEffortLevel(parent)) return parent
  return EFFORT_LEVELS.indexOf(parent) > EFFORT_LEVELS.indexOf(cap) ? cap : parent
}
