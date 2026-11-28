/**
 * Runs wireRules.ts on a server's responses before the SDK decodes them, and
 * on Claudin's own requests before they reach the transport.
 *
 * The seam is the SDK's own: Protocol.connect keeps a `transport.onmessage`
 * that was set before it, and calls it first with the same message object it
 * then decodes, so an edit made here is what the SDK parses. The discover
 * probe swaps it out for its one round trip and puts it back. A response
 * carries only its id, so the transport instance's `send` is wrapped to note
 * which method each tracked request id went out as; the same wrapper swaps
 * in the request a send rule returns.
 *
 * The same two hooks run cursorCycleGuard.ts over the list methods, so a
 * server whose cursors cycle, or that pages past MAX_LIST_PAGES, ends its
 * listing instead of failing it.
 *
 * The transport itself is neither wrapped nor subclassed: the SDK tells a
 * stdio transport from an HTTP one by its class, to probe on a sibling
 * process or to classify HTTP errors, and a stand-in would defeat both.
 *
 * attachMcpWireFilter is the filter as connections attach it, logging under
 * the server's name. It lives here rather than beside the fetchers so that
 * attaching one does not pull in fetchCapabilities.ts.
 */
import type { JSONRPCMessage, RequestId, Transport } from '@modelcontextprotocol/client'
import { logError, logMCPDebug, logMCPError } from 'src/shared/log.js'
import { createCursorCycleGuard } from 'src/mcp/client/cursorCycleGuard.js'
import { isRecord, type SkippedEntry } from 'src/mcp/client/listValidation.js'
import {
  SEND_RULES,
  type SendRule,
  WIRE_RULES,
  type WireRequest,
  type WireResult,
  type WireRule,
  type WireRuleContext,
} from 'src/mcp/client/wireRules.js'

export type WireFilterOptions = WireRuleContext & {
  /** The rule table; WIRE_RULES unless a test swaps it. */
  rules?: Readonly<Record<string, WireRule>>
  /** The outgoing rule table; SEND_RULES unless a test swaps it. */
  sendRules?: Readonly<Record<string, SendRule>>
  /** A listing cut short because the server repeated `cursor`. */
  onCursorCycle?: (method: string, cursor: string) => void
  /** A listing cut short at MAX_LIST_PAGES pages, with more to come. */
  onPageLimit?: (method: string, pages: number) => void
}

function requestId(message: JSONRPCMessage): RequestId | undefined {
  const id = (message as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

function applySendRule(rule: SendRule, message: JSONRPCMessage): JSONRPCMessage {
  try {
    return rule(message as unknown as WireRequest) as unknown as JSONRPCMessage
  } catch (error) {
    // A rule that breaks is logged, and the request goes out as the SDK built it.
    logError(error)
    return message
  }
}

export function attachWireFilter(transport: Transport, options: WireFilterOptions): void {
  const rules = options.rules ?? WIRE_RULES
  const sendRules = options.sendRules ?? SEND_RULES
  const context: WireRuleContext = { onSkipped: options.onSkipped }
  // Only requests some rule rewrites are tracked; an entry leaves with its
  // response, success or error.
  const methods = new Map<RequestId, string>()
  const cursors = createCursorCycleGuard()

  const send = transport.send.bind(transport)
  transport.send = (message, sendOptions) => {
    const id = requestId(message)
    const method = (message as { method?: unknown }).method
    if (id !== undefined && typeof method === 'string' && Object.hasOwn(rules, method)) {
      methods.set(id, method)
      const params = (message as { params?: unknown }).params
      cursors.onRequest(id, method, isRecord(params) ? params.cursor : undefined)
    }
    const outgoing =
      typeof method === 'string' && Object.hasOwn(sendRules, method)
        ? applySendRule(sendRules[method]!, message)
        : message
    return send(outgoing, sendOptions)
  }

  const previous = transport.onmessage
  transport.onmessage = (message, extra) => {
    const id = requestId(message)
    const method = id === undefined || 'method' in message ? undefined : methods.get(id)
    if (method !== undefined) {
      methods.delete(id!)
      const result = (message as { result?: unknown }).result
      if (!isRecord(result)) {
        cursors.forget(id!)
      } else {
        try {
          rules[method]!(result as WireResult, context)
        } catch (error) {
          // A rule that breaks is logged, and the response still goes on to
          // the SDK, which decodes it as it would have unfiltered.
          logError(error)
        }
        const cut = cursors.onResult(id!, method, result)
        if (cut?.reason === 'cycle') options.onCursorCycle?.(method, cut.cursor)
        if (cut?.reason === 'pages') options.onPageLimit?.(method, cut.pages)
      }
    }
    previous?.(message, extra)
  }
}

function logSkippedEntries(server: string, kind: string, skipped: SkippedEntry[]): void {
  for (const { name, reason } of skipped) {
    logMCPError(server, `Skipped ${kind}${name ? ` "${name}"` : ''}: ${reason}`)
  }
}

/**
 * The wire filter every MCP connection goes through before `client.connect`:
 * each list page reaches the SDK with its malformed entries already dropped,
 * and each one dropped is logged under the server's name.
 *
 * `keepInitialize` sends the 2025 `initialize` as the Client built it, for an
 * SDK-control client (sdkClients.ts): it is built with `capabilities: {}` and
 * handles none of the server requests the rewrite would announce.
 */
export function attachMcpWireFilter(
  serverName: string,
  transport: Transport,
  options: { keepInitialize?: boolean } = {},
): void {
  const { initialize: _rewrite, ...otherSendRules } = SEND_RULES
  attachWireFilter(transport, {
    sendRules: options.keepInitialize ? otherSendRules : SEND_RULES,
    onSkipped: (kind, skipped) => logSkippedEntries(serverName, kind, skipped),
    onCursorCycle: (method, cursor) =>
      logMCPError(serverName, `${method} repeated the cursor "${cursor}"; the list stops at the entries already received`),
    onPageLimit: (method, pages) =>
      logMCPDebug(serverName, `${method} still had a next page after ${pages} pages; the list stops at the entries already received`),
  })
}
