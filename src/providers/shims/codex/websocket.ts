/**
 * The ChatGPT Codex backend over WebSocket, the way Codex CLI talks to it.
 *
 * From Codex CLI 0.163.0 on the wire (mitmproxy, 2026-10-17): every model
 * request rides one socket per conversation on `/backend-api/codex/responses`,
 * upgraded with `OpenAI-Beta: responses_websockets=2026-02-06`; each frame is
 * the POST body plus `type: "response.create"`, and after a tool call it names
 * the previous response and carries only the new items (2.5 KB where the POST
 * sends the whole history). The prompt cache is the same either way.
 *
 * Only the protocol comes along: the headers the POST already sends plus that
 * beta header. Codex CLI's telemetry (x-codex-turn-metadata, thread-id,
 * client_metadata in each frame) and its `generate: false` prewarm do not —
 * the capture showed the prewarm left the first real turn uncached anyway.
 *
 * The gate is the backend, like the replay's: Copilot and any relay with its
 * own baseUrl keep the POST. The transport falls back to it on its own
 * (responsesSocket/transport.ts).
 *
 * Killswitch: CLAUDIN_CODEX_WEBSOCKET=0 sends every request as the POST + SSE
 * it was before. `bun test` defaults it to 0 (src/stubs/test-preload.ts),
 * since suites stub fetch and a Codex request would otherwise open a real
 * socket to chatgpt.com.
 */
import type { ResolvedProviderRequest } from 'src/providers/presets/providerConfig.js'
import { isCodexBackendRequest } from 'src/providers/shims/codex/backend.js'
import {
  createResponsesSocketTransport,
  RESPONSES_WEBSOCKET_BETA,
  type ResponsesSocketTransport,
} from 'src/providers/transport/responsesSocket/transport.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

const HTTP_SCHEME_RE = /^http/

export function isCodexWebSocketEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_CODEX_WEBSOCKET)
}

/** Whether this request goes to the Codex backend over a socket. */
export function codexSocketEligible(
  request: Pick<ResolvedProviderRequest, 'transport' | 'baseUrl'>,
): boolean {
  return isCodexBackendRequest(request) && isCodexWebSocketEnabled()
}

/** The socket URL for a POST URL: same host and path, ws(s) scheme. */
export function codexSocketUrl(url: string): string {
  return url.replace(HTTP_SCHEME_RE, 'ws')
}

/** The POST's headers for the upgrade: no body type, plus the protocol's beta. */
export function codexSocketHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'content-type' || lower === 'openai-beta') continue
    out[name] = value
  }
  out['OpenAI-Beta'] = RESPONSES_WEBSOCKET_BETA
  return out
}

let transport: ResponsesSocketTransport | undefined

export function requestOverCodexSocket(request: {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  signal?: AbortSignal
  http: () => Promise<Response>
}): Promise<Response> {
  transport ??= createResponsesSocketTransport({}, { label: 'codex-ws' })
  return transport.request({
    url: request.url,
    socketUrl: codexSocketUrl(request.url),
    headers: codexSocketHeaders(request.headers),
    body: request.body,
    signal: request.signal,
    http: request.http,
  })
}

/** Test seam: the transport requestOverCodexSocket uses (undefined: a fresh real one). */
export function _setCodexSocketTransportForTesting(next: ResponsesSocketTransport | undefined): void {
  transport?.closeAll()
  transport = next
}
