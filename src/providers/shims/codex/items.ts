/**
 * Responses API item state carried on Anthropic content blocks, so a Codex
 * session can send each item back the way the Codex CLI does.
 *
 * The Codex backend answers with items (`reasoning`, `message`,
 * `function_call`), and Codex CLI 0.162.1 replays every one of them, under the
 * id the backend gave it, in the `input` of each later request: in the same
 * turn, in the next one and after a resume (mitmproxy capture, 2026-10-16).
 * Claudin's history is Anthropic content blocks, so the state rides on the
 * block each item becomes, under one `codex` field:
 *
 *   reasoning      → a `thinking` block, empty text, `codex: { id, encrypted_content }`
 *   message        → its text block, `codex: { id, phase }`
 *   function_call  → its tool_use block (id stays the call_id), `codex: { id }`
 *
 * Only the Codex backend reads it (codexShim's replay). Every other provider
 * gets it redacted by stripCodexItems, so the field and the encrypted payload
 * never reach a wire they do not belong on.
 */
import type { AssistantMessage, UserMessage } from 'src/shared/types/message.js'

export type CodexItemState = {
  /** The id the backend gave the item: rs_…, msg_…, fc_…. */
  id: string
  /** A reasoning item's opaque payload, readable only by the backend. */
  encrypted_content?: string
  /** A message's phase: `commentary` before a tool call, `final_answer` at the end. */
  phase?: string
}

export type CodexReasoningInputItem = {
  type: 'reasoning'
  id: string
  summary: []
  encrypted_content: string
}

type Block = Record<string, unknown>

const isRecord = (value: unknown): value is Block =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Which reasoning items the backend can still decrypt: every one, until it
// refuses one (a payload from another ChatGPT account no longer decrypts).
// From then on, in this process, only the items captured after the refusal.
// The history keeps the refused items and the thinking-strip retry covers a
// single request, so without this every later request would fail first.
let refusedEarlierItems = false
const capturedSinceRefusal = new Set<string>()

/** The backend refused a replayed reasoning item: stop sending the ones captured before. */
export function noteReplayRefused(): void {
  refusedEarlierItems = true
  capturedSinceRefusal.clear()
}

export function _resetReplayTrustForTesting(): void {
  refusedEarlierItems = false
  capturedSinceRefusal.clear()
}

/** The Codex item state a block carries, if it carries a well-formed one. */
export function codexStateOf(block: unknown): CodexItemState | undefined {
  if (!isRecord(block) || !isRecord(block.codex)) return undefined
  const { id, encrypted_content, phase } = block.codex
  if (typeof id !== 'string') return undefined
  return {
    id,
    ...(typeof encrypted_content === 'string' && { encrypted_content }),
    ...(typeof phase === 'string' && { phase }),
  }
}

function hasCodexField(block: unknown): boolean {
  return isRecord(block) && 'codex' in block
}

/** A thinking block that stands for a Codex reasoning item. */
export function isCodexReasoningBlock(block: unknown): boolean {
  return isRecord(block) && block.type === 'thinking' && hasCodexField(block)
}

/** The thinking block a `reasoning` output item becomes, or undefined when it has nothing to replay. */
export function reasoningBlockFor(item: Block): Block | undefined {
  if (typeof item.id !== 'string' || typeof item.encrypted_content !== 'string') return undefined
  if (refusedEarlierItems) capturedSinceRefusal.add(item.id)
  return {
    type: 'thinking',
    thinking: '',
    signature: '',
    codex: { id: item.id, encrypted_content: item.encrypted_content },
  }
}

/** The state the text block of a `message` output item keeps. */
export function messageStateFor(item: Block): CodexItemState | undefined {
  if (typeof item.id !== 'string') return undefined
  return { id: item.id, ...(typeof item.phase === 'string' && { phase: item.phase }) }
}

/** The state the tool_use block of a `function_call` output item keeps. */
export function callStateFor(item: Block): CodexItemState | undefined {
  return typeof item.id === 'string' ? { id: item.id } : undefined
}

/** The `reasoning` input item a thinking block replays as, or undefined for any other block. */
export function reasoningItemFor(block: unknown): CodexReasoningInputItem | undefined {
  if (!isRecord(block) || block.type !== 'thinking') return undefined
  const state = codexStateOf(block)
  if (!state?.encrypted_content) return undefined
  if (refusedEarlierItems && !capturedSinceRefusal.has(state.id)) return undefined
  return { type: 'reasoning', id: state.id, summary: [], encrypted_content: state.encrypted_content }
}

/**
 * The messages with every trace of Codex item state removed, for any provider
 * other than the Codex backend: the thinking blocks that stand for reasoning
 * items go, and the `codex` field leaves every other block. An assistant
 * message left with nothing but thinking gets the placeholder
 * stripOldThinkingBlocks uses, so no empty turn reaches an API.
 *
 * Returns the input array itself when no block carries state, so a history
 * that never touched Codex renders exactly as before.
 */
export function stripCodexItems<M extends UserMessage | AssistantMessage>(messages: M[]): M[] {
  let changed = false
  const result = messages.map(msg => {
    if (msg.type !== 'assistant' || !Array.isArray(msg.message.content)) return msg
    const content = msg.message.content as unknown as Block[]
    if (!content.some(hasCodexField)) return msg
    changed = true
    const kept = content
      .filter(block => !isCodexReasoningBlock(block))
      .map(block => {
        if (!hasCodexField(block)) return block
        const { codex: _codex, ...rest } = block
        return rest
      })
    if (!kept.some(block => block.type !== 'thinking' && block.type !== 'redacted_thinking')) {
      kept.push({ type: 'text', text: '[thinking omitted]', citations: [] })
    }
    return { ...msg, message: { ...msg.message, content: kept } }
  })
  return changed ? (result as M[]) : messages
}
