// Adapted from opencode (MIT, Copyright (c) 2025 opencode):
// packages/opencode/src/plugin/openai/codex.ts
// packages/core/src/oauth/page.ts
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { getErrnoCode } from 'src/shared/errors.js'
import {
  asTrimmedString,
  CODEX_OAUTH_ISSUER,
  CODEX_OAUTH_ORIGINATOR,
  CODEX_OAUTH_SCOPE,
  escapeHtml,
  getCodexOAuthCallbackPort,
  getCodexOAuthClientId,
  isRecord,
  mintCodexApiKey,
  parseChatgptAccountId,
  parseJson,
  postCodexTokenForm,
} from 'src/providers/oauth/codexOAuthShared.js'

export type CodexOAuthTokens = {
  apiKey?: string
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
}

const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/auth/callback'
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const PKCE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
const PKCE_VERIFIER_LENGTH = 43
const CANCELLED_MESSAGE = 'Codex OAuth flow was cancelled.'
const INCOMPLETE_MESSAGE =
  'Codex OAuth completed, but the token response was missing credentials.'

type Pkce = { verifier: string; challenge: string }

type PendingLogin = {
  state: string
  pkce: Pkce
  redirectUri: string
  clientId: string
  /** Set once a valid callback is being redeemed; cancelling then waits for it. */
  redeeming: boolean
  resolve: (tokens: CodexOAuthTokens) => void
  reject: (error: Error) => void
}

async function generatePkce(): Promise<Pkce> {
  const verifier = Array.from(
    crypto.getRandomValues(new Uint8Array(PKCE_VERIFIER_LENGTH)),
  )
    .map(byte => PKCE_ALPHABET[byte % PKCE_ALPHABET.length])
    .join('')
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return { verifier, challenge: Buffer.from(digest).toString('base64url') }
}

function generateState(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    'base64url',
  )
}

function buildAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  pkce: Pkce
  state: string
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: CODEX_OAUTH_SCOPE,
    code_challenge: input.pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: input.state,
    originator: CODEX_OAUTH_ORIGINATOR,
  })
  return `${CODEX_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`
}

function busyPortMessage(port: number): string {
  return `Codex OAuth needs localhost:${port} for its callback. Close any app already using that port and try again.`
}

async function redeemAuthorizationCode(
  code: string,
  login: PendingLogin,
  signal: AbortSignal,
): Promise<CodexOAuthTokens> {
  const response = await postCodexTokenForm(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: login.redirectUri,
      client_id: login.clientId,
      code_verifier: login.pkce.verifier,
    },
    signal,
  )
  const text = await response.text()
  if (!response.ok) {
    const detail = text.trim()
    throw new Error(
      detail
        ? `Codex OAuth token exchange failed (${response.status}): ${detail}`
        : `Codex OAuth token exchange failed with status ${response.status}.`,
    )
  }
  const body = parseJson(text)
  const fields = isRecord(body) ? body : {}
  const accessToken = asTrimmedString(fields.access_token)
  const refreshToken = asTrimmedString(fields.refresh_token)
  if (!accessToken || !refreshToken) throw new Error(INCOMPLETE_MESSAGE)
  const idToken = asTrimmedString(fields.id_token)
  return {
    apiKey: idToken ? await mintCodexApiKey(idToken, signal) : undefined,
    accessToken,
    refreshToken,
    idToken,
    accountId:
      parseChatgptAccountId(idToken) ?? parseChatgptAccountId(accessToken),
  }
}

type PageCopy = { title: string; heading: string; message: string; footnote: string }

const SUCCESS_PAGE: PageCopy = {
  title: 'Codex Login Complete',
  heading: 'Codex login complete',
  message: 'You can return to Claudin now.',
  footnote: 'Claudin will finish activating your new Codex OAuth login.',
}

const CANCELLED_PAGE: PageCopy = {
  title: 'Codex Login Cancelled',
  heading: 'Codex login cancelled',
  message: 'The login was cancelled before it finished.',
  footnote: 'Close this window and retry in Claudin.',
}

function failurePage(message: string): PageCopy {
  return {
    title: 'Codex Login Failed',
    heading: 'Codex login failed',
    message,
    footnote: 'Close this window and retry in Claudin.',
  }
}

