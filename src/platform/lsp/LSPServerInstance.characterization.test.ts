/**
 * One language server's lifecycle as LSPServerManager drives it: start with the
 * workspace handshake, health, request retries, restart limits, crash
 * recovery and the startup timeout. Each case spawns the real fake server from
 * __testutils__ over stdio.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { basename, join } from 'path'
import { pathToFileURL } from 'url'
import { getCwd } from 'src/shared/fs/cwd.js'
import {
  createLSPServerInstance,
  type LSPServerInstance,
} from 'src/platform/lsp/LSPServerInstance.js'
import type { ScopedLspServerConfig } from 'src/platform/lsp/types.js'
import {
  type FakeServerBehaviour,
  fakeServerCommand,
} from 'src/platform/lsp/__testutils__/fakeLanguageServer.js'
import { eventually, processIsAlive, readPid, tempDirs } from 'src/platform/lsp/__testutils__/lspTestKit.js'

const dirs = tempDirs('lsp-instance-')
const live: LSPServerInstance[] = []
let savedConfigDir: string | undefined

beforeAll(() => {
  savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = dirs.make()
})
afterEach(async () => {
  await Promise.allSettled(live.splice(0).map(instance => instance.stop()))
})
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  dirs.cleanup()
})

function configFor(
  behaviour: FakeServerBehaviour = {},
  extra: Partial<ScopedLspServerConfig> = {},
): ScopedLspServerConfig {
  return {
    ...fakeServerCommand(behaviour),
    extensionToLanguage: { '.fake': 'fake' },
    scope: 'dynamic',
    source: 'test',
    workspaceFolder: dirs.make(),
    ...extra,
  }
}

function instanceOf(config: ScopedLspServerConfig, name = 'fake'): LSPServerInstance {
  const instance = createLSPServerInstance(name, config)
  live.push(instance)
  return instance
}

function recordStates(instance: LSPServerInstance): string[] {
  const seen: string[] = []
  instance.onStateChange(() => seen.push(instance.state))
  return seen
}

describe('creation', () => {
  const unsupported: Array<[string, Partial<ScopedLspServerConfig>]> = [
    ['restartOnCrash', { restartOnCrash: true }],
    ['shutdownTimeout', { shutdownTimeout: 100 }],
  ]
  test.each(unsupported)('a config setting %s is refused', (field, extra) => {
    expect(() => createLSPServerInstance('picky', configFor({}, extra))).toThrow(
      `LSP server 'picky': ${field} is not yet implemented`,
    )
  })

  test('a new instance is stopped, unhealthy and has no history', () => {
    const config = configFor()
    const instance = createLSPServerInstance('fresh', config)
    expect({
      name: instance.name,
      config: instance.config,
      state: instance.state,
      startTime: instance.startTime,
      lastError: instance.lastError,
      restartCount: instance.restartCount,
      capabilities: instance.capabilities,
      healthy: instance.isHealthy(),
    }).toEqual({
      name: 'fresh',
      config,
      state: 'stopped',
      startTime: undefined,
      lastError: undefined,
      restartCount: 0,
      capabilities: undefined,
      healthy: false,
    })
  })
})

describe('start', () => {
  test('goes starting then running, and becomes healthy with the server capabilities', async () => {
    const instance = instanceOf(configFor({ capabilities: { renameProvider: true } }))
    const states = recordStates(instance)
    const before = Date.now()
    await instance.start()
    expect(states).toEqual(['starting', 'running'])
    expect(instance.isHealthy()).toBe(true)
    expect(instance.capabilities).toEqual({ renameProvider: true })
    expect(instance.startTime!.getTime()).toBeGreaterThanOrEqual(before)
  })

  test('the server is handed the workspace folder, our pid and the declared client capabilities', async () => {
    const folder = dirs.make()
    const options = { preferences: { quoteStyle: 'single' } }
    const instance = instanceOf(configFor({}, { workspaceFolder: folder, initializationOptions: options }))
    await instance.start()
    const sent = await instance.sendRequest<any>('fake/initializeParams', {})
    const uri = pathToFileURL(folder).href
    expect(sent).toMatchObject({
      processId: process.pid,
      initializationOptions: options,
      workspaceFolders: [{ uri, name: basename(folder) }],
      rootPath: folder,
      rootUri: uri,
    })
    expect(sent.capabilities.workspace).toEqual({ configuration: false, workspaceFolders: false })
    expect(sent.capabilities.textDocument.synchronization.didSave).toBe(true)
    expect(sent.capabilities.textDocument.publishDiagnostics.tagSupport.valueSet).toEqual([1, 2])
    expect(sent.capabilities.textDocument.hover.contentFormat).toEqual(['markdown', 'plaintext'])
    expect(sent.capabilities.textDocument.definition.linkSupport).toBe(true)
    expect(sent.capabilities.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport).toBe(true)
    expect(sent.capabilities.general.positionEncodings).toEqual(['utf-16'])
  })

  test('without a workspace folder the session cwd is the root, and options default to {}', async () => {
    const instance = instanceOf(configFor({}, { workspaceFolder: undefined }))
    await instance.start()
    const sent = await instance.sendRequest<any>('fake/initializeParams', {})
    expect(sent.rootPath).toBe(getCwd())
    expect(sent.initializationOptions).toEqual({})
  })

  test('the config env and args reach the process', async () => {
    const instance = instanceOf(configFor({}, { env: { FAKE_LSP_MARK: 'instance-env' } }))
    await instance.start()
    const who = await instance.sendRequest<{ env: string }>('fake/whoami', { env: 'FAKE_LSP_MARK' })
    expect(who.env).toBe('instance-env')
  })

  test('starting a running server does not spawn another one', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const instance = instanceOf(configFor({ pidFile }))
    await instance.start()
    const first = readPid(pidFile)
    await instance.start()
    const who = await instance.sendRequest<{ pid: number }>('fake/whoami', {})
    expect(who.pid).toBe(first)
  })

  const failures: Array<[string, Partial<ScopedLspServerConfig>, FakeServerBehaviour, RegExp]> = [
    ['a missing binary', { command: '/nonexistent/fake-lsp-binary', args: [] }, {}, /ENOENT/],
    ['a refused initialize', {}, { onInitialize: 'reject' }, /initialize refused by fake/],
  ]
  test.each(failures)('%s leaves the instance in error with the cause', async (_l, extra, behaviour, cause) => {
    const instance = instanceOf(configFor(behaviour, extra))
    const states = recordStates(instance)
    await expect(instance.start()).rejects.toThrow(cause)
    expect(instance.state).toBe('error')
    expect(instance.lastError?.message).toMatch(cause)
    expect(instance.isHealthy()).toBe(false)
    expect(states).toEqual(['starting', 'error'])
  })

  test('startupTimeout fails a hung initialize, and the spawned process is cleaned up', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const instance = instanceOf(configFor({ onInitialize: 'hang', pidFile }, { startupTimeout: 150 }))
    const started = Date.now()
    await expect(instance.start()).rejects.toThrow(
      "LSP server 'fake' timed out after 150ms during initialization",
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(instance.state).toBe('error')
    await eventually(() => !processIsAlive(readPid(pidFile)), 3000, 'the hung server to be stopped')
  })

  test('a startupTimeout that is not reached changes nothing', async () => {
    const instance = instanceOf(configFor({}, { startupTimeout: 5000 }))
    await instance.start()
    expect(instance.state).toBe('running')
  })
})

describe('requests and notifications', () => {
  test('a request is refused while the server is not running', async () => {
    const instance = instanceOf(configFor())
    await expect(instance.sendRequest('fake/echo', {})).rejects.toThrow(
      "Cannot send request to LSP server 'fake': server is stopped",
    )
  })

  test('the refusal names the last error once there is one', async () => {
    const instance = instanceOf(configFor({ onInitialize: 'reject' }))
    await instance.start().catch(() => {})
    await expect(instance.sendRequest('fake/echo', {})).rejects.toThrow(
      "Cannot send request to LSP server 'fake': server is error, last error: initialize refused by fake",
    )
  })

  test('a notification is refused while the server is not running', async () => {
    const instance = instanceOf(configFor())
    await expect(instance.sendNotification('custom/x', {})).rejects.toThrow(
      "Cannot send notification to LSP server 'fake': server is stopped",
    )
  })

  test('a request round-trips through a running server', async () => {
    const instance = instanceOf(configFor())
    await instance.start()
    expect(await instance.sendRequest<unknown>('fake/echo', { a: 1 })).toEqual({ a: 1 })
  })

  test('a server error is wrapped with the method and server name, without retry', async () => {
    const instance = instanceOf(configFor())
    await instance.start()
    await expect(instance.sendRequest('fake/fail', { code: -32000, message: 'bad thing' })).rejects.toThrow(
      "LSP request 'fake/fail' failed for server 'fake': bad thing",
    )
  })

  test('"content modified" is retried with backoff until the server answers', async () => {
    const instance = instanceOf(configFor())
    await instance.start()
    const started = Date.now()
    const result = await instance.sendRequest('fake/flaky', { key: 'once', failures: 1 })
    expect(result).toEqual({ attempts: 2 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(450)
  })

  test('"content modified" gives up after three retries', async () => {
    const instance = instanceOf(configFor())
    await instance.start()
    const started = Date.now()
    await expect(instance.sendRequest('fake/flaky', { key: 'always', failures: 99 })).rejects.toThrow(
      "LSP request 'fake/flaky' failed for server 'fake': content modified",
    )
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(3400)
    expect(elapsed).toBeLessThan(6000)
    const flaky = await instance.sendRequest<{ attempts: number }>('fake/flaky', { key: 'always', failures: 4 })
    expect(flaky.attempts).toBe(5)
  }, 15000)

  // Fixed in LSPClient (was pinned as a defect): calls used to fail with the
  // parse error for good while isHealthy() still reported true.
  test('after an unreadable message the instance is healthy and calls still work', async () => {
    const instance = instanceOf(configFor())
    await instance.start()
    await instance.sendRequest('fake/garbage', {})
    expect([instance.state, instance.isHealthy()]).toEqual(['running', true])
    await expect(instance.sendNotification('custom/x', {})).resolves.toBeUndefined()
    expect(await instance.sendRequest<unknown>('fake/echo', { after: 'garbage' })).toEqual({ after: 'garbage' })
  })

  test('a notification reaches the running server', async () => {
    const instance = instanceOf(configFor())
    await instance.start()
    await instance.sendNotification('custom/ping', { n: 3 })
    const journal = await instance.sendRequest<Array<{ method: string; params: unknown }>>('fake/journal', {})
    expect(journal.filter(e => e.method === 'custom/ping')).toEqual([{ method: 'custom/ping', params: { n: 3 } }])
  })

  test('handlers registered on the instance receive server notifications and requests', async () => {
    const instance = instanceOf(configFor())
    const heard: unknown[] = []
    instance.onNotification('fake/news', params => heard.push(params))
    instance.onRequest('fake/question', (params: { q: string }) => `re: ${params.q}`)
    await instance.start()
    await instance.sendRequest('fake/push', { method: 'fake/news', params: { n: 1 } })
    const asked = await instance.sendRequest('fake/ask', { method: 'fake/question', params: { q: 'why' } })
    await eventually(() => heard.length === 1, 2000, 'the notification')
    expect(heard).toEqual([{ n: 1 }])
    expect(asked).toEqual({ result: 're: why' })
  })
})

describe('stop and restart', () => {
  test('stop goes stopping then stopped, and a second stop is a no-op', async () => {
    const instance = instanceOf(configFor())
    await instance.start()
    const states = recordStates(instance)
    await instance.stop()
    await instance.stop()
    expect(states).toEqual(['stopping', 'stopped'])
    expect(instance.isHealthy()).toBe(false)
  })

  test('a refused shutdown puts the instance in error and rejects', async () => {
    const instance = instanceOf(configFor({ onShutdown: 'reject' }))
    await instance.start()
    await expect(instance.stop()).rejects.toThrow('shutdown refused by fake')
    expect(instance.state).toBe('error')
    expect(instance.lastError?.message).toContain('shutdown refused by fake')
  })

  test('restart replaces the process and counts the restart', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const instance = instanceOf(configFor({ pidFile }))
    await instance.start()
    const firstPid = readPid(pidFile)
    await instance.restart()
    expect(instance.restartCount).toBe(1)
    expect(instance.state).toBe('running')
    const who = await instance.sendRequest<{ pid: number }>('fake/whoami', {})
    expect(who.pid).not.toBe(firstPid)
    await eventually(() => !processIsAlive(firstPid), 3000, 'the old process to exit')
  })

  test('restarts beyond maxRestarts are refused and leave the server stopped', async () => {
    const instance = instanceOf(configFor({}, { maxRestarts: 1 }))
    await instance.start()
    await instance.restart()
    await expect(instance.restart()).rejects.toThrow("Max restart attempts (1) exceeded for server 'fake'")
    expect([instance.restartCount, instance.state]).toEqual([2, 'stopped'])
  })

  test('a restart whose stop fails says so', async () => {
    const instance = instanceOf(configFor({ onShutdown: 'reject' }))
    await instance.start()
    await expect(instance.restart()).rejects.toThrow(
      "Failed to stop LSP server 'fake' during restart: ",
    )
    expect(instance.restartCount).toBe(0)
  })

  test('a restart whose start fails names the attempt', async () => {
    const instance = instanceOf(configFor({ onInitialize: 'reject' }))
    await expect(instance.restart()).rejects.toThrow(
      "Failed to start LSP server 'fake' during restart (attempt 1/3): ",
    )
  })
})

describe('crash recovery', () => {
  test('a crash moves a running server to error, and the next start brings it back', async () => {
    const instance = instanceOf(configFor())
    await instance.start()
    const states = recordStates(instance)
    void instance.sendRequest('fake/crash', { code: 9 }).catch(() => {})
    await eventually(() => instance.state === 'error', 3000, 'the crash to be noticed')
    expect(instance.lastError?.message).toBe('LSP server fake crashed with exit code 9')
    expect(instance.isHealthy()).toBe(false)
    await instance.start()
    expect(instance.isHealthy()).toBe(true)
    expect(states).toEqual(['error', 'starting', 'running'])
  })

  test('crashes beyond maxRestarts stop the instance from respawning', async () => {
    const instance = instanceOf(configFor({}, { maxRestarts: 0 }))
    await instance.start()
    void instance.sendRequest('fake/crash', { code: 4 }).catch(() => {})
    await eventually(() => instance.state === 'error', 3000, 'the crash to be noticed')
    await expect(instance.start()).rejects.toThrow(
      "LSP server 'fake' exceeded max crash recovery attempts (0)",
    )
    expect(instance.lastError?.message).toContain('exceeded max crash recovery attempts')
  })

  test('a successful start forgives earlier crashes', async () => {
    const instance = instanceOf(configFor({}, { maxRestarts: 1 }))
    for (const code of [5, 6, 7]) {
      await instance.start()
      void instance.sendRequest('fake/crash', { code }).catch(() => {})
      await eventually(() => instance.state === 'error', 3000, `crash ${code}`)
    }
    expect(instance.lastError?.message).toContain('exit code 7')
  })
})

describe('state listeners', () => {
  test('an unsubscribed listener hears nothing, and a throwing one does not block the others', async () => {
    const instance = instanceOf(configFor())
    const heard: string[] = []
    const off = instance.onStateChange(() => heard.push('removed'))
    instance.onStateChange(() => {
      throw new Error('listener blew up')
    })
    instance.onStateChange(() => heard.push(instance.state))
    off()
    await instance.start()
    expect(heard).toEqual(['starting', 'running'])
  })
})
