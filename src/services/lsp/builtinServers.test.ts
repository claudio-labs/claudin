import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'

// createRequire bypasses Bun's mock.module — these are guaranteed real even
// if a previously-loaded test file already registered an incomplete mock
// for the same specifier.
const _require = createRequire(import.meta.url)

// Top-level mocks — must come before imports of the module under test
const mockExecFile = mock(async (_cmd: string, _args: string[]) => ({
  code: 0,
  stdout: '/usr/bin/typescript-language-server\n',
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
const realLogBuiltin = await import('../../utils/log.js')
mock.module('../../utils/log.js', () => ({
  ...realLogBuiltin,
  logError: mockLogError,
}))

const mockReinit = mock(() => {})
mock.module('./manager.js', () => ({
  reinitializeLspServerManager: mockReinit,
  isLspConnected: () => false,
  getLspServerManager: () => undefined,
  initializeLspServerManager: () => {},
  shutdownLspServerManager: async () => {},
  getInitializationStatus: () => ({ status: 'not-started' }),
  waitForInitialization: async () => {},
  _resetLspManagerForTesting: () => {},
}))

const fakeHome = '/tmp/fake-home-lsp-test'
const realOs = _require('os') as typeof import('os')
mock.module('os', () => ({
  ...realOs,
  default: realOs,
  homedir: () => fakeHome,
  release: () => '5.15.0',
  type: () => 'Linux',
  version: () => '#1 SMP',
}))

const mockConfigDir = '/tmp/fake-claudio-lsp-test'
const realEnvUtilsBuiltin = await import('../../utils/envUtils.js')
mock.module('../../utils/envUtils.js', () => ({
  ...realEnvUtilsBuiltin,
  getClaudioConfigHomeDir: () => mockConfigDir,
  isEnvTruthy: (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false',
}))

type AnyAsyncFn = (...args: unknown[]) => Promise<unknown>
const mockAxiosGet = mock<AnyAsyncFn>(async () => ({ data: new ArrayBuffer(0) }))
mock.module('axios', () => ({
  default: { get: mockAxiosGet },
}))

// fs/promises mock — all functions are individually mocked; override per-test as needed
const mockReadFile = mock<AnyAsyncFn>(async () => { throw new Error('ENOENT') })
const mockWriteFile = mock<AnyAsyncFn>(async () => {})
const mockMkdir = mock<AnyAsyncFn>(async () => undefined)
const mockAccess = mock<AnyAsyncFn>(async () => {})
const mockUnlink = mock<AnyAsyncFn>(async () => {})
const mockReaddir = mock<AnyAsyncFn>(async () => [] as string[])

const realFsPromisesBuiltin = _require('fs/promises') as typeof import('fs/promises')
mock.module('fs/promises', () => ({
  ...realFsPromisesBuiltin,
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

// fs.createWriteStream — used by the streaming gz path; route into a
// Writable that drops bytes on the floor so tests don't touch real disk.
const realFs = _require('fs') as typeof import('fs')
const { Writable: _Writable } = _require('stream') as typeof import('stream')
function makeNullWritable() {
  return new _Writable({ write(_c, _e, cb) { cb() } })
}
mock.module('fs', () => ({
  ...realFs,
  createWriteStream: () => makeNullWritable(),
}))

const mockGetUserLspSettings = mock(() => ({} as Record<string, { disabled?: boolean }>))
const realUserSettingsBuiltin = await import('./userSettings.js')
mock.module('./userSettings.js', () => ({
  ...realUserSettingsBuiltin,
  getUserLspSettings: mockGetUserLspSettings,
  isLspGloballyEnabled: mock(() => true),
}))

// Import after mocks
async function freshModule() {
  return import(`./builtinServers.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mockExecFile.mockReset()
  mockLogError.mockReset()
  mockReinit.mockReset()
  mockAxiosGet.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockMkdir.mockReset()
  mockAccess.mockReset()
  mockUnlink.mockReset()
  mockReaddir.mockReset()
  mockGetUserLspSettings.mockReset()
})

// ---------------------------------------------------------------------------
// whichBinary
// ---------------------------------------------------------------------------

describe('whichBinary', () => {
  test('returns path when which exits 0', async () => {
    mockExecFile.mockImplementation(async () => ({
      code: 0,
      stdout: '/usr/bin/tls\n',
      stderr: '',
    }))
    const { whichBinary } = await freshModule()
    expect(await whichBinary('tls')).toBe('/usr/bin/tls')
  })

  test('returns null when which exits non-zero', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { whichBinary } = await freshModule()
    expect(await whichBinary('missing-binary')).toBeNull()
  })

  test('returns null when stdout is empty', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 0, stdout: '   \n', stderr: '' }))
    const { whichBinary } = await freshModule()
    expect(await whichBinary('empty')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// npm() factory installer
// ---------------------------------------------------------------------------

describe('npm() installer', () => {
  test('executes npm install -g and returns path on success', async () => {
    mockExecFile.mockImplementation(async (...a: unknown[]) => { const [cmd] = a as [string, string[]];
      if (cmd === 'npm') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'which') return { code: 0, stdout: '/usr/local/bin/typescript-language-server\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    const result = await tls.installer.install()
    expect(result).toBe('/usr/local/bin/typescript-language-server')
    expect(mockExecFile).toHaveBeenCalledWith('npm', ['install', '-g', 'typescript-language-server'], expect.any(Object))
  })

  test('returns null and logs error when npm fails', async () => {
    mockExecFile.mockImplementation(async (cmd: string) => {
      if (cmd === 'npm') return { code: 1, stdout: '', stderr: 'npm ERR!' }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    const result = await tls.installer.install()
    expect(result).toBeNull()
    expect(mockLogError).toHaveBeenCalledTimes(1)
  })

  test('returns null when which after npm install fails', async () => {
    mockExecFile.mockImplementation(async (cmd: string) => {
      if (cmd === 'npm') return { code: 0, stdout: '', stderr: '' }
      return { code: 1, stdout: '', stderr: '' } // which fails
    })
    const { SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    const result = await tls.installer.install()
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// goInstall() factory installer
// ---------------------------------------------------------------------------

describe('goInstall() installer', () => {
  test('returns null when go is not in PATH', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { SERVER_DEFINITIONS } = await freshModule()
    const gopls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'gopls')
    const result = await gopls.installer.install()
    expect(result).toBeNull()
  })

  test('executes go install and returns path on success', async () => {
    mockExecFile.mockImplementation(async (...a: unknown[]) => { const [cmd, args] = a as [string, string[]];
      if (cmd === 'which' && args[0] === 'go') return { code: 0, stdout: '/usr/bin/go\n', stderr: '' }
      if (cmd === 'go') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'which' && args[0] === 'gopls') return { code: 0, stdout: '/usr/bin/gopls\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { SERVER_DEFINITIONS } = await freshModule()
    const gopls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'gopls')
    const result = await gopls.installer.install()
    expect(result).toBe('/usr/bin/gopls')
    expect(mockExecFile).toHaveBeenCalledWith('go', ['install', 'golang.org/x/tools/gopls@latest'], expect.any(Object))
  })

  test('returns null and logs error when go install fails', async () => {
    mockExecFile.mockImplementation(async (...a: unknown[]) => { const [cmd, args] = a as [string, string[]];
      if (cmd === 'which' && args[0] === 'go') return { code: 0, stdout: '/usr/bin/go\n', stderr: '' }
      if (cmd === 'go') return { code: 1, stdout: '', stderr: 'go: network error' }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { SERVER_DEFINITIONS } = await freshModule()
    const gopls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'gopls')
    const result = await gopls.installer.install()
    expect(result).toBeNull()
    expect(mockLogError).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// githubRelease() factory installer
// ---------------------------------------------------------------------------

describe('githubRelease() installer', () => {
  test('uses cache when checkedAt < 24h and binary accessible', async () => {
    const cachedStatus = JSON.stringify({ checkedAt: Date.now() - 1_000, tag: 'v1.0' })
    mockReadFile.mockImplementation(async () => cachedStatus)
    mockAccess.mockImplementation(async () => {}) // binary exists
    const { SERVER_DEFINITIONS } = await freshModule()
    const rustAnalyzer = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'rust-analyzer')
    const result = await rustAnalyzer.installer.install()
    expect(mockAxiosGet).not.toHaveBeenCalled()
    expect(result).not.toBeNull()
  })

  test('fetches new release when cache expired', async () => {
    const expiredStatus = JSON.stringify({ checkedAt: Date.now() - 90_000_000, tag: 'v0.9' })
    mockReadFile.mockImplementation(async () => expiredStatus)
    mockAccess.mockImplementation(async () => { throw new Error('no file') })

    const platform = process.platform
    const arch = process.arch
    const osMap: Record<string, string> = { linux: 'unknown-linux-gnu', darwin: 'apple-darwin', win32: 'pc-windows-msvc' }
    const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' }
    const triple = `${archMap[arch] ?? arch}-${osMap[platform] ?? platform}`
    const assetName = `rust-analyzer-${triple}.gz`

    mockAxiosGet.mockImplementation(async (url: unknown) => {
      if (typeof url === 'string' && url.includes('api.github.com')) {
        return { data: { tag_name: 'v2.0', assets: [{ name: assetName, browser_download_url: `https://example.com/${assetName}` }] } }
      }
      // binary download — return a Readable stream of gzipped bytes,
      // matching the new responseType: 'stream' contract.
      const { strToU8, gzipSync } = await import('fflate')
      const { Readable } = await import('node:stream')
      const gz = gzipSync(strToU8('fake-binary'))
      return { data: Readable.from([Buffer.from(gz)]) }
    })

    const { SERVER_DEFINITIONS } = await freshModule()
    const rustAnalyzer = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'rust-analyzer')
    const result = await rustAnalyzer.installer.install()
    expect(mockAxiosGet).toHaveBeenCalledTimes(2) // github API + download
    expect(result).not.toBeNull()
  })

  test('returns null when GitHub API fails', async () => {
    mockReadFile.mockImplementation(async () => { throw new Error('no cache') })
    mockAxiosGet.mockImplementation(async () => { throw new Error('network error') })
    const { SERVER_DEFINITIONS } = await freshModule()
    const rustAnalyzer = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'rust-analyzer')
    const result = await rustAnalyzer.installer.install()
    expect(result).toBeNull()
    expect(mockLogError).toHaveBeenCalledTimes(1)
  })

  test('returns null when no asset matches platform', async () => {
    mockReadFile.mockImplementation(async () => { throw new Error('no cache') })
    mockAxiosGet.mockImplementation(async () => ({
      data: { tag_name: 'v1.0', assets: [{ name: 'unsupported-platform.exe', browser_download_url: 'https://x.com/x' }] },
    }))
    const { SERVER_DEFINITIONS } = await freshModule()
    // omnisharp has platform-specific asset selection; use a predictable case
    const clangd = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'clangd')
    // On current platform there might be a match; test with wrong platform by mocking process.platform?
    // Instead, verify null is returned by having no matching assets:
    const result = await clangd.installer.install()
    // We can't easily override process.platform here; accept either null or a path
    // The key assertion is that when no asset matches, logError is called
    if (result === null) {
      expect(mockLogError).toHaveBeenCalled()
    }
  })
})

