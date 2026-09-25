import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import { getRuntimeMainLoopModel } from 'src/providers/model/model.js'

/**
 * The model one turn of the query loop calls.
 *
 * The main thread, and the internal forks that share its prompt cache
 * (compaction, memory extraction, session memory, suggestions), follow the
 * session: the app state, so a /model switch lands on the next turn, with the
 * opusplan/haiku plan-mode swaps applied.
 *
 * An agent spawned by runAgent — the only caller that sets `agentType` on its
 * context — calls the model runAgent resolved for it (getAgentModel: its
 * definition, the Agent tool's per-call `model`, an /agents override), which
 * its options.mainLoopModel carries. Until 2026-09-25 the loop read the app
 * state for these too, and a sub-agent's app state is its parent's: every
 * spawned agent ran on the parent's model while its system prompt named the
 * one it had been resolved to. The recorded sessions show the haiku-defined
 * WebResearcher on Opus; the Explore E2E showed its sonnet default and a
 * per-call `model: "haiku"` on Opus. A fork resolves to the parent's model
 * (getAgentModel's `inherit`, with the same plan-mode swap), so its
 * cache-sharing prefix is unchanged.
 */
export function selectTurnModel(params: {
  agentType: string | undefined
  agentModel: string
  sessionModel: string
  permissionMode: PermissionMode
  exceeds200kTokens: boolean
}): string {
  if (params.agentType !== undefined) return params.agentModel
  return getRuntimeMainLoopModel({
    permissionMode: params.permissionMode,
    mainLoopModel: params.sessionModel,
    exceeds200kTokens: params.exceeds200kTokens,
  })
}
