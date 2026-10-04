/**
 * The fixes the rewrite of mcp/doctor applied (docs/tech/rewrite/mcp/doctor.md,
 * Findings 4, 6, 8, 9 and 10), plus the branches the characterization suite
 * does not reach. Real config in a temp world; only the connection is scripted.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'path'
import { getAllMcpConfigs, getMcpConfigsByScope, isMcpServerDisabled } from 'src/mcp/config.js'
import { doctorAllServers, doctorServer, type McpDoctorDependencies } from 'src/mcp/doctor.js'
import { DOCTOR_SCOPES, isDoctorScope, parseDoctorScopeFilter } from 'src/mcp/doctor/scopes.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { describeMcpConfigFilePath, getProjectMcpServerStatus } from 'src/mcp/utils.js'
import { mcpDoctorHandler } from 'src/platform/headless/handlers/mcp.js'
import {
  enterWorld,
  leaveWorld,
  setLocalServers,
  setToggles,
  setUserServers,
  writeMcpJson,
  writeSettings,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'

let w: World

beforeEach(() => {
  w = enterWorld()
})

afterEach(() => {
  leaveWorld()
})

const cmd = (command: string, args: string[] = []) => ({ command, args })
const quick = { configOnly: true } as const

type Connect = (name: string, config: ScopedMcpServerConfig) => Promise<MCPServerConnection>

/** Real config readers; the connection is `connect`, and every clear is recorded. */
function withConnection(
  connect: Connect,
  runtime?: Record<string, ScopedMcpServerConfig>,
): { deps: McpDoctorDependencies; cleared: string[] } {
  const cleared: string[] = []
  const deps: McpDoctorDependencies = {
    getMcpConfigsByScope,
    getProjectMcpServerStatus,
    isMcpServerDisabled,
    describeMcpConfigFilePath,
    getAllMcpConfigs: runtime ? async () => ({ servers: runtime, errors: [] }) : getAllMcpConfigs,
    connectToServer: Object.assign(connect, { cache: new Map() }) as unknown as McpDoctorDependencies['connectToServer'],
    clearServerCache: async name => {
      cleared.push(name)
    },
  }
  return { deps, cleared }
}

const connected: Connect = async (name, config) =>
  ({ name, config, type: 'connected', capabilities: {}, cleanup: async () => {} }) as unknown as MCPServerConnection

async function runHandler(
  name: string | undefined,
  options: Parameters<typeof mcpDoctorHandler>[1],
): Promise<{ stdout: string; stderr: string; exitCodes: Array<number | undefined> }> {
  const out: string[] = []
  const err: string[] = []
  const exitCodes: Array<number | undefined> = []
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  const error = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    err.push(parts.map(String).join(' '))
  })
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code)
  }) as typeof process.exit)
  try {
    await mcpDoctorHandler(name, options)
  } finally {
    write.mockRestore()
    error.mockRestore()
    exit.mockRestore()
  }
  return { stdout: out.join(''), stderr: err.join('\n'), exitCodes }
}

describe('Finding 4: an observed file-backed definition names its file, not its scope', () => {
  test.each<[string, () => void, 'local' | 'project']>([
    ['local, under --scope user', () => {
      setLocalServers({ svc: cmd('l') })
      setUserServers({ svc: cmd('u') })
    }, 'local'],
    ['an approved project server, under --scope user', () => {
      writeSettings('local', { enabledMcpjsonServers: ['svc'] })
      writeMcpJson({ mcpServers: { svc: cmd('p') } })
      setUserServers({ svc: cmd('u') })
    }, 'project'],
  ])('%s', async (_why, arrange, scope) => {
    arrange()

    const [declared, observed] = (await doctorServer('svc', { configOnly: true, scopeFilter: 'user' })).servers[0]!.definitions

    expect(declared).toMatchObject({ sourceType: 'user', runtimeActive: false })
    expect(observed).toMatchObject({ sourceType: scope, runtimeActive: true, sourcePath: describeMcpConfigFilePath(scope) })
    expect(observed!.sourcePath).not.toBe(scope)
  })

  test('the project file is the one in the working directory', async () => {
    writeSettings('local', { enabledMcpjsonServers: ['svc'] })
    writeMcpJson({ mcpServers: { svc: cmd('p') } })
    setUserServers({ svc: cmd('u') })

    const report = await doctorServer('svc', { configOnly: true, scopeFilter: 'user' })

    expect(report.servers[0]!.definitions[1]!.sourcePath).toBe(join(w.project, '.mcp.json'))
  })

  test.each(['enterprise', 'user'] as const)('a runtime-only %s config names the file too', async scope => {
    const { deps } = withConnection(connected, { svc: { ...cmd('x'), scope } as ScopedMcpServerConfig })

    const [only] = (await doctorServer('svc', quick, deps)).servers[0]!.definitions

    expect(only).toMatchObject({ sourceType: scope, sourcePath: describeMcpConfigFilePath(scope) })
  })

  test('an observed definition matching a declared file adds nothing', async () => {
    setLocalServers({ svc: cmd('l') })
    const { deps } = withConnection(connected, { svc: { ...cmd('elsewhere'), scope: 'local' } as ScopedMcpServerConfig })

    const s = (await doctorServer('svc', { configOnly: false }, deps)).servers[0]!

    expect(s.definitions.map(d => [d.sourceType, d.runtimeActive])).toEqual([['local', false]])
    expect(s.liveCheck).toEqual({ attempted: false, result: 'skipped' })
  })
})

