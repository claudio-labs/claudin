import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { enterWorld, leaveWorld, localRecord, setUserServers, withEnv } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import {
  mountManager,
  quiet,
  socketConfig,
  startSocketServer,
  stopAllSocketServers,
  unmountAll,
  until,
  type Mounted,
  type SocketServer,
} from 'src/mcp/__testutils__/connectionRig.js'
import {
  clearSessionDisconnected,
  isSessionDisconnected,
  markSessionDisconnected,
  resetSessionDisconnectsForTests,
} from 'src/mcp/sessionDisconnects.js'

beforeEach(() => {
  resetSessionDisconnectsForTests()
})

const SLOW = 20_000

function written(server: SocketServer): Record<string, unknown> {
  const { scope: _scope, ...rest } = socketConfig(server)
  return rest
}

describe('sessionDisconnects', () => {
  test('a marked server reads back as disconnected, others do not', () => {
    markSessionDisconnected('github')
    expect(isSessionDisconnected('github')).toBe(true)
    expect(isSessionDisconnected('sentry')).toBe(false)
  })

  test('clearing takes the disconnect back', () => {
    markSessionDisconnected('github')
    clearSessionDisconnected('github')
    expect(isSessionDisconnected('github')).toBe(false)
  })

  test('clearing a server that was never marked is a no-op, not an error', () => {
    expect(() => clearSessionDisconnected('never-seen')).not.toThrow()
  })
})

// The claim these guard is the one the user actually made: `x` disconnects for
// this session and does NOT edit settings.json.
describe('the disconnect path in useManageMCPConnections', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./useManageMCPConnections.ts', import.meta.url)),
    'utf8',
  )

  test('exists and is exported from the hook', () => {
    expect(src).toContain('const disconnectMcpServer = useCallback(')
    expect(src).toMatch(/return \{[^}]*disconnectMcpServer[^}]*\}/)
  })

  // The four checks below used to scan the hook's source text; the rewrite
  // moved that code into src/mcp/connectionManager/, so each now asserts the
  // same behaviour through the mounted manager.
  describe('through the mounted manager', () => {
    let restoreEnv: () => void
    beforeEach(() => {
      enterWorld()
      restoreEnv = withEnv({ MCP_TIMEOUT: '45000' })
    })
    afterEach(async () => {
      await unmountAll()
      stopAllSocketServers()
      restoreEnv()
      leaveWorld()
    })

    async function twoRemote(): Promise<{ sock: SocketServer; m: Mounted }> {
      const sock = startSocketServer()
      const other = startSocketServer()
      setUserServers({ sock: written(sock), other: written(other) })
      const m = await mountManager()
      await m.reaches('sock', 'connected')
      await m.reaches('other', 'connected')
      return { sock, m }
    }

    test('never persists — that call is the whole difference from toggleMcpServer', async () => {
      const { m } = await twoRemote()
      await m.disconnect('sock')
      await m.reaches('sock', 'disabled')
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
      await m.toggle('other')
      await m.reaches('other', 'disabled')
      expect(localRecord().disabledMcpServers).toEqual(['other'])
    }, SLOW)

    test('marks the session set before closing the transport', async () => {
      const { sock, m } = await twoRemote()
      await m.disconnect('sock')
      expect(isSessionDisconnected('sock')).toBe(true)
      await until('the session to close', () => sock.open() === 0)
      await quiet(300)
      expect(sock.sessions()).toBe(1)
      expect(m.client('sock')?.type).toBe('disabled')
    }, SLOW)

    test('the auto-reconnect guard consults the session set, not just the disk', async () => {
      const { sock } = await twoRemote()
      markSessionDisconnected('sock')
      sock.dropSessions()
      await quiet(400)
      expect(sock.sessions()).toBe(1)
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
    }, SLOW)

    test('every deliberate re-dial clears the flag', async () => {
      const { m } = await twoRemote()
      const redials = [(name: string) => m.reconnect(name), (name: string) => m.toggle(name)]
      for (const redial of redials) {
        await m.disconnect('sock')
        await m.reaches('sock', 'disabled')
        expect(isSessionDisconnected('sock')).toBe(true)
        await redial('sock')
        expect(isSessionDisconnected('sock')).toBe(false)
        await m.reaches('sock', 'connected')
      }
    }, SLOW)
  })
})
