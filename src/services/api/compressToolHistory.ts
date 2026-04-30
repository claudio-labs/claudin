/**
 * Compresses old tool_result content for stateless OpenAI-compatible providers
 * (Copilot, Mistral, Ollama). Preserves all conversation structure — tool_use,
 * tool_result pairing, text, thinking, and is_error all survive intact. Only
 * the BULK text of older tool_results is shrunk to delay context saturation.
 *
 * Tier sizes scale with the model's effective context window via
 * getEffectiveContextWindowSize() — same calculation used by auto-compact, so
 * the two systems stay aligned.
 *
 * Complements (does not replace) microCompact.ts:
 * - microCompact: time/cache-based, runs from query.ts, binary clear/keep,
 *   limited to Claude (cache editing) or idle gaps (time-based).
 * - compressToolHistory: size-based, runs at the shim layer, tiered
 *   compression, covers the gap for active sessions on non-Claude providers.
 *
 * Reuses isCompactableTool from microCompact to avoid touching tools the
 * project already classifies as unsafe to compress (e.g. Task, Agent).
 * Skips blocks already cleared by microCompact (TOOL_RESULT_CLEARED_MESSAGE).
 *
 * Anthropic native bypasses both shims, so it is unaffected by this module.
 */
import { getEffectiveContextWindowSize } from '../compact/autoCompact.js'
import { isCompactableTool } from '../compact/microCompact.js'
import { TOOL_RESULT_CLEARED_MESSAGE } from '../../utils/toolResultStorage.js'
import { getGlobalConfig } from '../../utils/config.js'

// Mid-tier truncation budget. 2k chars ≈ 500 tokens, enough to preserve the
// shape of most tool outputs (file headers, command stderr, top grep hits)
// without ballooning context. Bump too high and the tier loses its purpose.
const MID_MAX_CHARS = 2_000

// Stub args budget. JSON.stringify of a typical tool input fits in 200 chars
// (file paths, short commands, small queries). Long inputs are rare and clamping
// here keeps the stub size bounded even when callers pass oversized arguments.
const STUB_ARGS_MAX_CHARS = 200

type AnyMessage = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

type ToolUseBlock = {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

type Tiers = { recent: number; mid: number }

// Tier sizes scale with effective window. Targets roughly:
// - recent tier stays under ~25% of available window (full fidelity kept)
// - recent + mid tier stays under ~50% of available window (bounded bulk)
// - everything older collapses to ~15-token stubs
// Values assume ~5KB avg tool_result, which matches the Copilot default case
// (parallel_tool_calls=true means multiple Read/Bash outputs per turn). For
// ≥ 500k models the tiers are so generous that compression is effectively
// inert for any realistic session — see compressToolHistory.test.ts.
export function getTiers(effectiveWindow: number): Tiers {
  if (effectiveWindow < 16_000) return { recent: 2, mid: 3 }
  if (effectiveWindow < 32_000) return { recent: 3, mid: 5 }
  if (effectiveWindow < 64_000) return { recent: 4, mid: 8 }
  if (effectiveWindow < 128_000) return { recent: 5, mid: 10 }
  if (effectiveWindow < 256_000) return { recent: 8, mid: 15 }
  if (effectiveWindow < 500_000) return { recent: 12, mid: 25 }
  return { recent: 25, mid: 50 }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b: { type?: string; text?: string }) =>
          b?.type === 'text' && typeof b.text === 'string',
      )
      .map((b: { text?: string }) => b.text ?? '')
      .join('\n')
  }
  return ''
}

// Old-tier compression strategy. Replaces content entirely with a one-line
// metadata marker ~10× more token-efficient than a 500-char truncation AND
// unambiguous — partial truncations can look authoritative to the model. The
// stub format encodes tool name + args so the model can re-invoke the same
// tool if it needs the omitted output back.
function buildStub(
  block: ToolResultBlock,
  toolUsesById: Map<string, ToolUseBlock>,
): ToolResultBlock {
  const original = extractText(block.content)
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  const name = toolUse?.name ?? 'tool'
  const args = toolUse?.input
    ? JSON.stringify(toolUse.input).slice(0, STUB_ARGS_MAX_CHARS)
    : '{}'
  return {
    ...block,
    content: [
      {
        type: 'text',
        text: `[${name} args=${args} → ${original.length} chars omitted]`,
      },
    ],
  }
}

