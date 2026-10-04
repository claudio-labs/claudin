/**
 * Characterization of what the doctor reads from configuration
 * (src/mcp/doctor.ts), with live checks off: definitions per scope, which one
 * runs, shadowing, approval and disabled state, validation errors, the scope
 * filter, and the summary counts.
 *
 * Real `.mcp.json`, `managed-mcp.json` and settings files in a temp world; the
 * user and local scopes go through the global config (see mcpConfigWorld).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { doctorAllServers, doctorServer, type McpDoctorDefinition, type McpDoctorReport } from 'src/mcp/doctor.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import {
  addPlugin,
  enterWorld,
  leaveWorld,
  serveClaudeAi,
  setLocalServers,
  setToggles,
  setUserServers,
  withEnv,
  writeManagedMcp,
  writeMcpJson,
  writeSettings,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'

let w: World
let undo: Array<() => void> = []

beforeEach(() => {
  w = enterWorld()
})

afterEach(() => {
  for (const step of undo.reverse()) step()
  undo = []
  getPlatform.cache.delete(undefined)
  leaveWorld()
})

const cmd = (command: string, args: string[] = []) => ({ command, args })
const quick = { configOnly: true } as const
const server = (report: McpDoctorReport, name: string) => {
  const found = report.servers.find(s => s.serverName === name)
  if (!found) throw new Error(`no report for ${name}`)
  return found
}
const codesOf = (report: McpDoctorReport, name: string) => server(report, name).findings.map(f => f.code)

describe('the report envelope', () => {
  test('an empty world gives an empty, zeroed report', async () => {
    const before = Date.now()
    const report = await doctorAllServers(quick)
    const after = Date.now()

    expect(report).toMatchObject({
      configOnly: true,
      summary: { totalReports: 0, healthy: 0, warnings: 0, blocking: 0 },
      findings: [],
      servers: [],
    })
    expect(report.targetName).toBeUndefined()
    expect(report.scopeFilter).toBeUndefined()
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt)
    expect(Date.parse(report.generatedAt)).toBeGreaterThanOrEqual(before - 1)
    expect(Date.parse(report.generatedAt)).toBeLessThanOrEqual(after + 1)
  })

  test('the single-server form names its target and marks the server as requested', async () => {
    setLocalServers({ a: cmd('a') })

    const one = await doctorServer('a', { configOnly: true, scopeFilter: 'local' })
    const all = await doctorAllServers({ configOnly: true, scopeFilter: 'local' })

    expect(one).toMatchObject({ targetName: 'a', scopeFilter: 'local', configOnly: true })
    expect(one.servers.map(s => [s.serverName, s.requestedByUser])).toEqual([['a', true]])
    expect(all.targetName).toBeUndefined()
    expect(all.scopeFilter).toBe('local')
    expect(all.servers.map(s => [s.serverName, s.requestedByUser])).toEqual([['a', false]])
  })

  test('every name from every scope is reported once, sorted by code unit', async () => {
    setLocalServers({ beta: cmd('b'), Zed: cmd('z') })
    setUserServers({ beta: cmd('b2'), alpha: cmd('a') })
    writeSettings('local', { enableAllProjectMcpServers: true })
    writeMcpJson({ mcpServers: { gamma: cmd('g'), alpha: cmd('a3') } })
    addPlugin('kit', { tool: cmd('t') })

    const report = await doctorAllServers(quick)

    expect(report.servers.map(s => s.serverName)).toEqual(['Zed', 'alpha', 'beta', 'gamma', 'plugin:kit:tool'])
    expect(report.summary.totalReports).toBe(5)
  })
})

describe('definitions', () => {
  test('one per scope that declares the name, in the order enterprise, local, project, user', async () => {
    writeManagedMcp({ mcpServers: { svc: cmd('e') } })
    setLocalServers({ svc: cmd('l') })
    writeSettings('local', { enabledMcpjsonServers: ['svc'] })
    writeMcpJson({ mcpServers: { svc: { type: 'http', url: 'https://p.example/mcp' } } })
    setUserServers({ svc: { type: 'sse', url: 'https://u.example/sse' } })

    const s = server(await doctorServer('svc', quick), 'svc')

    expect(s.definitions.map(d => [d.name, d.sourceType, d.transport, d.runtimeActive, d.runtimeVisible])).toEqual([
      ['svc', 'enterprise', 'stdio', true, true],
      ['svc', 'local', 'stdio', false, false],
      ['svc', 'project', 'http', false, false],
      ['svc', 'user', 'sse', false, false],
    ])
    for (const d of s.definitions) expect(d).toMatchObject({ pendingApproval: false, disabled: false })
  })

  test('each scope names its file', async () => {
    writeManagedMcp({ mcpServers: { svc: cmd('e') } })
    setLocalServers({ svc: cmd('l') })
    writeMcpJson({ mcpServers: { svc: cmd('p') } })
    setUserServers({ svc: cmd('u') })

    const [enterprise, local, project, user] = server(await doctorServer('svc', quick), 'svc').definitions

    expect(enterprise!.sourcePath).toBe(join(w.admin, 'managed-mcp.json'))
    expect(project!.sourcePath).toBe(join(w.project, '.mcp.json'))
    // The global config file's own path belongs to src/platform/config, and it
    // is resolved once per process, so only its shape is pinned here.
    expect(user!.sourcePath).toMatch(/^\/.*\.json$/)
    expect(local!.sourcePath).toBe(`${user!.sourcePath} [project: ${w.project}]`)
  })

  test('a server declared in a parent .mcp.json still names the one in the working directory', async () => {
    writeMcpJson({ mcpServers: { up: cmd('u') } }, w.outer)

    const s = server(await doctorServer('up', quick), 'up')

    expect(s.definitions).toHaveLength(1)
    expect(s.definitions[0]!.sourcePath).toBe(join(w.project, '.mcp.json'))
  })

  test.each<[string, () => void, McpDoctorDefinition['sourceType']]>([
    ['local over user', () => { setLocalServers({ x: cmd('l') }); setUserServers({ x: cmd('u') }) }, 'local'],
    ['approved project over user', () => {
      writeSettings('local', { enabledMcpjsonServers: ['x'] })
      writeMcpJson({ mcpServers: { x: cmd('p') } })
      setUserServers({ x: cmd('u') })
    }, 'project'],
    ['local over approved project', () => {
      writeSettings('local', { enabledMcpjsonServers: ['x'] })
      writeMcpJson({ mcpServers: { x: cmd('p') } })
      setLocalServers({ x: cmd('l') })
    }, 'local'],
    ['user over a pending project entry', () => {
      writeMcpJson({ mcpServers: { x: cmd('p') } })
      setUserServers({ x: cmd('u') })
    }, 'user'],
  ])('%s: exactly the winning definition is active', async (_why, arrange, winner) => {
    arrange()

    const s = server(await doctorServer('x', quick), 'x')

    expect(s.definitions.filter(d => d.runtimeActive).map(d => d.sourceType)).toEqual([winner])
  })
})

describe('shadowing', () => {
  test('two scopes declaring a name give two warnings that name the active source', async () => {
    setLocalServers({ dup: cmd('l') })
    setUserServers({ dup: cmd('u') })

    const report = await doctorServer('dup', quick)
    const findings = server(report, 'dup').findings

    expect(findings.map(f => [f.code, f.severity, f.blocking, f.serverName])).toEqual([
      ['duplicate.same_name_multiple_scopes', 'warn', false, 'dup'],
      ['scope.shadowed', 'warn', false, 'dup'],
    ])
    expect(findings[0]!.message).toContain('local')
    expect(findings[1]!.message).toContain('dup')
    for (const f of findings) {
      expect(f.remediation).toEqual(expect.any(String))
      expect(f.scope).toBeUndefined()
      expect(f.sourcePath).toBeUndefined()
    }
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 2, blocking: 0 })
  })

  test('the managed file, when it declares the name too, is the active source named', async () => {
    writeManagedMcp({ mcpServers: { dup: cmd('e') } })
    setUserServers({ dup: cmd('u') })

    const findings = server(await doctorServer('dup', quick), 'dup').findings

    expect(findings.map(f => f.code)).toEqual(['duplicate.same_name_multiple_scopes', 'scope.shadowed'])
    expect(findings[0]!.message).toContain('enterprise')
  })

  test('a plugin server is not a duplicate of a scope with the same key shape', async () => {
    setLocalServers({ 'plugin:kit:tool': cmd('l') })
    addPlugin('kit', { tool: cmd('t') })

    const report = await doctorServer('plugin:kit:tool', quick)

    expect(server(report, 'plugin:kit:tool').definitions.map(d => d.sourceType)).toEqual(['local'])
    expect(codesOf(report, 'plugin:kit:tool')).toEqual([])
  })

  test('one scope only: no shadowing finding', async () => {
    setUserServers({ solo: cmd('u') })

    expect(codesOf(await doctorServer('solo', quick), 'solo')).toEqual([])
  })
})

describe('approval and disabled state', () => {
  test('a pending project server: definition flagged, warning with scope and file, check skipped', async () => {
    writeMcpJson({ mcpServers: { repo: cmd('r') } })

    const report = await doctorServer('repo', quick)
    const s = server(report, 'repo')

    expect(s.definitions[0]).toMatchObject({ sourceType: 'project', pendingApproval: true, runtimeActive: false, runtimeVisible: false })
    expect(s.liveCheck).toEqual({ attempted: false, result: 'skipped' })
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toMatchObject({
      code: 'state.pending_project_approval',
      severity: 'warn',
      blocking: false,
      scope: 'project',
      serverName: 'repo',
      sourcePath: join(w.project, '.mcp.json'),
    })
    expect(s.findings[0]!.message).toContain('repo')
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 1, blocking: 0 })
  })

  test('approval is only ever pending for the project scope', async () => {
    setLocalServers({ x: cmd('l') })
    setUserServers({ x: cmd('u') })
    writeManagedMcp({ mcpServers: { x: cmd('e') } })

    const s = server(await doctorServer('x', quick), 'x')

    expect(s.definitions.map(d => d.pendingApproval)).toEqual([false, false, false])
  })

  test('a disabled server: definition flagged, warning with its file, not active', async () => {
    setLocalServers({ off: cmd('o') })
    setToggles({ disabled: ['off'] })

    const report = await doctorServer('off', quick)
    const s = server(report, 'off')

    expect(s.definitions[0]).toMatchObject({ disabled: true, runtimeActive: false, runtimeVisible: false })
    expect(s.findings.map(f => [f.code, f.severity, f.blocking])).toEqual([['state.disabled', 'warn', false]])
    expect(s.findings[0]!.sourcePath).toBe(s.definitions[0]!.sourcePath)
    expect(s.findings[0]!.scope).toBeUndefined()
    expect(report.summary.warnings).toBe(1)
  })

  test('a disabled name declared in two scopes gets one disabled warning per definition', async () => {
    setLocalServers({ off: cmd('l') })
    setUserServers({ off: cmd('u') })
    setToggles({ disabled: ['off'] })

    const report = await doctorServer('off', quick)
    const s = server(report, 'off')

    expect(s.definitions.map(d => [d.sourceType, d.disabled, d.runtimeActive])).toEqual([
      ['local', true, false],
      ['user', true, false],
    ])
    expect(s.findings.map(f => f.code)).toEqual([
      'duplicate.same_name_multiple_scopes',
      'scope.shadowed',
      'state.disabled',
      'state.disabled',
    ])
    expect(s.findings.slice(2).map(f => f.sourcePath)).toEqual(s.definitions.map(d => d.sourcePath))
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 4, blocking: 0 })
  })
})

describe('servers only the runtime knows', () => {
  test('a plugin server gets an observed definition naming the plugin', async () => {
    addPlugin('kit', { tool: { type: 'http', url: 'https://kit.example/mcp' } })

    const report = await doctorAllServers(quick)
    const s = server(report, 'plugin:kit:tool')

    expect(s.definitions).toEqual([
      {
        name: 'plugin:kit:tool',
        sourceType: 'plugin',
        sourcePath: 'plugin:kit@inline',
        transport: 'http',
        runtimeVisible: true,
        runtimeActive: true,
        disabled: false,
      },
    ])
    expect(s.findings).toEqual([])

    const named = await doctorServer('plugin:kit:tool', quick)
    expect(named.summary.totalReports).toBe(1)
    expect(server(named, 'plugin:kit:tool').definitions).toEqual(s.definitions)
  })

  test('a disabled plugin server is reported disabled, not missing', async () => {
    addPlugin('kit', { tool: cmd('t') })
    setToggles({ disabled: ['plugin:kit:tool'] })

    const report = await doctorAllServers(quick)
    const s = server(report, 'plugin:kit:tool')

    expect(s.definitions).toHaveLength(1)
    expect(s.definitions[0]).toMatchObject({ sourceType: 'plugin', disabled: true, runtimeActive: false, runtimeVisible: false })
    expect(s.findings.map(f => [f.code, f.blocking])).toEqual([['state.disabled', false]])
    expect(report.summary).toMatchObject({ warnings: 1, blocking: 0 })
  })

  const connector = (): Record<string, ScopedMcpServerConfig> => ({
    'claude.ai Notes': { type: 'claudeai-proxy', url: 'https://notes.example/mcp', id: 'conn-1', scope: 'claudeai' },
  })

  test('a claude.ai connector is off until enabled, and is reported that way', async () => {
    serveClaudeAi(connector())

    const s = server(await doctorAllServers(quick), 'claude.ai Notes')

    expect(s.definitions).toEqual([
      expect.objectContaining({ sourceType: 'claudeai', sourcePath: 'claude.ai', transport: 'claudeai-proxy', disabled: true, runtimeActive: false }),
    ])
    expect(s.findings.map(f => [f.code, f.sourcePath])).toEqual([['state.disabled', 'claude.ai']])
  })

  test('an enabled claude.ai connector is active', async () => {
    serveClaudeAi(connector())
    setToggles({ enabled: ['claude.ai Notes'] })

    const s = server(await doctorAllServers(quick), 'claude.ai Notes')

    expect(s.definitions).toEqual([expect.objectContaining({ sourceType: 'claudeai', disabled: false, runtimeActive: true })])
    expect(s.findings).toEqual([])
  })
})

describe('a missing server', () => {
  test('is one blocking error naming it, with no definitions and no check', async () => {
    setLocalServers({ other: cmd('o') })

    const report = await doctorServer('nowhere', { configOnly: false })
    const s = server(report, 'nowhere')

    expect(s.definitions).toEqual([])
    expect(s.liveCheck).toEqual({ attempted: false, result: 'skipped' })
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toMatchObject({ code: 'state.not_found', severity: 'error', blocking: true, serverName: 'nowhere' })
    expect(s.findings[0]!.message).toContain('nowhere')
    expect(s.findings[0]!.remediation).toEqual(expect.any(String))
    expect(s.findings[0]!.sourcePath).toBeUndefined()
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 0, blocking: 1 })
  })
})

describe('validation errors from the config files', () => {
  test('a .mcp.json that is not JSON is one global, blocking finding', async () => {
    setLocalServers({ fine: cmd('f') })
    writeMcpJson('{ "mcpServers": ')

    const report = await doctorAllServers(quick)

    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'config.invalid_json',
        severity: 'error',
        blocking: true,
        scope: 'project',
        sourcePath: join(w.project, '.mcp.json'),
        remediation: expect.any(String),
      }),
    ])
    expect(report.findings[0]!.serverName).toBeUndefined()
    expect(server(report, 'fine').findings).toEqual([])
    expect(report.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 0, blocking: 1 })
  })

  test('a .mcp.json off the schema is a global error, and none of its servers are reported', async () => {
    writeMcpJson({ mcpServers: { broken: { type: 'carrier-pigeon' }, sound: cmd('s') } })

    const report = await doctorAllServers(quick)

    expect(report.servers).toEqual([])
    expect(report.findings.map(f => [f.code, f.severity, f.blocking, f.scope])).toEqual([
      ['config.invalid_schema', 'error', true, 'project'],
    ])
  })

  test('an invalid user entry is a global error for the user scope', async () => {
    setUserServers({ blank: { command: '' } })

    const report = await doctorAllServers(quick)

    expect(report.findings.map(f => [f.code, f.blocking, f.scope])).toEqual([['config.invalid_schema', true, 'user']])
  })

  test('a managed-mcp.json that is not JSON is a global error for the enterprise scope', async () => {
    writeManagedMcp('not json at all')

    const report = await doctorAllServers(quick)

    expect(report.findings.map(f => [f.code, f.blocking, f.scope, f.sourcePath])).toEqual([
      ['config.invalid_json', true, 'enterprise', join(w.admin, 'managed-mcp.json')],
    ])
  })

  test('an unset variable is a warning on its server, listed before the state findings', async () => {
    undo.push(withEnv({ DOCTOR_CHAR_UNSET: undefined }))
    writeMcpJson({ mcpServers: { envy: cmd('${DOCTOR_CHAR_UNSET}'), plain: cmd('p') } })

    const report = await doctorAllServers(quick)

    expect(report.findings).toEqual([])
    expect(codesOf(report, 'envy')).toEqual(['config.missing_env_vars', 'state.pending_project_approval'])
    expect(server(report, 'envy').findings[0]).toMatchObject({
      severity: 'warn',
      blocking: false,
      scope: 'project',
      serverName: 'envy',
      sourcePath: join(w.project, '.mcp.json'),
    })
    expect(server(report, 'envy').findings[0]!.message).toContain('DOCTOR_CHAR_UNSET')
    expect(codesOf(report, 'plain')).toEqual(['state.pending_project_approval'])
    expect(report.summary).toEqual({ totalReports: 2, healthy: 0, warnings: 3, blocking: 0 })
  })

  test('the Windows npx warning lands on its server', async () => {
    getPlatform.cache.set(undefined, 'windows')
    writeSettings('local', { enableAllProjectMcpServers: true })
    writeMcpJson({ mcpServers: { node: cmd('npx', ['-y', 'some-mcp']) } })

    const report = await doctorAllServers(quick)

    expect(server(report, 'node').findings.map(f => [f.code, f.severity, f.blocking])).toEqual([
      ['config.windows_npx_wrapper_required', 'warn', false],
    ])
    expect(report.findings).toEqual([])
  })

  test('the single-server form keeps the global findings and only its own server findings', async () => {
    undo.push(withEnv({ DOCTOR_CHAR_UNSET: undefined }))
    writeSettings('local', { enableAllProjectMcpServers: true })
    writeMcpJson({ mcpServers: { envy: cmd('${DOCTOR_CHAR_UNSET}'), plain: cmd('p') } })
    writeManagedMcp('{')

    const plain = await doctorServer('plain', quick)
    const envy = await doctorServer('envy', quick)

    expect(plain.findings.map(f => f.code)).toEqual(['config.invalid_json'])
    expect(envy.findings.map(f => f.code)).toEqual(['config.invalid_json'])
    expect(codesOf(plain, 'plain')).toEqual([])
    expect(codesOf(envy, 'envy')).toEqual(['config.missing_env_vars'])
    expect(plain.summary).toEqual({ totalReports: 1, healthy: 0, warnings: 0, blocking: 1 })
  })
})

describe('the scope filter', () => {
  const arrange = () => {
    writeManagedMcp('{')
    setLocalServers({ mine: cmd('l'), both: cmd('l2') })
    setUserServers({ theirs: cmd('u'), both: cmd('u2') })
    writeMcpJson('{ broken')
    addPlugin('kit', { tool: cmd('t') })
  }

  test.each([
    ['user', ['both', 'theirs']],
    ['local', ['both', 'mine']],
    ['project', []],
    ['enterprise', []],
  ] as const)('%s: only that scope\'s names, and only its validation errors', async (scope, names) => {
    arrange()

    const report = await doctorAllServers({ configOnly: true, scopeFilter: scope })

    expect(report.servers.map(s => s.serverName)).toEqual([...names])
    expect(report.findings.map(f => f.scope)).toEqual(scope === 'project' || scope === 'enterprise' ? [scope] : [])
  })

  test('a filtered scope that holds the name lists its definition, plus the one that runs', async () => {
    arrange()

    const s = server(await doctorServer('both', { configOnly: true, scopeFilter: 'user' }), 'both')

    expect(s.definitions.map(d => [d.sourceType, d.runtimeActive])).toEqual([
      ['user', false],
      ['local', true],
    ])
    expect(s.findings.map(f => f.code)).toEqual(['duplicate.same_name_multiple_scopes', 'scope.shadowed'])
  })

  test('a filtered scope that runs the name lists only its own definition', async () => {
    arrange()

    const s = server(await doctorServer('both', { configOnly: true, scopeFilter: 'local' }), 'both')

    expect(s.definitions.map(d => [d.sourceType, d.runtimeActive])).toEqual([['local', true]])
    expect(s.findings).toEqual([])
  })

  test('a runtime-only server is not found under any filter', async () => {
    arrange()

    for (const scope of ['local', 'project', 'user', 'enterprise'] as const) {
      const report = await doctorServer('plugin:kit:tool', { configOnly: true, scopeFilter: scope })
      expect(server(report, 'plugin:kit:tool').definitions).toEqual([])
      expect(codesOf(report, 'plugin:kit:tool')).toEqual(['state.not_found'])
    }
  })
})
