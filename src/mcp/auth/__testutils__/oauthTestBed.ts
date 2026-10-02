/**
 * A test bed for the MCP OAuth client: a real authorization server on an
 * ephemeral loopback port, and a credential store isolated in a temp dir.
 *
 * The server speaks enough OAuth to be driven end to end by the MCP SDK:
 * RFC 9728 protected-resource metadata, RFC 8414 server metadata, dynamic
 * client registration, an authorize endpoint that "approves" at once with a
 * 302 back to the redirect URI, a token endpoint that checks PKCE and rotates
 * refresh tokens, and an RFC 7009 revocation endpoint. Every request is
 * recorded, and `config` changes how it answers.
 *
 * The store side never reaches the OS vault. On Linux the secure storage asks
 * `secret-tool` first, so a stand-in that always refuses sits ahead of the
 * real one on PATH, and the plaintext store under CLAUDIN_CONFIG_DIR is what
 * ends up holding the secrets. `BROWSER` points at a stand-in that logs the
 * URL and exits 0, so no real browser is ever launched.
 */
import { afterEach, beforeEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Seen = {
  method: string
  path: string
  authorization: string | null
  form: URLSearchParams | null
  body: unknown
}

type Reply = Response | undefined

export type BedConfig = {
  /** Serve RFC 9728 metadata for /mcp pointing at this server as the AS. */
  protectedResource: boolean
  /** Where the RFC 8414 document lives. */
  metadataAt: 'root' | 'under-mcp' | 'nowhere'
  /** Status the root metadata path answers with when it is not served. */
  rootMetadataStatus: number
  /** Merged into the RFC 8414 document. */
  metadataExtra: Record<string, unknown>
  /** Dynamic registration either works or answers 500. */
  registration: 'open' | 'broken'
  /** expires_in for every token the server issues. */
  lifetime: number
  /** The authorize endpoint redirects back with this error instead of a code. */
  denyWith?: { error: string; error_description?: string }
  /** First say over a token request; return undefined to let the server answer. */
  onToken?: (form: URLSearchParams, attempt: number) => Reply
  /** First say over a revocation request. */
  onRevoke?: (form: URLSearchParams, authorization: string | null) => Reply
  /** What GET/POST /mcp answers with. */
  onResource?: () => Response
}

const DEFAULTS: BedConfig = {
  protectedResource: true,
  metadataAt: 'root',
  rootMetadataStatus: 404,
  metadataExtra: {},
  registration: 'open',
  lifetime: 3600,
}

export type AuthBed = {
  base: string
  mcpUrl: string
  config: BedConfig
  seen: Seen[]
  /** The requests that hit one path, in order. */
  hits(path: string): Seen[]
  /** Refresh tokens the server still honours. */
  liveRefresh: Set<string>
  /** Registered client ids, mapped to their secret when one was issued. */
  clients: Map<string, string | undefined>
  stop(): void
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const s256 = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')

/** Starts the authorization server. `tls` serves it over https with a throwaway self-signed cert. */
export function startAuthBed(
  overrides: Partial<BedConfig> = {},
  tls?: { cert: string; key: string },
): AuthBed {
  const config: BedConfig = { ...DEFAULTS, ...overrides }
  const seen: Seen[] = []
  const clients = new Map<string, string | undefined>()
  const grants = new Map<
    string,
    { challenge: string; redirect: string; client: string; scope: string | null }
  >()
  const liveRefresh = new Set<string>()
  let serial = 0
  let tokenAttempts = 0

  const issue = (scope: string | null) => {
    serial += 1
    const refresh = `refresh-${serial}`
    liveRefresh.add(refresh)
    return json(200, {
      access_token: `access-${serial}`,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: config.lifetime,
      ...(scope ? { scope } : {}),
    })
  }

  let origin = ''
  const document = () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    ...config.metadataExtra,
  })

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    ...(tls ? { tls } : {}),
    async fetch(req) {
      const url = new URL(req.url)
      const type = req.headers.get('content-type') ?? ''
      let form: URLSearchParams | null = null
      let body: unknown = null
      if (req.method === 'POST') {
        const text = await req.text()
        if (type.includes('application/x-www-form-urlencoded')) {
          form = new URLSearchParams(text)
        } else if (text) {
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }
        }
      }
      const authorization = req.headers.get('authorization')
      seen.push({ method: req.method, path: url.pathname, authorization, form, body })

      switch (url.pathname) {
        case '/.well-known/oauth-protected-resource/mcp':
          return config.protectedResource
            ? json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] })
            : json(404, {})
        case '/.well-known/oauth-authorization-server':
          return config.metadataAt === 'root'
            ? json(200, document())
            : json(config.rootMetadataStatus, {})
        case '/.well-known/oauth-authorization-server/mcp':
          return config.metadataAt === 'under-mcp' ? json(200, document()) : json(404, {})
        case '/register': {
          if (config.registration === 'broken') return json(500, { error: 'server_error' })
          const id = `client-${clients.size + 1}`
          clients.set(id, undefined)
          return json(201, { ...(body as object), client_id: id })
        }
        case '/authorize': {
          const redirect = url.searchParams.get('redirect_uri') ?? ''
          const back = new URL(redirect)
          back.searchParams.set('state', url.searchParams.get('state') ?? '')
          if (config.denyWith) {
            back.searchParams.set('error', config.denyWith.error)
            if (config.denyWith.error_description) {
              back.searchParams.set('error_description', config.denyWith.error_description)
            }
          } else {
            const code = `code-${grants.size + 1}`
            grants.set(code, {
              challenge: url.searchParams.get('code_challenge') ?? '',
              redirect,
              client: url.searchParams.get('client_id') ?? '',
              scope: url.searchParams.get('scope'),
            })
            back.searchParams.set('code', code)
          }
          return new Response(null, { status: 302, headers: { Location: back.toString() } })
        }
        case '/token': {
          tokenAttempts += 1
          const fields = form ?? new URLSearchParams()
          const early = config.onToken?.(fields, tokenAttempts)
          if (early) return early
          if (fields.get('grant_type') === 'authorization_code') {
            const grant = grants.get(fields.get('code') ?? '')
            if (!grant) return json(400, { error: 'invalid_grant' })
            if (s256(fields.get('code_verifier') ?? '') !== grant.challenge) {
              return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
            }
            if (fields.get('redirect_uri') !== grant.redirect) {
              return json(400, { error: 'invalid_grant', error_description: 'redirect mismatch' })
            }
            grants.delete(fields.get('code') ?? '')
            return issue(grant.scope)
          }
          if (fields.get('grant_type') === 'refresh_token') {
            const presented = fields.get('refresh_token') ?? ''
            if (!liveRefresh.delete(presented)) return json(400, { error: 'invalid_grant' })
            return issue(null)
          }
          return json(400, { error: 'unsupported_grant_type' })
        }
        case '/revoke':
          return config.onRevoke?.(form ?? new URLSearchParams(), authorization) ?? new Response(null, { status: 200 })
        case '/mcp':
          return config.onResource?.() ?? json(200, {})
        default:
          return json(404, {})
      }
    },
  })
  origin = `${tls ? 'https' : 'http'}://127.0.0.1:${server.port}`

  return {
    base: origin,
    mcpUrl: `${origin}/mcp`,
    config,
    seen,
    hits: path => seen.filter(r => r.path === path),
    liveRefresh,
    clients,
    stop: () => server.stop(true),
  }
}

