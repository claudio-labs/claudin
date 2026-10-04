/**
 * Characterization of the second start-up phase: the claude.ai connectors.
 *
 * The connector listing is a network call to the claude.ai API behind an
 * OAuth login, so it is the one boundary stubbed here: the session holds a
 * token with the `user:mcp_servers` scope, and axios answers the listing
 * from a table. Everything after the listing is real. HTTPS_PROXY points at
 * a local listener that counts connections and drops them, so nothing leaves
 * the machine and a connector that must not be dialled is seen not to be;
 * an opted-in connector shows it was dialled by reaching an outcome (the
 * rig's token cannot open the proxy). Claudin's default privacy level never asks for
 * the listing, so the suite opts in to nonessential traffic, except in the
 * row that pins that default.
 */
import axios, { type AxiosAdapter } from 'axios'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  enterWorld,
  leaveWorld,
  setToggles,
  setUserServers,
  withEnv,
  writeManagedMcp,
  writeSettings,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'
import {
  killAllStdioServers,
  mountManager,
  quiet,
  socketConfig,
  startSocketServer,
  stdioServer,
  stopAllSocketServers,
  unmountAll,
  until,
  type Mounted,
} from 'src/mcp/__testutils__/connectionRig.js'
import { clearClaudeAIMcpConfigsCache } from 'src/mcp/claudeai.js'
import { emitAuthChanged } from 'src/providers/auth/authChanged.js'
import { getClaudeAIOAuthTokens } from 'src/providers/auth/auth.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'

const SLOW = 20_000
const NOTES = 'claude.ai Notes'
const DRIVE = 'claude.ai Drive'

type Listed = { id: string; display_name: string; url: string }

let world: World
let listed: Listed[] = []
let listingCalls = 0
let dialled = 0
/** A request line for 127.0.0.1 or localhost: a stray from another file, never a connector. */
const LOOPBACK_TARGET = /^\S+ (?:https?:\/\/)?(?:127\.0\.0\.1|localhost)[:/]/
let proxy: { port: number; stop: (closeActive?: boolean) => void } | undefined
let restoreEnv: () => void
const adapterBefore = axios.defaults.adapter

const answerListing: AxiosAdapter = async config => {
  if (!String(config.url).includes('/v1/mcp_servers')) throw new Error(`unexpected request in test: ${config.url}`)
  listingCalls++
  return { data: { data: listed }, status: 200, statusText: 'OK', headers: {}, config }
}

beforeEach(() => {
  world = enterWorld()
  // The claude.ai listing is memoized for the process; an earlier file
  // (the capabilities suite logs in and lists) may have filled it.
  clearClaudeAIMcpConfigsCache()
  listed = []
  listingCalls = 0
  dialled = 0
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      // Count the request, not the socket: a connection a previous file left
      // retrying to its own loopback server can reach this proxy too.
      data(socket, chunk) {
        const requestLine = String(chunk).split('\r\n')[0] ?? ''
        if (!LOOPBACK_TARGET.test(requestLine)) dialled++
        socket.end()
      },
    },
  })
  proxy = listener
  restoreEnv = withEnv({
    HTTPS_PROXY: `http://127.0.0.1:${listener.port}`,
    HTTP_PROXY: `http://127.0.0.1:${listener.port}`,
    https_proxy: undefined,
    http_proxy: undefined,
    // Loopback servers (the witness's peers) are reached directly.
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: undefined,
    // Claudin's default privacy level skips the listing; this suite opts in.
    CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC: '0',
    ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC: undefined,
    DISABLE_TELEMETRY: undefined,
    ENABLE_CLAUDEAI_MCP_SERVERS: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  })
  getClaudeAIOAuthTokens.cache.set(undefined, {
    accessToken: 'connection-rig-token',
    refreshToken: null,
    expiresAt: null,
    scopes: ['user:inference', 'user:mcp_servers'],
    subscriptionType: null,
    rateLimitTier: null,
  })
  axios.defaults.adapter = answerListing
})

afterEach(async () => {
  await unmountAll()
  axios.defaults.adapter = adapterBefore
  getClaudeAIOAuthTokens.cache.delete(undefined)
  proxy?.stop(true)
  stopAllSocketServers()
  killAllStdioServers()
  restoreEnv()
  leaveWorld()
})

function connector(name: string, url = `https://connectors.example.test/${name.replace(/\W/g, '')}`): Listed {
  return { id: `id-${name}`, display_name: name.replace('claude.ai ', ''), url }
}

