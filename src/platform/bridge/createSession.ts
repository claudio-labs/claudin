import type { SDKMessage } from 'src/platform/entrypoints/agentSdkTypes.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { extractErrorDetail } from 'src/platform/bridge/debugUtils.js'
import { toCompatSessionId } from 'src/platform/bridge/sessionIdCompat.js'
import type { SessionCreateFailure } from 'src/platform/bridge/types.js'

type GitSource = {
  type: 'git_repository'
  url: string
  revision?: string
}

type GitOutcome = {
  type: 'git_repository'
  git_info: { type: 'github'; repo: string; branches: string[] }
}

/**
 * Sticky once the server has rejected a body carrying git context: every later
 * creation in this process skips the field instead of paying the same wasted
 * round-trip. Process-lifetime and deliberately not persisted — a GitHub
 * connection the user repairs is picked up on the next start.
 */
let gitContextRejected = false

function isSuccessStatus(status: number): boolean {
  return status === 200 || status === 201
}

/**
 * Whether a failed creation is worth exactly one immediate retry with the git
 * context stripped.
 *
 * `session_context.sources` is the only part of this body the server validates
 * against state outside the request: the repository has to be visible to the
 * account's Claude GitHub App. A private repo, one missing from the app's
 * repository selection, or an expired GitHub connection turns the whole
 * creation into a 400 — so Remote Control dies on a field that only decorates
 * the session card on claude.ai.
 *
 * Keyed on the status rather than on the server's prose: that message is
 * English, human-facing and free to change, while "we sent the one
 * externally-validated field and got a 400" is the durable signal.
 */
export function shouldRetryWithoutGitContext(
  status: number,
  sentGitContext: boolean,
): boolean {
  return sentGitContext && status === 400
}

// Events must be wrapped in { type: 'event', data: <sdk_message> } for the
// POST /v1/sessions endpoint (discriminated union format).
type SessionEvent = {
  type: 'event'
  data: SDKMessage
}

/**
 * Create a session on a bridge environment via POST /v1/sessions.
 *
 * Used by both `claude remote-control` (empty session so the user has somewhere to
 * type immediately) and `/remote-control` (session pre-populated with conversation
 * history).
 *
 * Returns the session ID on success, or null if creation fails (non-fatal).
 * `onFailure` receives why — the caller decides whether to retry and what to
 * show, which a bare null return cannot support.
 */