/** A self-signed certificate for 127.0.0.1, made with the openssl CLI. */
export function makeLoopbackCert(dir: string): { cert: string; key: string } {
  const keyPath = join(dir, 'tls-key.pem')
  const certPath = join(dir, 'tls-cert.pem')
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
}

/**
 * Runs `body` with certificate checks off, for the self-signed test server.
 *
 * Bun watches this variable through assignments only (checked on Bun 1.3):
 * deleting it leaves whatever was last assigned in force, and after a delete
 * no later assignment is honoured for the rest of the process. So the way
 * back is to assign '1' (Bun's default, strict) and never delete. A variable
 * that was absent before stays '1' afterwards, which verifies certificates
 * exactly as absent does.
 */
export async function withSelfSignedTrust<T>(body: () => Promise<T>): Promise<T> {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    return await body()
  } finally {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = before ?? '1'
  }
}

const TOUCHED_ENV = [
  'CLAUDIN_CONFIG_DIR',
  'PATH',
  'BROWSER',
  'MCP_OAUTH_CALLBACK_PORT',
  'MCP_OAUTH_CLIENT_METADATA_URL',
  'MCP_CLIENT_SECRET',
] as const

export type IsolatedStore = {
  /** The per-test temp root. */
  root(): string
  /** CLAUDIN_CONFIG_DIR for this test. */
  configDir(): string
  /** The plaintext credential file the store falls back to. */
  credentialsPath(): string
  /** What the store holds right now (the parsed credential file, or null). */
  read(): Record<string, any> | null
  /** Replaces the credential file wholesale. */
  write(data: Record<string, unknown>): void
  /** Every argv the stand-in secret-tool was called with. */
  vaultCalls(): string[]
  /** Every URL handed to the stand-in browser. */
  browserUrls(): string[]
}

