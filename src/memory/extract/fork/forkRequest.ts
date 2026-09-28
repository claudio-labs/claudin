/**
 * The one request an extraction makes of the forked-agent runner.
 *
 * The fork replays the parent's system prompt, contexts, tools and messages
 * exactly as they came, so its first request reads the parent's prompt
 * cache. Nothing is overridden, the model included.
 */
import type { ForkedAgentParams } from 'src/agent/coordinator/forkedAgent.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'

/** Query source and fork label. The Claude shim keeps this source on the parent's 1-hour cache TTL. */
const EXTRACTION_QUERY_SOURCE = 'extract_memories'

/** A reading turn and a writing turn, with room to recover from a refused call. */
const EXTRACTION_MAX_TURNS = 5

/**
 * Exactly the fields an extraction sets. The rest stay unset on purpose: an
 * output cap would change the thinking budget and with it the cache key, and
 * the fork's messages are not worth a sidechain transcript.
 */
export type ExtractionForkRequest = Required<
  Pick<
    ForkedAgentParams,
    | 'promptMessages'
    | 'cacheSafeParams'
    | 'canUseTool'
    | 'querySource'
    | 'forkLabel'
    | 'skipTranscript'
    | 'maxTurns'
  >
>

export function buildExtractionForkRequest(
  context: REPLHookContext,
  prompt: string,
  canUseTool: CanUseToolFn,
): ExtractionForkRequest {
  const { messages, systemPrompt, userContext, systemContext, toolUseContext } = context
  return {
    promptMessages: [createUserMessage({ content: prompt })],
    cacheSafeParams: { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: messages },
    canUseTool,
    querySource: EXTRACTION_QUERY_SOURCE,
    forkLabel: EXTRACTION_QUERY_SOURCE,
    skipTranscript: true,
    maxTurns: EXTRACTION_MAX_TURNS,
  }
}
