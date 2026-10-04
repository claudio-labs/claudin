/**
 * Which headers each remote transport is given, in one place, so where a
 * credential may travel can be read (and tested) without a network.
 *
 * The stored OAuth token of an `http` or `sse` server is not here: the SDK
 * adds it from the auth provider, and the headers below override it.
 */

export type RemoteServerType = 'http' | 'sse' | 'sse-ide' | 'ws' | 'ws-ide' | 'claudeai-proxy'

export type CredentialInputs = {
  userAgent: string
  /** The config's headers, `headersHelper` output included. */
  configured?: Record<string, string>
  /** Whether an OAuth token is stored for the server. */
  hasStoredToken?: boolean
  /** The session ingress token (tracked: sent to any `ws`/`http` host, see the spec's Finding 1). */
  ingressToken?: string | null
  /** The IDE lockfile token of a `ws-ide` server. */
  ideToken?: string
  /** This session's id, for the claude.ai proxy. */
  sessionId?: string
}

const IDE_AUTH_HEADER = 'X-Claude-Code-Ide-Authorization'
const PROXY_SESSION_HEADER = 'X-Mcp-Client-Session-Id'

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase()
  return Object.keys(headers).some(key => key.toLowerCase() === wanted)
}

function bearer(token: string | null | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function outgoingHeaders(type: RemoteServerType, inputs: CredentialInputs): Record<string, string> {
  const userAgent = { 'User-Agent': inputs.userAgent }
  const configured = inputs.configured ?? {}
  switch (type) {
    case 'http': {
      const ingressAllowed = !inputs.hasStoredToken && !hasHeader(configured, 'authorization')
      return { ...userAgent, ...bearer(ingressAllowed ? inputs.ingressToken : undefined), ...configured }
    }
    case 'ws': {
      const ingressAllowed = !hasHeader(configured, 'authorization')
      return { ...userAgent, ...bearer(ingressAllowed ? inputs.ingressToken : undefined), ...configured }
    }
    case 'sse':
      return { ...userAgent, ...configured }
    case 'ws-ide':
      return { ...userAgent, ...(inputs.ideToken ? { [IDE_AUTH_HEADER]: inputs.ideToken } : {}) }
    case 'sse-ide':
      return {}
    case 'claudeai-proxy':
      return { ...userAgent, ...(inputs.sessionId ? { [PROXY_SESSION_HEADER]: inputs.sessionId } : {}) }
  }
}
