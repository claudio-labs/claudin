/**
 * Characterization of the doctor's exported contract (src/mcp/doctor.ts) that
 * real servers cannot reach on their own:
 *
 * - `buildEmptyDoctorReport` and `findingsFromValidationErrors`, driven with
 *   literal input;
 * - the connection outcomes no stdio script produces (needs-auth, pending,
 *   disabled), through the `deps` parameter. Every dependency is the real one
 *   except `connectToServer` and `clearServerCache`, which are scripted: the
 *   network boundary. Config still comes from real files in a temp world.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getAllMcpConfigs, getMcpConfigsByScope, isMcpServerDisabled } from 'src/mcp/config.js'
import {
  buildEmptyDoctorReport,
  doctorAllServers,
  doctorServer,
  findingsFromValidationErrors,
  type McpDoctorDependencies,
  type McpDoctorScopeFilter,
} from 'src/mcp/doctor.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { describeMcpConfigFilePath, getProjectMcpServerStatus } from 'src/mcp/utils.js'
import type { ValidationError } from 'src/platform/settings/validation.js'
import {
  enterWorld,
  leaveWorld,
  setLocalServers,
  setUserServers,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'

beforeEach(() => {
  enterWorld()
})

afterEach(() => {
  leaveWorld()
})

describe('buildEmptyDoctorReport', () => {
  test.each([
    [{ configOnly: true }, [true, undefined, undefined]],
    [{ configOnly: false, scopeFilter: 'enterprise' as McpDoctorScopeFilter }, [false, 'enterprise', undefined]],
    [{ configOnly: true, scopeFilter: 'project' as McpDoctorScopeFilter, targetName: 'fs' }, [true, 'project', 'fs']],
  ] as const)('echoes %j with zero counts and nothing found', (given, [configOnly, filter, target]) => {
    const empty = buildEmptyDoctorReport(given)

    expect([empty.configOnly, empty.scopeFilter, empty.targetName]).toEqual([configOnly, filter, target])
    expect(Object.keys(empty).sort()).toEqual(['configOnly', 'findings', 'generatedAt', 'scopeFilter', 'servers', 'summary', 'targetName'])
    expect(empty.summary).toEqual({ blocking: 0, healthy: 0, totalReports: 0, warnings: 0 })
    expect([empty.findings, empty.servers]).toEqual([[], []])
    expect(Number.isNaN(Date.parse(empty.generatedAt))).toBe(false)
  })

  test('each call is a fresh object', () => {
    const first = buildEmptyDoctorReport({ configOnly: true })
    first.findings.push({ blocking: true, code: 'x', message: 'x', severity: 'error' })

    expect(buildEmptyDoctorReport({ configOnly: true }).findings).toEqual([])
  })
})

describe('findingsFromValidationErrors', () => {
  const issue = (message: string, severity?: 'fatal' | 'warning'): ValidationError => ({
    file: '/work/.mcp.json',
    path: 'mcpServers.svc',
    message,
    suggestion: 'do the thing',
    mcpErrorMetadata: severity ? { scope: 'project', serverName: 'svc', severity } : undefined,
  })

  test.each([
    ['MCP config is not a valid JSON', 'fatal', 'config.invalid_json'],
    ['MCP config is not a valid JSON.', 'fatal', 'config.validation_error'],
    ['Missing environment variables: A, B', 'warning', 'config.missing_env_vars'],
    ['missing environment variables: A', 'warning', 'config.validation_error'],
    ["Windows cannot launch npx directly here: it needs a 'cmd /c' wrapper", 'warning', 'config.windows_npx_wrapper_required'],
    ["Note: Windows cannot launch npx directly here", 'warning', 'config.windows_npx_wrapper_required'],
    ['Does not adhere to MCP server configuration schema', 'fatal', 'config.invalid_schema'],
    ['mcpServers.svc: Does not adhere to MCP server configuration schema', 'fatal', 'config.validation_error'],
    ['MCP config file not found', 'fatal', 'config.validation_error'],
  ] as const)('%j → %s', (message, severity, code) => {
    expect(findingsFromValidationErrors([issue(message, severity)])[0]!.code).toBe(code)
  })

  test.each([
    ['fatal', 'error', true],
    ['warning', 'warn', false],
    [undefined, 'warn', false],
  ] as const)('metadata severity %s → %s, blocking %p', (given, severity, blocking) => {
    const [finding] = findingsFromValidationErrors([issue('anything', given)])

    expect(finding).toMatchObject({ severity, blocking })
  })

  test('every field is carried over, in input order', () => {
    const findings = findingsFromValidationErrors([
      issue('Missing environment variables: TOKEN', 'warning'),
      { file: undefined, path: '', message: 'MCP config is not a valid JSON', suggestion: undefined, mcpErrorMetadata: { scope: 'user', severity: 'fatal' } },
    ])

    expect(findings).toEqual([
      {
        blocking: false,
        code: 'config.missing_env_vars',
        message: 'Missing environment variables: TOKEN',
        remediation: 'do the thing',
        scope: 'project',
        serverName: 'svc',
        severity: 'warn',
        sourcePath: '/work/.mcp.json',
      },
      {
        blocking: true,
        code: 'config.invalid_json',
        message: 'MCP config is not a valid JSON',
        remediation: undefined,
        scope: 'user',
        serverName: undefined,
        severity: 'error',
        sourcePath: undefined,
      },
    ])
  })

  test('no errors, no findings', () => {
    expect(findingsFromValidationErrors([])).toEqual([])
  })
})

type Outcome =
  | { type: 'connected' }
  | { type: 'needs-auth' }
  | { type: 'pending' }
  | { type: 'disabled' }
  | { type: 'failed'; error?: string }

type Ledger = {
  connects: Array<[string, ScopedMcpServerConfig]>
  clears: Array<[string, ScopedMcpServerConfig]>
}

/** Real config readers; the connection and its cleanup follow a script. */
function scripted(
  outcomes: Record<string, Outcome>,
  options: { clearFails?: boolean; delayMs?: number; runtime?: Record<string, ScopedMcpServerConfig> } = {},
): { deps: McpDoctorDependencies; ledger: Ledger } {
  const ledger: Ledger = { connects: [], clears: [] }
  const connect = async (name: string, config: ScopedMcpServerConfig) => {
    ledger.connects.push([name, config])
    if (options.delayMs) await new Promise(r => setTimeout(r, options.delayMs))
    const outcome = outcomes[name] ?? { type: 'failed', error: `unscripted ${name}` }
    return { name, config, capabilities: {}, cleanup: async () => {}, ...outcome } as unknown as MCPServerConnection
  }
  const readers = { getMcpConfigsByScope, getProjectMcpServerStatus, isMcpServerDisabled, describeMcpConfigFilePath }
  const runtime = options.runtime
  const deps: McpDoctorDependencies = {
    ...readers,
    getAllMcpConfigs: runtime ? async () => ({ servers: runtime, errors: [] }) : getAllMcpConfigs,
    connectToServer: Object.assign(connect, { cache: new Map() }) as unknown as McpDoctorDependencies['connectToServer'],
    clearServerCache: async (name, config) => {
      ledger.clears.push([name, config])
      if (options.clearFails) throw new Error('cleanup exploded')
    },
  }
  return { deps, ledger }
}

