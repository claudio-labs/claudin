/**
 * The prompt-cache prefix invariant (cache.md §1), checked on recorded
 * requests: every request must send the previous request's messages again,
 * byte for byte, before anything it adds. Opus 5.5 binds each thinking block
 * to the bytes before it, so a changed byte costs more than its cache tail:
 * the server drops the thinking after it and writes everything from there
 * again (input_transformations: thinking_dropped).
 *
 * Messages are rendered with the production pipeline (renderMessagesForAPI +
 * addCacheBreakpoints) and compared with `cache_control` stripped — the
 * marker legitimately moves every request.
 */
import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { addCacheBreakpoints } from 'src/providers/shims/claude/paramBuilders.js'
import { renderMessagesForAPI } from 'src/providers/shims/claude/renderMessages.js'
import type { Message } from 'src/shared/types/message.js'
import type { Tools } from 'src/tools/Tool.js'

type Block = { type?: string; text?: string; content?: unknown }

/**
 * A string `content` and a single text block are the same prompt to the API:
 * addCacheBreakpoints turns the last message's string into a block to carry
 * the marker, and the next request sends it as a string again. Measured
 * 2026-10-01 with count_tokens: a tool_result as a string or as one text
 * block counts the same and drops no thinking. Comparing the canonical form
 * keeps the check on bytes that change the prompt.
 */
function canonicalContent(content: unknown): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return content
  return (content as Block[]).map(block =>
    block?.type === 'tool_result' && typeof block.content === 'string'
      ? { ...block, content: [{ type: 'text', text: block.content }] }
      : block,
  )
}

/** The wire bytes of one request's messages, one string per message. */
export function wireMessages(messages: Message[], tools: Tools): string[] {
  const historyRedaction = getCacheProfile().historyRedactionEnabled
  const config = getGlobalConfig()
  const { messages: rendered } = renderMessagesForAPI(messages, tools, {
    useToolSearch: false,
    advisor: false,
    stripOldThinking: historyRedaction && !!config.thinkingHistoryRedactionEnabled,
    stripOldNarration: historyRedaction && !!config.narrationHistoryRedactionEnabled,
  })
  return addCacheBreakpoints(rendered, true).map(m =>
    JSON.stringify({ ...m, content: canonicalContent(m.content) }, (key, value) =>
      key === 'cache_control' ? undefined : value,
    ),
  )
}

export type PrefixBreak = {
  /** Indices into the recorded requests. */
  from: number
  to: number
  /** First message whose bytes changed, and the request it belonged to. */
  index: number
  role: string
  before: string
  after: string
}

/**
 * The first place where a request did not re-send its predecessor's messages.
 * Null when every request extends the one before it.
 */
export function findPrefixBreak(requests: readonly string[][]): PrefixBreak | null {
  for (let r = 1; r < requests.length; r++) {
    const prev = requests[r - 1]!
    const cur = requests[r]!
    for (let i = 0; i < prev.length; i++) {
      if (cur[i] === prev[i]) continue
      const before = prev[i]!
      const after = cur[i] ?? '(missing)'
      let at = 0
      while (at < before.length && before[at] === after[at]) at++
      const window = (s: string) => JSON.stringify(s.slice(Math.max(0, at - 120), at + 200))
      return {
        from: r - 1,
        to: r,
        index: i,
        role: (JSON.parse(before) as { role?: string }).role ?? '?',
        before: window(before),
        after: window(after),
      }
    }
  }
  return null
}

/** A failure message that says where the prefix moved and how. */
export function describePrefixBreak(b: PrefixBreak): string {
  return [
    `request ${b.to} changed message ${b.index} (${b.role}) that request ${b.from} had sent:`,
    `  sent:   ${b.before}`,
    `  resent: ${b.after}`,
  ].join('\n')
}