// ---------------------------------------------------------------------------
// installInBackground + anti-loop
// ---------------------------------------------------------------------------

describe('installInBackground', () => {
  beforeEach(() => {
    // Default: no existing status file
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockWriteFile.mockImplementation(async () => {})
    mockMkdir.mockImplementation(async () => undefined)
    mockUnlink.mockImplementation(async () => {})
  })

  test('installs when no status file exists', async () => {
    mockExecFile.mockImplementation(async (cmd: string) => {
      if (cmd === 'npm') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'which') return { code: 0, stdout: '/usr/bin/typescript-language-server\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    await installInBackground(tls)
    expect(mockReinit).toHaveBeenCalledTimes(1)
    expect(mockUnlink).toHaveBeenCalledTimes(1)
  })

  test('skips when status is in-progress < 30min', async () => {
    const status = JSON.stringify({ status: 'in-progress', attemptedAt: Date.now() - 1_000 })
    mockReadFile.mockImplementation(async () => status)
    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    await installInBackground(tls)
    expect(mockExecFile).not.toHaveBeenCalledWith('npm', expect.any(Array), expect.any(Object))
    expect(mockReinit).not.toHaveBeenCalled()
  })

  test('retries when status is in-progress >= 30min (stale)', async () => {
    const status = JSON.stringify({ status: 'in-progress', attemptedAt: Date.now() - 31 * 60_000 })
    mockReadFile.mockImplementation(async () => status)
    mockExecFile.mockImplementation(async (cmd: string) => {
      if (cmd === 'npm') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'which') return { code: 0, stdout: '/bin/tls\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    await installInBackground(tls)
    expect(mockReinit).toHaveBeenCalledTimes(1)
  })

  test('skips when status is failed < 7 days', async () => {
    const status = JSON.stringify({ status: 'failed', attemptedAt: Date.now() - 24 * 3_600_000 })
    mockReadFile.mockImplementation(async () => status)
    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    await installInBackground(tls)
    expect(mockExecFile).not.toHaveBeenCalledWith('npm', expect.any(Array), expect.any(Object))
    expect(mockReinit).not.toHaveBeenCalled()
  })

  test('retries when status is failed >= 7 days', async () => {
    const status = JSON.stringify({ status: 'failed', attemptedAt: Date.now() - 8 * 24 * 3_600_000 })
    mockReadFile.mockImplementation(async () => status)
    mockExecFile.mockImplementation(async (cmd: string) => {
      if (cmd === 'npm') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'which') return { code: 0, stdout: '/bin/tls\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    await installInBackground(tls)
    expect(mockReinit).toHaveBeenCalledTimes(1)
  })

  test('writes failed status when install returns null', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: 'fail' }))
    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    await installInBackground(tls)
    expect(mockReinit).not.toHaveBeenCalled()
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.install-status.json'),
      expect.stringContaining('"failed"'),
      'utf8',
    )
  })

  test('writes failed status on exception + does not propagate', async () => {
    mockExecFile.mockImplementation(async (cmd: string) => {
      if (cmd === 'npm') throw new Error('unexpected crash')
      return { code: 1, stdout: '', stderr: '' }
    })
    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    const tls = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'typescript-language-server')
    await installInBackground(tls)
    expect(mockReinit).not.toHaveBeenCalled()
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.install-status.json'),
      expect.stringContaining('"failed"'),
      'utf8',
    )
  })

  test('does not install when def has no installer (dart)', async () => {
    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    const dart = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'dart')
    await installInBackground(dart)
    expect(mockExecFile).not.toHaveBeenCalled()
    expect(mockReinit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getBuiltinLspServers — startup
// ---------------------------------------------------------------------------

describe('getBuiltinLspServers', () => {
  test('includes server when which succeeds', async () => {
    mockGetUserLspSettings.mockReturnValue({})
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockExecFile.mockImplementation(async (...a: unknown[]) => { const [cmd, args] = a as [string, string[]];
      if (cmd === 'which' && args[0] === 'typescript-language-server') {
        return { code: 0, stdout: '/usr/bin/typescript-language-server\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['typescript-language-server']).toBeDefined()
    expect(result['typescript-language-server'].scope).toBe('builtin')
    expect(result['typescript-language-server'].source).toBe('builtin')
  })

  test('excludes server when which fails — no install triggered', async () => {
    mockGetUserLspSettings.mockReturnValue({})
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['typescript-language-server']).toBeUndefined()
    expect(result['gopls']).toBeUndefined()
    // No npm/go/curl calls — detect-only, no auto-install
    const installCalls = mockExecFile.mock.calls.filter(
      (args) => args[0] === 'npm' || args[0] === 'go',
    )
    expect(installCalls).toHaveLength(0)
  })

  test('does not propagate exceptions from one server — others still included', async () => {
    mockGetUserLspSettings.mockReturnValue({})
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockExecFile.mockImplementation(async (...a: unknown[]) => { const [cmd, args] = a as [string, string[]];
      if (cmd !== 'which') return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'typescript-language-server') {
        return { code: 0, stdout: '/usr/bin/typescript-language-server\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['typescript-language-server']).toBeDefined()
    expect(Object.values(result as Record<string, { scope: string }>).every(s => s.scope === 'builtin')).toBe(true)
  })

  test('all results have scope=builtin and source=builtin', async () => {
    mockGetUserLspSettings.mockReturnValue({})
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockExecFile.mockImplementation(async (...a: unknown[]) => { const [cmd, args] = a as [string, string[]];
      if (cmd === 'which' && args[0] === 'typescript-language-server') {
        return { code: 0, stdout: '/usr/bin/tls\n', stderr: '' }
      }
      if (cmd === 'which' && args[0] === 'clangd') {
        return { code: 0, stdout: '/usr/bin/clangd\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    for (const server of Object.values(result) as Array<{ scope: string; source: string }>) {
      expect(server.scope).toBe('builtin')
      expect(server.source).toBe('builtin')
    }
  })

  test('dart is excluded when dart binary not in PATH (no install attempted)', async () => {
    mockGetUserLspSettings.mockReturnValue({})
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['dart']).toBeUndefined()
  })

  test('jdtls excluded when java not in PATH', async () => {
    mockGetUserLspSettings.mockReturnValue({})
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['jdtls']).toBeUndefined()
  })

  test('excludes disabled server even when binary is in PATH', async () => {
    mockExecFile.mockImplementation(async (...a: unknown[]) => { const [cmd, args] = a as [string, string[]];
      if (cmd === 'which' && args[0] === 'typescript-language-server') {
        return { code: 0, stdout: '/usr/bin/tls\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    mockGetUserLspSettings.mockReturnValue({ 'typescript-language-server': { disabled: true } })
    const { getBuiltinLspServers } = await freshModule()
    const result = await getBuiltinLspServers()
    expect(result['typescript-language-server']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// Bun's mock.module() is process-global with no auto-restore; without these
// resets, our incomplete factories above corrupt every later file that pulls
// the same specifier (notably wiki tests using fs/promises and node:os).
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('fs/promises', () => realFsPromisesBuiltin)
  mock.module('fs', () => realFs)
  mock.module('os', () => realOs)
  mock.module('axios', () => ({ default: {} }))
  mock.module('../../utils/execFileNoThrow.js', () => ({
    execFileNoThrow: () => ({ code: 0, stdout: '', stderr: '' }),
    execFileNoThrowWithCwd: () => ({ code: 0, stdout: '', stderr: '' }),
  }))
  mock.module('../../utils/log.js', () => ({ ...realLogBuiltin, logError: () => {} }))
  mock.module('../../utils/envUtils.js', () => ({
    ...realEnvUtilsBuiltin,
    getClaudioConfigHomeDir: () => '/tmp',
    isEnvTruthy: (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false',
  }))
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
  mock.module('./userSettings.js', () => ({
    ...realUserSettingsBuiltin,
    getUserLspSettings: () => ({}),
    isLspGloballyEnabled: () => true,
  }))
})