export async function createBridgeSession({
  environmentId,
  title,
  events,
  gitRepoUrl,
  branch,
  signal,
  baseUrl: baseUrlOverride,
  getAccessToken,
  permissionMode,
  onFailure,
}: {
  environmentId: string
  title?: string
  events: SessionEvent[]
  gitRepoUrl: string | null
  branch: string
  signal: AbortSignal
  baseUrl?: string
  getAccessToken?: () => string | undefined
  permissionMode?: string
  onFailure?: (failure: SessionCreateFailure) => void
}): Promise<string | null> {
  const { getClaudeAIOAuthTokens } = await import('src/providers/auth/auth.js')
  const { getOrganizationUUID } = await import('src/providers/oauth/client.js')
  const { getOauthConfig } = await import('src/shared/constants/oauth.js')
  const { getOAuthHeaders } = await import('src/platform/teleport/api.js')
  const { parseGitHubRepository } = await import('src/vcs/git/detectRepository.js')
  const { getDefaultBranch } = await import('src/vcs/git/git.js')
  const { getMainLoopModel } = await import('src/providers/model/model.js')
  const { default: axios } = await import('axios')

  const accessToken =
    getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session creation')
    onFailure?.({ retryable: false, detail: 'not signed in' })
    return null
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session creation')
    onFailure?.({
      retryable: false,
      detail: 'no organization for this account',
    })
    return null
  }

  // Build git source and outcome context
  let gitSource: GitSource | null = null
  let gitOutcome: GitOutcome | null = null

  if (gitRepoUrl) {
    const { parseGitRemote } = await import('src/vcs/git/detectRepository.js')
    const parsed = parseGitRemote(gitRepoUrl)
    if (parsed) {
      const { host, owner, name } = parsed
      const revision = branch || (await getDefaultBranch()) || undefined
      gitSource = {
        type: 'git_repository',
        url: `https://${host}/${owner}/${name}`,
        revision,
      }
      gitOutcome = {
        type: 'git_repository',
        git_info: {
          type: 'github',
          repo: `${owner}/${name}`,
          branches: [`claude/${branch || 'task'}`],
        },
      }
    } else {
      // Fallback: try parseGitHubRepository for owner/repo format
      const ownerRepo = parseGitHubRepository(gitRepoUrl)
      if (ownerRepo) {
        const [owner, name] = ownerRepo.split('/')
        if (owner && name) {
          const revision = branch || (await getDefaultBranch()) || undefined
          gitSource = {
            type: 'git_repository',
            url: `https://github.com/${owner}/${name}`,
            revision,
          }
          gitOutcome = {
            type: 'git_repository',
            git_info: {
              type: 'github',
              repo: `${owner}/${name}`,
              branches: [`claude/${branch || 'task'}`],
            },
          }
        }
      }
    }
  }

  const buildRequestBody = (includeGitContext: boolean) => ({
    ...(title !== undefined && { title }),
    events,
    session_context: {
      sources: includeGitContext && gitSource ? [gitSource] : [],
      outcomes: includeGitContext && gitOutcome ? [gitOutcome] : [],
      model: getMainLoopModel(),
    },
    environment_id: environmentId,
    source: 'remote-control',
    ...(permissionMode && { permission_mode: permissionMode }),
  })

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${baseUrlOverride ?? getOauthConfig().BASE_API_URL}/v1/sessions`
  const post = async (
    includeGitContext: boolean,
  ): Promise<{ status: number; data: unknown } | null> => {
    try {
      return await axios.post(url, buildRequestBody(includeGitContext), {
        headers,
        signal,
        validateStatus: s => s < 500,
      })
    } catch (err: unknown) {
      // validateStatus passes everything below 500 through, so what reaches
      // here is a 5xx, a timeout or a dead socket — all worth another attempt.
      logForDebugging(
        `[bridge] Session creation request failed: ${errorMessage(err)}`,
      )
      onFailure?.({ retryable: true, detail: errorMessage(err) })
      return null
    }
  }

  const sentGitContext = gitSource !== null && !gitContextRejected
  let response = await post(sentGitContext)
  if (!response) {
    return null
  }

  if (
    !isSuccessStatus(response.status) &&
    shouldRetryWithoutGitContext(response.status, sentGitContext)
  ) {
    const rejectDetail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session creation rejected with status ${response.status}${rejectDetail ? `: ${rejectDetail}` : ''} — retrying without the git context`,
    )
    gitContextRejected = true
    response = await post(false)
    if (!response) {
      return null
    }
  }

  if (!isSuccessStatus(response.status)) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session creation failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    onFailure?.({
      status: response.status,
      detail,
      // 429 is the one 4xx that answers differently on its own.
      retryable: response.status === 429,
    })
    return null
  }

  const sessionData: unknown = response.data
  if (
    !sessionData ||
    typeof sessionData !== 'object' ||
    !('id' in sessionData) ||
    typeof sessionData.id !== 'string'
  ) {
    logForDebugging('[bridge] No session ID in response')
    onFailure?.({
      status: response.status,
      detail: 'malformed session response',
      retryable: false,
    })
    return null
  }

  return sessionData.id
}

/**
 * Fetch a bridge session via GET /v1/sessions/{id}.
 *
 * Returns the session's environment_id (for `--session-id` resume) and title.
 * Uses the same org-scoped headers as create/archive — the environments-level
 * client in bridgeApi.ts uses a different beta header and no org UUID, which
 * makes the Sessions API return 404.
 */
