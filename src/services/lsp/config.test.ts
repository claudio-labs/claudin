/**
 * Unit tests for getAllLspServers() 3-source merge logic.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import type { ScopedLspServerConfig } from './types.js'

function makeServer(name: string, scope: 'builtin' | 'dynamic', source: string): ScopedLspServerConfig {
  return {
    command: name,
    args: [],
    extensionToLanguage: { '.test': 'test' },
    scope,
    source,
  }
}

const realBuiltinServers = { ...(await import('./builtinServers.js')) }
const mockGetBuiltins = mock(async (): Promise<Record<string, ScopedLspServerConfig>> => ({}))
mock.module('./builtinServers.js', () => ({
  ...realBuiltinServers,
  getBuiltinLspServers: mockGetBuiltins,
}))

const mockGetUserSettings = mock((): Record<string, { disabled?: boolean; command?: string[]; extensions?: string[] }> => ({}))
const realUserSettingsConfig = { ...(await import('./userSettings.js')) }
mock.module('./userSettings.js', () => ({
  ...realUserSettingsConfig,
  getUserLspSettings: mockGetUserSettings,
  isLspGloballyEnabled: mock(() => true),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsyncFn = (...args: any[]) => Promise<any>
// Mock plugin loading to return no plugins by default. We spread the real
// module so the shape carries every export — Bun locks the namespace shape
// on first import, so a partial mock here would leak missing-export errors
// into every later test file that pulls pluginLoader transitively (e.g.
// tools.lsp-gate, diagnosticsForToolResult).
const realPluginLoader = await import('../../utils/plugins/pluginLoader.js')
const mockLoadPlugins = mock<AnyAsyncFn>(async () => ({ enabled: [] }))
mock.module('../../utils/plugins/pluginLoader.js', () => ({
  ...realPluginLoader,
  loadAllPluginsCacheOnly: mockLoadPlugins,
}))

const realLogConfig = await import('../../utils/log.js')
mock.module('../../utils/log.js', () => ({ ...realLogConfig, logError: mock(() => {}) }))
const realDebugConfigTest = await import('../../utils/debug.js')
mock.module('../../utils/debug.js', () => ({ ...realDebugConfigTest, logForDebugging: mock(() => {}), logAntError: mock(() => {}) }))
const realErrorsConfigTest = await import('../../utils/errors.js')
class _ClaudeError extends Error {}
class _MalformedCommandError extends Error {}
class _AbortError extends Error {}
class _ConfigParseError extends Error {}
class _ShellError extends Error {}
class _TeleportOperationError extends Error {}
class _TelemetrySafeError extends Error {}
mock.module('../../utils/errors.js', () => ({
  ClaudeError: _ClaudeError,
  MalformedCommandError: _MalformedCommandError,
  AbortError: _AbortError,
  ConfigParseError: _ConfigParseError,
  ShellError: _ShellError,
  TeleportOperationError: _TeleportOperationError,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: _TelemetrySafeError,
  errorMessage: (e: unknown) => String(e),
  toError: (e: unknown) => e instanceof Error ? e : new Error(String(e)),
  getErrnoCode: (_e: unknown) => null,
  isENOENT: (_e: unknown) => false,
  isFsInaccessible: (_e: unknown) => false,
  isAbortError: (_e: unknown) => false,
  hasExactErrorMessage: () => false,
  getErrnoPath: (_e: unknown) => undefined,
  shortErrorStack: (_e: unknown) => '',
  classifyAxiosError: (_e: unknown) => ({ type: 'unknown' }),
}))
// Prevent deep plugin integration chain from loading
mock.module('../../utils/plugins/lspPluginIntegration.js', () => ({
  getPluginLspServers: mock(async () => ({})),
  addPluginScopeToLspServers: mock((s: unknown) => s),
}))

async function freshConfig() {
  return import(`./config.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mockGetBuiltins.mockReset()
  mockGetUserSettings.mockReset()
  mockLoadPlugins.mockReset()
})

describe('getAllLspServers — 3-source merge', () => {
  test('returns built-ins when no plugins and no user settings', async () => {
    mockGetBuiltins.mockImplementation(async () => ({
      'typescript-language-server': makeServer('typescript-language-server', 'builtin', 'builtin'),
    }))
    mockLoadPlugins.mockImplementation(async () => ({ enabled: [] }))
    mockGetUserSettings.mockImplementation(() => ({}))
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(servers['typescript-language-server']).toBeDefined()
    expect(servers['typescript-language-server'].scope).toBe('builtin')
  })

  test('plugin server overrides built-in with same name', async () => {
    mockGetBuiltins.mockImplementation(async () => ({
      'my-server': makeServer('builtin-cmd', 'builtin', 'builtin'),
    }))
    mockLoadPlugins.mockImplementation(async () => ({
      enabled: [{
        name: 'test-plugin',
        manifest: { name: 'test-plugin', lspServers: {} },
        path: '/tmp/plugin',
        source: 'test-plugin@test',
        repository: 'test-plugin@test',
        enabled: true,
      }],
    }))
    // Mock getPluginLspServers
    mock.module('../../utils/plugins/lspPluginIntegration.js', () => ({
      getPluginLspServers: async (_plugin: unknown, _errors: unknown[]) => ({
        'my-server': makeServer('plugin-cmd', 'dynamic', 'test-plugin'),
      }),
    }))
    mockGetUserSettings.mockImplementation(() => ({}))
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(servers['my-server'].command).toBe('plugin-cmd')
    expect(servers['my-server'].scope).toBe('dynamic')
  })

  test('user disabled:true removes server from result', async () => {
    mockGetBuiltins.mockImplementation(async () => ({
      'typescript-language-server': makeServer('typescript-language-server', 'builtin', 'builtin'),
    }))
    mockLoadPlugins.mockImplementation(async () => ({ enabled: [] }))
    mockGetUserSettings.mockImplementation(() => ({
      'typescript-language-server': { disabled: true },
    }))
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(servers['typescript-language-server']).toBeUndefined()
  })

  test('user custom server replaces same-named builtin/plugin at bare key', async () => {
    mockGetBuiltins.mockImplementation(async () => ({}))
    mockLoadPlugins.mockImplementation(async () => ({ enabled: [] }))
    mockGetUserSettings.mockImplementation(() => ({
      'my-custom': { command: ['my-lsp', '--stdio'], extensions: ['.xyz'] },
    }))
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    // registered under bare key so it replaces (not coexists with) a same-name builtin/plugin
    expect(servers['my-custom']).toBeDefined()
    expect(servers['my-custom'].command).toBe('my-lsp')
    expect(servers['my-custom'].args).toEqual(['--stdio'])
    expect(servers['my-custom'].extensionToLanguage['.xyz']).toBe('xyz')
    expect(servers['my-custom'].source).toBe('user')
    expect(servers['user:my-custom']).toBeUndefined()
  })

  test('failure in getBuiltinLspServers does not prevent plugins from loading', async () => {
    mockGetBuiltins.mockImplementation(async () => { throw new Error('builtin fail') })
    mockLoadPlugins.mockImplementation(async () => ({
      enabled: [{
        name: 'p',
        manifest: { name: 'p', lspServers: {} },
        path: '/tmp/p',
        source: 'p@m',
        repository: 'p@m',
        enabled: true,
      }],
    }))
    mock.module('../../utils/plugins/lspPluginIntegration.js', () => ({
      getPluginLspServers: async () => ({
        'plugin-server': makeServer('plugin-cmd', 'dynamic', 'p'),
      }),
    }))
    mockGetUserSettings.mockImplementation(() => ({}))
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(servers['plugin-server']).toBeDefined()
  })

  test('returns empty object when everything fails', async () => {
    mockGetBuiltins.mockImplementation(async () => { throw new Error('fail') })
    mockLoadPlugins.mockImplementation(async () => { throw new Error('fail') })
    mockGetUserSettings.mockImplementation(() => { throw new Error('fail') })
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(Object.keys(servers).length).toBe(0)
  })

  test('user disabled removes both built-in and plugin server', async () => {
    mockGetBuiltins.mockImplementation(async () => ({
      'shared-server': makeServer('cmd', 'builtin', 'builtin'),
    }))
    mockLoadPlugins.mockImplementation(async () => ({ enabled: [] }))
    mockGetUserSettings.mockImplementation(() => ({
      'shared-server': { disabled: true },
    }))
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(servers['shared-server']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// In particular, debug.js and errors.js leaks have caused SyntaxError missing
// exports in later files (e.g. tools.lsp-gate tests). We do NOT restore
// pluginLoader.js / lspPluginIntegration.js — those have many exports the
// existing partial mock already covers for downstream tests, and replacing
// them here with our own incomplete stub regresses things further.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('../../utils/debug.js', () => realDebugConfigTest)
  mock.module('../../utils/errors.js', () => realErrorsConfigTest)
  mock.module('../../utils/log.js', () => ({ ...realLogConfig, logError: () => {} }))
  mock.module('./builtinServers.js', () => realBuiltinServers)
  mock.module('./userSettings.js', () => realUserSettingsConfig)
})
