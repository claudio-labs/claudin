/**
 * Rig for the remote-session suites: a fake Anthropic sessions API on an
 * ephemeral local port, scratch credentials under a temp CLAUDIN_CONFIG_DIR,
 * and a hook mounted inside a real Ink root drawn on the fake terminal.
 *
 * The base URL of the Anthropic API is fixed in the product (only an
 * allow-listed FedStart host may replace it), so the one seam is the OAuth
 * constants module: `pointAnthropicApiAt` swaps its `BASE_API_URL` for the
 * local server and leaves every other field as it is.
 */
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React, { type ReactNode } from 'react'
import type { ServerWebSocket } from 'bun'
import * as oauthConstants from 'src/shared/constants/oauth.js'
import { resetStateForTests } from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests, saveGlobalConfig } from 'src/platform/config/config.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'

// --- the API base -----------------------------------------------------------

const originalOauth = { ...oauthConstants }
let apiBase: string | null = null

mock.module('src/shared/constants/oauth.js', () => ({
  ...originalOauth,
  getOauthConfig: () => {
    const config = originalOauth.getOauthConfig()
    return apiBase === null ? config : { ...config, BASE_API_URL: apiBase }
  },
}))

/** Sends every Anthropic API call, HTTP and WebSocket, to `base`. */
export function pointAnthropicApiAt(base: string | null): void {
  apiBase = base
}

/**
 * Back to the real base, for an afterAll. The stand-in module stays
 * registered, as a pass-through: another suite of this rig may run later in
 * the same process, and Bun registers a module's stand-in only once per
 * import of this file.
 */
export function restoreAnthropicApi(): void {
  apiBase = null
}

// --- environment ------------------------------------------------------------

const TOUCHED_ENV = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_REMOTE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'HOME',
] as const

export type Scratch = {
  dir: string
  configDir: string
  /** Puts every variable this rig touched back the way it was. */
  dispose: () => void
}

/**
 * A fresh temp directory that holds the config dir, with the variables the
 * unit reads cleared, proxies off, and git kept away from the user's config.
 */
export function openScratch(prefix: string): Scratch {
  const saved = new Map<string, string | undefined>()
  for (const key of TOUCHED_ENV) saved.set(key, process.env[key])
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const configDir = join(dir, 'config')
  for (const key of TOUCHED_ENV) delete process.env[key]
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.NO_PROXY = '127.0.0.1,localhost'
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.HOME = dir
  resetStateForTests()
  resetGlobalConfigForTests()
  clearOAuthTokenCache()
  return {
    dir,
    configDir,
    dispose: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetStateForTests()
      resetGlobalConfigForTests()
      clearOAuthTokenCache()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export type Login = {
  accessToken: string
  organizationUuid: string
  subscriptionType?: 'pro' | 'max' | 'team' | 'enterprise'
}

/**
 * A claude.ai login: the token in the plaintext credentials file of the
 * scratch config dir, the organization in the global config.
 */
export function signIn(scratch: Scratch, login: Login): void {
  mkdirSync(scratch.configDir, { recursive: true })
  writeFileSync(
    join(scratch.configDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: login.accessToken,
        refreshToken: null,
        expiresAt: null,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: login.subscriptionType ?? 'max',
        rateLimitTier: null,
      },
    }),
  )
  saveGlobalConfig(config => ({
    ...config,
    oauthAccount: {
      ...(config.oauthAccount ?? {}),
      organizationUuid: login.organizationUuid,
    } as typeof config.oauthAccount,
  }))
  clearOAuthTokenCache()
}

// --- the fake sessions API --------------------------------------------------

export type Handshake = {
  path: string
  query: Record<string, string>
  authorization: string | null
  version: string | null
}

