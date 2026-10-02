/**
 * Test-only plumbing for the Codex OAuth characterization suites.
 *
 * Two boundaries are replaced, nothing else:
 *   - the OpenAI issuer (`https://auth.openai.com`) — every request to it is
 *     re-addressed to a real HTTP server on an ephemeral 127.0.0.1 port that
 *     records what arrived and answers from a script the test supplies;
 *   - the OS keyring — a stand-in `secret-tool` that always fails sits first on
 *     PATH, so credential storage falls through to the plaintext file under a
 *     per-test `CLAUDIN_CONFIG_DIR`. The user's real keyring is never touched.
 */
import { afterEach, beforeEach } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  getGlobalConfig,
  saveGlobalConfig,
} from 'src/platform/config/config.js'

const ISSUER_ORIGIN = 'https://auth.openai.com'

export type IssuerCall = {
  method: string
  path: string
  contentType: string | null
  form: Record<string, string>
}

export type IssuerAnswer = {
  status?: number
  /** A string is sent verbatim; anything else is JSON-encoded. */
  body?: unknown
}

export type FakeIssuer = {
  calls: IssuerCall[]
  callsOfGrant(grant: string): IssuerCall[]
  stop(): void
}

/**
 * Starts the stand-in issuer and points `fetch` at it. `answer` sees each
 * request after it is recorded, and may await before replying.
 */
export function startFakeIssuer(
  answer: (call: IssuerCall) => IssuerAnswer | Promise<IssuerAnswer>,
): FakeIssuer {
  const calls: IssuerCall[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const raw = await req.text()
      const call: IssuerCall = {
        method: req.method,
        path: new URL(req.url).pathname,
        contentType: req.headers.get('content-type'),
        form: Object.fromEntries(new URLSearchParams(raw)),
      }
      calls.push(call)
      const reply = await answer(call)
      const payload =
        typeof reply.body === 'string' || reply.body === undefined
          ? (reply.body ?? '')
          : JSON.stringify(reply.body)
      return new Response(payload, { status: reply.status ?? 200 })
    },
  })

  const localOrigin = `http://127.0.0.1:${server.port}`
  const passThrough = globalThis.fetch
  const rerouted = (input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input)
    if (target.startsWith(ISSUER_ORIGIN)) {
      return passThrough(localOrigin + target.slice(ISSUER_ORIGIN.length), init)
    }
    return passThrough(input, init)
  }
  globalThis.fetch = Object.assign(rerouted, passThrough)

  return {
    calls,
    callsOfGrant: grant => calls.filter(c => c.form.grant_type === grant),
    stop() {
      globalThis.fetch = passThrough
      server.stop(true)
    },
  }
}

export const REFRESH_GRANT = 'refresh_token'
export const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
export const AUTH_CODE_GRANT = 'authorization_code'

/** An unsigned JWT whose payload is `claims`. */
export function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return [encode({ alg: 'none' }), encode(claims), 'unsigned'].join('.')
}

/** Seconds-since-epoch, `offsetMs` away from now — the unit JWT `exp` uses. */
export function expIn(offsetMs: number): number {
  return Math.floor((Date.now() + offsetMs) / 1000)
}

const TOUCHED_ENV = [
  'CLAUDIN_CONFIG_DIR',
  'PATH',
  'CLAUDIN_SIMPLE',
  'CODEX_OAUTH_CLIENT_ID',
  'CODEX_OAUTH_CALLBACK_PORT',
  'CODEX_API_KEY',
] as const

export type CodexSandbox = {
  /** The per-test `CLAUDIN_CONFIG_DIR`. */
  configDir: string
  /** Where the plaintext credential store lives inside `configDir`. */
  credentialsPath: string
}

/**
 * Registers per-test setup in the CALLING file's scope: a fresh temp tree,
 * `CLAUDIN_CONFIG_DIR` inside it, the failing keyring stub on PATH, the Codex
 * env knobs cleared, and no provider profile active. Everything is put back
 * afterwards, env first and the temp tree last.
 */
export function useCodexSandbox(): CodexSandbox {
  const current: CodexSandbox = { configDir: '', credentialsPath: '' }
  let root = ''
  let savedEnv: Partial<Record<(typeof TOUCHED_ENV)[number], string>> = {}
  let savedProfiles: ReturnType<typeof getGlobalConfig>['providerProfiles']
  let savedActiveId: string | undefined

  beforeEach(() => {
    savedEnv = {}
    for (const key of TOUCHED_ENV) {
      if (process.env[key] !== undefined) savedEnv[key] = process.env[key]
    }
    root = mkdtempSync(join(tmpdir(), 'codex-oauth-char-'))
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const keyring = join(bin, 'secret-tool')
    writeFileSync(keyring, '#!/bin/sh\nexit 1\n')
    chmodSync(keyring, 0o755)

    current.configDir = join(root, 'config')
    current.credentialsPath = join(current.configDir, '.credentials.json')
    process.env.CLAUDIN_CONFIG_DIR = current.configDir
    process.env.PATH = [bin, savedEnv.PATH ?? ''].join(delimiter)
    for (const key of TOUCHED_ENV.slice(2)) delete process.env[key]

    const config = getGlobalConfig()
    savedProfiles = config.providerProfiles
    savedActiveId = config.activeProviderProfileId
    saveGlobalConfig(prev => ({
      ...prev,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))
  })

  afterEach(() => {
    saveGlobalConfig(prev => ({
      ...prev,
      providerProfiles: savedProfiles,
      activeProviderProfileId: savedActiveId,
    }))
    for (const key of TOUCHED_ENV) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  return current
}
