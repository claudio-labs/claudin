import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'

// createRequire bypasses Bun's mock.module — these are guaranteed real even
// if a previously-loaded test file already registered an incomplete mock
// for the same specifier.
const _require = createRequire(import.meta.url)
const realFflate = _require('fflate') as typeof import('fflate')
const realFs = _require('fs') as typeof import('fs')

// Top-level mocks — must come before imports of the module under test
const mockIsConnected = mock(() => false)
mock.module('./manager.js', () => ({
  isLspConnected: mockIsConnected,
  reinitializeLspServerManager: mock(() => {}),
  getLspServerManager: () => undefined,
  initializeLspServerManager: () => {},
  shutdownLspServerManager: async () => {},
  getInitializationStatus: () => ({ status: 'not-started' }),
  waitForInitialization: async () => {},
  _resetLspManagerForTesting: () => {},
}))

// Capture the real module before mocking so afterAll can restore it.
const realExecFileNoThrowRows = { ...(await import('../../utils/execFileNoThrow.js')) }

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

const mockGetUserSettings = mock(() => ({} as Record<string, { disabled?: boolean }>))
const realUserSettingsRows = { ...(await import('./userSettings.js')) }
mock.module('./userSettings.js', () => ({
  ...realUserSettingsRows,
  getUserLspSettings: mockGetUserSettings,
  isLspGloballyEnabled: mock(() => true),
}))

const realOsRows = _require('os') as typeof import('os')
mock.module('os', () => ({ ...realOsRows, default: realOsRows, homedir: () => '/home/test', release: () => '5.15.0', platform: () => 'linux' }))

const realEnvUtilsRows = { ...(await import('../../utils/envUtils.js')) }
mock.module('../../utils/envUtils.js', () => ({
  ...realEnvUtilsRows,
  getClaudioConfigHomeDir: () => '/home/test/.claudio',
}))

type AsyncFn = (...args: unknown[]) => Promise<unknown>
const mockReadFile = mock<AsyncFn>(async () => { throw new Error('ENOENT') })
const realFsPromisesRows = _require('fs/promises') as typeof import('fs/promises')

