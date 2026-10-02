/**
 * What the characterization suites do not reach: requests in flight when the
 * server goes away, deaths by signal, a server that leaves during shutdown,
 * a start over a live process, handlers that follow the client to a new
 * process, and the environment a server inherits.
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

const dirs = tempDirs('lsp-client-unit-')
const live: LSPClient[] = []
const INHERITED = 'FAKE_LSP_INHERITED'
const OVERRIDDEN = 'FAKE_LSP_OVERRIDDEN'
let savedConfigDir: string | undefined

beforeAll(() => {
  savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = dirs.make()
})
afterEach(async () => {
  delete process.env[INHERITED]
  delete process.env[OVERRIDDEN]
  await Promise.allSettled(live.splice(0).map(client => client.stop()))
})
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  dirs.cleanup()
})

const init = (): InitializeParams => ({
  processId: process.pid,
  rootUri: `file://${dirs.make()}`,
  capabilities: {},
})

async function startFake(
  client: LSPClient,
  behaviour: FakeServerBehaviour = {},
  env?: Record<string, string>,
): Promise<void> {
  const { command, args } = fakeServerCommand(behaviour)
  await client.start(command, args, { env })
  await client.initialize(init())
}

function tracked(onCrash?: (error: Error) => void): LSPClient {
  const client = createLSPClient('fake', onCrash)
  live.push(client)
  return client
}

describe('a server that goes away under a request', () => {
  const exits: Array<[number, string]> = [
    [5, 'LSP server fake crashed with exit code 5'],
    [0, 'LSP server fake exited'],
  ]
  test.each(exits)('exit code %d rejects the request in flight with "%s"', async (code, message) => {
    const client = tracked()
    await startFake(client)
    await expect(client.sendRequest('fake/crash', { code })).rejects.toThrow(message)
  })

  test('a kill by signal is reported as a crash naming the signal', async () => {
    const crashes: Error[] = []
    const client = tracked(error => crashes.push(error))
    const pidFile = join(dirs.make(), 'pid')
    await startFake(client, { pidFile })
    process.kill(readPid(pidFile), 'SIGKILL')
    await eventually(() => crashes.length > 0, 3000, 'onCrash')
    expect(crashes.map(e => e.message)).toEqual(['LSP server fake was killed by SIGKILL'])
    expect(client.isInitialized).toBe(false)
  })
})

describe('stop', () => {
  test('a server that exits with an error instead of answering shutdown still stops quietly', async () => {
    const crashes: Error[] = []
    const client = tracked(error => crashes.push(error))
    const leavesOnShutdown = `process.stdin.on('data', d => { if (String(d).includes('"shutdown"')) process.exit(1) })`
    await client.start(process.execPath, ['-e', leavesOnShutdown])
    const outcome = await Promise.race([
      client.stop().then(() => 'stopped'),
      new Promise(resolve => setTimeout(resolve, 2000, 'still waiting on shutdown')),
    ])
    expect(outcome).toBe('stopped')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(crashes).toEqual([])
  })
})

describe('start', () => {
  test('starting over a live process ends it without calling it a crash', async () => {
    const crashes: Error[] = []
    const client = tracked(error => crashes.push(error))
    const firstPidFile = join(dirs.make(), 'pid')
    await startFake(client, { pidFile: firstPidFile })
    const firstPid = readPid(firstPidFile)
    await startFake(client)
    await eventually(() => !processIsAlive(firstPid), 3000, 'the first process to end')
    const who = await client.sendRequest<{ pid: number }>('fake/whoami', {})
    expect(who.pid).not.toBe(firstPid)
    expect(crashes).toEqual([])
  })

  test('the server inherits this process environment, and the caller env wins over it', async () => {
    process.env[INHERITED] = 'ours'
    process.env[OVERRIDDEN] = 'ours'
    const client = tracked()
    await startFake(client, {}, { [OVERRIDDEN]: 'theirs' })
    const seen = async (name: string) =>
      (await client.sendRequest<{ env: string | null }>('fake/whoami', { env: name })).env
    expect([await seen(INHERITED), await seen(OVERRIDDEN)]).toEqual(['ours', 'theirs'])
  })
})

describe('handlers', () => {
  test('handlers registered once follow the client to its next process', async () => {
    const heard: unknown[] = []
    const client = tracked()
    client.onNotification('fake/news', params => heard.push(params))
    client.onRequest('fake/question', (params: { q: string }) => `re: ${params.q}`)
    await startFake(client)
    await client.stop()
    await startFake(client)
    await client.sendRequest('fake/push', { method: 'fake/news', params: { round: 2 } })
    const asked = await client.sendRequest('fake/ask', { method: 'fake/question', params: { q: 'again' } })
    await eventually(() => heard.length === 1, 2000, 'the notification')
    expect(heard).toEqual([{ round: 2 }])
    expect(asked).toEqual({ result: 're: again' })
  })

  test('a server request nobody handles is answered with method-not-found', async () => {
    const client = tracked()
    await startFake(client)
    const asked = await client.sendRequest<{ error?: { code: number } }>('fake/ask', {
      method: 'nobody/home',
      params: {},
    })
    expect(asked.error?.code).toBe(-32601)
  })
})
