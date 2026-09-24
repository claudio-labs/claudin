import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import type {
  AnyContentBlock,
  AnyMessage,
  ToolUseBlock,
} from 'src/agent/compact/stableStubState/types.js'
import { getInner } from 'src/agent/compact/stableStubState/types.js'
import {
  getClippedInputFields,
  getStubTextForId,
  inputStubKey,
  recordStubText,
} from 'src/agent/compact/stableStubState/clippedIdRegistry.js'
import {
  MIN_STUB_TOKENS,
  buildInputClipStub,
  isInputClipStubContent,
} from 'src/agent/compact/stableStubState/clipStubText.js'

/**
 * Walk messages and rewrite the recorded input fields of every assistant
 * `tool_use` whose id the relief policy clipped (`addClippedInputs`). The
 * client-side twin of the API's `clear_tool_inputs`: a Patch body, a
 * Write's content or an Agent brief is the model's own output, already on
 * disk or already acted on, and it stays in the prefix for the rest of the
 * session — 40% of one 958k transcript was tool_use inputs that no clip
 * could reach.
 *
 * WIRE-ONLY. Unlike applyStableStubs this is never substituted back into
 * QueryEngine's messages: the TUI renders the patch it applied, the plan
 * dossier and session persistence keep the full call. The three shim request
 * paths and the relief estimate (microCompact.ts) call it on their own copy.
 *
 * Same identity-preserving contract as applyStableStubs: the input array
 * reference comes back when nothing was clipped or every clipped field is
 * already a stub. Same byte contract too — a field is stubbed once, the
 * bytes are recorded first-write-wins under `${id}#${field}`, and every
 * later render replays them. A field under MIN_STUB_TOKENS is left alone:
 * the stub would not be shorter than the value it replaces.
 */
export function applyStableInputStubs<T extends AnyMessage>(messages: T[]): T[] {
  const clipped = getClippedInputFields()
  if (clipped.size === 0) return messages

  let anyTouched = false
  const out = messages.map(msg => {
    const inner = getInner(msg)
    const role = inner.role ?? msg.role
    if (role !== 'assistant') return msg
    const content = inner.content
    if (!Array.isArray(content)) return msg

    let touched = false
    const newContent = (content as AnyContentBlock[]).map(block => {
      if (block?.type !== 'tool_use') return block
      const use = block as ToolUseBlock
      const fields = use.id ? clipped.get(use.id) : undefined
      if (!fields || !use.input || typeof use.input !== 'object') return block
      const stubbed = stubInputFields(use, fields)
      if (stubbed === use.input) return block
      touched = true
      return { ...block, input: stubbed }
    })

    if (!touched) return msg
    anyTouched = true
    if (msg.message) {
      return { ...msg, message: { ...msg.message, content: newContent } } as T
    }
    return { ...msg, content: newContent } as T
  })

  return anyTouched ? out : messages
}

/** The tool_use input with its clipped fields stubbed; the same object when
 * nothing changed. */
function stubInputFields(use: ToolUseBlock, fields: readonly string[]): unknown {
  const input = use.input as Record<string, unknown>
  const toolName = use.name ?? 'tool'
  let next: Record<string, unknown> | undefined
  for (const field of fields) {
    const value = input[field]
    if (typeof value !== 'string' || isInputClipStubContent(value)) continue
    const key = inputStubKey(use.id ?? '', field)
    let stub = use.id ? getStubTextForId(key) : undefined
    if (stub === undefined) {
      const tokens = roughTokenCountEstimation(value)
      if (tokens < MIN_STUB_TOKENS) continue
      stub = buildInputClipStub(toolName, field, tokens)
      if (use.id) recordStubText(key, stub)
    }
    next ??= { ...input }
    next[field] = stub
  }
  return next ?? input
}
