import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearSessionDisconnected,
  isSessionDisconnected,
  markSessionDisconnected,
  resetSessionDisconnectsForTests,
} from 'src/mcp/sessionDisconnects.js'

beforeEach(() => {
  resetSessionDisconnectsForTests()
})

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
// this session and does NOT edit settings.json. Both live inside a React hook
// that cannot be instantiated under `bun test`, so they are pinned at the
// source level — the same approach coordinatorMode.test.ts takes.
describe('the disconnect path in useManageMCPConnections', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./useManageMCPConnections.ts', import.meta.url)),
    'utf8',
  )
  const disconnectBody = src.slice(
    src.indexOf('const disconnectMcpServer = useCallback('),
  )

  test('exists and is exported from the hook', () => {
    expect(src).toContain('const disconnectMcpServer = useCallback(')
    expect(src).toMatch(/return \{[^}]*disconnectMcpServer[^}]*\}/)
  })

  test('never persists — that call is the whole difference from toggleMcpServer', () => {
    expect(disconnectBody).not.toContain('setMcpServerEnabled')
    // The function it is deliberately NOT is right above it and does persist,
    // so a source scan that found nothing anywhere would prove nothing.
    expect(src).toContain('setMcpServerEnabled(serverName, false)')
  })

  test('marks the session set before closing the transport', () => {
    // Ordering is load-bearing: clearServerCache trips `onclose`, which reads
    // the set synchronously to decide whether to start the reconnect loop.
    const mark = disconnectBody.indexOf('markSessionDisconnected(serverName)')
    const close = disconnectBody.indexOf('clearServerCache(serverName')
    expect(mark).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(mark)
  })

  test('the auto-reconnect guard consults the session set, not just the disk', () => {
    // Without this the disconnect is inert for http/sse/ws: the transport
    // closes and the backoff loop immediately dials it back.
    expect(src).toMatch(
      /isMcpServerDisabled\(client\.name\)\s*\|\|\s*isSessionDisconnected\(client\.name\)/,
    )
  })

  test('every deliberate re-dial clears the flag', () => {
    // Otherwise a server reconnected from /mcp comes up once and then never
    // auto-reconnects again for the rest of the session.
    const clears = src.match(/clearSessionDisconnected\(serverName\)/g) ?? []
    expect(clears.length).toBe(2)
  })
})