// Mid-tier compression. The trailing marker is load-bearing: without it, the
// model can't distinguish "tool returned 2000 chars" from "tool returned 20k
// chars that we cut to 2000". Distinguishing those matters for the model's
// decision to re-invoke the tool.
function truncateBlock(
  block: ToolResultBlock,
  maxChars: number,
): ToolResultBlock {
  const text = extractText(block.content)
  if (text.length <= maxChars) return block
  const omitted = text.length - maxChars
  return {
    ...block,
    content: [
      {
        type: 'text',
        text: `${text.slice(0, maxChars)}\n[…truncated ${omitted} chars from tool history]`,
      },
    ],
  }
}

function getInner(msg: AnyMessage): { role?: string; content?: unknown } {
  return (msg.message ?? msg) as { role?: string; content?: unknown }
}

function indexToolUses(messages: AnyMessage[]): Map<string, ToolUseBlock> {
  const map = new Map<string, ToolUseBlock>()
  for (const msg of messages) {
    const content = getInner(msg).content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<{ type?: string; id?: string }>) {
      if (b?.type === 'tool_use' && b.id) {
        map.set(b.id, b as ToolUseBlock)
      }
    }
  }
  return map
}

// `toolUseCount` lets the caller cheaply detect "no orphans possible" via
// `toolUseCount === resultIds.size`, skipping collectOrphanInputIds on the
// fast path (paired-tool sessions).
function scanToolResults(messages: AnyMessage[]): {
  indices: number[]
  resultIds: Set<string>
  toolUseCount: number
} {
  const indices: number[] = []
  const resultIds = new Set<string>()
  let toolUseCount = 0
  for (let i = 0; i < messages.length; i++) {
    const inner = getInner(messages[i])
    const role = inner.role ?? messages[i].role
    const content = inner.content
    if (!Array.isArray(content)) continue
    if (role === 'assistant') {
      for (const b of content as Array<{ type?: string }>) {
        if (b?.type === 'tool_use') toolUseCount++
      }
      continue
    }
    if (role !== 'user') continue
    let sawToolResult = false
    for (const b of content as Array<{ type?: string; tool_use_id?: string }>) {
      if (b?.type !== 'tool_result') continue
      sawToolResult = true
      if (b.tool_use_id) resultIds.add(b.tool_use_id)
    }
    if (sawToolResult) indices.push(i)
  }
  return { indices, resultIds, toolUseCount }
}

function rewriteMessage<T extends AnyMessage>(
  msg: T,
  newContent: unknown[],
): T {
  if (msg.message) {
    return { ...msg, message: { ...msg.message, content: newContent } }
  }
  return { ...msg, content: newContent }
}

// microCompact.maybeTimeBasedMicrocompact may have already replaced old
// tool_result content with TOOL_RESULT_CLEARED_MESSAGE before we see it.
// Re-compressing produces a stub over a marker (e.g. `[Read args={} → 40
// chars omitted]`), wasteful and less informative than the canonical marker.
function isAlreadyCleared(block: ToolResultBlock): boolean {
  const text = extractText(block.content)
  return text === TOOL_RESULT_CLEARED_MESSAGE
}

function shouldCompressBlock(
  block: ToolResultBlock,
  toolUsesById: Map<string, ToolUseBlock>,
): boolean {
  if (isAlreadyCleared(block)) return false
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  // Unknown tool name (orphan tool_result with no matching tool_use) falls
  // through to compression with a generic "tool" stub. Safer default: the
  // original tool_use vanished so there's no downstream use for the output.
  if (!toolUse?.name) return true
  // Respect microCompact's curated safe-to-compress set (Read/Bash/Grep/…/
  // mcp__*) so user-facing flow tools (Task, Agent, custom) stay intact.
  return isCompactableTool(toolUse.name)
}

// Looser sibling of shouldCompressBlock used purely for the input-stub
// decision. We DO want to stub bulky tool_use.input even when the paired
// tool_result has already been collapsed by microCompact (TOOL_RESULT_CLEARED_
// MESSAGE) — the output marker stays untouched, only the bulky input
// (think Edit `new_string`, Write `content`) gets dropped. The compactable
// allowlist still wins so Task/Agent inputs are never stubbed.
function isInputStubbable(
  block: ToolResultBlock,
  toolUsesById: Map<string, ToolUseBlock>,
): boolean {
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  if (!toolUse?.name) return true
  return isCompactableTool(toolUse.name)
}