export type ApiCall = {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

type Answer = { status: number; body: unknown }

/**
 * Speaks the part of the Anthropic sessions API the unit reaches: the
 * subscribe socket, and whatever HTTP routes a test answers with `answer`.
 * An HTTP route nobody answered gets 404.
 */
export class FakeSessionsApi {
  readonly handshakes: Handshake[] = []
  readonly calls: ApiCall[] = []
  /** What the client wrote on any socket, parsed. */
  readonly fromClient: Array<Record<string, unknown>> = []
  /** Close codes the server saw, one per closed socket. */
  readonly closes: number[] = []
  private readonly open = new Set<ServerWebSocket<unknown>>()
  private readonly answers = new Map<string, Answer>()
  private readonly server: ReturnType<typeof Bun.serve>

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request, server) => {
        const url = new URL(request.url)
        const query = Object.fromEntries(url.searchParams)
        if (url.pathname === TICK) return new Response('tick')
        if (url.pathname.includes('/subscribe')) {
          this.handshakes.push({
            path: url.pathname,
            query,
            authorization: request.headers.get('authorization'),
            version: request.headers.get('anthropic-version'),
          })
          if (server.upgrade(request, { data: undefined })) return undefined
          return new Response('upgrade expected', { status: 400 })
        }
        const text = await request.text()
        this.calls.push({
          method: request.method,
          path: url.pathname,
          query,
          headers: Object.fromEntries(request.headers),
          body: text ? JSON.parse(text) : null,
        })
        const answer = this.answers.get(`${request.method} ${url.pathname}`)
        if (!answer) return Response.json({ error: { message: 'no route' } }, { status: 404 })
        return Response.json(answer.body, { status: answer.status })
      },
      websocket: {
        open: ws => {
          this.open.add(ws)
        },
        message: (_ws, data) => {
          this.fromClient.push(JSON.parse(String(data)))
        },
        close: (ws, code) => {
          this.open.delete(ws)
          this.closes.push(code)
        },
      },
    })
  }

  get base(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  get openSockets(): number {
    return this.open.size
  }

  answer(method: string, path: string, status: number, body: unknown = {}): void {
    this.answers.set(`${method} ${path}`, { status, body })
  }

  callsTo(method: string, path: string): ApiCall[] {
    return this.calls.filter(call => call.method === method && call.path === path)
  }

  /** Sends one frame, as JSON, on every open socket. */
  push(frame: unknown): void {
    for (const ws of this.open) ws.send(JSON.stringify(frame))
  }

  /** Sends raw text on every open socket. */
  pushRaw(text: string): void {
    for (const ws of this.open) ws.send(text)
  }

  /** Closes every open socket from the server side with `code`. */
  hangUp(code: number): void {
    for (const ws of this.open) ws.close(code, 'test')
  }

  /**
   * Waits for `check` while the test has faked the clock. Bun's fake timers
   * freeze every sleep, so the wait yields by a round trip to this server:
   * real I/O, which lets socket frames and HTTP replies come in.
   */
  async waitOnFakeClock(check: () => boolean, roundTrips = 400): Promise<void> {
    for (let left = roundTrips; !check(); left--) {
      if (left <= 0) throw new Error('waitOnFakeClock: condition never held')
      await fetch(`${this.base}${TICK}`).then(response => response.text())
    }
  }

  stop(): void {
    this.server.stop(true)
  }
}

const TICK = '/__tick'

// --- mounting a hook --------------------------------------------------------

export type HookUnderTest<P, R> = {
  /** The value the hook returned on its latest render. */
  current: () => R
  /** Every value it returned, render by render. */
  returns: R[]
  /** Renders again with new props. */
  rerender: (props: P) => Promise<void>
  unmount: () => void
  terminal: FakeTerminal
}

const mounted = new Set<() => void>()

/**
 * Runs `useIt(props)` inside a component of a real Ink root. `around` wraps
 * that component (a provider, say).
 */
export async function mountHook<P, R>(
  useIt: (props: P) => R,
  props: P,
  around: (child: ReactNode) => ReactNode = child => child,
): Promise<HookUnderTest<P, R>> {
  const returns: R[] = []
  function Carrier({ args }: { args: P }): null {
    returns.push(useIt(args))
    return null
  }
  const terminal = createFakeTerminal()
  const root = await createRoot({
    stdout: terminal.stdout,
    stdin: terminal.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  root.render(around(<Carrier args={props} />))
  await waitFor(() => returns.length > 0)
  let gone = false
  const unmount = () => {
    if (gone) return
    gone = true
    mounted.delete(unmount)
    root.unmount()
    terminal.close()
  }
  mounted.add(unmount)
  return {
    current: () => returns[returns.length - 1] as R,
    returns,
    rerender: async next => {
      const before = returns.length
      root.render(around(<Carrier args={next} />))
      await waitFor(() => returns.length > before)
    },
    unmount,
    terminal,
  }
}

/** Unmounts whatever a failed test left mounted. */
export function unmountAll(): void {
  for (const unmount of [...mounted]) unmount()
}

/** Polls `check` until it holds; throws after `ms`. */
export async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  // Counted in sleeps, not read off Date: a test may have faked the clock.
  for (let left = Math.ceil(ms / 5); !check(); left--) {
    if (left <= 0) throw new Error('waitFor: condition never held')
    await Bun.sleep(5)
  }
}

/** Lets pending socket frames and promise callbacks run. */
export async function settle(ms = 40): Promise<void> {
  await Bun.sleep(ms)
}

// --- recording state setters ------------------------------------------------

export type Cell<T> = {
  /** A React-style setter: a value, or an updater of the previous one. */
  set: (next: T | ((previous: T) => T)) => void
  value: () => T
  /** Every value it has held, the first one included. */
  history: T[]
}

/** Stands in for a `useState` setter the caller of a hook owns. */
export function cell<T>(first: T): Cell<T> {
  let value = first
  const history: T[] = [first]
  return {
    set: next => {
      value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next
      history.push(value)
    },
    value: () => value,
    history,
  }
}
