import {
  getSessionIngressToken,
  setSessionIngressToken,
} from 'src/platform/bootstrap/state.js'
import {
  defaultIngressTokenSourceDeps,
  readIngressTokenFromDisk,
} from 'src/sessions/remote/ingressTokenSource.js'

const ACCESS_TOKEN_ENV = 'CLAUDE_CODE_SESSION_ACCESS_TOKEN'
const ORGANIZATION_ENV = 'CLAUDE_CODE_ORGANIZATION_UUID'
/** claude.ai session keys travel as a cookie; everything else is a bearer token. */
const SESSION_KEY_PREFIX = 'sk-ant-sid'

/**
 * The token for the session-ingress API. The access-token variable wins on
 * every call; whatever the disk gave (null included) is remembered for the
 * process, because the descriptor can be drained only once.
 */
export function getSessionIngressAuthToken(): string | null {
  const fromEnv = process.env[ACCESS_TOKEN_ENV]
  if (fromEnv) return fromEnv

  const remembered = getSessionIngressToken()
  if (remembered !== undefined) return remembered

  const fromDisk = readIngressTokenFromDisk(
    {
      descriptor: process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR,
      tokenFile: process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE,
    },
    defaultIngressTokenSourceDeps(),
  )
  setSessionIngressToken(fromDisk)
  return fromDisk
}

export function getSessionIngressAuthHeaders(): Record<string, string> {
  const token = getSessionIngressAuthToken()
  if (!token) return {}
  if (!token.startsWith(SESSION_KEY_PREFIX)) {
    return { Authorization: `Bearer ${token}` }
  }
  const organization = process.env[ORGANIZATION_ENV]
  return organization
    ? { Cookie: `sessionKey=${token}`, 'X-Organization-Uuid': organization }
    : { Cookie: `sessionKey=${token}` }
}

/** Rotation in-process goes through the variable, which outranks the remembered token. */
export function updateSessionIngressAuthToken(token: string): void {
  process.env[ACCESS_TOKEN_ENV] = token
}
