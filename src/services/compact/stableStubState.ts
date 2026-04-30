/**
 * Stable-stub tool_result compression.
 *
 * Anthropic prompt cache uses prefix matching: any byte change mid-sequence
 * invalidates the cache from that position onward. The earlier tiered
 * compressor (compressToolHistory) recomputed every turn — fine for stateless
 * shims, fatal for cached prefixes.
 *
 * Stable-stub strategy: maintain a per-session monotonic Set<string> of
 * clipped tool_use_ids. Once an id is in the set, the corresponding
 * tool_result content is ALWAYS rewritten to the same deterministic stub
 * bytes. After the first turn that adds an id, every subsequent turn produces
 * identical bytes for that block → prefix cache stays warm. Cache breaks ONCE
 * per "clip event", then stabilizes.
 *
 * Works on every provider: Anthropic native, Bedrock, Vertex, OpenAI shims,
 * Codex shim. Replaces the old compressToolHistory module.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { estimateImageTokens } from '../../utils/imageTokenEstimator.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'

const DOCUMENT_TOKEN_FALLBACK = 2000

const clippedIds = new Set<string>()

export function getClippedIds(): ReadonlySet<string> {
  return clippedIds
}

export function addClippedIds(ids: Iterable<string>): void {
  for (const id of ids) {
    clippedIds.add(id)
  }
}

export function resetClippedIds(): void {
  clippedIds.clear()
}

// Mirrors microCompact.calculateToolResultTokens but works on the loose
// tool_result shape that flows through both Anthropic-native and shim paths.
function estimateToolResultTokens(content: unknown): number {
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

// Round to a stable bucket so the stub label is deterministic across turns.
// Without rounding, equally-tokenized content might still differ by 1-2
// tokens between estimator runs (rare but possible on edge cases).
function roundTokens(n: number): number {
  if (n <= 0) return 0
  if (n < 100) return Math.max(1, Math.round(n / 10) * 10)
  if (n < 1000) return Math.round(n / 50) * 50
  return Math.round(n / 100) * 100
}

type ToolUseBlock = {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

type AnyContentBlock = {
  type?: string
  tool_use_id?: string
  [k: string]: unknown
}

type AnyMessage = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

function getInner(msg: AnyMessage): { role?: string; content?: unknown } {
  return msg.message ?? msg
}

function indexToolUses(messages: readonly AnyMessage[]): Map<string, string> {
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

/**
 * Build the deterministic stub string for a clipped tool_result.
 *
 * Format: `[clipped: ~N tokens from <toolName>]`
 *
 * CRITICAL: This must be byte-stable across turns for the same (id, content)
 * pair. Do NOT include timestamps, random values, or anything dynamic.
 */
export function buildClipStub(toolName: string, originalTokens: number): string {
  return `[clipped: ~${roundTokens(originalTokens)} tokens from ${toolName}]`
}

// Used to detect blocks already rewritten on a previous turn so applyStableStubs
// doesn't recompute the token count from the short stub itself (which would
// drift to a smaller number and break byte-stability).
const CLIP_STUB_PATTERN = /^\[clipped: ~\d+ tokens from .+\]$/

/**
 * Walk messages and rewrite every tool_result whose tool_use_id is in the
 * clipped-ids set. No-op when the set is empty (returns the input array
 * reference — callers may rely on this fast path).
 *
 * Trade-off: array-of-blocks tool_result content with image/document parts
 * collapses to a string stub, dropping the image bytes. Same trade-off as
 * the old compressToolHistory.
 */
export function applyStableStubs<T extends AnyMessage>(messages: T[]): T[] {
  if (clippedIds.size === 0) return messages

  const toolNames = indexToolUses(messages)

  return messages.map(msg => {
    const inner = getInner(msg)
    const content = inner.content
    if (!Array.isArray(content)) return msg

    let touched = false
    const newContent = (content as AnyContentBlock[]).map(block => {
      if (
        block?.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string' ||
        !clippedIds.has(block.tool_use_id)
      ) {
        return block
      }

      const existing = (block as ToolResultBlockParam).content
      // Idempotent: once a block carries the clipped-stub format, leave it
      // alone so subsequent calls produce byte-identical output even though
      // the stub string itself estimates to fewer tokens than the original.
      if (typeof existing === 'string' && CLIP_STUB_PATTERN.test(existing)) {
        return block
      }

      const stub = buildClipStub(
        toolNames.get(block.tool_use_id) ?? 'tool',
        estimateToolResultTokens(existing),
      )
      touched = true
      return { ...block, content: stub }
    })

    if (!touched) return msg

    if (msg.message) {
      return { ...msg, message: { ...msg.message, content: newContent } } as T
    }
    return { ...msg, content: newContent } as T
  })
}
