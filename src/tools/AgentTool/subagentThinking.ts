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

import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

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
