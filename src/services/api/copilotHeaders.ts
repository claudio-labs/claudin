/**
 * Per-request GitHub Copilot headers.
 *
 * Copilot bills "premium requests" by user-initiated turns: agentic
 * follow-ups (tool-result continuations, compaction resumes) must be marked
 * with `x-initiator: agent` or they each count as a fresh user request.
 * Vision requests additionally require `Copilot-Vision-Request: true` on
 * some models or the image blocks are rejected.
 *
 * The static editor-identification headers live in
 * `openaiShim/constants.ts` (COPILOT_HEADERS); this module computes the
 * request-dependent ones from the outbound message list. Messages may be in
 * the internal Claudin shape (`{ type, message: { role, content } }`) or the
 * Anthropic SDK shape (`{ role, content }`) — both are handled.
 */

type LooseMessage = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

type LooseBlock = {
  type?: string
  content?: unknown
  source?: unknown
}

function roleOf(message: LooseMessage): string | undefined {
  return message.message?.role ?? message.role
}

function contentOf(message: LooseMessage): unknown {
  return message.message ? message.message.content : message.content
}

function blockIsImage(block: LooseBlock): boolean {
  if (!block || typeof block !== 'object') return false
  if (block.type === 'image') return true
  // tool_result blocks can nest image blocks inside their content array.
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    return block.content.some(inner => blockIsImage(inner as LooseBlock))
  }
  return false
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(block => blockIsImage(block as LooseBlock))
}

function contentIsAllToolResults(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(block => {
    const b = block as LooseBlock
    return b && typeof b === 'object' && b.type === 'tool_result'
  })
}

/**
 * `user` only when the last message is a genuine human turn. Tool-result
 * continuations arrive with role "user" but all-tool_result content — those
 * are agent-initiated follow-ups, as is any assistant-last replay.
 */
export function detectCopilotInitiator(
  messages: ReadonlyArray<unknown>,
): 'agent' | 'user' {
  const last = messages[messages.length - 1] as LooseMessage | undefined
  if (!last || typeof last !== 'object') return 'user'
  if (roleOf(last) !== 'user') return 'agent'
  if (contentIsAllToolResults(contentOf(last))) return 'agent'
  return 'user'
}

export function messagesContainImage(
  messages: ReadonlyArray<unknown>,
): boolean {
  return messages.some(message =>
    contentHasImage(contentOf(message as LooseMessage)),
  )
}

/** Request-dependent Copilot headers for an outbound message list. */
export function buildCopilotDynamicHeaders(
  messages: ReadonlyArray<unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-initiator': detectCopilotInitiator(messages),
  }
  if (messagesContainImage(messages)) {
    headers['Copilot-Vision-Request'] = 'true'
  }
  return headers
}

/**
 * Fetch wrapper for the native Anthropic route (`{base}/v1/messages`):
 * the Anthropic SDK builds the request internally, so the message list is
 * only observable from the serialized body. Injects the dynamic headers
 * (plus any static extras) into every POST with a JSON messages payload.
 */
export function wrapFetchWithCopilotHeaders(
  inner: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  staticHeaders: Record<string, string> = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(staticHeaders)) {
      if (!headers.has(name)) headers.set(name, value)
    }
    try {
      if (typeof init?.body === 'string') {
        const parsed = JSON.parse(init.body) as { messages?: unknown }
        if (Array.isArray(parsed?.messages)) {
          for (const [name, value] of Object.entries(
            buildCopilotDynamicHeaders(parsed.messages),
          )) {
            headers.set(name, value)
          }
        }
      }
    } catch {
      // Non-JSON body (or unexpected shape) — send static headers only.
    }
    return inner(input, { ...init, headers })
  }
}
