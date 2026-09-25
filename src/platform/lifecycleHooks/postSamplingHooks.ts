import type { QuerySource } from 'src/agent/prompts/querySource.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'
import type { SystemPrompt } from 'src/agent/systemPromptType.js'

// Generic context for REPL hooks (both post-sampling and stop hooks)
export type REPLHookContext = {
  messages: Message[] // Full message history including assistant responses
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}