/** Mounts, and waits until the listing was read and a local witness connected. */
async function mountWithWitness(props: { strict?: boolean; dynamic?: Record<string, ScopedMcpServerConfig> } = {}): Promise<Mounted> {
  const witness = stdioServer(world.root, 'witness')
  const dynamic = { witness: { ...witness.config, scope: 'dynamic' } as ScopedMcpServerConfig, ...props.dynamic }
  const m = await mountManager({ ...props, dynamic })
  await m.reaches('witness', 'connected')
  await quiet(300)
  return m
}

describe('claude.ai connectors', () => {
  test(
    'are listed once per start; one not opted into is shown disabled and never dialled',
    async () => {
      listed = [connector(NOTES)]
      const m = await mountWithWitness()
      await m.reaches(NOTES, 'disabled')
      await quiet(200)
      expect(listingCalls).toBe(1)
      expect(dialled).toBe(0)
      expect(m.journey(NOTES).filter(t => t !== 'absent')).toEqual(['disabled'])
      expect(m.client(NOTES)?.config).toMatchObject({ type: 'claudeai-proxy', scope: 'claudeai', id: `id-${NOTES}` })
    },
    SLOW,
  )

  test(
    'one the user opted into is shown pending and then dialled',
    async () => {
      listed = [connector(NOTES), connector(DRIVE)]
      setToggles({ enabled: [NOTES] })
      const m = await mountWithWitness()
      // The rig's token cannot open the proxy, so the attempt ends failed;
      // reaching an outcome at all is what shows it was dialled.
      await m.reaches(NOTES, 'failed', 'needs-auth', 'connected')
      expect(m.journey(NOTES).filter(t => t !== 'absent')[0]).toBe('pending')
      expect(m.journey(DRIVE).filter(t => t !== 'absent')).toEqual(['disabled'])
    },
    SLOW,
  )

  type Gate = { why: string; arrange: (m?: never) => void; props?: { strict?: boolean }; listingCalls: number }
  const gates: Gate[] = [
    {
      // By URL: a connector's display name is not a valid `serverName`, and
      // the settings schema rejects the whole policy file over it.
      why: 'the managed policy denies its URL: never shown, never dialled',
      arrange: () => writeSettings('policy', { deniedMcpServers: [{ serverUrl: 'https://connectors.example.test/*' }] }),
      listingCalls: 1,
    },
    {
      why: "Claudin's default privacy level is on: the listing is never requested",
      arrange: () => {
        delete process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
      },
      listingCalls: 0,
    },
    {
      why: 'strict mode: the listing is never requested',
      arrange: () => {},
      props: { strict: true },
      listingCalls: 0,
    },
    {
      why: 'a managed-mcp.json exists: the listing is never requested',
      arrange: () => {
        const corp = stdioServer(world.root, 'corp')
        const { scope: _scope, ...asWritten } = corp.config
        writeManagedMcp({ mcpServers: { corp: asWritten } })
      },
      listingCalls: 0,
    },
  ]
  for (const gate of gates) {
    test(
      `when ${gate.why}`,
      async () => {
        listed = [connector(NOTES)]
        setToggles({ enabled: [NOTES] })
        gate.arrange()
        const m = await mountWithWitness(gate.props)
        await quiet(200)
        expect({ shown: m.client(NOTES)?.type ?? 'absent', listingCalls, dialled }).toEqual({
          shown: 'absent',
          listingCalls: gate.listingCalls,
          dialled: 0,
        })
      },
      SLOW,
    )
  }

  test(
    'one that points at the same URL as an enabled manual server is dropped in favour of the manual one',
    async () => {
      const ws = startSocketServer({ tools: ['t'] })
      const { scope: _scope, ...manual } = socketConfig(ws)
      setUserServers({ mine: manual })
      listed = [connector(NOTES, ws.url)]
      setToggles({ enabled: [NOTES] })
      const m = await mountWithWitness()
      await m.reaches('mine', 'connected')
      await quiet(200)
      expect(listingCalls).toBe(1)
      expect(m.client(NOTES)).toBeUndefined()
      expect(dialled).toBe(0)
    },
    SLOW,
  )

  test(
    'are listed again when the login changes',
    async () => {
      listed = [connector(NOTES)]
      const m = await mountWithWitness()
      await m.reaches(NOTES, 'disabled')
      expect(listingCalls).toBe(1)
      listed = [connector(NOTES), connector(DRIVE)]
      emitAuthChanged()
      await until('a second listing', () => listingCalls === 2)
      await m.reaches(DRIVE, 'disabled')
      // A connector already listed is not listed twice.
      expect(m.state().mcp.clients.filter(c => c.name === NOTES)).toHaveLength(1)
    },
    SLOW,
  )
})