describe('Finding 6: the duplicate warning when no definition runs', () => {
  test('says none is active instead of naming the first listed', async () => {
    setLocalServers({ off: cmd('l') })
    setUserServers({ off: cmd('u') })
    setToggles({ disabled: ['off'] })

    const [duplicate] = (await doctorServer('off', quick)).servers[0]!.findings

    expect(duplicate!.code).toBe('duplicate.same_name_multiple_scopes')
    expect(duplicate!.message).toMatch(/none of its definitions is active/)
    expect(duplicate!.message).not.toContain('active source')
    expect(duplicate!.message).not.toContain('local')
  })

  test('still names the running source when there is one', async () => {
    setLocalServers({ dup: cmd('l') })
    setUserServers({ dup: cmd('u') })

    const [duplicate] = (await doctorServer('dup', quick)).servers[0]!.findings

    expect(duplicate!.message).toContain('the active source is local')
  })
})

describe('Finding 8: --scope accepts only the scopes the doctor reads', () => {
  test.each(['dynamic', 'claudeai', 'managed'])('%s is refused like an unknown scope', async scope => {
    setLocalServers({ s: cmd('s') })

    const result = await runHandler(undefined, { scope, configOnly: true })

    expect(result.exitCodes).toEqual([1])
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`Invalid scope: ${scope}`)
    for (const known of ['local', 'user', 'project', 'enterprise']) expect(result.stderr).toContain(known)
  })

  test('the four readable scopes, and nothing else, parse', () => {
    expect([...DOCTOR_SCOPES].sort()).toEqual(['enterprise', 'local', 'project', 'user'])
    for (const scope of DOCTOR_SCOPES) expect(parseDoctorScopeFilter(scope)).toBe(scope)
    for (const scope of ['dynamic', 'claudeai', 'managed', 'Local', '']) expect(isDoctorScope(scope)).toBe(false)
    expect(() => parseDoctorScopeFilter('managed')).toThrow('Must be one of: enterprise, local, project, user')
  })
})

describe('Finding 9: the count lines agree in number', () => {
  const countLines = (text: string) => text.split('\n').filter(l => /^- \d+ /.test(l))

  test.each<[string, () => string | undefined, string[]]>([
    ['one missing server', () => 'ghost', [
      '- 1 server report generated', '- 0 healthy', '- 0 warnings', '- 1 blocking issue',
    ]],
    ['one pending server', () => {
      writeMcpJson({ mcpServers: { a: cmd('a') } })
      return undefined
    }, ['- 1 server report generated', '- 0 healthy', '- 1 warning', '- 0 blocking issues']],
    ['two pending servers', () => {
      writeMcpJson({ mcpServers: { a: cmd('a'), b: cmd('b') } })
      return undefined
    }, ['- 2 server reports generated', '- 0 healthy', '- 2 warnings', '- 0 blocking issues']],
  ])('%s', async (_why, arrange, expected) => {
    const name = arrange()

    const { stdout } = await runHandler(name, { configOnly: true })

    expect(countLines(stdout)).toEqual(expected)
  })

  test('two blocking issues are plural', async () => {
    writeMcpJson('{ broken')

    const { stdout } = await runHandler('ghost', { configOnly: true })

    expect(stdout).toContain('- 2 blocking issues\n')
  })
})