const stdio = (command: string) => ({ command, args: [] as string[] })

describe('live check outcomes', () => {
  test('connected: attempted, no finding, healthy', async () => {
    setLocalServers({ svc: stdio('s') })
    const { deps } = scripted({ svc: { type: 'connected' } })

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.liveCheck).toEqual({ attempted: true, result: 'connected', durationMs: expect.any(Number) })
    expect(report.servers[0]!.findings).toEqual([])
    expect(report.summary).toEqual({ totalReports: 1, healthy: 1, warnings: 0, blocking: 0 })
  })

  test('needs-auth: a warning naming the server and the active file, not blocking', async () => {
    setLocalServers({ svc: stdio('s') })
    const { deps } = scripted({ svc: { type: 'needs-auth' } })

    const report = await doctorServer('svc', { configOnly: false }, deps)
    const s = report.servers[0]!

    expect(s.liveCheck).toMatchObject({ attempted: true, result: 'needs-auth' })
    expect(s.liveCheck.error).toBeUndefined()
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toMatchObject({
      code: 'auth.needs_auth',
      severity: 'warn',
      blocking: false,
      serverName: 'svc',
      sourcePath: s.definitions[0]!.sourcePath,
      remediation: expect.any(String),
    })
    expect(s.findings[0]!.message).toContain('svc')
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 1, blocking: 0 })
  })

  test.each(['pending', 'disabled'] as const)('%s from the connection: attempted, no finding, not healthy', async type => {
    setLocalServers({ svc: stdio('s') })
    const { deps } = scripted({ svc: { type } })

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.liveCheck).toEqual({ attempted: true, result: type, durationMs: expect.any(Number) })
    expect(report.servers[0]!.findings).toEqual([])
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 0, blocking: 0 })
  })

  test('failed with no error text: a blocking health failure whose message has no detail', async () => {
    setLocalServers({ svc: stdio('s') })
    const { deps } = scripted({ svc: { type: 'failed' } })

    const report = await doctorServer('svc', { configOnly: false }, deps)
    const s = report.servers[0]!

    expect(s.liveCheck).toEqual({ attempted: true, result: 'failed', durationMs: expect.any(Number), error: undefined })
    expect(s.findings.map(f => [f.code, f.severity, f.blocking])).toEqual([['health.failed', 'error', true]])
    expect(s.findings[0]!.message).toContain('svc')
    expect(s.findings[0]!.message).not.toContain(':')
  })

  test.each([
    ['stdio', stdio('s'), 'Command Not Found here', 'stdio.command_not_found'],
    ['stdio', stdio('s'), 'spawn failed', 'health.failed'],
    ['sse', { type: 'sse', url: 'https://x.example/sse' }, 'not found', 'health.failed'],
  ] as const)('%s transport, error %j → %s', async (_t, config, error, code) => {
    setLocalServers({ svc: config })
    const { deps } = scripted({ svc: { type: 'failed', error } })

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.findings.map(f => f.code)).toEqual([code])
    expect(report.servers[0]!.findings[0]!.message).toContain(error)
  })

  test('the time spent connecting is reported', async () => {
    setLocalServers({ svc: stdio('s') })
    const { deps } = scripted({ svc: { type: 'connected' } }, { delayMs: 40 })

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.liveCheck.durationMs).toBeGreaterThanOrEqual(30)
  })

  test('connected but carrying a warning is not healthy', async () => {
    setLocalServers({ svc: stdio('l') })
    setUserServers({ svc: stdio('u') })
    const { deps } = scripted({ svc: { type: 'connected' } })

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.liveCheck.result).toBe('connected')
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 2, blocking: 0 })
  })

  test('the summary adds up every server', async () => {
    setLocalServers({ a: stdio('a'), b: stdio('b'), c: stdio('c'), d: stdio('d') })
    const { deps } = scripted({
      a: { type: 'connected' },
      b: { type: 'needs-auth' },
      c: { type: 'failed', error: 'boom' },
      d: { type: 'connected' },
    })

    const report = await doctorAllServers({ configOnly: false }, deps)

    expect(report.servers.map(s => s.liveCheck.result)).toEqual(['connected', 'needs-auth', 'failed', 'connected'])
    expect(report.summary).toEqual({ totalReports: 4, healthy: 2, warnings: 1, blocking: 1 })
  })
})

