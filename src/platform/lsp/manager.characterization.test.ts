/**
 * The process-wide LSP singleton as startup, /reload-plugins, exit and the
 * tools see it: the status it reports while initializing, after success and
 * after failure, re-initialization, shutdown, the change listeners, and the
 * diagnostics that reach the registry once it is up. Servers are real
 * fake-server processes.
 *
 * As in LSPServerManager.characterization.test.ts, `getAllLspServers` (the
 * enabled-plugins config) is the one mocked boundary; the real module is put
 * back in afterAll.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { join } from 'path'
import type { ScopedLspServerConfig } from 'src/platform/lsp/types.js'
import {
  awaitDiagnosticsForFile,
  checkForLSPDiagnostics,
  forgetDiagnosticsForEditedFile,
  resetAllLSPDiagnosticState,
} from 'src/platform/lsp/LSPDiagnosticRegistry.js'
import {
  type FakeServerBehaviour,
  fakeServerCommand,
} from 'src/platform/lsp/__testutils__/fakeLanguageServer.js'
import { eventually, processIsAlive, readPid, tempDirs } from 'src/platform/lsp/__testutils__/lspTestKit.js'

const realConfig = { ...(await import('src/platform/lsp/config.js')) }
let configured: Record<string, ScopedLspServerConfig> | Error = {}
let configGate: Promise<void> = Promise.resolve()
mock.module('src/platform/lsp/config.js', () => ({
  ...realConfig,
  getAllLspServers: async () => {
    await configGate
    if (configured instanceof Error) throw configured
    return { servers: configured }
  },
}))

// LSPTool's suites replace `manager.js` for the whole run and never hand it
// back, so the real singleton is loaded under its own specifier (a query on
// the file) that no mock.module can match.
const unmockedSpecifier = './manager.ts?characterization'
const lsp: typeof import('src/platform/lsp/manager.js') = await import(unmockedSpecifier)

const dirs = tempDirs('lsp-singleton-')
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_SIMPLE']) saved[key] = process.env[key]
  process.env.CLAUDIN_CONFIG_DIR = dirs.make()
  delete process.env.CLAUDIN_SIMPLE
})
beforeEach(async () => {
  await lsp.shutdownLspServerManager()
  lsp._resetLspManagerForTesting()
  resetAllLSPDiagnosticState()
  configured = {}
  configGate = Promise.resolve()
})
afterEach(async () => {
  await lsp.shutdownLspServerManager()
  resetAllLSPDiagnosticState()
})
afterAll(() => {
  mock.module('src/platform/lsp/config.js', () => realConfig)
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  dirs.cleanup()
})

function server(behaviour: FakeServerBehaviour = {}, ext = '.ts'): ScopedLspServerConfig {
  return {
    ...fakeServerCommand(behaviour),
    extensionToLanguage: { [ext]: 'lang' },
    scope: 'dynamic',
    source: 'test-plugin',
    workspaceFolder: dirs.make(),
  }
}

function snapshot() {
  return {
    status: lsp.getInitializationStatus().status,
    hasManager: lsp.getLspServerManager() !== undefined,
    connected: lsp.isLspConnected(),
  }
}

async function initialized(servers: Record<string, ScopedLspServerConfig>) {
  configured = servers
  lsp.initializeLspServerManager()
  await lsp.waitForInitialization()
  return lsp.getLspServerManager()!
}

function countChanges(): { count: () => number; stop: () => void } {
  let n = 0
  const stop = lsp.onLspStateChange(() => n++)
  return { count: () => n, stop: () => void stop() }
}

describe('before initialization', () => {
  test('reports not-started, no manager and no connection; waiting returns at once', async () => {
    expect(snapshot()).toEqual({ status: 'not-started', hasManager: false, connected: false })
    await expect(lsp.waitForInitialization()).resolves.toBeUndefined()
  })

  test('bare mode never initializes', async () => {
    process.env.CLAUDIN_SIMPLE = '1'
    try {
      configured = { ts: server() }
      lsp.initializeLspServerManager()
      expect(snapshot()).toEqual({ status: 'not-started', hasManager: false, connected: false })
    } finally {
      delete process.env.CLAUDIN_SIMPLE
    }
  })

  test('reinitialize does not start a manager that was never initialized', () => {
    lsp.reinitializeLspServerManager()
    expect(snapshot().status).toBe('not-started')
  })

  test('shutdown with nothing initialized resolves', async () => {
    await expect(lsp.shutdownLspServerManager()).resolves.toBeUndefined()
  })
})

describe('initialization', () => {
  test('is pending with a manager at once, then succeeds and tells listeners', async () => {
    let release!: () => void
    configGate = new Promise(resolve => (release = resolve))
    configured = { ts: server() }
    const changes = countChanges()
    lsp.initializeLspServerManager()
    expect(snapshot()).toEqual({ status: 'pending', hasManager: true, connected: false })
    release()
    await lsp.waitForInitialization()
    changes.stop()
    expect(snapshot()).toEqual({ status: 'success', hasManager: true, connected: true })
    expect(changes.count()).toBe(1)
  })

  test('a second call while initialized keeps the same manager', async () => {
    const first = await initialized({ ts: server() })
    lsp.initializeLspServerManager()
    expect(lsp.getLspServerManager()).toBe(first)
  })

  test('with no configured server it succeeds but is not connected', async () => {
    await initialized({})
    expect(snapshot()).toEqual({ status: 'success', hasManager: true, connected: false })
  })

  test('a config failure reports failed with the error, hides the manager, and tells listeners', async () => {
    configured = new Error('plugins unreadable')
    const changes = countChanges()
    lsp.initializeLspServerManager()
    await lsp.waitForInitialization()
    changes.stop()
    const status = lsp.getInitializationStatus()
    expect(status).toEqual({ status: 'failed', error: configured })
    expect(snapshot()).toEqual({ status: 'failed', hasManager: false, connected: false })
    expect(changes.count()).toBe(1)
    await expect(lsp.waitForInitialization()).resolves.toBeUndefined()
  })

  test('initializing again after a failure retries with a fresh manager', async () => {
    configured = new Error('first try fails')
    lsp.initializeLspServerManager()
    await lsp.waitForInitialization()
    await initialized({ ts: server() })
    expect(snapshot()).toEqual({ status: 'success', hasManager: true, connected: true })
  })

  test('a shutdown while pending wins over the late success', async () => {
    let release!: () => void
    configGate = new Promise(resolve => (release = resolve))
    configured = { ts: server() }
    lsp.initializeLspServerManager()
    await lsp.shutdownLspServerManager()
    release()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(snapshot()).toEqual({ status: 'not-started', hasManager: false, connected: false })
  })

  test('a shutdown while pending also wins over the late failure', async () => {
    let release!: () => void
    configGate = new Promise(resolve => (release = resolve))
    configured = new Error('late failure')
    lsp.initializeLspServerManager()
    await lsp.shutdownLspServerManager()
    release()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(lsp.getInitializationStatus().status).toBe('not-started')
  })
})

describe('connection and server state', () => {
  test('is not connected once every server is in error', async () => {
    const manager = await initialized({ broken: server({ onInitialize: 'reject' }) })
    expect(lsp.isLspConnected()).toBe(true)
    await manager.ensureServerStarted('/w/a.ts').catch(() => {})
    expect(lsp.isLspConnected()).toBe(false)
  })

  test('one healthy server is enough to be connected', async () => {
    const manager = await initialized({
      broken: server({ onInitialize: 'reject' }, '.ts'),
      fine: server({}, '.py'),
    })
    await manager.ensureServerStarted('/w/a.ts').catch(() => {})
    expect(lsp.isLspConnected()).toBe(true)
  })

  test('server transitions after initialization reach the listeners', async () => {
    const manager = await initialized({ ts: server() })
    const changes = countChanges()
    await manager.ensureServerStarted('/w/a.ts')
    void manager.sendRequest('/w/a.ts', 'fake/crash', { code: 3 }).catch(() => {})
    await eventually(() => manager.getServerForFile('/w/a.ts')?.state === 'error', 3000, 'the crash')
    changes.stop()
    expect(changes.count()).toBe(3)
  })

  test('an unsubscribed listener hears nothing and a throwing one does not block others', async () => {
    let heard = 0
    const off = lsp.onLspStateChange(() => heard++)
    off()
    const stopThrower = lsp.onLspStateChange(() => {
      throw new Error('listener blew up')
    })
    const changes = countChanges()
    await initialized({})
    stopThrower()
    changes.stop()
    expect([heard, changes.count()]).toEqual([0, 1])
  })
})

describe('reinitialize', () => {
  test('replaces the manager, stops the old servers and tells listeners', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const old = await initialized({ ts: server({ pidFile }) })
    await old.ensureServerStarted('/w/a.ts')
    const changes = countChanges()
    lsp.reinitializeLspServerManager()
    expect(lsp.getInitializationStatus().status).toBe('pending')
    expect(changes.count()).toBeGreaterThan(0)
    await lsp.waitForInitialization()
    changes.stop()
    expect(lsp.getLspServerManager()).not.toBe(old)
    expect(lsp.getInitializationStatus().status).toBe('success')
    expect(changes.count()).toBeGreaterThanOrEqual(2)
    await eventually(() => !processIsAlive(readPid(pidFile)), 3000, 'the old server to exit')
  })

  test('a failing shutdown of the old manager does not stop the new one', async () => {
    const old = await initialized({ ts: server({ onShutdown: 'reject' }) })
    await old.ensureServerStarted('/w/a.ts')
    lsp.reinitializeLspServerManager()
    await lsp.waitForInitialization()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(lsp.getInitializationStatus().status).toBe('success')
  })
})

describe('shutdown', () => {
  test('stops running servers and returns to not-started', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const manager = await initialized({ ts: server({ pidFile }) })
    await manager.ensureServerStarted('/w/a.ts')
    await lsp.shutdownLspServerManager()
    expect(snapshot()).toEqual({ status: 'not-started', hasManager: false, connected: false })
    await eventually(() => !processIsAlive(readPid(pidFile)), 3000, 'the server to exit')
  })

  test('a server that refuses to stop does not make shutdown reject', async () => {
    const manager = await initialized({ ts: server({ onShutdown: 'reject' }) })
    await manager.ensureServerStarted('/w/a.ts')
    await expect(lsp.shutdownLspServerManager()).resolves.toBeUndefined()
    expect(snapshot().status).toBe('not-started')
  })
})

describe('diagnostics delivery', () => {
  test('what a server publishes after an open reaches the diagnostics registry', async () => {
    const manager = await initialized({ ts: server({ flagLinesContaining: 'TODO' }) })
    const file = join(dirs.make(), 'work.ts')
    await manager.openFile(file, 'ok\nTODO fix\nok\nTODO again')
    const files = await awaitDiagnosticsForFile(file, 3000)
    expect(files?.[0]?.diagnostics.map(d => d.message)).toEqual(['line 2 holds TODO', 'line 4 holds TODO'])
    const delivered = checkForLSPDiagnostics().flatMap(set => set.files.map(f => f.uri))
    expect(delivered).toEqual([file])
  })

  test('after an edit, the wait sees what the server says about the new content', async () => {
    const manager = await initialized({ ts: server({ flagLinesContaining: 'TODO' }) })
    const file = join(dirs.make(), 'edited.ts')
    const rounds: Array<[string, string[]]> = [
      ['TODO first', ['line 1 holds TODO']],
      ['a\nb\nTODO third', ['line 3 holds TODO']],
      ['all done', []],
    ]
    const seen: Array<[string, string[]]> = []
    for (const [text] of rounds) {
      forgetDiagnosticsForEditedFile(file)
      await manager.changeFile(file, text)
      const files = await awaitDiagnosticsForFile(file, 3000)
      seen.push([text, files?.[0]?.diagnostics.map(d => d.message) ?? ['<timed out>']])
    }
    expect(seen).toEqual(rounds)
  })
})
