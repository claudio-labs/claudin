/**
 * The per-file router the tools talk to (LSPTool, the edit tools, the rename
 * flow): which server owns a file, lazy start, document sync and rename
 * notifications, and shutdown. Servers are real fake-server processes.
 *
 * The one mock is the plugin config boundary: `getAllLspServers` is where the
 * set of servers comes from (enabled plugins), and the plugin loader is
 * already stubbed for the whole run by config.test.ts, so it cannot be driven
 * from disk here. The real module is put back in afterAll.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { ScopedLspServerConfig } from 'src/platform/lsp/types.js'
import {
  type FakeServerBehaviour,
  fakeServerCommand,
} from 'src/platform/lsp/__testutils__/fakeLanguageServer.js'
import { eventually, processIsAlive, readPid, tempDirs } from 'src/platform/lsp/__testutils__/lspTestKit.js'

const realConfig = { ...(await import('src/platform/lsp/config.js')) }
let configured: Record<string, ScopedLspServerConfig> | Error = {}
mock.module('src/platform/lsp/config.js', () => ({
  ...realConfig,
  getAllLspServers: async () => {
    if (configured instanceof Error) throw configured
    return { servers: configured }
  },
}))

const { createLSPServerManager } = await import('src/platform/lsp/LSPServerManager.js')
type Manager = ReturnType<typeof createLSPServerManager>

const dirs = tempDirs('lsp-manager-')
const managers: Manager[] = []
let savedConfigDir: string | undefined

beforeAll(() => {
  savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = dirs.make()
})
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(m => m.shutdown()))
  configured = {}
})
afterAll(() => {
  mock.module('src/platform/lsp/config.js', () => realConfig)
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  dirs.cleanup()
})

function server(
  extensionToLanguage: Record<string, string>,
  behaviour: FakeServerBehaviour = {},
  extra: Partial<ScopedLspServerConfig> = {},
): ScopedLspServerConfig {
  return {
    ...fakeServerCommand(behaviour),
    extensionToLanguage,
    scope: 'dynamic',
    source: 'test-plugin',
    workspaceFolder: dirs.make(),
    ...extra,
  }
}

async function managerWith(servers: Record<string, ScopedLspServerConfig>): Promise<Manager> {
  configured = servers
  const { createLSPServerManager: create } = await import('src/platform/lsp/LSPServerManager.js')
  const manager = create()
  managers.push(manager)
  await manager.initialize()
  return manager
}

type Journal = Array<{ method: string; params: any }>
async function documentTraffic(manager: Manager, anyFile: string): Promise<Journal> {
  const journal = (await manager.sendRequest<Journal>(anyFile, 'fake/journal', {})) ?? []
  return journal.filter(e => e.method.startsWith('textDocument/') || e.method.startsWith('workspace/'))
}

function sourceFile(dir: string, name: string, text: string): string {
  const file = join(dir, name)
  writeFileSync(file, text)
  return file
}

const uriOf = (file: string) => pathToFileURL(file).href

describe('initialize', () => {
  test('keeps every valid server and drops the ones it cannot use', async () => {
    const manager = await managerWith({
      good: server({ '.ts': 'typescript' }),
      'no-command': { ...server({ '.a': 'a' }), command: '' },
      'no-extensions': server({}),
      unsupported: server({ '.b': 'b' }, {}, { restartOnCrash: true }),
    })
    expect([...manager.getAllServers().keys()]).toEqual(['good'])
    expect(manager.getAllServers().get('good')?.state).toBe('stopped')
  })

  test('a config load failure rejects initialize', async () => {
    configured = new Error('plugin registry unreadable')
    const { createLSPServerManager: create } = await import('src/platform/lsp/LSPServerManager.js')
    await expect(create().initialize()).rejects.toThrow('plugin registry unreadable')
  })
})

describe('server selection', () => {
  test('routes by extension, case-insensitively, first registered server winning', async () => {
    const manager = await managerWith({
      alpha: server({ '.ts': 'typescript', '.MTS': 'typescript' }),
      beta: server({ '.ts': 'typescript', '.py': 'python' }),
    })
    const cases: Array<[string, string | undefined]> = [
      ['/w/a.ts', 'alpha'],
      ['/w/A.TS', 'alpha'],
      ['/w/b.mts', 'alpha'],
      ['/w/c.py', 'beta'],
      ['/w/d.rs', undefined],
      ['/w/Makefile', undefined],
    ]
    expect(cases.map(([file]) => [file, manager.getServerForFile(file)?.name])).toEqual(cases)
  })

  test('nothing is started for a file no server owns', async () => {
    const manager = await managerWith({ only: server({ '.ts': 'typescript' }) })
    expect(await manager.ensureServerStarted('/w/x.go')).toBeUndefined()
    expect(await manager.sendRequest('/w/x.go', 'fake/echo', {})).toBeUndefined()
    await manager.openFile('/w/x.go', 'package main')
    expect(manager.getAllServers().get('only')?.state).toBe('stopped')
  })

  test('a server starts on first use and is reused afterwards', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }, { pidFile }) })
    const first = await manager.ensureServerStarted('/w/a.ts')
    expect(first?.state).toBe('running')
    const again = await manager.ensureServerStarted('/w/b.ts')
    expect(again).toBe(first)
    const who = await manager.sendRequest<{ pid: number }>('/w/c.ts', 'fake/whoami', {})
    expect(who?.pid).toBe(readPid(pidFile))
  })

  test('a server that cannot start makes the file request reject', async () => {
    const manager = await managerWith({ broken: server({ '.ts': 'typescript' }, { onInitialize: 'reject' }) })
    await expect(manager.sendRequest('/w/a.ts', 'fake/echo', {})).rejects.toThrow('initialize refused by fake')
    expect(manager.getServerForFile('/w/a.ts')?.state).toBe('error')
  })

  test('a server left in error is started again by the next request', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    await manager.ensureServerStarted('/w/a.ts')
    void manager.sendRequest('/w/a.ts', 'fake/crash', { code: 2 }).catch(() => {})
    const instance = manager.getServerForFile('/w/a.ts')!
    await eventually(() => instance.state === 'error', 3000, 'the crash')
    expect(await manager.sendRequest<unknown>('/w/a.ts', 'fake/echo', { back: true })).toEqual({ back: true })
  })

  test('a request error from the server reaches the caller', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    await expect(
      manager.sendRequest('/w/a.ts', 'fake/fail', { code: -32000, message: 'no symbol here' }),
    ).rejects.toThrow('no symbol here')
  })

  test('a workspace/configuration request from the server gets one null per item', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    const answer = await manager.sendRequest('/w/a.ts', 'fake/ask', {
      method: 'workspace/configuration',
      params: { items: [{ section: 'typescript' }, { section: 'editor' }, {}] },
    })
    expect(answer).toEqual({ result: [null, null, null] })
  })
})

describe('document sync', () => {
  test('open sends didOpen once, with the mapped language, version 1 and the text', async () => {
    const dir = dirs.make()
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    const file = join(dir, 'main.ts')
    expect(manager.isFileOpen(file)).toBe(false)
    await manager.openFile(file, 'const a = 1')
    await manager.openFile(file, 'const a = 2')
    expect(manager.isFileOpen(file)).toBe(true)
    expect(await documentTraffic(manager, file)).toEqual([
      {
        method: 'textDocument/didOpen',
        params: { textDocument: { uri: uriOf(file), languageId: 'typescript', version: 1, text: 'const a = 1' } },
      },
    ])
  })

  test('an extension declared in upper case routes but falls back to plaintext', async () => {
    const manager = await managerWith({ up: server({ '.MD': 'markdown' }) })
    const file = join(dirs.make(), 'notes.md')
    await manager.openFile(file, '# hi')
    const [open] = await documentTraffic(manager, file)
    expect(open?.params.textDocument.languageId).toBe('plaintext')
  })

  // Defect, pinned as-is: every didChange carries version 1, the same as the
  // didOpen before it; LSP expects the version to grow with each change.
  test('change before open opens; change after open sends the full text as version 1', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    const file = join(dirs.make(), 'edit.ts')
    await manager.changeFile(file, 'v1')
    await manager.changeFile(file, 'v2')
    await manager.changeFile(file, 'v3')
    const traffic = await documentTraffic(manager, file)
    expect(traffic.map(e => [e.method, e.params.textDocument.version, e.params.textDocument.text ?? e.params.contentChanges[0].text])).toEqual([
      ['textDocument/didOpen', 1, 'v1'],
      ['textDocument/didChange', 1, 'v2'],
      ['textDocument/didChange', 1, 'v3'],
    ])
  })

  test('save and close are skipped while the server is not running', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    await manager.saveFile('/w/a.ts')
    await manager.closeFile('/w/a.ts')
    await manager.saveFile('/w/a.unknown')
    expect(manager.getServerForFile('/w/a.ts')?.state).toBe('stopped')
  })

  test('save sends didSave; close sends didClose and lets the file be opened again', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    const file = join(dirs.make(), 'cycle.ts')
    await manager.openFile(file, 'one')
    await manager.saveFile(file)
    await manager.closeFile(file)
    expect(manager.isFileOpen(file)).toBe(false)
    await manager.openFile(file, 'two')
    const traffic = await documentTraffic(manager, file)
    expect(traffic.map(e => e.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didSave',
      'textDocument/didClose',
      'textDocument/didOpen',
    ])
    expect(traffic[1]?.params).toEqual({ textDocument: { uri: uriOf(file) } })
    expect(traffic[2]?.params).toEqual({ textDocument: { uri: uriOf(file) } })
  })

  test('invalidateOpenFile forgets the file without telling the server', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    const file = join(dirs.make(), 'stale.ts')
    await manager.openFile(file, 'old')
    manager.invalidateOpenFile(file)
    expect(manager.isFileOpen(file)).toBe(false)
    await manager.changeFile(file, 'new')
    const traffic = await documentTraffic(manager, file)
    expect(traffic.map(e => [e.method, e.params.textDocument.text])).toEqual([
      ['textDocument/didOpen', 'old'],
      ['textDocument/didOpen', 'new'],
    ])
  })

  test('after a crash, save and close are skipped and change reopens on a fresh process', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    const file = join(dirs.make(), 'crashy.ts')
    await manager.openFile(file, 'before')
    const instance = manager.getServerForFile(file)!
    void manager.sendRequest(file, 'fake/crash', { code: 1 }).catch(() => {})
    await eventually(() => instance.state === 'error', 3000, 'the crash')
    await manager.saveFile(file)
    await manager.closeFile(file)
    await manager.changeFile(file, 'after')
    expect(instance.state).toBe('running')
    // Tracking survived the crash, so the new process is never told about
    // the file: the change is skipped as "already open".
    expect(await documentTraffic(manager, file)).toEqual([])
  })

  // Defect, pinned as-is: a server that exits with code 0 on its own is not
  // treated as a crash, so its instance stays 'running' while unhealthy and is
  // never restarted; every sync and request after that fails.
  const afterCleanExit: Array<[string, (m: Manager, file: string) => Promise<unknown>, string]> = [
    ['open', (m, f) => m.openFile(`${f}.other.ts`, 'x'), 'Failed to sync file open'],
    ['change', (m, f) => m.changeFile(f, 'x'), 'Failed to sync file change'],
    ['save', (m, f) => m.saveFile(f), 'Failed to sync file save'],
    ['close', (m, f) => m.closeFile(f), 'Failed to sync file close'],
    ['request', (m, f) => m.sendRequest(f, 'fake/echo', {}), "server is running"],
  ]
  test.each(afterCleanExit)('a %s after the server exited cleanly rejects', async (_label, act, message) => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    const file = join(dirs.make(), 'zombie.ts')
    await manager.openFile(file, 'x')
    const instance = manager.getServerForFile(file)!
    void manager.sendRequest(file, 'fake/crash', { code: 0 }).catch(() => {})
    await eventually(() => !instance.isHealthy(), 3000, 'the exit')
    expect(instance.state).toBe('running')
    await expect(act(manager, file)).rejects.toThrow(message)
  })
})

describe('diagnostics delivery', () => {
  test('a server notification for a document reaches a handler on the instance', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }, { flagLinesContaining: 'BAD' }) })
    const file = join(dirs.make(), 'diag.ts')
    const instance = manager.getServerForFile(file)!
    const published: any[] = []
    instance.onNotification('textDocument/publishDiagnostics', params => published.push(params))
    await manager.openFile(file, 'fine\nBAD here\nfine')
    await eventually(() => published.length === 1, 3000, 'publishDiagnostics')
    expect(published[0].uri).toBe(uriOf(file))
    expect(published[0].diagnostics.map((d: any) => [d.range.start.line, d.message])).toEqual([
      [1, 'line 2 holds BAD'],
    ])
  })
})

describe('notifyDidRenameFiles', () => {
  test('an empty list does nothing', async () => {
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    await manager.notifyDidRenameFiles([])
    expect(manager.getServerForFile('/w/a.ts')?.state).toBe('stopped')
  })

  test('a server that advertises didRename gets the pairs, then the old URI closed and the new one opened', async () => {
    const dir = dirs.make()
    const manager = await managerWith({
      ts: server({ '.ts': 'typescript' }, { capabilities: { workspace: { fileOperations: { didRename: { filters: [] } } } } }),
    })
    const oldFile = join(dir, 'old.ts')
    const newFile = sourceFile(dir, 'new.ts', 'renamed body')
    await manager.openFile(oldFile, 'old body')
    await manager.notifyDidRenameFiles([{ oldPath: oldFile, newPath: newFile }])
    const traffic = await documentTraffic(manager, newFile)
    expect(traffic.map(e => e.method)).toEqual([
      'textDocument/didOpen',
      'workspace/didRenameFiles',
      'textDocument/didClose',
      'textDocument/didOpen',
    ])
    expect(traffic[1]?.params).toEqual({ files: [{ oldUri: uriOf(oldFile), newUri: uriOf(newFile) }] })
    expect(traffic[3]?.params.textDocument).toMatchObject({ uri: uriOf(newFile), text: 'renamed body' })
    expect([manager.isFileOpen(oldFile), manager.isFileOpen(newFile)]).toEqual([false, true])
  })

  test('a server that did not advertise didRename is skipped entirely', async () => {
    const dir = dirs.make()
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }, { capabilities: {} }) })
    const oldFile = join(dir, 'a.ts')
    const newFile = sourceFile(dir, 'b.ts', 'b')
    await manager.openFile(oldFile, 'a')
    await manager.notifyDidRenameFiles([{ oldPath: oldFile, newPath: newFile }])
    expect((await documentTraffic(manager, newFile)).map(e => e.method)).toEqual(['textDocument/didOpen'])
    expect(manager.isFileOpen(oldFile)).toBe(true)
  })

  test('when the server cannot take the notifications the rename still resolves', async () => {
    const dir = dirs.make()
    const rename = { capabilities: { workspace: { fileOperations: { didRename: {} } } } }
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }, rename) })
    const oldFile = join(dir, 'old.ts')
    const newFile = sourceFile(dir, 'new.ts', 'body')
    await manager.openFile(oldFile, 'body')
    const instance = manager.getServerForFile(oldFile)!
    void manager.sendRequest(oldFile, 'fake/crash', { code: 0 }).catch(() => {})
    await eventually(() => !instance.isHealthy(), 3000, 'the exit')
    await expect(manager.notifyDidRenameFiles([{ oldPath: oldFile, newPath: newFile }])).resolves.toBeUndefined()
    expect([manager.isFileOpen(oldFile), manager.isFileOpen(newFile)]).toEqual([true, false])
  })

  test('renames whose target no running server owns are ignored', async () => {
    const dir = dirs.make()
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }) })
    await manager.notifyDidRenameFiles([
      { oldPath: join(dir, 'a.ts'), newPath: join(dir, 'b.ts') },
      { oldPath: join(dir, 'a.txt'), newPath: join(dir, 'b.txt') },
    ])
    expect(manager.getServerForFile(join(dir, 'b.ts'))?.state).toBe('stopped')
  })

  test('a renamed file missing on disk is not opened, and nothing throws', async () => {
    const dir = dirs.make()
    const rename = { capabilities: { workspace: { fileOperations: { didRename: {} } } } }
    const manager = await managerWith({ ts: server({ '.ts': 'typescript' }, rename) })
    await manager.ensureServerStarted(join(dir, 'x.ts'))
    const missing = join(dir, 'vanished.ts')
    await manager.notifyDidRenameFiles([{ oldPath: join(dir, 'x.ts'), newPath: missing }])
    expect(manager.isFileOpen(missing)).toBe(false)
    expect((await documentTraffic(manager, missing)).map(e => e.method)).toEqual(['workspace/didRenameFiles'])
  })
})

describe('shutdown', () => {
  test('stops running servers and forgets every server and open file', async () => {
    const pidFile = join(dirs.make(), 'pid')
    const manager = await managerWith({
      ts: server({ '.ts': 'typescript' }, { pidFile }),
      idle: server({ '.py': 'python' }),
    })
    const file = join(dirs.make(), 'a.ts')
    await manager.openFile(file, 'x')
    await manager.shutdown()
    expect(manager.getAllServers().size).toBe(0)
    expect(manager.getServerForFile(file)).toBeUndefined()
    expect(manager.isFileOpen(file)).toBe(false)
    await eventually(() => !processIsAlive(readPid(pidFile)), 3000, 'the server to exit')
  })

  test('a server that refuses to stop is named in the rejection, after state is cleared', async () => {
    const manager = await managerWith({
      stubborn: server({ '.ts': 'typescript' }, { onShutdown: 'reject' }),
      polite: server({ '.py': 'python' }),
    })
    await manager.ensureServerStarted('/w/a.ts')
    await manager.ensureServerStarted('/w/a.py')
    await expect(manager.shutdown()).rejects.toThrow(
      'Failed to stop 1 LSP server(s): stubborn: shutdown refused by fake',
    )
    expect(manager.getAllServers().size).toBe(0)
  })
})
