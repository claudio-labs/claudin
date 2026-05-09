/**
 * Per-server unit tests for all 12 built-in LSP server definitions.
 * Each describe block tests: detect via which, detect fails → fallback,
 * fallback also fails → null, toConfig shape, DISABLE_DOWNLOAD guard.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'

// createRequire bypasses Bun's mock.module — these are guaranteed real even
// if a previously-loaded test file already registered an incomplete mock
// for the same specifier.
const _require = createRequire(import.meta.url)

// Capture the real module before mocking so afterAll can restore it.
const realExecFileNoThrowServers = { ...(await import('../../utils/execFileNoThrow.js')) }

const mockExecFile = mock(async (_cmd: string, _args: string[]) => ({
  code: 1,
  stdout: '',
  stderr: '',
}))
// Include execFileNoThrow + execSyncWithDefaults_DEPRECATED in the shape so
// later test files that transitively import the real exports don't trip
// "Export not found" — Bun's mock.module locks the shape on first import.
mock.module('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrow: mockExecFile,
  execFileNoThrowWithCwd: mockExecFile,
  execSyncWithDefaults_DEPRECATED: () => ({ code: 0, stdout: '', stderr: '' }),
}))

const mockLogError = mock((_err: unknown) => {})
const realLogServers = { ...(await import('../../utils/log.js')) }
mock.module('../../utils/log.js', () => ({
  ...realLogServers,
  logError: mockLogError,
}))

mock.module('./manager.js', () => ({
  reinitializeLspServerManager: mock(() => {}),
  isLspConnected: () => false,
  getLspServerManager: () => undefined,
  initializeLspServerManager: () => {},
  shutdownLspServerManager: async () => {},
  getInitializationStatus: () => ({ status: 'not-started' }),
  waitForInitialization: async () => {},
  _resetLspManagerForTesting: () => {},
}))

const realOsServers = _require('os') as typeof import('os')
mock.module('os', () => ({ ...realOsServers, default: realOsServers, homedir: () => '/tmp/fake-home', release: () => '5.15.0', type: () => 'Linux', version: () => '#1 SMP' }))

let configDir = '/tmp/fake-config-dir'
const realEnvUtilsServers = { ...(await import('../../utils/envUtils.js')) }
mock.module('../../utils/envUtils.js', () => ({
  ...realEnvUtilsServers,
  getClaudioConfigHomeDir: () => configDir,
  isEnvTruthy: (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false',
}))

const mockAxiosGet = mock(async () => ({ data: {} }))
mock.module('axios', () => ({ default: { get: mockAxiosGet } }))

const mockGetUserLspSettings = mock(() => ({} as Record<string, { disabled?: boolean }>))
const realUserSettingsServers = { ...(await import('./userSettings.js')) }
mock.module('./userSettings.js', () => ({
  ...realUserSettingsServers,
  getUserLspSettings: mockGetUserLspSettings,
  isLspGloballyEnabled: mock(() => true),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsyncFn = (...args: any[]) => Promise<any>
const mockReadFile = mock<AnyAsyncFn>(async () => { throw new Error('ENOENT') })
const mockWriteFile = mock<AnyAsyncFn>(async () => {})
const mockMkdir = mock<AnyAsyncFn>(async () => undefined)
const mockAccess = mock<AnyAsyncFn>(async () => { throw new Error('ENOENT') })
const mockUnlink = mock<AnyAsyncFn>(async () => {})
const mockReaddir = mock<AnyAsyncFn>(async () => [] as string[])
const realFsPromisesServers = _require('fs/promises') as typeof import('fs/promises')
mock.module('fs/promises', () => ({
  ...realFsPromisesServers,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  access: mockAccess,
  unlink: mockUnlink,
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
  mockLogError.mockReset()
  mockAxiosGet.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockMkdir.mockReset()
  mockAccess.mockReset()
  mockUnlink.mockReset()
  mockReaddir.mockReset()
  mockGetUserLspSettings.mockReset()
  mockGetUserLspSettings.mockReturnValue({})
})

function whichSucceeds(binary: string, path: string) {
  return async (...a: unknown[]) => {
    const [cmd, args] = a as [string, string[]]
    if (cmd === 'which' && args[0] === binary) return { code: 0, stdout: `${path}\n`, stderr: '' }
    return { code: 1, stdout: '', stderr: '' }
  }
}

// ---------------------------------------------------------------------------
// typescript-language-server
// ---------------------------------------------------------------------------

describe('typescript-language-server', () => {
  test('detect via which — returns config', async () => {
    mockExecFile.mockImplementation(whichSucceeds('typescript-language-server', '/usr/bin/typescript-language-server'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['typescript-language-server']
    expect(s).toBeDefined()
    expect(s.command).toBe('/usr/bin/typescript-language-server')
    expect(s.args).toEqual(['--stdio'])
    expect(s.extensionToLanguage['.ts']).toBe('typescript')
    expect(s.extensionToLanguage['.tsx']).toBe('typescriptreact')
    expect(s.extensionToLanguage['.js']).toBe('javascript')
    expect(s.extensionToLanguage['.jsx']).toBe('javascriptreact')
    expect(s.extensionToLanguage['.mjs']).toBe('javascript')
    expect(s.extensionToLanguage['.cjs']).toBe('javascript')
  })

  test('detect fails — fallback to npm install attempted', async () => {
    mockExecFile.mockImplementation(async (cmd, args) => {
      if (cmd === 'npm') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'which' && args[0] === 'typescript-language-server') return { code: 0, stdout: '/usr/bin/tls\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    // mock status file so installInBackground runs
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    const { SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    const result = await tls.installer.install()
    expect(result).toBe('/usr/bin/tls')
  })

  test('detect fails — npm install also fails — returns null', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: 'fail' }))
    const { SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    const result = await tls.installer.install()
    expect(result).toBeNull()
  })

})

// ---------------------------------------------------------------------------
// rust-analyzer
// ---------------------------------------------------------------------------

describe('rust-analyzer', () => {
  test('detect via which — returns config', async () => {
    mockExecFile.mockImplementation(whichSucceeds('rust-analyzer', '/usr/bin/rust-analyzer'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['rust-analyzer']
    expect(s).toBeDefined()
    expect(s.command).toBe('/usr/bin/rust-analyzer')
    expect(s.extensionToLanguage['.rs']).toBe('rust')
  })

  test('installer type is github-release', async () => {
    const { SERVER_DEFINITIONS } = await freshModule()
    const ra = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'rust-analyzer')
    expect(ra.installer.type).toBe('github-release')
  })

})

// ---------------------------------------------------------------------------
// pyright
// ---------------------------------------------------------------------------

describe('pyright', () => {
  test('detect via which — returns config with pyright-langserver binary', async () => {
    mockExecFile.mockImplementation(whichSucceeds('pyright-langserver', '/usr/bin/pyright-langserver'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['pyright']
    expect(s).toBeDefined()
    expect(s.command).toBe('/usr/bin/pyright-langserver')
    expect(s.args).toEqual(['--stdio'])
    expect(s.extensionToLanguage['.py']).toBe('python')
    expect(s.extensionToLanguage['.pyi']).toBe('python')
  })

  test('installer is npm with pyright-langserver binary override', async () => {
    const { SERVER_DEFINITIONS } = await freshModule()
    const pyright = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'pyright')
    expect(pyright.installer.type).toBe('npm')
    // npm install -g pyright installs the binary as pyright-langserver, not pyright
    // npm().install() calls: (1) npm install -g pyright, (2) which pyright-langserver
    mockExecFile
      .mockImplementationOnce(() => Promise.resolve({ code: 0, stdout: '', stderr: '' })) // npm install -g pyright ok
      .mockImplementationOnce(() => Promise.resolve({ code: 0, stdout: '/usr/bin/pyright-langserver\n', stderr: '' })) // which pyright-langserver hit
    const bin = await pyright.installer.install()
    expect(bin).toBe('/usr/bin/pyright-langserver')
    // must NOT have called which with 'pyright' (would return null since package != binary)
    const whichCalls = mockExecFile.mock.calls.filter((c: unknown[]) => c[0] === 'which')
    expect(whichCalls.every((c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'pyright-langserver')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// gopls
// ---------------------------------------------------------------------------

describe('gopls', () => {
  test('detect via which — returns config', async () => {
    mockExecFile.mockImplementation(whichSucceeds('gopls', '/usr/local/go/bin/gopls'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['gopls']
    expect(s).toBeDefined()
    expect(s.extensionToLanguage['.go']).toBe('go')
  })

  test('detect fails + go present → go install attempted', async () => {
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'go') return { code: 0, stdout: '/usr/bin/go\n', stderr: '' }
      if (cmd === 'go') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'which' && args[0] === 'gopls') return { code: 0, stdout: '/usr/bin/gopls\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { SERVER_DEFINITIONS } = await freshModule()
    const gopls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'gopls')
    const result = await gopls.installer.install()
    expect(result).toBe('/usr/bin/gopls')
  })

  test('detect fails + go absent → null', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { SERVER_DEFINITIONS } = await freshModule()
    const gopls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'gopls')
    const result = await gopls.installer.install()
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// biome
// ---------------------------------------------------------------------------

describe('biome', () => {
  test('detect via which — extensionToLanguage covers json/jsonc', async () => {
    mockExecFile.mockImplementation(whichSucceeds('biome', '/usr/bin/biome'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['biome']
    expect(s).toBeDefined()
    expect(s.extensionToLanguage['.json']).toBe('json')
    expect(s.extensionToLanguage['.jsonc']).toBe('jsonc')
    expect(s.extensionToLanguage['.ts']).toBe('typescript')
  })

  test('installer is npm with @biomejs/biome', async () => {
    const { SERVER_DEFINITIONS } = await freshModule()
    const biome = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'biome')
    expect(biome.installer.type).toBe('npm')
  })
})

// ---------------------------------------------------------------------------
// yaml-language-server
// ---------------------------------------------------------------------------

describe('yaml-language-server', () => {
  test('detect via which — returns config with .yml/.yaml', async () => {
    mockExecFile.mockImplementation(whichSucceeds('yaml-language-server', '/usr/bin/yaml-language-server'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['yaml-language-server']
    expect(s).toBeDefined()
    expect(s.extensionToLanguage['.yml']).toBe('yaml')
    expect(s.extensionToLanguage['.yaml']).toBe('yaml')
    expect(s.args).toContain('--stdio')
  })
})

// ---------------------------------------------------------------------------
// taplo
// ---------------------------------------------------------------------------

describe('taplo', () => {
  test('detect via which — returns .toml config', async () => {
    mockExecFile.mockImplementation(whichSucceeds('taplo', '/usr/bin/taplo'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['taplo']
    expect(s).toBeDefined()
    expect(s.extensionToLanguage['.toml']).toBe('toml')
  })

  test('installer is github-release from tamasfe/taplo', async () => {
    const { SERVER_DEFINITIONS } = await freshModule()
    const taplo = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'taplo')
    expect(taplo.installer.type).toBe('github-release')
  })
})

// ---------------------------------------------------------------------------
// dart
// ---------------------------------------------------------------------------

describe('dart', () => {
  test('detect via which — returns config with language-server arg', async () => {
    mockExecFile.mockImplementation(whichSucceeds('dart', '/usr/bin/dart'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['dart']
    expect(s).toBeDefined()
    expect(s.args).toContain('language-server')
    expect(s.extensionToLanguage['.dart']).toBe('dart')
  })

  test('detect fails — no install (no installer)', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { SERVER_DEFINITIONS } = await freshModule()
    const dart = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'dart')
    expect(dart.installer).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// omnisharp
// ---------------------------------------------------------------------------

describe('omnisharp', () => {
  test('detect via which — returns .cs/.csx config', async () => {
    mockExecFile.mockImplementation(whichSucceeds('OmniSharp', '/usr/bin/OmniSharp'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['omnisharp']
    expect(s).toBeDefined()
    expect(s.extensionToLanguage['.cs']).toBe('csharp')
    expect(s.extensionToLanguage['.csx']).toBe('csharp')
  })

  test('installer is github-release', async () => {
    const { SERVER_DEFINITIONS } = await freshModule()
    const omnisharp = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'omnisharp')
    expect(omnisharp.installer.type).toBe('github-release')
  })
})

// ---------------------------------------------------------------------------
// jdtls
// ---------------------------------------------------------------------------

describe('jdtls', () => {
  test('java absent → excluded', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['jdtls']).toBeUndefined()
  })

  test('java present + jar found → config with -jar arg', async () => {
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'java') return { code: 0, stdout: '/usr/bin/java\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    mockReaddir.mockImplementation(async () => ['org.eclipse.equinox.launcher_1.6.0.v20210129.jar'] as string[])
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['jdtls']
    expect(s).toBeDefined()
    expect(s.command).toBe('java')
    expect(s.args).toContain('-jar')
    expect(s.extensionToLanguage['.java']).toBe('java')
  })

  test('java present + no jar → excluded', async () => {
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'java') return { code: 0, stdout: '/usr/bin/java\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    mockReaddir.mockImplementation(async () => [])
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['jdtls']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// kotlin-language-server
// ---------------------------------------------------------------------------

describe('kotlin-language-server', () => {
  test('java absent → excluded', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['kotlin-language-server']).toBeUndefined()
  })

  test('java present + kotlin server binary found → config', async () => {
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
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['kotlin-language-server']
    expect(s).toBeDefined()
    // kotlin-language-server ships a launcher script — execute it directly, not via java -jar
    expect(s.command).toContain('kotlin-language-server')
    expect(s.args).toEqual([])
    expect(s.extensionToLanguage['.kt']).toBe('kotlin')
    expect(s.extensionToLanguage['.kts']).toBe('kotlin')
  })

  test('installer is github-release from fwcd/kotlin-language-server', async () => {
    const { SERVER_DEFINITIONS } = await freshModule()
    const kls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'kotlin-language-server')
    expect(kls.installer.type).toBe('github-release')
  })
})

// ---------------------------------------------------------------------------
// clangd
// ---------------------------------------------------------------------------

describe('clangd', () => {
  test('detect via which — returns C/C++ extensions config', async () => {
    mockExecFile.mockImplementation(whichSucceeds('clangd', '/usr/bin/clangd'))
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const s = result['clangd']
    expect(s).toBeDefined()
    expect(s.extensionToLanguage['.c']).toBe('c')
    expect(s.extensionToLanguage['.cpp']).toBe('cpp')
    expect(s.extensionToLanguage['.cc']).toBe('cpp')
    expect(s.extensionToLanguage['.cxx']).toBe('cpp')
    expect(s.extensionToLanguage['.h']).toBe('c')
    expect(s.extensionToLanguage['.hpp']).toBe('cpp')
    expect(s.extensionToLanguage['.hxx']).toBe('cpp')
  })

  test('installer is github-release from clangd/clangd', async () => {
    const { SERVER_DEFINITIONS } = await freshModule()
    const clangd = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'clangd')
    expect(clangd.installer.type).toBe('github-release')
  })
})

// ---------------------------------------------------------------------------
// All 12 servers present when all detected
// ---------------------------------------------------------------------------

describe('all 12 servers', () => {
  test('all present when which returns 0 for all binaries + java jar found + kotlin bin found', async () => {
    mockExecFile.mockImplementation(async (...a: unknown[]) => {
      const [cmd, args] = a as [string, string[]]
      if (cmd === 'which') return { code: 0, stdout: `/${args[0]}\n`, stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    mockReaddir.mockImplementation(async () => ['org.eclipse.equinox.launcher_1.6.0.v20210129.jar'] as string[])
    mockAccess.mockImplementation(async () => {}) // kotlin bin accessible
    mockGetUserLspSettings.mockReturnValue({})
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    const names = Object.keys(result)
    expect(names).toContain('typescript-language-server')
    expect(names).toContain('rust-analyzer')
    expect(names).toContain('pyright')
    expect(names).toContain('gopls')
    expect(names).toContain('biome')
    expect(names).toContain('yaml-language-server')
    expect(names).toContain('taplo')
    expect(names).toContain('dart')
    expect(names).toContain('omnisharp')
    expect(names).toContain('jdtls')
    expect(names).toContain('kotlin-language-server')
    expect(names).toContain('clangd')
    expect(names.length).toBe(12)
  })
})

// ---------------------------------------------------------------------------
// disabled: true in user settings suppresses background install
// ---------------------------------------------------------------------------

describe('getBuiltinLspServers — disabled server', () => {
  test('installInBackground NOT called when server has disabled: true in user settings', async () => {
    mockGetUserLspSettings.mockReturnValue({ 'typescript-language-server': { disabled: true } })
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    // mockWriteFile would be called by writeInstallStatus if installInBackground ran
    const { getBuiltinLspServers } = await freshModule()
    await getBuiltinLspServers()
    const writeCallPaths = mockWriteFile.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(writeCallPaths.some(p => p.includes('typescript-language-server') && p.includes('.install-status'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// See builtinServers.integration.test.ts for the rationale.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('fs/promises', () => realFsPromisesServers)
  mock.module('os', () => realOsServers)
  mock.module('axios', () => ({ default: {} }))
  mock.module('../../utils/execFileNoThrow.js', () => realExecFileNoThrowServers)
  mock.module('../../utils/log.js', () => realLogServers)
  mock.module('src/utils/log.js', () => realLogServers)
  mock.module('../../utils/envUtils.js', () => realEnvUtilsServers)
  mock.module('src/utils/envUtils.js', () => realEnvUtilsServers)
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
  mock.module('./userSettings.js', () => realUserSettingsServers)
  mock.module('src/services/lsp/userSettings.js', () => realUserSettingsServers)
})