describe('which declaration runs: the identity', () => {
  test.each<[string, Record<string, unknown>, ScopedMcpServerConfig, boolean]>([
    ['same command and arguments', cmd('srv', ['-a']), { ...cmd('srv', ['-a']), scope: 'local' }, true],
    ['other arguments', cmd('srv', ['-a']), { ...cmd('srv', ['-b']), scope: 'local' }, false],
    ['same URL', { type: 'http', url: 'https://a.example' }, { type: 'http', url: 'https://a.example', scope: 'local' }, true],
    ['other URL', { type: 'http', url: 'https://a.example' }, { type: 'http', url: 'https://b.example', scope: 'local' }, false],
  ])('%s → active %p', async (_why, declared, runtime, active) => {
    setLocalServers({ svc: declared })
    const { deps } = withConnection(connected, { svc: runtime })

    const [first] = (await doctorServer('svc', quick, deps)).servers[0]!.definitions

    expect(first).toMatchObject({ sourceType: 'local', runtimeActive: active })
  })

  test('the same command in two scopes: only the scope that runs is active', async () => {
    setLocalServers({ svc: cmd('same') })
    setUserServers({ svc: cmd('same') })

    const s = (await doctorServer('svc', quick)).servers[0]!

    expect(s.definitions.map(d => [d.sourceType, d.runtimeActive])).toEqual([['local', true], ['user', false]])
  })
})

describe('shadowing counts file-backed declarations only', () => {
  test.each<[string, ScopedMcpServerConfig, 'plugin' | 'claudeai']>([
    ['a plugin', { ...cmd('p'), scope: 'dynamic', pluginSource: 'kit@m' } as ScopedMcpServerConfig, 'plugin'],
    ['a claude.ai connector', { type: 'claudeai-proxy', url: 'https://c.example', id: 'i', scope: 'claudeai' } as ScopedMcpServerConfig, 'claudeai'],
  ])('a user declaration beside %s that runs is not shadowing', async (_why, runtime, sourceType) => {
    setUserServers({ svc: cmd('u') })
    if (sourceType === 'claudeai') setToggles({ enabled: ['svc'] })
    const { deps } = withConnection(connected, { svc: runtime })

    const s = (await doctorServer('svc', quick, deps)).servers[0]!

    expect(s.definitions.map(d => [d.sourceType, d.runtimeActive])).toEqual([['user', false], [sourceType, true]])
    expect(s.findings).toEqual([])
  })
})

describe('validation findings on a server', () => {
  test('several errors for one server all land on it, in order', async () => {
    const issue = (message: string) => ({
      file: '/f.json',
      path: 'mcpServers.svc',
      message,
      mcpErrorMetadata: { scope: 'local' as const, serverName: 'svc', severity: 'warning' as const },
    })
    const { deps } = withConnection(connected)
    const local: Record<string, ScopedMcpServerConfig> = { svc: { ...cmd('s'), scope: 'local' } }
    deps.getMcpConfigsByScope = scope =>
      scope === 'local'
        ? { servers: local, errors: [issue('Missing environment variables: A'), issue('other')] }
        : { servers: {}, errors: [] }

    const report = await doctorAllServers(quick, deps)

    expect(report.findings).toEqual([])
    expect(report.servers[0]!.findings.map(f => f.code)).toEqual(['config.missing_env_vars', 'config.validation_error'])
  })
})

describe('Finding 10: a connection function that throws fails only its server', () => {
  test('the thrower is a failed check with the thrown message; the rest is reported and every server cleared', async () => {
    setLocalServers({ fine: cmd('f'), thrower: cmd('t') })
    const { deps, cleared } = withConnection(async (name, config) => {
      if (name === 'thrower') throw new Error('socket exploded')
      return connected(name, config)
    })

    const report = await doctorAllServers({ configOnly: false }, deps)

    expect(report.servers.map(s => [s.serverName, s.liveCheck.result])).toEqual([
      ['fine', 'connected'],
      ['thrower', 'failed'],
    ])
    const thrower = report.servers[1]!
    expect(thrower.liveCheck).toEqual({ attempted: true, result: 'failed', durationMs: expect.any(Number), error: 'socket exploded' })
    expect(thrower.findings.map(f => [f.code, f.blocking])).toEqual([['health.failed', true]])
    expect(thrower.findings[0]!.message).toContain('socket exploded')
    expect(report.summary).toEqual({ totalReports: 2, healthy: 1, warnings: 0, blocking: 1 })
    expect(cleared.sort()).toEqual(['fine', 'thrower'])
  })

  test('a thrown non-Error value is reported as text', async () => {
    setLocalServers({ odd: cmd('o') })
    const { deps } = withConnection(async () => {
      throw 'plain string'
    })

    const report = await doctorServer('odd', { configOnly: false }, deps)

    expect(report.servers[0]!.liveCheck.error).toBe('plain string')
  })
})