// Orphan tool_use blocks (no paired tool_result) are invisible to the
// tool_result tier sets, so they get their own pass. We tier them by their
// position in the assistant-message stream — same intuition as the
// tool_result tiering, applied to the parallel stream. Pure-text assistant
// turns also count toward the stream length, which is a deliberate
// simplification: interleaving the two streams would double the tier-math
// complexity for marginal benefit. Don't try to "fix" this without measuring.
function collectOrphanInputIds(
  messages: AnyMessage[],
  toolResultIds: Set<string>,
  tiers: Tiers,
): Set<string> {
  const ids = new Set<string>()
  const assistantIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const inner = getInner(messages[i])
    const role = inner.role ?? messages[i].role
    if (role === 'assistant' && Array.isArray(inner.content)) {
      assistantIndices.push(i)
    }
  }
  const totalA = assistantIndices.length
  for (let p = 0; p < totalA; p++) {
    const fromEnd = totalA - 1 - p
    if (fromEnd < tiers.recent) continue
    const content = getInner(messages[assistantIndices[p]]).content as unknown[]
    for (const block of content as ToolUseBlock[]) {
      if (block?.type !== 'tool_use' || !block.id) continue
      if (toolResultIds.has(block.id)) continue
      // Respect the same allowlist used elsewhere — Task/Agent inputs
      // carry the user-visible prompt and must survive intact.
      if (block.name && !isCompactableTool(block.name)) continue
      ids.add(block.id)
    }
  }
  return ids
}

export function compressToolHistory<T extends AnyMessage>(
  messages: T[],
  model: string,
): T[] {
  // Master kill-switch. Returns the original reference so callers skip a
  // defensive copy when the feature is disabled.
  if (!getGlobalConfig().toolHistoryCompressionEnabled) return messages

  const tiers = getTiers(getEffectiveContextWindowSize(model))

  const { indices: toolResultIndices, resultIds: toolResultIds, toolUseCount } =
    scanToolResults(messages)
  const total = toolResultIndices.length

  // Skip the orphan pre-pass entirely when every tool_use has a paired
  // tool_result — the common case. Preserves the old fast-path cost.
  const hasOrphans = toolUseCount > toolResultIds.size
  const inputStubIds = hasOrphans
    ? new Set<string>(collectOrphanInputIds(messages, toolResultIds, tiers))
    : new Set<string>()

  if (total <= tiers.recent && inputStubIds.size === 0) return messages

  // O(1) lookup: messageIndex → tool-result position (0 = oldest). Replaces
  // the naive Array.indexOf(i) that was O(n²) across the .map below.
  const positionByIndex = new Map<number, number>()
  for (let pos = 0; pos < toolResultIndices.length; pos++) {
    positionByIndex.set(toolResultIndices[pos], pos)
  }

  const toolUsesById = indexToolUses(messages)

  const firstPass = messages.map((msg, i) => {
    const pos = positionByIndex.get(i)
    if (pos === undefined) return msg

    const fromEnd = total - 1 - pos
    if (fromEnd < tiers.recent) return msg

    const inMidWindow = fromEnd < tiers.recent + tiers.mid
    const content = getInner(msg).content as unknown[]
    const newContent = content.map(block => {
      const b = block as { type?: string }
      if (b?.type !== 'tool_result') return block
      const tr = block as ToolResultBlock

      // Input-stub decision is looser than the output one: cleared blocks
      // qualify here (their bulky input is dead weight) but not above.
      if (tr.tool_use_id && isInputStubbable(tr, toolUsesById)) {
        inputStubIds.add(tr.tool_use_id)
      }

      if (!shouldCompressBlock(tr, toolUsesById)) return block
      return inMidWindow
        ? truncateBlock(tr, MID_MAX_CHARS)
        : buildStub(tr, toolUsesById)
    })

    return rewriteMessage(msg, newContent)
  })

  if (inputStubIds.size === 0) return firstPass

  return firstPass.map(msg => {
    const inner = getInner(msg)
    const role = inner.role ?? (msg as { role?: string }).role
    if (role !== 'assistant') return msg
    const content = inner.content
    if (!Array.isArray(content)) return msg
    let changed = false
    const newContent = (content as ToolUseBlock[]).map(block => {
      if (block?.type !== 'tool_use' || !block.id || !inputStubIds.has(block.id)) return block
      changed = true
      const charCount = JSON.stringify(block.input ?? {}).length
      return { ...block, input: { _stub: `input: ${charCount} chars omitted` } }
    })
    return changed ? rewriteMessage(msg, newContent) : msg
  })
}
