import { APIUserAbortError } from '@anthropic-ai/sdk/error'
import type { Tools } from 'src/Tool.js'
import type { AssistantMessage, Message } from 'src/types/message.js'
import type { SystemPrompt } from 'src/agent/systemPromptType.js'
import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import { withStreamingVCR } from 'src/services/vcr.js'
import { queryModel } from 'src/services/api/claude/streaming.js'
import type { Options } from 'src/services/api/claude/types.js'

export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // Store the assistant message but continue consuming the generator to ensure
  // logAPISuccessAndDuration gets called (which happens after all yields)
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // If the signal was aborted, throw APIUserAbortError instead of a generic error
    // This allows callers to handle abort scenarios gracefully
    if (signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}
