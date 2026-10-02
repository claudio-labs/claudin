/**
 * The JSON-RPC client as its owner (LSPServerInstance) drives it, against a real
 * child process: the fake language server in __testutils__, spoken to over
 * stdio. Nothing below the client is mocked, so these pin the contract a
 * replacement client has to meet: lifecycle, both directions of routing,
 * crash reporting and the errors a caller sees.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'path'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { createLSPClient, type LSPClient } from 'src/platform/lsp/LSPClient.js'
import {
  type FakeServerBehaviour,
  fakeServerCommand,
} from 'src/platform/lsp/__testutils__/fakeLanguageServer.js'
import { eventually, processIsAlive, readPid, tempDirs } from 'src/platform/lsp/__testutils__/lspTestKit.js'

const dirs = tempDirs('lsp-client-')
const live: LSPClient[] = []
let savedConfigDir: string | undefined

beforeAll(() => {
  savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = dirs.make()
})
afterEach(async () => {
  await Promise.allSettled(live.splice(0).map(client => client.stop()))
})
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  dirs.cleanup()
})

const minimalInit = (root: string): InitializeParams => ({
  processId: process.pid,
  rootUri: `file://${root}`,
  capabilities: {},
})

function track(client: LSPClient): LSPClient {
  live.push(client)
  return client
}

async function launch(
  behaviour: FakeServerBehaviour = {},
  onCrash?: (error: Error) => void,
  options?: { env?: Record<string, string>; cwd?: string },
): Promise<LSPClient> {
  const client = track(createLSPClient('fake', onCrash))
  const { command, args } = fakeServerCommand(behaviour)
  await client.start(command, args, options)
  return client
}

async function launchReady(behaviour: FakeServerBehaviour = {}, onCrash?: (error: Error) => void) {
  const client = await launch(behaviour, onCrash)
  await client.initialize(minimalInit(dirs.make()))
  return client
}

type Journal = Array<{ method: string; params: unknown }>
const methodsSeen = async (client: LSPClient): Promise<string[]> =>
  (await client.sendRequest<Journal>('fake/journal', null))
    .map(entry => entry.method)
    .filter(method => !method.startsWith('$/'))

describe('before start', () => {
  const calls: Array<[string, (c: LSPClient) => Promise<unknown>]> = [
    ['initialize', c => c.initialize(minimalInit('/'))],
    ['sendRequest', c => c.sendRequest('fake/echo', 1)],
    ['sendNotification', c => c.sendNotification('anything', {})],
  ]
  test.each(calls)('%s refuses with "not started"', async (_name, call) => {
    await expect(call(createLSPClient('idle'))).rejects.toThrow('LSP client not started')
  })

  test('reports no capabilities and is not initialized', () => {
    const client = createLSPClient('idle')
    expect([client.capabilities, client.isInitialized]).toEqual([undefined, false])
  })

  test('stop on a client that never started is a quiet no-op', async () => {
    await expect(createLSPClient('idle').stop()).resolves.toBeUndefined()
  })
})

describe('start and initialize', () => {
  test('initialize returns the server result and records its capabilities', async () => {
    const capabilities = { hoverProvider: true, definitionProvider: true }
    const client = await launch({ capabilities, stderrBanner: 'fake server booting' })
    expect(client.isInitialized).toBe(false)
    const result = await client.initialize(minimalInit(dirs.make()))
    expect(result.capabilities).toEqual(capabilities)
    expect(client.capabilities).toEqual(capabilities)
    expect(client.isInitialized).toBe(true)
  })

  test('the server is told "initialized" after answering initialize', async () => {
    const client = await launchReady()
    expect(await methodsSeen(client)).toEqual(['initialized'])
  })

  test('a request before initialize is refused locally', async () => {
    const client = await launch()
    await expect(client.sendRequest('fake/echo', 1)).rejects.toThrow('LSP server not initialized')
  })

  test('an initialize error from the server rejects and leaves the client uninitialized', async () => {
    const client = await launch({ onInitialize: 'reject' })
    await expect(client.initialize(minimalInit('/'))).rejects.toThrow('initialize refused by fake')
    expect(client.isInitialized).toBe(false)
  })

  test('the child gets the caller env on top of ours, and the caller cwd', async () => {
    const cwd = dirs.make()
    const client = await launch({}, undefined, { env: { FAKE_LSP_MARK: 'from-config' }, cwd })
    await client.initialize(minimalInit(cwd))
    const who = await client.sendRequest<{ cwd: string; env: string | null }>('fake/whoami', {
      env: 'FAKE_LSP_MARK',
    })
    expect(who).toMatchObject({ cwd, env: 'from-config' })
  })

  test('a command that does not exist rejects start with the spawn error', async () => {
    const client = createLSPClient('ghost')
    await expect(client.start(join(dirs.make(), 'no-such-server'), [])).rejects.toThrow(/ENOENT/)
    await expect(client.initialize(minimalInit('/'))).rejects.toThrow('LSP client not started')
  })
})

describe('routing', () => {
  test('a request reaches the server and its result comes back', async () => {
    const client = await launchReady()
    const payload = { nested: { list: [1, 'two'] } }
    expect(await client.sendRequest<unknown>('fake/echo', payload)).toEqual(payload)
  })

  test('an error response rejects with the server message and code', async () => {
    const client = await launchReady()
    const failure = client.sendRequest('fake/fail', { code: -32099, message: 'nope from server' })
    await expect(failure).rejects.toMatchObject({ message: 'nope from server', code: -32099 })
  })

  test('a notification reaches the server in the order sent', async () => {
    const client = await launchReady()
    await client.sendNotification('custom/first', { n: 1 })
    await client.sendNotification('custom/second', { n: 2 })
    const journal = await client.sendRequest<Journal>('fake/journal', null)
    expect(journal.filter(e => e.method.startsWith('custom/'))).toEqual([
      { method: 'custom/first', params: { n: 1 } },
      { method: 'custom/second', params: { n: 2 } },
    ])
  })

  const timings: Array<[string, boolean]> = [
    ['registered before start', true],
    ['registered after start', false],
  ]

  test.each(timings)('a server notification reaches a handler %s', async (_label, early) => {
    const received: unknown[] = []
    const client = track(createLSPClient('fake'))
    if (early) client.onNotification('fake/news', params => received.push(params))
    const { command, args } = fakeServerCommand()
    await client.start(command, args)
    if (!early) client.onNotification('fake/news', params => received.push(params))
    await client.initialize(minimalInit(dirs.make()))
    await client.sendRequest('fake/push', { method: 'fake/news', params: { headline: 'x' } })
    await eventually(() => received.length === 1, 2000, 'the pushed notification')
    expect(received).toEqual([{ headline: 'x' }])
  })

  test.each(timings)('a server request is answered by a handler %s', async (_label, early) => {
    const client = track(createLSPClient('fake'))
    const answer = (params: { items: unknown[] }) => params.items.map((_, i) => `answer-${i}`)
    if (early) client.onRequest('workspace/configuration', answer)
    const { command, args } = fakeServerCommand()
    await client.start(command, args)
    if (!early) client.onRequest('workspace/configuration', answer)
    await client.initialize(minimalInit(dirs.make()))
    const echoed = await client.sendRequest('fake/ask', {
      method: 'workspace/configuration',
      params: { items: [{}, {}] },
    })
    expect(echoed).toEqual({ result: ['answer-0', 'answer-1'] })
  })
})

describe('stop', () => {
  test('sends shutdown then exit, ends the process and forgets the session', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const client = await launchReady({ capabilities: { hoverProvider: true }, pidFile })
    const pid = readPid(pidFile)
    await client.stop()
    expect([client.isInitialized, client.capabilities]).toEqual([false, undefined])
    await eventually(() => !processIsAlive(pid), 3000, 'the server to exit')
    await expect(client.sendRequest('fake/echo', 1)).rejects.toThrow('LSP client not started')
  })

  test('the same client can be started again after a clean stop', async () => {
    const client = await launchReady()
    await client.stop()
    const { command, args } = fakeServerCommand()
    await client.start(command, args)
    await client.initialize(minimalInit(dirs.make()))
    expect(await client.sendRequest<unknown>('fake/echo', { round: 2 })).toEqual({ round: 2 })
  })

  test('a refused shutdown still kills the process, then rejects with the refusal', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const client = await launchReady({ onShutdown: 'reject', pidFile })
    await expect(client.stop()).rejects.toThrow('shutdown refused by fake')
    await eventually(() => !processIsAlive(readPid(pidFile)), 3000, 'the server to be killed')
    expect(client.isInitialized).toBe(false)
  })

  // Defect, pinned as-is: the refusal is kept as a start failure and nothing
  // clears it, so the same client can be spawned again but never initialized.
  test('after a refused shutdown the client cannot be initialized again', async () => {
    const client = await launchReady({ onShutdown: 'reject' })
    await client.stop().catch(() => {})
    const { command, args } = fakeServerCommand()
    await client.start(command, args)
    await expect(client.initialize(minimalInit('/'))).rejects.toThrow('shutdown refused by fake')
  })
})

describe('crash', () => {
  test('a non-zero exit is reported once through onCrash and drops initialization', async () => {
    const crashes: Error[] = []
    const client = await launchReady({}, error => crashes.push(error))
    void client.sendRequest('fake/crash', { code: 7 }).catch(() => {})
    await eventually(() => crashes.length > 0, 3000, 'onCrash')
    expect(crashes.map(e => e.message)).toEqual(['LSP server fake crashed with exit code 7'])
    expect(client.isInitialized).toBe(false)
  })

  test('a clean exit is not a crash, but the client stops counting as initialized', async () => {
    const crashes: Error[] = []
    const client = await launchReady({}, error => crashes.push(error))
    void client.sendRequest('fake/crash', { code: 0 }).catch(() => {})
    await eventually(() => !client.isInitialized, 3000, 'the connection to close')
    expect(crashes).toEqual([])
  })

  // Defect, pinned as-is: the in-flight initialize does not settle when the
  // server dies under it; only a later stop() (which disposes the connection)
  // rejects it. Without a startupTimeout an owner awaiting it waits forever.
  test('an exit during initialize reports a crash; the initialize settles only on stop', async () => {
    const crashes: Error[] = []
    const client = await launch({ onInitialize: { exitWith: 3 } }, error => crashes.push(error))
    let settled: string | undefined
    const initializing = client.initialize(minimalInit('/')).then(
      () => (settled = 'resolved'),
      (error: Error) => (settled = error.message),
    )
    await eventually(() => crashes.length > 0, 3000, 'onCrash')
    expect(crashes.map(e => e.message)).toEqual(['LSP server fake crashed with exit code 3'])
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(settled).toBeUndefined()
    await expect(client.stop()).rejects.toThrow('Connection is closed')
    await initializing
    expect(settled).toContain('connection got disposed')
  })

  test('a notification to a server that already exited is dropped without an error', async () => {
    const client = await launchReady()
    void client.sendRequest('fake/crash', { code: 0 }).catch(() => {})
    await eventually(() => !client.isInitialized, 3000, 'the connection to close')
    await expect(client.sendNotification('custom/late', {})).resolves.toBeUndefined()
  })

  test('an unreadable message poisons the client: every later call throws the parse error', async () => {
    const client = await launchReady()
    expect(await client.sendRequest<string>('fake/garbage', {})).toBe('after garbage')
    const later: Array<[string, () => unknown]> = [
      ['request', () => client.sendRequest('fake/echo', {})],
      ['notification', () => client.sendNotification('custom/x', {})],
      ['notification handler', () => client.onNotification('custom/y', () => {})],
      ['request handler', () => client.onRequest('custom/z', () => null)],
    ]
    const outcomes: Array<[string, string]> = []
    for (const [label, call] of later) {
      try {
        await call()
        outcomes.push([label, 'ok'])
      } catch (error) {
        outcomes.push([label, /JSON/i.test((error as Error).message) ? 'parse error' : (error as Error).message])
      }
    }
    expect(outcomes).toEqual(later.map(([label]) => [label, 'parse error']))
    expect(client.isInitialized).toBe(true)
  })

  test('a stop does not report the exit it causes as a crash', async () => {
    const crashes: Error[] = []
    const client = await launchReady({}, error => crashes.push(error))
    await client.stop()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(crashes).toEqual([])
  })
})
