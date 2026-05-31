/**
 * Heuristic + ephemeral state for the "serial Read narration" nudge.
 *
 * Detects the anti-pattern where the model serializes a multi-file
 * investigation into a chain of single-Read turns, each with a 1-line
 * narration text block in between. When triggered, FileReadTool appends a
 * <system-reminder> to the next Read's tool_result suggesting the Explore
 * agent or parallel Reads.
 *
 * Companion to FileReadTool.ts:CYBER_RISK_MITIGATION_REMINDER — same
 * injection surface (just-in-time tool_result append), proven non-inert.
 */

export const SERIAL_READ_NUDGE_REMINDER =
  '\n\n<system-reminder>\nYou\'ve made 3 sequential single-file Reads with narration between each. If you\'re investigating across multiple files, dispatch the Explore agent in one call (Agent tool, subagent_type=Explore), or emit the remaining Reads as parallel tool_use blocks in a single message. Skip the inter-read commentary — it bloats context without informing the user.\n</system-reminder>\n'

/**
 * Minimal shape we care about for an assistant message in this detector.
 * Mirrors the runtime Message/AssistantMessage shape (see Tool.ts:269 + the
 * existing iteration patterns in query.ts:1605, promptCacheBreakDetection.ts:450).
 */
export interface AssistantMessageLike {
  type: string
  message?: {
    role?: string
    content?: ReadonlyArray<{
      type?: string
      name?: string
      text?: string
    }>
  }
}

/**
 * Returns true if the last `window` assistant messages show the serial-Read
 * pattern: ≥3 of them each contain exactly one Read tool_use, zero other tool
 * calls, AND at least one of them has a non-empty text block (narration).
 *
 * Cheap, O(window) — never scans the whole transcript.
 */
export function detectSerialReadPattern(
  messages: ReadonlyArray<unknown>,
  window = 4,
): boolean {
  // Walk backwards collecting up to `window` assistant messages.
  const asst: AssistantMessageLike[] = []
  for (let i = messages.length - 1; i >= 0 && asst.length < window; i--) {
    const m = messages[i] as AssistantMessageLike
    if (m && m.type === 'assistant') asst.push(m)
  }
  if (asst.length < 3) return false

  let qualifying = 0
  let anyNarration = false
  for (const m of asst) {
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    let readCount = 0
    let otherToolCount = 0
    let hasText = false
    for (const block of content) {
      if (block?.type === 'tool_use') {
        if (block.name === 'Read') readCount++
        else otherToolCount++
      } else if (block?.type === 'text') {
        const t = typeof block.text === 'string' ? block.text.trim() : ''
        if (t.length > 0) hasText = true
      }
    }
    if (readCount === 1 && otherToolCount === 0) {
      qualifying++
      if (hasText) anyNarration = true
    }
  }
  return qualifying >= 3 && anyNarration
}

/**
 * Per-turn one-shot guard. The injection is parameter-keyed on the messages
 * array identity (the per-query Message[] reference held on ToolUseContext);
 * a WeakSet keeps state ephemeral and never leaks across queries.
 *
 * markFiredAndCheck returns true the first time it's called with a given
 * messages reference, false on every subsequent call.
 */
const FIRED: WeakSet<object> = new WeakSet()

export function markFiredAndCheck(messages: ReadonlyArray<unknown>): boolean {
  // ReadonlyArray<unknown> is a real Array instance at runtime — safe to
  // use as a WeakSet key.
  const key = messages as unknown as object
  if (FIRED.has(key)) return false
  FIRED.add(key)
  return true
}

/**
 * Test-only: reset the WeakSet by replacing its keys is not possible, so
 * tests should always pass a fresh array reference per case.
 */
