/**
 * Unit tests for getAllLspServers() — servers are sourced exclusively from
 * enabled plugins (no built-in registry, no user-settings server definitions).
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import type { ScopedLspServerConfig } from './types.js'

function makeServer(name: string, source: string): ScopedLspServerConfig {
  return {
    command: name,
    args: [],
    extensionToLanguage: { '.test': 'test' },
    scope: 'dynamic',
    source,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsyncFn = (...args: any[]) => Promise<any>
// Mock plugin loading to return no plugins by default. We spread the real
// module so the shape carries every export — Bun locks the namespace shape
// on first import, so a partial mock here would leak missing-export errors
// into every later test file that pulls pluginLoader transitively (e.g.
// tools.lsp-gate, diagnosticsForToolResult).
const realPluginLoader = await import('src/services/plugins/pluginLoader.js')
const mockLoadPlugins = mock<AnyAsyncFn>(async () => ({ enabled: [] }))
mock.module('src/services/plugins/pluginLoader.js', () => ({
  ...realPluginLoader,
  loadAllPluginsCacheOnly: mockLoadPlugins,
}))

// Snapshot real modules with a plain-object copy BEFORE mocking. `await import`
// returns a live namespace that mock.module() rewrites in place, so restoring to
// the namespace would re-apply the stub (e.g. a stripped errors.js missing
// isENOENT, which broke GlobTool/FileReadTool in later files).
const realLogConfig = { ...(await import('src/utils/log.js')) }
mock.module('src/utils/log.js', () => ({ ...realLogConfig, logError: mock(() => {}) }))
const realDebugConfigTest = { ...(await import('src/utils/debug.js')) }
mock.module('src/utils/debug.js', () => ({ ...realDebugConfigTest, logForDebugging: mock(() => {}), logAntError: mock(() => {}) }))
const realErrorsConfigTest = { ...(await import('src/utils/errors.js')) }
class _ClaudeError extends Error {}
class _MalformedCommandError extends Error {}
class _AbortError extends Error {}
class _ConfigParseError extends Error {}
class _ShellError extends Error {}
class _TeleportOperationError extends Error {}
class _TelemetrySafeError extends Error {}
mock.module('src/utils/errors.js', () => ({
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
mock.module('src/services/plugins/lspPluginIntegration.js', () => ({
  getPluginLspServers: mock(async () => ({})),
  addPluginScopeToLspServers: mock((s: unknown) => s),
}))

async function freshConfig() {
  return import(`./config.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mockLoadPlugins.mockReset()
})

describe('getAllLspServers — plugin-only', () => {
  test('returns empty when no plugins are enabled', async () => {
    mockLoadPlugins.mockImplementation(async () => ({ enabled: [] }))
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(Object.keys(servers).length).toBe(0)
  })

  test('returns servers declared by an enabled plugin', async () => {
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
    mock.module('src/services/plugins/lspPluginIntegration.js', () => ({
      getPluginLspServers: async () => ({
        'my-server': makeServer('plugin-cmd', 'test-plugin'),
      }),
      addPluginScopeToLspServers: (s: unknown) => s,
    }))
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(servers['my-server']).toBeDefined()
    expect(servers['my-server'].command).toBe('plugin-cmd')
    expect(servers['my-server'].scope).toBe('dynamic')
  })

  test('returns empty object when plugin loading fails', async () => {
    mockLoadPlugins.mockImplementation(async () => { throw new Error('fail') })
    const { getAllLspServers } = await freshConfig()
    const { servers } = await getAllLspServers()
    expect(Object.keys(servers).length).toBe(0)
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
  mock.module('src/utils/debug.js', () => realDebugConfigTest)
  mock.module('src/utils/debug.js', () => realDebugConfigTest)
  mock.module('src/utils/errors.js', () => realErrorsConfigTest)
  mock.module('src/utils/errors.js', () => realErrorsConfigTest)
  mock.module('src/utils/log.js', () => realLogConfig)
  mock.module('src/utils/log.js', () => realLogConfig)
})
