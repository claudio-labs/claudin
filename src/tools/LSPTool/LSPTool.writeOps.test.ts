/**
 * Integration tests for the 4 LSPTool write-ops added in T5.1:
 *   rename, codeActions (read-only), applyCodeAction, renameFile.
 *
 * Strategy mirrors LSPTool.readonly.regression.test.ts: mock the LSP
 * server manager, plant per-method fixtures, and run real LSPTool.call()
 * against real temp files so the IO-bound applyNormalizedEdit path is
 * fully exercised.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import { setCwdState } from '../../bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { ToolUseContext } from '../../Tool.js'

// ---------------------------------------------------------------------------
// Mock infra — same as readonly regression
// ---------------------------------------------------------------------------

type RecordedCall = { filePath: string; method: string; params: unknown }
const recordedCalls: RecordedCall[] = []
const fixtures = new Map<string, unknown>()

function reset(): void {
  recordedCalls.length = 0
  fixtures.clear()
  didRenameCalls.length = 0
  invalidatedPaths.length = 0
  changeFileShouldThrow = false
  didRenameShouldThrow = false
}

const fakeServer = { name: 'fake-server', config: {}, state: 'running' as const }

const didRenameCalls: Array<{ oldPath: string; newPath: string }[]> = []
const invalidatedPaths: string[] = []
let changeFileShouldThrow = false
let didRenameShouldThrow = false
const fakeManager = {
  isFileOpen: () => true,
  openFile: async () => {},
  changeFile: async () => {
    if (changeFileShouldThrow) throw new Error('broken pipe')
  },
  saveFile: async () => {},
  closeFile: async () => {},
  ensureServerStarted: async () => undefined,
  getServerForFile: () => fakeServer,
  getAllServers: () => new Map(),
  initialize: async () => {},
  shutdown: async () => {},
  invalidateOpenFile: (filePath: string) => {
    invalidatedPaths.push(filePath)
  },
  notifyDidRenameFiles: async (
    renames: ReadonlyArray<{ oldPath: string; newPath: string }>,
  ) => {
    if (didRenameShouldThrow) throw new Error('server crashed')
    didRenameCalls.push(renames.map(r => ({ ...r })))
  },
  sendRequest: async (filePath: string, method: string, params: unknown) => {
    recordedCalls.push({ filePath, method, params })
    return fixtures.get(method)
  },
}

mock.module('../../services/lsp/manager.js', () => ({
  isLspConnected: () => true,
  getLspServerManager: () => fakeManager,
  reinitializeLspServerManager: () => {},
  initializeLspServerManager: () => {},
  shutdownLspServerManager: async () => {},
  getInitializationStatus: () => ({ status: 'success' as const }),
  waitForInitialization: async () => {},
  _resetLspManagerForTesting: () => {},
}))

mock.module('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrow: async () => ({ code: 1, stdout: '', stderr: '' }),
  execFileNoThrowWithCwd: async () => ({ code: 1, stdout: '', stderr: '' }),
  execSyncWithDefaults_DEPRECATED: () => ({ code: 0, stdout: '', stderr: '' }),
}))

const { LSPTool } = await import('./LSPTool.js')
const { __resetCodeActionCacheForTests } = await import('./codeActionCache.js')

// ---------------------------------------------------------------------------
// Per-test temp dir and ToolUseContext stub
// ---------------------------------------------------------------------------

let tmp: string

beforeAll(() => {
  // Make sure the tmp dir is treated as a working dir so writes auto-allow.
})

const {
  __resetWriteOpPrepCacheForTests,
  __setPreparedWriteOpForTests,
} = await import('./writeOpPrep.js')
const { resolveWorkspaceEdit, pathsTouchedByEdit } = await import(
  './workspaceEdit.js'
)

afterEach(() => {
  reset()
  __resetCodeActionCacheForTests()
  __resetWriteOpPrepCacheForTests()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

function setupTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), 'lspwrite-'))
  setCwdState(tmp)
  return tmp
}

function ctxFor(readFileState?: unknown): ToolUseContext {
  const permCtx = {
    ...getEmptyToolPermissionContext(),
    mode: 'acceptEdits' as const,
    additionalWorkingDirectories: new Map([[tmp, { source: 'cli' as const }]]),
  }
  // Minimal ToolUseContext stub — only the fields write-ops touch.
  return {
    getAppState: () => ({ toolPermissionContext: permCtx } as unknown as ReturnType<ToolUseContext['getAppState']>),
    abortController: new AbortController(),
    readFileState: readFileState ?? new Map(),
    options: { tools: [] },
  } as unknown as ToolUseContext
}

function fileUri(p: string): string {
  return pathToFileURL(p).href
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe('LSPTool rename', () => {
  test('applies WorkspaceEdit returned by the server and notifies didChange', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    writeFileSync(a, 'function foo() {}\nfoo()\n')

    fixtures.set('textDocument/rename', {
      changes: {
        [fileUri(a)]: [
          {
            range: {
              start: { line: 0, character: 9 },
              end: { line: 0, character: 12 },
            },
            newText: 'bar',
          },
          {
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 3 },
            },
            newText: 'bar',
          },
        ],
      },
    })

    const result = await LSPTool.call(
      {
        operation: 'rename',
        filePath: a,
        line: 1,
        character: 10,
        newName: 'bar',
      },
      ctxFor(),
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('Modified 1 file')
    expect(readFileSync(a, 'utf8')).toBe('function bar() {}\nbar()\n')

    // Verify the server saw textDocument/rename then a changeFile follow-up
    const methods = recordedCalls.map(c => c.method)
    expect(methods).toContain('textDocument/rename')
  })

  test('returns a no-op message when the server returns empty edit', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    writeFileSync(a, 'function foo() {}\n')
    fixtures.set('textDocument/rename', null)

    const result = await LSPTool.call(
      {
        operation: 'rename',
        filePath: a,
        line: 1,
        character: 10,
        newName: 'bar',
      },
      ctxFor(),
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('no changes')
  })
})

// ---------------------------------------------------------------------------
// codeActions + applyCodeAction
// ---------------------------------------------------------------------------

describe('LSPTool codeActions / applyCodeAction', () => {
  test('lists actions with synthetic ids and flags command-only as unsupported', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    writeFileSync(a, 'const x = 1\n')
    fixtures.set('textDocument/codeAction', [
      {
        title: 'Add type annotation',
        kind: 'quickfix',
        edit: {
          changes: {
            [fileUri(a)]: [
              {
                range: {
                  start: { line: 0, character: 7 },
                  end: { line: 0, character: 7 },
                },
                newText: ': number',
              },
            ],
          },
        },
      },
      { title: 'Run formatter', kind: 'source', command: { title: 'fmt', command: 'fmt' } },
    ])

    const result = await LSPTool.call(
      {
        operation: 'codeActions',
        filePath: a,
        line: 1,
        character: 1,
        endLine: 1,
        endCharacter: 11,
      },
      ctxFor(),
    )
    const data = (result as { data: { result: string; resultCount?: number } }).data
    expect(data.resultCount).toBe(2)
    expect(data.result).toContain('Add type annotation')
    expect(data.result).toContain('unsupported: command-only')
  })

  test('applyCodeAction applies the cached edit on disk', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    writeFileSync(a, 'const x = 1\n')

    fixtures.set('textDocument/codeAction', [
      {
        title: 'Add type annotation',
        kind: 'quickfix',
        edit: {
          changes: {
            [fileUri(a)]: [
              {
                range: {
                  start: { line: 0, character: 7 },
                  end: { line: 0, character: 7 },
                },
                newText: ': number',
              },
            ],
          },
        },
      },
    ])

    const list = await LSPTool.call(
      {
        operation: 'codeActions',
        filePath: a,
        line: 1,
        character: 1,
      },
      ctxFor(),
    )
    const listData = (list as { data: { result: string } }).data
    const idMatch = listData.result.match(/(ca_[a-f0-9-]+)/)
    expect(idMatch).not.toBeNull()
    const actionId = idMatch![1]!

    const apply = await LSPTool.call(
      { operation: 'applyCodeAction', filePath: a, actionId },
      ctxFor(),
    )
    const applyData = (apply as { data: { result: string } }).data
    expect(applyData.result).toContain('Modified 1 file')
    expect(readFileSync(a, 'utf8')).toBe('const x: number = 1\n')
  })

  test('applyCodeAction rejects command-only actions with an actionable message', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    writeFileSync(a, 'const x = 1\n')
    fixtures.set('textDocument/codeAction', [
      { title: 'Run formatter', kind: 'source', command: { title: 'fmt', command: 'fmt' } },
    ])
    const list = await LSPTool.call(
      { operation: 'codeActions', filePath: a, line: 1, character: 1 },
      ctxFor(),
    )
    const listData = (list as { data: { result: string } }).data
    const idMatch = listData.result.match(/(ca_unsupported_\d+)/)
    expect(idMatch).not.toBeNull()
    const apply = await LSPTool.call(
      { operation: 'applyCodeAction', filePath: a, actionId: idMatch![1]! },
      ctxFor(),
    )
    const applyData = (apply as { data: { result: string } }).data
    expect(applyData.result).toContain('command-only')
  })

  test('applyCodeAction with unknown id returns an error', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    writeFileSync(a, '')
    const result = await LSPTool.call(
      { operation: 'applyCodeAction', filePath: a, actionId: 'ca_nope' },
      ctxFor(),
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('Unknown or expired actionId')
  })
})

// ---------------------------------------------------------------------------
// renameFile
// ---------------------------------------------------------------------------

describe('LSPTool renameFile', () => {
  test('moves the file on disk and applies import-update edits from the server', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    const b = join(tmp, 'b.ts')
    const c = join(tmp, 'c.ts')
    writeFileSync(a, 'export const x = 1\n')
    writeFileSync(c, "import { x } from './a'\n")

    // The server returns edits that update c.ts's import
    fixtures.set('workspace/willRenameFiles', {
      documentChanges: [
        {
          textDocument: { uri: fileUri(c), version: 1 },
          edits: [
            {
              range: {
                start: { line: 0, character: 19 },
                end: { line: 0, character: 22 },
              },
              newText: './b',
            },
          ],
        },
      ],
    })

    const result = await LSPTool.call(
      { operation: 'renameFile', filePath: a, newPath: b },
      ctxFor(),
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('Modified 1 file')
    expect(data.result).toContain('Renamed 1 file')
    expect(readFileSync(b, 'utf8')).toBe('export const x = 1\n')
    expect(readFileSync(c, 'utf8')).toBe("import { x } from './b'\n")
    expect(didRenameCalls.length).toBe(1)
    expect(didRenameCalls[0]).toEqual([{ oldPath: a, newPath: b }])
  })

  test('didChange failure invalidates open-file tracking', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    writeFileSync(a, 'const x = 1\n')
    fixtures.set('textDocument/rename', {
      changes: {
        [fileUri(a)]: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
            newText: 'y',
          },
        ],
      },
    })
    changeFileShouldThrow = true
    const result = await LSPTool.call(
      { operation: 'rename', filePath: a, line: 1, character: 7, newName: 'y' },
      ctxFor(),
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('Modified 1 file')
    expect(readFileSync(a, 'utf8')).toBe('const y = 1\n')
    expect(invalidatedPaths).toContain(a)
  })

  test('didRenameFiles failure invalidates both old and new paths', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    const b = join(tmp, 'b.ts')
    writeFileSync(a, 'export const x = 1\n')
    fixtures.set('workspace/willRenameFiles', {})
    didRenameShouldThrow = true
    const result = await LSPTool.call(
      { operation: 'renameFile', filePath: a, newPath: b },
      ctxFor(),
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('Renamed 1 file')
    expect(invalidatedPaths).toContain(a)
    expect(invalidatedPaths).toContain(b)
  })
})

// ---------------------------------------------------------------------------
// permission gate
// ---------------------------------------------------------------------------

describe('LSPTool write-ops checkPermissions preflight', () => {
  test('threshold exceeded -> ask with aggregated diff embedded in message', async () => {
    setupTmp()
    const files = Array.from({ length: 5 }, (_, i) =>
      join(tmp, `f${i}.ts`),
    )
    for (const f of files) writeFileSync(f, 'foo()\n')
    fixtures.set('textDocument/rename', {
      changes: Object.fromEntries(
        files.map(f => [
          fileUri(f),
          [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'bar',
            },
          ],
        ]),
      ),
    })

    const permCtx = {
      ...getEmptyToolPermissionContext(),
      mode: 'acceptEdits' as const,
      additionalWorkingDirectories: new Map([[tmp, { source: 'cli' as const }]]),
    }
    const ctx = {
      getAppState: () => ({ toolPermissionContext: permCtx } as unknown as ReturnType<ToolUseContext['getAppState']>),
      abortController: new AbortController(),
      readFileState: new Map(),
      options: { tools: [] },
    } as unknown as ToolUseContext

    // Force a threshold of 3 so the 5-file rename trips it.
    const { saveGlobalConfig } = await import('../../utils/config.js')
    saveGlobalConfig(c => ({ ...c, lspWorkspaceEditConfirmThreshold: 3 }))

    try {
      const decision = await LSPTool.checkPermissions(
        {
          operation: 'rename',
          filePath: files[0]!,
          line: 1,
          character: 1,
          newName: 'bar',
        },
        ctx,
      )
      expect(decision.behavior).toBe('ask')
      if (decision.behavior !== 'ask') throw new Error('unreachable')
      expect(decision.message).toContain('threshold 3')
      // All affected paths listed and diff hunks rendered.
      for (const f of files) expect(decision.message).toContain(f)
      expect(decision.message).toContain('-foo')
      expect(decision.message).toContain('+bar')
    } finally {
      saveGlobalConfig(c => ({ ...c, lspWorkspaceEditConfirmThreshold: undefined }))
    }
  })

  test('bypassPermissions skips the threshold ask', async () => {
    setupTmp()
    const files = Array.from({ length: 5 }, (_, i) =>
      join(tmp, `f${i}.ts`),
    )
    for (const f of files) writeFileSync(f, 'foo()\n')
    fixtures.set('textDocument/rename', {
      changes: Object.fromEntries(
        files.map(f => [
          fileUri(f),
          [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'bar',
            },
          ],
        ]),
      ),
    })

    const permCtx = {
      ...getEmptyToolPermissionContext(),
      mode: 'bypassPermissions' as const,
      additionalWorkingDirectories: new Map([[tmp, { source: 'cli' as const }]]),
    }
    const ctx = {
      getAppState: () => ({ toolPermissionContext: permCtx } as unknown as ReturnType<ToolUseContext['getAppState']>),
      abortController: new AbortController(),
      readFileState: new Map(),
      options: { tools: [] },
    } as unknown as ToolUseContext

    const { saveGlobalConfig } = await import('../../utils/config.js')
    saveGlobalConfig(c => ({ ...c, lspWorkspaceEditConfirmThreshold: 3 }))

    try {
      const decision = await LSPTool.checkPermissions(
        {
          operation: 'rename',
          filePath: files[0]!,
          line: 1,
          character: 1,
          newName: 'bar',
        },
        ctx,
      )
      expect(decision.behavior).toBe('allow')
    } finally {
      saveGlobalConfig(c => ({ ...c, lspWorkspaceEditConfirmThreshold: undefined }))
    }
  })
})

describe('LSPTool write-ops permission gate', () => {
  test('rename aborts entirely if any affected path is denied', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    const b = join(tmp, 'b.ts')
    writeFileSync(a, 'foo\n')
    writeFileSync(b, 'foo\n')

    fixtures.set('textDocument/rename', {
      changes: {
        [fileUri(a)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 3 },
            },
            newText: 'bar',
          },
        ],
        [fileUri(b)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 3 },
            },
            newText: 'bar',
          },
        ],
      },
    })

    // Build ctx with b denied
    const permCtx = {
      ...getEmptyToolPermissionContext(),
      mode: 'acceptEdits' as const,
      additionalWorkingDirectories: new Map([[tmp, { source: 'cli' as const }]]),
      alwaysDenyRules: { cliArg: [`Edit(/${b})`] },
    }
    const ctx = {
      getAppState: () => ({ toolPermissionContext: permCtx } as unknown as ReturnType<ToolUseContext['getAppState']>),
      abortController: new AbortController(),
      readFileState: new Map(),
      options: { tools: [] },
    } as unknown as ToolUseContext

    const result = await LSPTool.call(
      {
        operation: 'rename',
        filePath: a,
        line: 1,
        character: 1,
        newName: 'bar',
      },
      ctx,
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('denied')
    // Both files untouched
    expect(readFileSync(a, 'utf8')).toBe('foo\n')
    expect(readFileSync(b, 'utf8')).toBe('foo\n')
  })

  test('drift detection: prep approved subset, edit touches additional path -> aborts', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    const b = join(tmp, 'b.ts')
    writeFileSync(a, 'foo\n')
    writeFileSync(b, 'foo\n')

    // The edit touches BOTH a and b, but the cached prep claims only [a]
    // was approved at preflight. The drift detector must abort apply.
    const edit = {
      changes: {
        [fileUri(a)]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: 'bar',
          },
        ],
        [fileUri(b)]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: 'bar',
          },
        ],
      },
    }
    const normalized = resolveWorkspaceEdit(edit)
    const allPaths = pathsTouchedByEdit(edit)
    expect(allPaths).toContain(a)
    expect(allPaths).toContain(b)
    __setPreparedWriteOpForTests(
      {
        operation: 'rename',
        absolutePath: a,
        line: 1,
        character: 1,
        newName: 'bar',
      },
      {
        serverName: 'fake-server',
        edit,
        normalized,
        paths: [a],
        storedAt: 0,
      },
    )

    const result = await LSPTool.call(
      {
        operation: 'rename',
        filePath: a,
        line: 1,
        character: 1,
        newName: 'bar',
      },
      ctxFor(),
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('not approved at preflight')
    expect(data.result).toContain(b)
    // Files untouched — drift error must abort BEFORE write.
    expect(readFileSync(a, 'utf8')).toBe('foo\n')
    expect(readFileSync(b, 'utf8')).toBe('foo\n')
  })

  test('cache miss + path needs ask -> reconfirmation error, no write', async () => {
    setupTmp()
    // File outside any working dir → checkBatchWritePermission returns 'ask'.
    const outside = mkdtempSync(join(tmpdir(), 'lspwrite-outside-'))
    const a = join(outside, 'a.ts')
    writeFileSync(a, 'foo\n')
    try {
      fixtures.set('textDocument/rename', {
        changes: {
          [fileUri(a)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'bar',
            },
          ],
        },
      })

      const permCtx = {
        ...getEmptyToolPermissionContext(),
        mode: 'acceptEdits' as const,
        // tmp is the working dir, but the file lives in `outside` → ask.
        additionalWorkingDirectories: new Map([[tmp, { source: 'cli' as const }]]),
      }
      const ctx = {
        getAppState: () => ({ toolPermissionContext: permCtx } as unknown as ReturnType<ToolUseContext['getAppState']>),
        abortController: new AbortController(),
        readFileState: new Map(),
        options: { tools: [] },
      } as unknown as ToolUseContext

      // Call directly without preflight so prep cache is empty → fallback
      // path → gateAndApply has no approvedPaths → 'ask' must throw.
      const result = await LSPTool.call(
        {
          operation: 'rename',
          filePath: a,
          line: 1,
          character: 1,
          newName: 'bar',
        },
        ctx,
      )
      const data = (result as { data: { result: string } }).data
      expect(data.result).toContain('reconfirmation')
      expect(readFileSync(a, 'utf8')).toBe('foo\n')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// readFileState sync after writes
// ---------------------------------------------------------------------------

const { FileStateCache } = await import('../../utils/fileStateCache.js')
const { getFileModificationTime } = await import('../../utils/file.js')

describe('LSPTool readFileState sync', () => {
  test('rename updates tracked readFileState entry with new content + mtime', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    const before = 'function foo() {}\nfoo()\n'
    writeFileSync(a, before)

    // Seed a stale entry: agent did a Read pre-rename, so the cache key
    // is `a` with the pre-edit content and an old timestamp.
    const cache = new FileStateCache(100, 25 * 1024 * 1024)
    cache.set(a, {
      content: before,
      timestamp: getFileModificationTime(a) - 5_000,
      offset: undefined,
      limit: undefined,
    })

    fixtures.set('textDocument/rename', {
      changes: {
        [fileUri(a)]: [
          {
            range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
            newText: 'bar',
          },
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
            newText: 'bar',
          },
        ],
      },
    })

    const result = await LSPTool.call(
      { operation: 'rename', filePath: a, line: 1, character: 10, newName: 'bar' },
      ctxFor(cache),
    )
    const data = (result as { data: { result: string } }).data
    expect(data.result).toContain('Modified 1 file')

    const after = readFileSync(a, 'utf8')
    expect(after).toBe('function bar() {}\nbar()\n')

    // The cache entry should now mirror the post-write state — content
    // matches disk and timestamp is fresh. A subsequent FileEdit must
    // not trip "modified since last read".
    const synced = cache.get(a)
    expect(synced).toBeDefined()
    expect(synced?.content).toBe(after)
    expect(synced?.timestamp).toBe(getFileModificationTime(a))
  })

  test('rename does NOT seed cache entry when file was not tracked', async () => {
    setupTmp()
    const a = join(tmp, 'a.ts')
    writeFileSync(a, 'function foo() {}\n')

    const cache = new FileStateCache(100, 25 * 1024 * 1024)
    // Intentionally not seeded — agent never Read this file.

    fixtures.set('textDocument/rename', {
      changes: {
        [fileUri(a)]: [
          {
            range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
            newText: 'bar',
          },
        ],
      },
    })

    await LSPTool.call(
      { operation: 'rename', filePath: a, line: 1, character: 10, newName: 'bar' },
      ctxFor(cache),
    )

    // No untracked seeding: the read-before-edit gate is intentional for
    // files the agent never opened. Only entries the agent explicitly
    // Read get refreshed.
    expect(cache.has(a)).toBe(false)
  })

  test('renameFile drops the old path from readFileState', async () => {
    setupTmp()
    const oldPath = join(tmp, 'a.ts')
    const newPath = join(tmp, 'b.ts')
    writeFileSync(oldPath, 'export const x = 1\n')

    const cache = new FileStateCache(100, 25 * 1024 * 1024)
    cache.set(oldPath, {
      content: 'export const x = 1\n',
      timestamp: getFileModificationTime(oldPath),
      offset: undefined,
      limit: undefined,
    })

    fixtures.set('workspace/willRenameFiles', null)

    await LSPTool.call(
      {
        operation: 'renameFile',
        filePath: oldPath,
        newPath,
      },
      ctxFor(cache),
    )

    // The old path no longer exists on disk; the cache entry pointing
    // to it must be cleared so FileEdit against `oldPath` correctly
    // fails ENOENT instead of appearing fresh.
    expect(cache.has(oldPath)).toBe(false)
  })
})
