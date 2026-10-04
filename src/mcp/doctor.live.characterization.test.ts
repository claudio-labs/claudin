/**
 * Characterization of the doctor's live checks (src/mcp/doctor.ts):
 * which configured servers it starts, what each outcome reports, and that no
 * process outlives the call.
 *
 * Real config in a temp world (see mcpConfigWorld), real stdio MCP servers
 * written as scripts into it (see stdioProbeServers), and a local HTTP port for
 * the remote rows. Nothing is stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { doctorAllServers, doctorServer, type McpDoctorReport } from 'src/mcp/doctor.js'
import { setIsInteractive } from 'src/platform/bootstrap/state.js'
import {
  addPlugin,
  enterWorld,
  leaveWorld,
  setLocalServers,
  setToggles,
  setUserServers,
  writeManagedMcp,
  writeMcpJson,
  writeSettings,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'
import {
  installProbeServers,
  reapProbeServers,
  type ProbeServers,
} from 'src/mcp/__testutils__/stdioProbeServers.js'

type Globals = { MACRO?: { VERSION: string } }
const globals = globalThis as unknown as Globals
let macroBefore: Globals['MACRO']
let homeBefore: string | undefined

let w: World
let probes: ProbeServers

beforeAll(() => {
  // The bundle inlines MACRO; under `bun test` the connection code needs it defined.
  macroBefore = globals.MACRO
  globals.MACRO ??= { VERSION: '0.0.0-doctor-char' }
  homeBefore = process.env.HOME
})

afterAll(() => {
  globals.MACRO = macroBefore
})

beforeEach(() => {
  w = enterWorld()
  const home = join(w.root, 'user-home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  probes = installProbeServers(w.root)
})

afterEach(() => {
  reapProbeServers(probes)
  if (homeBefore === undefined) delete process.env.HOME
  else process.env.HOME = homeBefore
  leaveWorld()
})

const only = (report: McpDoctorReport) => {
  expect(report.servers).toHaveLength(1)
  return report.servers[0]!
}
const codes = (report: McpDoctorReport) => only(report).findings.map(f => f.code)

describe('one live check per outcome', () => {
  test('a server that completes the handshake is connected and healthy', async () => {
    setLocalServers({ fine: probes.answering() })

    const report = await doctorServer('fine', { configOnly: false })
    const server = only(report)

    expect(probes.started()).toHaveLength(1)
    expect(server.liveCheck.attempted).toBe(true)
    expect(server.liveCheck.result).toBe('connected')
    expect(server.liveCheck.error).toBeUndefined()
    expect(server.liveCheck.durationMs).toBeGreaterThanOrEqual(0)
    expect(server.findings).toEqual([])
    expect(report.summary).toEqual({ totalReports: 1, healthy: 1, warnings: 0, blocking: 0 })
  })

  test('a server that dies before answering fails, blocking, with the connection error', async () => {
    setLocalServers({ crashy: probes.dying() })

    const report = await doctorServer('crashy', { configOnly: false })
    const server = only(report)

    expect(probes.started()).toHaveLength(1)
    expect(server.liveCheck).toMatchObject({ attempted: true, result: 'failed' })
    expect(server.liveCheck.error).toEqual(expect.any(String))
    expect(server.liveCheck.durationMs).toBeGreaterThanOrEqual(0)
    const [finding] = server.findings
    expect(server.findings).toHaveLength(1)
    expect(finding).toMatchObject({ code: 'health.failed', severity: 'error', blocking: true, serverName: 'crashy' })
    expect(finding!.message).toContain('crashy')
    expect(finding!.message).toContain(server.liveCheck.error!)
    expect(finding!.remediation).toEqual(expect.any(String))
    expect(finding!.sourcePath).toBe(server.definitions[0]!.sourcePath)
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 0, blocking: 1 })
  })

  test('a stdio command missing from PATH gets its own code and a PATH remedy', async () => {
    setLocalServers({ ghost: probes.absent() })

    const report = await doctorServer('ghost', { configOnly: false })
    const server = only(report)

    expect(server.liveCheck.result).toBe('failed')
    expect(server.liveCheck.error).toContain('claudin-doctor-no-such-binary')
    expect(server.liveCheck.error!.toLowerCase()).toContain('not found')
    expect(server.findings).toHaveLength(1)
    expect(server.findings[0]).toMatchObject({ code: 'stdio.command_not_found', severity: 'error', blocking: true })
    expect(server.findings[0]!.remediation).toContain('PATH')
    expect(report.summary.blocking).toBe(1)
  })

  test('a remote server whose error says "not found" is a plain health failure, not a missing command', async () => {
    const http = Bun.serve({ port: 0, fetch: () => new Response('not found', { status: 404, statusText: 'Not Found' }) })
    try {
      setLocalServers({ remote: { type: 'http', url: `http://127.0.0.1:${http.port}/mcp` } })

      const report = await doctorServer('remote', { configOnly: false })
      const server = only(report)

      expect(server.definitions[0]!.transport).toBe('http')
      expect(server.liveCheck.result).toBe('failed')
      expect(server.liveCheck.error!.toLowerCase()).toContain('not found')
      expect(codes(report)).toEqual(['health.failed'])
    } finally {
      http.stop(true)
    }
  })

  test('a remote server nobody listens on fails its live check', async () => {
    const http = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = http.port
    http.stop(true)
    setUserServers({ gone: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } })

    const report = await doctorServer('gone', { configOnly: false })

    expect(only(report).liveCheck).toMatchObject({ attempted: true, result: 'failed' })
    expect(codes(report)).toEqual(['health.failed'])
  })
})

describe('the processes it starts', () => {
  test('are all gone once the call returns, whatever the outcome', async () => {
    setLocalServers({ a: probes.answering(), b: probes.dying(), c: probes.answering() })

    const report = await doctorAllServers({ configOnly: false })

    expect(report.servers.map(s => s.liveCheck.result)).toEqual(['connected', 'failed', 'connected'])
    expect(probes.started()).toHaveLength(3)
    expect(await probes.allGone()).toBe(true)
  })

  test('each server is started once per call, and again on the next call', async () => {
    setLocalServers({ once: probes.answering() })

    await doctorServer('once', { configOnly: false })
    expect(probes.started()).toHaveLength(1)
    await doctorServer('once', { configOnly: false })
    expect(probes.started()).toHaveLength(2)
    expect(await probes.allGone()).toBe(true)
  })

  test('config-only starts nothing and reports every check as skipped', async () => {
    setLocalServers({ a: probes.answering(), b: probes.dying(), c: probes.absent() })

    const all = await doctorAllServers({ configOnly: true })
    const one = await doctorServer('a', { configOnly: true })

    expect(probes.started()).toEqual([])
    for (const server of [...all.servers, ...one.servers]) {
      expect(server.liveCheck).toEqual({ attempted: false, result: 'skipped' })
    }
    expect(all.summary).toEqual({ totalReports: 3, healthy: 0, warnings: 0, blocking: 0 })
  })

  test('with no options, doctorAllServers runs the live checks', async () => {
    setLocalServers({ a: probes.answering() })

    const report = await doctorAllServers()

    expect(report.configOnly).toBe(false)
    expect(only(report).liveCheck.result).toBe('connected')
    expect(probes.started()).toHaveLength(1)
  })
})

describe('project servers from .mcp.json: the doctor asks nothing itself', () => {
  test('interactive session: an unapproved server is reported pending and not started', async () => {
    writeMcpJson({ mcpServers: { repoServer: probes.answering() } })

    const report = await doctorServer('repoServer', { configOnly: false })
    const server = only(report)

    expect(probes.started()).toEqual([])
    expect(server.liveCheck).toEqual({ attempted: false, result: 'pending' })
    expect(server.definitions[0]).toMatchObject({ sourceType: 'project', pendingApproval: true, runtimeActive: false })
    expect(codes(report)).toEqual(['state.pending_project_approval'])
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 1, blocking: 0 })
  })

  test.each([
    ['in the project directory', (w: World) => w.project],
    ['in a parent directory', (w: World) => w.outer],
  ])('non-interactive session: an unapproved server %s is started without a prompt', async (_where, dirOf) => {
    setIsInteractive(false)
    writeMcpJson({ mcpServers: { repoServer: probes.answering() } }, dirOf(w))

    const report = await doctorServer('repoServer', { configOnly: false })

    expect(probes.started()).toHaveLength(1)
    expect(only(report).liveCheck.result).toBe('connected')
    expect(only(report).definitions[0]).toMatchObject({ pendingApproval: false, runtimeActive: true })
    expect(report.summary.healthy).toBe(1)
  })

  test('interactive session: a server approved in local settings is started', async () => {
    writeMcpJson({ mcpServers: { repoServer: probes.answering() } })
    writeSettings('local', { enabledMcpjsonServers: ['repoServer'] })

    const report = await doctorServer('repoServer', { configOnly: false })

    expect(probes.started()).toHaveLength(1)
    expect(only(report).liveCheck.result).toBe('connected')
  })

  test('a rejected server is not started, and the report says nothing about it', async () => {
    setIsInteractive(false)
    writeMcpJson({ mcpServers: { repoServer: probes.answering() } })
    writeSettings('local', { disabledMcpjsonServers: ['repoServer'] })

    const report = await doctorServer('repoServer', { configOnly: false })
    const server = only(report)

    expect(probes.started()).toEqual([])
    expect(server.liveCheck).toEqual({ attempted: false, result: 'skipped' })
    expect(server.definitions[0]).toMatchObject({ pendingApproval: false, runtimeActive: false, disabled: false })
    expect(server.findings).toEqual([])
  })
})

describe('the allow and deny policy', () => {
  const blocked: Array<[string, 'policy' | 'user', (p: ProbeServers) => Record<string, unknown>]> = [
    ['a managed deny by name', 'policy', () => ({ deniedMcpServers: [{ serverName: 'held' }] })],
    ['a managed deny by command', 'policy', p => ({ deniedMcpServers: [{ serverCommand: [p.answering().command, ...p.answering().args] }] })],
    ['a managed allowlist that leaves it out', 'policy', () => ({ allowedMcpServers: [{ serverName: 'someone-else' }] })],
    ['an empty managed allowlist', 'policy', () => ({ allowedMcpServers: [] })],
    ['a deny in user settings', 'user', () => ({ deniedMcpServers: [{ serverName: 'held' }] })],
  ]

  test.each(blocked)('%s: not started, check skipped, no finding', async (_why, layer, policy) => {
    setIsInteractive(false)
    writeSettings(layer, policy(probes))
    setLocalServers({ held: probes.answering() })
    writeMcpJson({ mcpServers: { heldToo: probes.answering() } })

    const one = await doctorServer('held', { configOnly: false })
    expect(probes.started()).toEqual([])
    expect(only(one).liveCheck).toEqual({ attempted: false, result: 'skipped' })
    expect(only(one).definitions[0]).toMatchObject({ sourceType: 'local', runtimeActive: false, runtimeVisible: false })
    expect(only(one).findings).toEqual([])
    expect(one.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 0, blocking: 0 })
  })

  test('a server the policy admits is started', async () => {
    writeSettings('policy', { allowedMcpServers: [{ serverName: 'held' }], deniedMcpServers: [{ serverName: 'other' }] })
    setLocalServers({ held: probes.answering() })

    const report = await doctorServer('held', { configOnly: false })

    expect(probes.started()).toHaveLength(1)
    expect(only(report).liveCheck.result).toBe('connected')
  })

  test('a managed-mcp.json takes over: only its servers are started', async () => {
    writeManagedMcp({ mcpServers: { corp: probes.answering() } })
    setLocalServers({ mine: probes.answering() })

    const report = await doctorAllServers({ configOnly: false })

    expect(report.servers.map(s => [s.serverName, s.liveCheck.result])).toEqual([
      ['corp', 'connected'],
      ['mine', 'skipped'],
    ])
    expect(report.servers[0]!.definitions[0]).toMatchObject({ sourceType: 'enterprise', runtimeActive: true })
    expect(report.servers[1]!.findings).toEqual([])
    expect(probes.started()).toHaveLength(1)
  })
})

describe('disabled servers', () => {
  test('are not started, and report a disabled state with a warning', async () => {
    setLocalServers({ off: probes.answering() })
    setToggles({ disabled: ['off'] })

    const report = await doctorServer('off', { configOnly: false })
    const server = only(report)

    expect(probes.started()).toEqual([])
    expect(server.liveCheck).toEqual({ attempted: false, result: 'disabled' })
    expect(server.definitions[0]).toMatchObject({ disabled: true, runtimeActive: false, runtimeVisible: false })
    expect(server.findings).toHaveLength(1)
    expect(server.findings[0]).toMatchObject({ code: 'state.disabled', severity: 'warn', blocking: false })
    expect(server.findings[0]!.message).toContain('off')
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 1, blocking: 0 })
  })

  test('a disabled plugin server is not started either', async () => {
    addPlugin('kit', { tool: probes.answering() })
    setToggles({ disabled: ['plugin:kit:tool'] })

    const report = await doctorAllServers({ configOnly: false })

    expect(probes.started()).toEqual([])
    expect(only(report).liveCheck).toEqual({ attempted: false, result: 'disabled' })
    expect(codes(report)).toEqual(['state.disabled'])
  })

  test('an enabled plugin server is started', async () => {
    addPlugin('kit', { tool: probes.answering() })

    const report = await doctorServer('plugin:kit:tool', { configOnly: false })

    expect(probes.started()).toHaveLength(1)
    expect(only(report).liveCheck.result).toBe('connected')
  })
})

describe('the scope filter and the live check', () => {
  test('a target absent from the filtered scope is not started, even if another scope runs it', async () => {
    setLocalServers({ tool: probes.answering() })

    const report = await doctorServer('tool', { configOnly: false, scopeFilter: 'user' })

    expect(probes.started()).toEqual([])
    expect(only(report).definitions).toEqual([])
    expect(only(report).liveCheck).toEqual({ attempted: false, result: 'skipped' })
    expect(codes(report)).toEqual(['state.not_found'])
    expect(report.summary.blocking).toBe(1)
  })

  test('a target present but shadowed in the filtered scope: the definition that runs is the one checked', async () => {
    setLocalServers({ tool: probes.answering() })
    setUserServers({ tool: probes.dying() })

    const report = await doctorServer('tool', { configOnly: false, scopeFilter: 'user' })
    const server = only(report)

    expect(server.definitions.map(d => [d.sourceType, d.runtimeActive])).toEqual([
      ['user', false],
      ['local', true],
    ])
    expect(server.liveCheck.result).toBe('connected')
    expect(probes.started()).toHaveLength(1)
  })
})
