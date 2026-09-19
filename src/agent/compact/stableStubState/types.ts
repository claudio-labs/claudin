import { estimateImageTokens } from 'src/agent/context/imageTokenEstimator.js'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'

const DOCUMENT_TOKEN_FALLBACK = 2000

// Mirrors microCompact.calculateToolResultTokens but works on the loose
// tool_result shape that flows through both Anthropic-native and shim paths.
export function estimateToolResultTokens(content: unknown): number {
  if (content == null) return 0
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const item of content as Array<{
    type?: string
    text?: string
    source?: unknown
  }>) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'text' && typeof item.text === 'string') {
      total += roughTokenCountEstimation(item.text)
    } else if (item.type === 'image' && item.source) {
      total += estimateImageTokens(item.source as Parameters<typeof estimateImageTokens>[0])
    } else if (item.type === 'document') {
      total += DOCUMENT_TOKEN_FALLBACK
    }
  }
  return total
}

export type ToolUseBlock = {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

export type AnyContentBlock = {
  type?: string
  tool_use_id?: string
  [k: string]: unknown
}

export type AnyMessage = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
  // Every declared member is optional, which would make this a "weak type":
  // TypeScript then rejects any argument that shares none of these three keys,
  // so `Message` (a union whose `AttachmentMessage` arm has none of them) is
  // not assignable and `applyStableStubs(messages)` fails to infer `T`. The
  // index signature is what makes the structural check pass — the same shape
  // `AnyContentBlock` above already uses.
  [k: string]: unknown
}

export function getInner(msg: AnyMessage): { role?: string; content?: unknown } {
  return msg.message ?? msg
}

export function indexToolUses(messages: readonly AnyMessage[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const msg of messages) {
    const inner = getInner(msg)
    const role = inner.role ?? msg.role
    if (role !== 'assistant') continue
    const content = inner.content
    if (!Array.isArray(content)) continue
    for (const block of content as ToolUseBlock[]) {
      if (block?.type === 'tool_use' && block.id) {
        out.set(block.id, block.name ?? 'tool')
      }
    }
  }
  return out
}