export async function getBridgeSession(
  sessionId: string,
  opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<{ environment_id?: string; title?: string } | null> {
  const { getClaudeAIOAuthTokens } = await import('src/providers/auth/auth.js')
  const { getOrganizationUUID } = await import('src/providers/oauth/client.js')
  const { getOauthConfig } = await import('src/shared/constants/oauth.js')
  const { getOAuthHeaders } = await import('src/platform/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session fetch')
    return null
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session fetch')
    return null
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}`
  const timeoutMs = 10_000
  logForDebugging(`[bridge] Fetching session ${sessionId}`)

  let response
  try {
    response = await axios.get<{ environment_id?: string; title?: string }>(
      url,
      { headers, timeout: timeoutMs, validateStatus: s => s < 500 },
    )
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? 'no-response'
      const code = err.code ?? 'unknown-code'
      const requestUrl = err.config?.url ?? url
      const method = err.config?.method?.toUpperCase() ?? 'GET'
      const message = err.message ?? errorMessage(err)
      const timeout = err.config?.timeout ?? timeoutMs

      logForDebugging(
        `[bridge] Session fetch request failed: status=${status} code=${code} method=${method} url=${requestUrl} timeout=${timeout} message=${message}`,
      )
    } else {
      logForDebugging(
        `[bridge] Session fetch request failed: url=${url} timeout=${timeoutMs} message=${errorMessage(err)}`,
      )
    }
    return null
  }

  if (response.status !== 200) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session fetch failed with status ${response.status} url=${url}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  return response.data
}

/**
 * Archive a bridge session via POST /v1/sessions/{id}/archive.
 *
 * The CCR server never auto-archives sessions — archival is always an
 * explicit client action. Both `claude remote-control` (standalone bridge) and the
 * always-on `/remote-control` REPL bridge call this during shutdown to archive any
 * sessions that are still alive.
 *
 * The archive endpoint accepts sessions in any status (running, idle,
 * requires_action, pending) and returns 409 if already archived, making
 * it safe to call even if the server-side runner already archived the
 * session.
 *
 * Callers must handle errors — this function has no try/catch; 5xx,
 * timeouts, and network errors throw. Archival is best-effort during
 * cleanup; call sites wrap with .catch().
 */
export async function archiveBridgeSession(
  sessionId: string,
  opts?: {
    baseUrl?: string
    getAccessToken?: () => string | undefined
    timeoutMs?: number
  },
): Promise<void> {
  const { getClaudeAIOAuthTokens } = await import('src/providers/auth/auth.js')
  const { getOrganizationUUID } = await import('src/providers/oauth/client.js')
  const { getOauthConfig } = await import('src/shared/constants/oauth.js')
  const { getOAuthHeaders } = await import('src/platform/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session archive')
    return
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session archive')
    return
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/archive`
  logForDebugging(`[bridge] Archiving session ${sessionId}`)

  const response = await axios.post(
    url,
    {},
    {
      headers,
      timeout: opts?.timeoutMs ?? 10_000,
      validateStatus: s => s < 500,
    },
  )

  if (response.status === 200) {
    logForDebugging(`[bridge] Session ${sessionId} archived successfully`)
  } else {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session archive failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }
}

/**
 * Update the title of a bridge session via PATCH /v1/sessions/{id}.
 *
 * Called when the user renames a session via /rename while a bridge
 * connection is active, so the title stays in sync on claude.ai/code.
 *
 * Errors are swallowed — title sync is best-effort.
 */
export async function updateBridgeSessionTitle(
  sessionId: string,
  title: string,
  opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<void> {
  const { getClaudeAIOAuthTokens } = await import('src/providers/auth/auth.js')
  const { getOrganizationUUID } = await import('src/providers/oauth/client.js')
  const { getOauthConfig } = await import('src/shared/constants/oauth.js')
  const { getOAuthHeaders } = await import('src/platform/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session title update')
    return
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session title update')
    return
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  // Compat gateway only accepts session_* (compat/convert.go:27). v2 callers
  // pass raw cse_*; retag here so all callers can pass whatever they hold.
  // Idempotent for v1's session_* and bridgeMain's pre-converted compatSessionId.
  const compatId = toCompatSessionId(sessionId)
  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${compatId}`
  logForDebugging(`[bridge] Updating session title: ${compatId} → ${title}`)

  try {
    const response = await axios.patch(
      url,
      { title },
      { headers, timeout: 10_000, validateStatus: s => s < 500 },
    )

    if (response.status === 200) {
      logForDebugging(`[bridge] Session title updated successfully`)
    } else {
      const detail = extractErrorDetail(response.data)
      logForDebugging(
        `[bridge] Session title update failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      )
    }
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session title update request failed: ${errorMessage(err)}`,
    )
  }
}