/** Self-contained and script-free, so an echoed error can never run in the page. */
function renderPage(copy: PageCopy): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(copy.title)}</title>
    <style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5}small{color:#666}</style>
  </head>
  <body>
    <h1>${escapeHtml(copy.heading)}</h1>
    <p>${escapeHtml(copy.message)}</p>
    <small>${escapeHtml(copy.footnote)}</small>
  </body>
</html>`
}

function sendPage(res: ServerResponse, status: number, copy: PageCopy): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(renderPage(copy))
}

/**
 * The browser half of the Codex (ChatGPT) login: a PKCE authorize URL, a
 * loopback server that receives the redirect, and the code redemption.
 * One service runs one login at a time.
 */
export class CodexOAuthService {
  private server: Server | undefined
  private pending: PendingLogin | undefined
  private abortController: AbortController | undefined
  private timeout: ReturnType<typeof setTimeout> | undefined
  private readonly callbackTimeoutMs: number

  constructor(options: { callbackTimeoutMs?: number } = {}) {
    this.callbackTimeoutMs =
      options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS
  }

  async startOAuthFlow(
    openAuthUrl: (authUrl: string) => Promise<void>,
  ): Promise<CodexOAuthTokens> {
    const configuredPort = getCodexOAuthCallbackPort()
    const clientId = getCodexOAuthClientId()
    const abortController = new AbortController()
    this.abortController = abortController
    const server = await this.listen(configuredPort)
    const { port } = server.address() as AddressInfo
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`
    const pkce = await generatePkce()
    const state = generateState()

    const tokens = new Promise<CodexOAuthTokens>((resolve, reject) => {
      this.pending = {
        state,
        pkce,
        redirectUri,
        clientId,
        redeeming: false,
        resolve,
        reject,
      }
    })
    this.timeout = setTimeout(() => {
      this.settle(login =>
        login.reject(
          new Error('Codex OAuth timed out waiting for the browser to return.'),
        ),
      )
    }, this.callbackTimeoutMs)
    this.timeout.unref?.()

    try {
      // cleanup() during the bind has no login to reject yet; it leaves the signal aborted.
      if (abortController.signal.aborted) throw new Error(CANCELLED_MESSAGE)
      await openAuthUrl(buildAuthorizeUrl({ clientId, redirectUri, pkce, state }))
      return await tokens
    } finally {
      this.stop()
    }
  }

  /** Cancels a running login. A callback already being redeemed answers the browser first. */
  cleanup(): void {
    this.abortController?.abort()
    const pending = this.pending
    if (!pending || pending.redeeming) return
    this.settle(login => login.reject(new Error(CANCELLED_MESSAGE)))
    this.stop()
  }

  private listen(port: number): Promise<Server> {
    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', error => {
        this.server = undefined
        // Bun's bind error message omits EADDRINUSE; the code is reliable on Bun and Node.
        reject(
          getErrnoCode(error) === 'EADDRINUSE'
            ? new Error(busyPortMessage(port))
            : error,
        )
      })
      server.listen(port, CALLBACK_HOST, () => resolve(server))
    })
  }

  private stop(): void {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    this.server?.close()
    this.server = undefined
  }

  /** Hands the pending login to `finish` exactly once. */
  private settle(finish: (login: PendingLogin) => void): void {
    const login = this.pending
    if (!login) return
    this.pending = undefined
    finish(login)
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const login = this.pending
    if (!login || login.redeeming) {
      sendPage(res, 400, failurePage('No Codex login is waiting for this callback.'))
      return
    }

    const rejection = this.validateCallback(url.searchParams, login)
    if (rejection) {
      sendPage(res, 400, failurePage(rejection))
      this.settle(pending => pending.reject(new Error(rejection)))
      return
    }

    const signal = this.abortController?.signal ?? new AbortController().signal
    login.redeeming = true
    try {
      const tokens = await redeemAuthorizationCode(
        url.searchParams.get('code') ?? '',
        login,
        signal,
      )
      if (signal.aborted) throw new Error(CANCELLED_MESSAGE)
      sendPage(res, 200, SUCCESS_PAGE)
      this.settle(pending => pending.resolve(tokens))
    } catch (error) {
      if (signal.aborted) {
        sendPage(res, 200, CANCELLED_PAGE)
        this.settle(pending => pending.reject(new Error(CANCELLED_MESSAGE)))
        return
      }
      const failure = error instanceof Error ? error : new Error(String(error))
      sendPage(res, 400, failurePage(failure.message))
      this.settle(pending => pending.reject(failure))
    }
  }

  /** The reason a callback is refused, or undefined when it can be redeemed. */
  private validateCallback(
    params: URLSearchParams,
    login: PendingLogin,
  ): string | undefined {
    if (params.get('state') !== login.state) return 'Invalid state parameter'
    const error = asTrimmedString(params.get('error'))
    if (error) return asTrimmedString(params.get('error_description')) ?? error
    if (!asTrimmedString(params.get('code'))) return 'Missing authorization code'
    return undefined
  }
}