describe('the connection lifecycle', () => {
  test('connects with the active config, then clears that connection, once per server', async () => {
    setLocalServers({ a: stdio('a'), b: stdio('b') })
    setUserServers({ a: stdio('shadowed') })
    const { deps, ledger } = scripted({ a: { type: 'connected' }, b: { type: 'failed', error: 'x' } })

    await doctorAllServers({ configOnly: false }, deps)

    const seen = (list: Ledger['connects']) =>
      list.map(([name, config]) => [name, 'command' in config ? config.command : '', config.scope]).sort()
    expect(seen(ledger.connects)).toEqual([['a', 'a', 'local'], ['b', 'b', 'local']])
    expect(seen(ledger.clears)).toEqual(seen(ledger.connects))
  })

  test('a cleanup that throws does not change the report', async () => {
    setLocalServers({ svc: stdio('s') })
    const { deps, ledger } = scripted({ svc: { type: 'connected' } }, { clearFails: true })

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(ledger.clears).toHaveLength(1)
    expect(report.servers[0]!.liveCheck.result).toBe('connected')
    expect(report.summary.healthy).toBe(1)
  })

  test('config-only never connects or clears', async () => {
    setLocalServers({ svc: stdio('s') })
    const { deps, ledger } = scripted({ svc: { type: 'connected' } })

    await doctorAllServers({ configOnly: true }, deps)
    await doctorServer('svc', { configOnly: true }, deps)

    expect(ledger).toEqual({ connects: [], clears: [] })
  })
})

