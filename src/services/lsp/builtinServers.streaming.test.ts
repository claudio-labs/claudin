/**
 * Streaming + concurrency tests for builtinServers auto-install.
 *
 * Part 1: the .gz download path must NOT call fflate.gunzipSync — large
 * archives (rust-analyzer ~50MB.gz → 150MB) blocked the Ink render loop
 * for seconds when decompression ran synchronously on the main thread.
 * The new pipeline streams the HTTP body through node:zlib gunzip into
 * a write stream, never assembling the inflated buffer in memory.
 *
 * Part 2: installInBackground serializes the heavy install path through
 * a module-level promise queue (concurrency = 1). Detection (whichBinary)
 * is unaffected — only the actual install work is queued.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Readable, Writable } from 'stream'
import { createRequire } from 'node:module'

// createRequire bypasses Bun's mock.module — these are guaranteed real even
// if a previously-loaded test file already registered an incomplete mock
// for the same specifier.
const _require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Top-level mocks — installed before any import of the module under test
// ---------------------------------------------------------------------------

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
const realLogStreaming = await import('../../utils/log.js')
mock.module('../../utils/log.js', () => ({ ...realLogStreaming, logError: mockLogError }))

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
const realOsStreaming = _require('os') as typeof import('os')
mock.module('os', () => ({ ...realOsStreaming, default: realOsStreaming, homedir: () => '/tmp/fake-home-streaming', release: () => '5.15.0', type: () => 'Linux', version: () => '#1 SMP' }))
const realEnvUtilsStreaming = await import('../../utils/envUtils.js')
mock.module('../../utils/envUtils.js', () => ({
  ...realEnvUtilsStreaming,
  getClaudioConfigHomeDir: () => '/tmp/fake-config-streaming',
  isEnvTruthy: (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false',
}))

const mockGetUserLspSettings = mock(() => ({} as Record<string, { disabled?: boolean }>))
const realUserSettingsStreaming = await import('./userSettings.js')
mock.module('./userSettings.js', () => ({
  ...realUserSettingsStreaming,
  getUserLspSettings: mockGetUserLspSettings,
  isLspGloballyEnabled: mock(() => true),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsyncFn = (...args: any[]) => Promise<any>
const mockAxiosGet = mock<AnyAsyncFn>(async () => ({ data: {} }))
mock.module('axios', () => ({ default: { get: mockAxiosGet } }))

// fflate sync paths must NEVER be called by the streaming + worker paths.
// Spying on them via mock.module gives us a verifiable invariant: assert
// the spy was not invoked even though decompression happened.
const mockGunzipSync = mock((_buf: Uint8Array) => new Uint8Array())
const mockUnzipSync = mock((_buf: Uint8Array) => ({} as Record<string, Uint8Array>))
// fflate.unzip (async) is the real worker-thread path — keep it intact.
const realFflate = _require('fflate') as typeof import('fflate')
mock.module('fflate', () => ({
  ...realFflate,
  gunzipSync: mockGunzipSync,
  unzipSync: mockUnzipSync,
}))

const mockReadFile = mock<AnyAsyncFn>(async () => { throw new Error('ENOENT') })
const mockWriteFile = mock<AnyAsyncFn>(async () => {})
const mockMkdir = mock<AnyAsyncFn>(async () => undefined)
const mockAccess = mock<AnyAsyncFn>(async () => { throw new Error('ENOENT') })
const mockUnlink = mock<AnyAsyncFn>(async () => {})
const mockReaddir = mock<AnyAsyncFn>(async () => [] as string[])
const realFsPromisesStreaming = _require('fs/promises') as typeof import('fs/promises')
mock.module('fs/promises', () => ({
  ...realFsPromisesStreaming,
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

// fs.createWriteStream — divert into an in-memory sink so the streaming
// pipeline doesn't hit the real disk. Each call returns a fresh Writable
// that buffers chunks; the test reads .__bytes__ to verify content.
type Sink = Writable & { __bytes__: Buffer[]; __path__: string }
const sinks: Sink[] = []
function makeSink(path: string): Sink {
  const chunks: Buffer[] = []
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      cb()
    },
  }) as Sink
  w.__bytes__ = chunks
  w.__path__ = path
  sinks.push(w)
  return w
}
const realFs = _require('fs') as typeof import('fs')
mock.module('fs', () => ({
  ...realFs,
  createWriteStream: (path: string) => makeSink(path),
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
  mockGunzipSync.mockReset()
  mockUnzipSync.mockReset()
  sinks.length = 0
})

// ---------------------------------------------------------------------------
// Part 1: streaming .gz path
// ---------------------------------------------------------------------------

describe('downloadAndExtract — streaming .gz path', () => {
  beforeEach(() => {
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockAccess.mockImplementation(async () => { throw new Error('ENOENT') })
    mockUnlink.mockImplementation(async () => {})
    mockMkdir.mockImplementation(async () => undefined)
    mockWriteFile.mockImplementation(async () => {})
  })

  test('streams gz body through createWriteStream — never calls fflate.gunzipSync', async () => {
    const platform = process.platform
    const arch = process.arch
    const osMap: Record<string, string> = { linux: 'unknown-linux-gnu', darwin: 'apple-darwin', win32: 'pc-windows-msvc' }
    const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' }
    const triple = `${archMap[arch] ?? arch}-${osMap[platform] ?? platform}`
    const assetName = `rust-analyzer-${triple}.gz`

    const payload = Buffer.from('streamed-binary-bytes', 'utf8')
    const { gzipSync, strToU8 } = realFflate
    const compressed = Buffer.from(gzipSync(strToU8('streamed-binary-bytes')))

    mockAxiosGet.mockImplementation(async (url: unknown, opts: unknown) => {
      if (typeof url === 'string' && url.includes('api.github.com')) {
        return {
          data: {
            tag_name: 'v9.9',
            assets: [{ name: assetName, browser_download_url: `https://example.com/${assetName}` }],
          },
        }
      }
      // Binary fetch must use stream responseType — guard the contract too.
      const responseType = (opts as { responseType?: string } | undefined)?.responseType
      expect(responseType).toBe('stream')
      return { data: Readable.from([compressed]) }
    })

    const { SERVER_DEFINITIONS } = await freshModule()
    const ra = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'rust-analyzer')
    const result = await ra.installer.install()

    // Install completed and returned a path.
    expect(result).not.toBeNull()
    // Synchronous decompression was never called — the load-bearing invariant.
    expect(mockGunzipSync).not.toHaveBeenCalled()
    // The streaming pipeline produced the original (decompressed) bytes.
    const target = sinks.find(s => s.__path__.endsWith('rust-analyzer'))
    expect(target).toBeDefined()
    const written = Buffer.concat(target!.__bytes__)
    expect(written.equals(payload)).toBe(true)
    // writeFile (used by the old buffer path) was not called for the binary.
    const writeCalls = mockWriteFile.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(writeCalls.some(p => p.endsWith('rust-analyzer'))).toBe(false)
  })

  test('streaming gz path propagates pipeline errors and cleans up', async () => {
    const platform = process.platform
    const arch = process.arch
    const osMap: Record<string, string> = { linux: 'unknown-linux-gnu', darwin: 'apple-darwin', win32: 'pc-windows-msvc' }
    const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' }
    const triple = `${archMap[arch] ?? arch}-${osMap[platform] ?? platform}`
    const assetName = `rust-analyzer-${triple}.gz`

    mockAxiosGet.mockImplementation(async (url: unknown) => {
      if (typeof url === 'string' && url.includes('api.github.com')) {
        return { data: { tag_name: 'v9.9', assets: [{ name: assetName, browser_download_url: `https://x/${assetName}` }] } }
      }
      // Return non-gzipped bytes — gunzip pipe will fail.
      return { data: Readable.from([Buffer.from('not-actually-gzip')]) }
    })

    const { SERVER_DEFINITIONS } = await freshModule()
    const ra = SERVER_DEFINITIONS.find((d: { name: string }) => d.name === 'rust-analyzer')
    const result = await ra.installer.install()

    expect(result).toBeNull()
    expect(mockGunzipSync).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Part 2: install concurrency cap
// ---------------------------------------------------------------------------

describe('installInBackground — serialized via module-level queue', () => {
  beforeEach(() => {
    mockReadFile.mockImplementation(async () => { throw new Error('ENOENT') })
    mockWriteFile.mockImplementation(async () => {})
    mockMkdir.mockImplementation(async () => undefined)
    mockUnlink.mockImplementation(async () => {})
  })

  test('parallel installInBackground calls run one at a time', async () => {
    let active = 0
    let peak = 0
    const completionGate: Array<() => void> = []

    // npm() install path: (1) execFile npm install -g, (2) which <bin>.
    // We instrument the npm step to track concurrency: each invocation
    // increments `active`, awaits a gate, then decrements.
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'npm') {
        active++
        peak = Math.max(peak, active)
        await new Promise<void>(res => completionGate.push(res))
        active--
        return { code: 0, stdout: '', stderr: '' }
      }
      if (cmd === 'which') {
        return { code: 0, stdout: `/usr/bin/${args[0]}\n`, stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })

    const { installInBackground, SERVER_DEFINITIONS } = await freshModule()
    // Pick all npm-installer servers. Even with 4 we can verify that the
    // module-level queue holds peak concurrency at 1.
    const npmDefs = SERVER_DEFINITIONS.filter((d: { installer?: { type: string } }) =>
      d.installer && d.installer.type === 'npm',
    )
    expect(npmDefs.length).toBeGreaterThanOrEqual(4)

    const allDone = Promise.all(npmDefs.map((d: unknown) => installInBackground(d)))

    // Drain the queue: release one install at a time. After each release,
    // wait a tick so the next queued task can enter the gated section.
    for (let i = 0; i < npmDefs.length; i++) {
      while (completionGate.length === 0) {
        await new Promise(r => setTimeout(r, 1))
      }
      const release = completionGate.shift()!
      release()
      await new Promise(r => setImmediate(r))
    }

    await allDone

    // Concurrency invariant: at no point did more than one install run.
    expect(peak).toBe(1)
  })

  test('detection (whichBinary) does NOT go through the install queue', async () => {
    // Block all installs forever; getBuiltinLspServers must still resolve
    // because detection runs outside the queue.
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'npm') {
        // Hang forever — would deadlock getBuiltinLspServers if `which`
        // were also queued. We never resolve.
        await new Promise(() => {})
      }
      if (cmd === 'which' && args[0] === 'typescript-language-server') {
        return { code: 0, stdout: '/usr/bin/typescript-language-server\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    mockGetUserLspSettings.mockReturnValue({})

    const { getBuiltinLspServers } = await freshModule()
    const result = await Promise.race([
      getBuiltinLspServers(),
      new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 2000)),
    ])

    expect(result).not.toBe('timeout')
    if (result !== 'timeout') {
      // typescript-language-server detected synchronously; install queue stalled.
      expect(result['typescript-language-server']).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// See builtinServers.integration.test.ts for the rationale.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('fs/promises', () => realFsPromisesStreaming)
  mock.module('fs', () => realFs)
  mock.module('os', () => realOsStreaming)
  mock.module('fflate', () => realFflate)
  mock.module('axios', () => ({ default: {} }))
  mock.module('../../utils/execFileNoThrow.js', () => ({
    execFileNoThrow: () => ({ code: 0, stdout: '', stderr: '' }),
    execFileNoThrowWithCwd: () => ({ code: 0, stdout: '', stderr: '' }),
  }))
  mock.module('../../utils/log.js', () => ({ ...realLogStreaming, logError: () => {} }))
  mock.module('../../utils/envUtils.js', () => ({
    ...realEnvUtilsStreaming,
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
    ...realUserSettingsStreaming,
    getUserLspSettings: () => ({}),
    isLspGloballyEnabled: () => true,
  }))
})
