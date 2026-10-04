/**
 * The single user turn the explainer sends. Pure: it reads only its arguments.
 */
import type { AssistantMessage, Message } from 'src/shared/types/message.js'

/** Characters of the agent's own recent text that may travel with the question. */
export const CONTEXT_BUDGET = 1000

/** How many of the latest assistant turns are considered for context. */
const CONTEXT_TURNS = 3

const CUT_MARK = '...'

const CLOSING_ASK = 'Explain this command in context.'

export function formatToolInput(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    // bigint and cyclic values have no JSON form.
    return String(input)
  }
}

function isAssistantTurn(message: Message): message is AssistantMessage {
  return message.type === 'assistant'
}

function textOf(turn: AssistantMessage): string {
  const texts: string[] = []
  for (const block of turn.message.content) {
    if (block.type === 'text') texts.push(block.text)
  }
  return texts.join(' ')
}

/**
 * The agent's latest words, oldest first. The budget is spent from the newest
 * turn backwards so the turn closest to the command survives a cut.
 */
export function conversationContext(messages: readonly Message[], budget = CONTEXT_BUDGET): string {
  const texts = messages
    .filter(isAssistantTurn)
    .slice(-CONTEXT_TURNS)
    .map(textOf)
    .filter(text => text !== '')

  const kept: string[] = []
  let left = budget
  for (let i = texts.length - 1; i >= 0 && left > 0; i--) {
    const text = texts[i]!
    if (text.length <= left) {
      kept.unshift(text)
      left -= text.length
    } else {
      kept.unshift(text.slice(0, left) + CUT_MARK)
      left = 0
    }
  }
  return kept.join('\n\n')
}

export type ExplainerPromptInput = {
  toolName: string
  toolInput: unknown
  toolDescription?: string
  messages?: readonly Message[]
}

export function buildExplainerPrompt({ toolName, toolInput, toolDescription, messages }: ExplainerPromptInput): string {
  const head = [`Tool: ${toolName}`]
  if (toolDescription) head.push(`Description: ${toolDescription}`)
  head.push('Input:', formatToolInput(toolInput))

  const sections = [head.join('\n')]
  const context = conversationContext(messages ?? [])
  if (context) sections.push(`Recent conversation context:\n${context}`)
  sections.push(CLOSING_ASK)
  return sections.join('\n\n')
}