describe('observed definitions for runtime sources', () => {
  test.each([
    ['dynamic', { ...stdio('d'), scope: 'dynamic' }, 'dynamic', 'dynamic'],
    ['managed', { type: 'http', url: 'https://m.example', scope: 'managed' }, 'managed', 'managed'],
    ['a plugin with its source', { ...stdio('p'), scope: 'dynamic', pluginSource: 'kit@market' }, 'plugin', 'plugin:kit@market'],
    ['claude.ai', { type: 'claudeai-proxy', url: 'https://c.example', id: 'i', scope: 'claudeai' }, 'claudeai', 'claude.ai'],
  ] as const)('%s: source type and path', async (_why, config, sourceType, sourcePath) => {
    const { deps } = scripted({ svc: { type: 'connected' } }, { runtime: { svc: config as ScopedMcpServerConfig } })

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.definitions).toEqual([
      {
        name: 'svc',
        sourceType,
        sourcePath,
        transport: 'type' in config ? config.type : 'stdio',
        runtimeVisible: true,
        runtimeActive: true,
        disabled: false,
      },
    ])
    expect(report.servers[0]!.liveCheck.result).toBe('connected')
  })

  test('a dynamic config with an empty or absent plugin source is a plain dynamic server', async () => {
    const plugin = { ...stdio('p'), scope: 'dynamic', pluginSource: '' } as ScopedMcpServerConfig
    const unnamed = { ...stdio('p'), scope: 'dynamic' } as ScopedMcpServerConfig
    const { deps } = scripted({}, { runtime: { svc: plugin, other: unnamed } })

    const report = await doctorAllServers({ configOnly: true }, deps)

    expect(report.servers.map(s => [s.serverName, s.definitions[0]!.sourceType, s.definitions[0]!.sourcePath])).toEqual([
      ['other', 'dynamic', 'dynamic'],
      ['svc', 'dynamic', 'dynamic'],
    ])
  })

  test('a runtime source matching a declared one adds nothing', async () => {
    setLocalServers({ svc: stdio('s') })
    const { deps } = scripted({ svc: { type: 'connected' } })

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.definitions.map(d => d.sourceType)).toEqual(['local'])
  })

  test('a runtime config from another file with the same transport is still observed', async () => {
    setUserServers({ svc: stdio('u') })
    const { deps } = scripted(
      { svc: { type: 'connected' } },
      { runtime: { svc: { ...stdio('elsewhere'), scope: 'local' } as ScopedMcpServerConfig } },
    )

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.definitions.map(d => [d.sourceType, d.runtimeActive])).toEqual([
      ['user', false],
      ['local', true],
    ])
  })

  test('a runtime config differing only in transport from the declared one is observed', async () => {
    setLocalServers({ svc: stdio('l') })
    const { deps } = scripted(
      { svc: { type: 'connected' } },
      { runtime: { svc: { type: 'http', url: 'https://h.example', scope: 'local' } as ScopedMcpServerConfig } },
    )

    const report = await doctorServer('svc', { configOnly: false }, deps)

    expect(report.servers[0]!.definitions.map(d => [d.sourceType, d.transport, d.runtimeActive])).toEqual([
      ['local', 'stdio', false],
      ['local', 'http', true],
    ])
  })
})