/**
 * Registers beforeEach/afterEach hooks in the calling file: a fresh temp dir
 * per test, CLAUDIN_CONFIG_DIR inside it, and the vault and browser stand-ins
 * ahead on PATH. Everything is put back afterwards.
 */
export function useIsolatedStore(): IsolatedStore {
  let dir = ''
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED_ENV.map(k => [k, process.env[k]]))
    dir = mkdtempSync(join(tmpdir(), 'mcp-auth-bed-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    mkdirSync(join(dir, 'config'))
    const vault = join(bin, 'secret-tool')
    writeFileSync(vault, `#!/bin/sh\necho "$*" >> "${join(dir, 'vault.log')}"\nexit 1\n`)
    chmodSync(vault, 0o755)
    const browser = join(bin, 'browser')
    writeFileSync(browser, `#!/bin/sh\necho "$1" >> "${join(dir, 'browser.log')}"\nexit 0\n`)
    chmodSync(browser, 0o755)

    process.env.CLAUDIN_CONFIG_DIR = join(dir, 'config')
    process.env.PATH = `${bin}:${saved.PATH ?? ''}`
    process.env.BROWSER = browser
    delete process.env.MCP_OAUTH_CALLBACK_PORT
    delete process.env.MCP_OAUTH_CLIENT_METADATA_URL
    delete process.env.MCP_CLIENT_SECRET
  })

  afterEach(() => {
    for (const key of TOUCHED_ENV) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    try {
      chmodSync(join(dir, 'config'), 0o755)
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  })

  const lines = (name: string) => {
    const file = join(dir, name)
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  }
  const credentialsPath = () => join(dir, 'config', '.credentials.json')

  return {
    root: () => dir,
    configDir: () => join(dir, 'config'),
    credentialsPath,
    read: () =>
      existsSync(credentialsPath()) ? JSON.parse(readFileSync(credentialsPath(), 'utf8')) : null,
    write: data => writeFileSync(credentialsPath(), JSON.stringify(data)),
    vaultCalls: () => lines('vault.log'),
    browserUrls: () => lines('browser.log'),
  }
}

/**
 * Plays the user's browser: follows the authorization URL to the server's
 * 302, then loads the redirect it points at. Returns the callback page.
 */
export async function approveInBrowser(
  authorizationUrl: string,
): Promise<{ status: number; html: string; callbackUrl: string }> {
  const consent = await fetch(authorizationUrl, { redirect: 'manual' })
  const callbackUrl = consent.headers.get('location') ?? ''
  const page = await fetch(callbackUrl)
  return { status: page.status, html: await page.text(), callbackUrl }
}

/** Loads a URL on the loopback callback server and returns the page. */
export async function visit(url: string): Promise<{ status: number; html: string }> {
  const page = await fetch(url)
  return { status: page.status, html: await page.text() }
}
