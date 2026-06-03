/**
 * Integration tests: pipeline detect → config per server.
 * Mocks execFileNoThrowWithCwd to simulate binary availability.
 * Tests that getBuiltinLspServers() produces correct merged output.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'

// createRequire bypasses Bun's mock.module — these are guaranteed real even
// if a previously-loaded test file already registered an incomplete mock
// for the same specifier.
const _require = createRequire(import.meta.url)

// Capture the real module before mocking so afterAll can fully restore it.
const realExecFileNoThrowIntegration = { ...(await import('../../utils/execFileNoThrow.js')) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecFile = mock(async (..._args: any[]) => ({ code: 1, stdout: '', stderr: '' }))
// Include execFileNoThrow + execSyncWithDefaults_DEPRECATED in the shape so
// later test files that transitively import the real exports don't trip
// "Export not found" — Bun's mock.module locks the shape on first import.
mock.module('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrow: mockExecFile,
  execFileNoThrowWithCwd: mockExecFile,
  execSyncWithDefaults_DEPRECATED: () => ({ code: 0, stdout: '', stderr: '' }),
}))

const realLogIntegration = { ...(await import('../../utils/log.js')) }
mock.module('../../utils/log.js', () => ({ ...realLogIntegration, logError: mock(() => {}) }))
// Full export shape — Bun locks the namespace on first mock.module call,
// so subsequent files can't add exports we omit here.
mock.module('./manager.js', () => ({
  reinitializeLspServerManager: mock(() => {}),
  isLspConnected: mock(() => false),
  getLspServerManager: mock(() => undefined),
  initializeLspServerManager: mock(() => {}),
  shutdownLspServerManager: mock(async () => {}),
  getInitializationStatus: mock(() => ({ status: 'not-started' })),
  waitForInitialization: mock(async () => {}),
  _resetLspManagerForTesting: mock(() => {}),
}))
const realUserSettingsIntegration = { ...(await import('./userSettings.js')) }
mock.module('./userSettings.js', () => ({
  ...realUserSettingsIntegration,
  getUserLspSettings: mock(() => ({} as Record<string, { disabled?: boolean }>)),
  isLspGloballyEnabled: mock(() => true),
}))
const realOsIntegration = _require('os') as typeof import('os')
mock.module('os', () => ({ ...realOsIntegration, default: realOsIntegration, homedir: () => '/tmp/fake-home-integ', release: () => '5.15.0', type: () => 'Linux', version: () => '#1 SMP' }))
const realEnvUtilsIntegration = { ...(await import('../../utils/envUtils.js')) }
mock.module('../../utils/envUtils.js', () => ({
  ...realEnvUtilsIntegration,
  getClaudinConfigHomeDir: () => '/tmp/fake-config-integ',
  isEnvTruthy: (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false',
}))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
mock.module('axios', () => ({ default: { get: mock(async (..._args: any[]) => ({ data: {} })) } }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsyncFn = (...args: any[]) => Promise<any>
const mockReadFile = mock<AnyAsyncFn>(async () => { throw new Error('ENOENT') })
const mockWriteFile = mock<AnyAsyncFn>(async () => {})
const mockAccess = mock<AnyAsyncFn>(async () => { throw new Error('ENOENT') })
const mockReaddir = mock<AnyAsyncFn>(async () => [] as string[])
const realFsPromisesIntegration = _require('fs/promises') as typeof import('fs/promises')
mock.module('fs/promises', () => ({
  ...realFsPromisesIntegration,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mock(async () => undefined),
  access: mockAccess,
  unlink: mock(async () => {}),
  readdir: mockReaddir,
  chmod: mock(async () => {}),
  open: mock(async () => ({ close: async () => {} })),
  rmdir: mock(async () => {}),
  stat: mock(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  lstat: mock(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  realpath: mock(async (p: unknown) => p as string),
  rename: mock(async () => {}),
  appendFile: mock(async () => {}),
  rm: mock(async () => {}),
}))

async function freshModule() {
  return import(`./builtinServers.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mockExecFile.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockAccess.mockReset()
  mockReaddir.mockReset()
})

// ---------------------------------------------------------------------------
// Per-server detect success → appears in getBuiltinLspServers()
// ---------------------------------------------------------------------------

const simpleServers = [
  { name: 'typescript-language-server', binary: 'typescript-language-server', ext: '.ts', lang: 'typescript' },
  { name: 'rust-analyzer', binary: 'rust-analyzer', ext: '.rs', lang: 'rust' },
  { name: 'pyright', binary: 'pyright-langserver', ext: '.py', lang: 'python' },
  { name: 'gopls', binary: 'gopls', ext: '.go', lang: 'go' },
  { name: 'biome', binary: 'biome', ext: '.ts', lang: 'typescript' },
  { name: 'yaml-language-server', binary: 'yaml-language-server', ext: '.yml', lang: 'yaml' },
  { name: 'taplo', binary: 'taplo', ext: '.toml', lang: 'toml' },
  { name: 'dart', binary: 'dart', ext: '.dart', lang: 'dart' },
  { name: 'omnisharp', binary: 'OmniSharp', ext: '.cs', lang: 'csharp' },
  { name: 'clangd', binary: 'clangd', ext: '.cpp', lang: 'cpp' },
]

for (const { name, binary, ext, lang } of simpleServers) {
  describe(`${name} integration`, () => {
    test('detect success → server appears in getBuiltinLspServers()', async () => {
      mockExecFile.mockImplementation(async (...a: unknown[]) => {
        const [cmd, args] = a as [string, string[]]
        if (cmd === 'which' && args[0] === binary) return { code: 0, stdout: `/usr/bin/${binary}\n`, stderr: '' }
        return { code: 1, stdout: '', stderr: '' }
      })
      const { getBuiltinLspServers } = await freshModule()
      const result = await getBuiltinLspServers()
      expect(result[name]).toBeDefined()
      expect(result[name].scope).toBe('builtin')
      expect(result[name].source).toBe('builtin')
      expect(result[name].extensionToLanguage[ext]).toBe(lang)
    })

    test('detect fail → server absent from getBuiltinLspServers()', async () => {
      mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
      const { getBuiltinLspServers } = await freshModule()
      const result = await getBuiltinLspServers()
      expect(result[name]).toBeUndefined()
    })

    test('one server failing does not block others', async () => {
      const otherBinaries = simpleServers.filter(s => s.name !== name).map(s => s.binary)
      mockExecFile.mockImplementation(async (...a: unknown[]) => {
        const [cmd, args] = a as [string, string[]]
        if (cmd === 'which' && otherBinaries.includes(args[0])) {
          return { code: 0, stdout: `/usr/bin/${args[0]}\n`, stderr: '' }
        }
        return { code: 1, stdout: '', stderr: '' }
      })
      const { getBuiltinLspServers } = await freshModule()
      const result = await getBuiltinLspServers()
      // This server is absent
      expect(result[name]).toBeUndefined()
      // Others are present (at least some of the simple servers)
      const presentCount = Object.keys(result).filter(k => k !== 'jdtls' && k !== 'kotlin-language-server').length
      expect(presentCount).toBeGreaterThan(0)
    })
  })
}

// ---------------------------------------------------------------------------
// jdtls integration
// ---------------------------------------------------------------------------

describe('jdtls integration', () => {
  test('detect success (java + jar) → server appears', async () => {
    mockExecFile.mockImplementation(async (...a: unknown[]) => {
      const [cmd, args] = a as [string, string[]]
      if (cmd === 'which' && args[0] === 'java') return { code: 0, stdout: '/usr/bin/java\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    mockReaddir.mockImplementation(async () => ['org.eclipse.equinox.launcher_1.6.0.jar'] as string[])
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['jdtls']).toBeDefined()
    expect(result['jdtls'].scope).toBe('builtin')
    expect(result['jdtls'].extensionToLanguage['.java']).toBe('java')
  })

  test('java absent → jdtls absent', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['jdtls']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// kotlin-language-server integration
// ---------------------------------------------------------------------------

describe('kotlin-language-server integration', () => {
  test('detect success (java + kotlin bin) → server appears', async () => {
    mockExecFile.mockImplementation(async (...a: unknown[]) => {
      const [cmd, args] = a as [string, string[]]
      if (cmd === 'which' && args[0] === 'java') return { code: 0, stdout: '/usr/bin/java\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    mockAccess.mockImplementation(async (...a: unknown[]) => {
      const [path] = a as [string]
      if (typeof path === 'string' && path.includes('kotlin-language-server')) return
      throw new Error('ENOENT')
    })
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['kotlin-language-server']).toBeDefined()
    expect(result['kotlin-language-server'].extensionToLanguage['.kt']).toBe('kotlin')
  })

  test('java absent → kotlin absent', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['kotlin-language-server']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// All 12 together
// ---------------------------------------------------------------------------

describe('all servers together', () => {
  test('all 12 appear when all detected', async () => {
    mockExecFile.mockImplementation(async (...a: unknown[]) => {
      const [cmd, args] = a as [string, string[]]
      if (cmd === 'which') return { code: 0, stdout: `/${args[0]}\n`, stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    mockReaddir.mockImplementation(async () => ['org.eclipse.equinox.launcher_1.6.0.jar'] as string[])
    mockAccess.mockImplementation(async () => {})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(Object.keys(result).length).toBe(12)
  })

  test('empty result when all detection fails', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(Object.keys(result).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// Bun's mock.module() is process-global with no auto-restore; without these
// resets, our incomplete factories above corrupt every later file that pulls
// the same specifier (notably wiki tests using fs/promises and node:os).
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('fs/promises', () => realFsPromisesIntegration)
  mock.module('os', () => realOsIntegration)
  mock.module('axios', () => ({ default: {} }))
  mock.module('../../utils/execFileNoThrow.js', () => realExecFileNoThrowIntegration)
  mock.module('../../utils/log.js', () => realLogIntegration)
  mock.module('src/utils/log.js', () => realLogIntegration)
  mock.module('../../utils/envUtils.js', () => realEnvUtilsIntegration)
  mock.module('src/utils/envUtils.js', () => realEnvUtilsIntegration)
  mock.module('./manager.js', () => ({
    reinitializeLspServerManager: () => {},
    isLspConnected: () => false,
    getLspServerManager: () => undefined,
    initializeLspServerManager: () => {},
    shutdownLspServerManager: async () => {},
    getInitializationStatus: () => ({ status: 'not-started' }),
    waitForInitialization: async () => {},
    _resetLspManagerForTesting: () => {},
  }))
  mock.module('./userSettings.js', () => realUserSettingsIntegration)
  mock.module('src/services/lsp/userSettings.js', () => realUserSettingsIntegration)
})