mock.module('fs/promises', () => ({
  ...realFsPromisesRows,
  readFile: mockReadFile,
  writeFile: mock(async () => {}),
  mkdir: mock(async () => undefined),
  access: mock(async () => {}),
  unlink: mock(async () => {}),
  readdir: mock(async () => [] as string[]),
  chmod: mock(async () => {}),
  open: mock(async () => ({ close: async () => {} })),
  rmdir: mock(async () => {}),
  stat: mock(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  lstat: mock(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  realpath: mock(async (p: unknown) => p as string),
  rename: mock(async () => {}),
  copyFile: mock(async () => {}),
  rm: mock(async () => {}),
  appendFile: mock(async () => {}),
  symlink: mock(async () => {}),
  readlink: mock(async () => ''),
  truncate: mock(async () => {}),
  link: mock(async () => {}),
  utimes: mock(async () => {}),
  watch: mock(() => ({ [Symbol.asyncIterator]: async function* () {} })),
}))

const realLogRows = { ...(await import('../../utils/log.js')) }
mock.module('../../utils/log.js', () => ({ ...realLogRows, logError: mock(() => {}) }))

// Stub heavy dependencies not needed for getLspServerRows
mock.module('axios', () => ({ default: { get: mock(async () => ({ data: new ArrayBuffer(0) })) } }))
mock.module('fflate', () => ({
  ...realFflate,
  unzip: mock((_b: unknown, cb: (e: null, f: Record<string, unknown>) => void) => cb(null, {})),
}))
mock.module('fs', () => ({ ...realFs, createWriteStream: mock(() => null) }))

async function freshModule() {
  return import(`./builtinServers.ts?rows=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  mockExecFile.mockReset()
  mockGetUserSettings.mockReset()
  mockReadFile.mockReset()
  mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
  mockGetUserSettings.mockReturnValue({})
})

describe('getLspServerRows', () => {
  test('returns exactly 12 rows', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getLspServerRows } = await freshModule()
    const rows = await getLspServerRows()
    expect(rows).toHaveLength(12)
  })

  test('detected when which finds binary', async () => {
    mockExecFile.mockImplementation(async (_cmd: unknown, args: unknown) => {
      const [name] = args as string[]
      if (name === 'typescript-language-server') {
        return { code: 0, stdout: '/usr/bin/typescript-language-server\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { getLspServerRows } = await freshModule()
    const rows = await getLspServerRows()
    const row = rows.find((r: { name: string }) => r.name === 'typescript-language-server')
    expect(row).toBeDefined()
    expect(row?.found).toBe(true)
    expect(row?.status).toBe('✓ detected')
  })

  test('missing when which fails', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getLspServerRows } = await freshModule()
    const rows = await getLspServerRows()
    const row = rows.find((r: { name: string }) => r.name === 'typescript-language-server')
    expect(row).toBeDefined()
    expect(row?.found).toBe(false)
    expect(row?.status).toBe('✗ missing')
  })

  test('disabled when server is in user settings as disabled', async () => {
    mockGetUserSettings.mockReturnValue({ 'typescript-language-server': { disabled: true } })
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getLspServerRows } = await freshModule()
    const rows = await getLspServerRows()
    const row = rows.find((r: { name: string }) => r.name === 'typescript-language-server')
    expect(row).toBeDefined()
    expect(row?.disabled).toBe(true)
    expect(row?.status).toBe('⊘ disabled')
  })

  test('installing when install-status.json has in-progress', async () => {
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = path as string
      if (p.endsWith('typescript-language-server/.install-status.json')) {
        return JSON.stringify({ status: 'in-progress', attemptedAt: Date.now() })
      }
      throw new Error('ENOENT')
    })
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getLspServerRows } = await freshModule()
    const rows = await getLspServerRows()
    const row = rows.find((r: { name: string }) => r.name === 'typescript-language-server')
    expect(row).toBeDefined()
    expect(row?.status).toBe('⏳ installing')
  })

  test('managed: true when binary is under getClaudioConfigHomeDir', async () => {
    mockExecFile.mockImplementation(async (_cmd: unknown, args: unknown) => {
      const [name] = args as string[]
      if (name === 'rust-analyzer') {
        return { code: 0, stdout: '/home/test/.claudio/lsp/rust-analyzer/bin/rust-analyzer\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { getLspServerRows } = await freshModule()
    const rows = await getLspServerRows()
    const row = rows.find((r: { name: string }) => r.name === 'rust-analyzer')
    expect(row).toBeDefined()
    expect(row?.managed).toBe(true)
  })

  test('managed: false when binary is in user PATH', async () => {
    mockExecFile.mockImplementation(async (_cmd: unknown, args: unknown) => {
      const [name] = args as string[]
      if (name === 'clangd') {
        return { code: 0, stdout: '/usr/bin/clangd\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    const { getLspServerRows } = await freshModule()
    const rows = await getLspServerRows()
    const row = rows.find((r: { name: string }) => r.name === 'clangd')
    expect(row).toBeDefined()
    expect(row?.managed).toBe(false)
  })

  test('dart has installer manual (SDK)', async () => {
    mockExecFile.mockImplementation(async () => ({ code: 1, stdout: '', stderr: '' }))
    const { getLspServerRows } = await freshModule()
    const rows = await getLspServerRows()
    const row = rows.find((r: { name: string }) => r.name === 'dart')
    expect(row).toBeDefined()
    expect(row?.installer).toBe('manual (SDK)')
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// See builtinServers.integration.test.ts for the rationale.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('fs/promises', () => realFsPromisesRows)
  mock.module('fs', () => realFs)
  mock.module('os', () => realOsRows)
  mock.module('fflate', () => realFflate)
  mock.module('axios', () => ({ default: {} }))
  mock.module('../../utils/execFileNoThrow.js', () => realExecFileNoThrowRows)
  mock.module('../../utils/log.js', () => realLogRows)
  mock.module('src/utils/log.js', () => realLogRows)
  mock.module('../../utils/envUtils.js', () => realEnvUtilsRows)
  mock.module('src/utils/envUtils.js', () => realEnvUtilsRows)
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
  mock.module('./userSettings.js', () => realUserSettingsRows)
  mock.module('src/services/lsp/userSettings.js', () => realUserSettingsRows)
})
