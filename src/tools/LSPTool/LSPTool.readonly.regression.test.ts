/**
 * Regression baseline for the 9 read-only LSP operations.
 *
 * Captured BEFORE adding write-ops (rename, codeActions, applyCodeAction,
 * renameFile) per the T5.1 plan. Goal: lock the on-the-wire LSP request
 * shape (method + params) and the formatted output text for each operation
 * so the upcoming refactor cannot silently regress any existing behavior.
 *
 * Strategy:
 * - Mock services/lsp/manager.js with a fake LSPServerManager that records
 *   every sendRequest call and returns a per-test fixture.
 * - Mock execFileNoThrowWithCwd so the gitignore filter is deterministic.
 * - Use real files in a temp dir so fs.stat / fs.open in LSPTool work
 *   without further mocking (same pattern as GrepTool.test.ts).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import type { ToolUseContext } from 'src/Tool.js'
import { setCwdState } from 'src/bootstrap/state.js'

// ---------------------------------------------------------------------------
// Mock the LSP server manager + the execFile path used by gitignore filtering.
// IMPORTANT: must run before importing LSPTool.
// ---------------------------------------------------------------------------

type RecordedCall = { filePath: string; method: string; params: unknown }
const recordedCalls: RecordedCall[] = []

// Per-method fixture keyed by LSP method name. Tests overwrite before each
// LSPTool.call(). Reset between tests via clearFixtures().
const fixtures = new Map<string, unknown>()

function clearFixtures(): void {
  fixtures.clear()
  recordedCalls.length = 0
}

const fakeManager = {
  isFileOpen: () => true, // skip the open-file branch — keeps tests fs-light
  openFile: async () => {},
  changeFile: async () => {},
  saveFile: async () => {},
  closeFile: async () => {},
  ensureServerStarted: async () => undefined,
  getServerForFile: () => undefined,
  getAllServers: () => new Map(),
  initialize: async () => {},
  shutdown: async () => {},
  sendRequest: async (filePath: string, method: string, params: unknown) => {
    recordedCalls.push({ filePath, method, params })
    return fixtures.get(method)
  },
}

mock.module('src/services/lsp/manager.js', () => ({
  isLspConnected: () => true,
  getLspServerManager: () => fakeManager,
  reinitializeLspServerManager: () => {},
  initializeLspServerManager: () => {},
  shutdownLspServerManager: async () => {},
  getInitializationStatus: () => ({ status: 'success' as const }),
  waitForInitialization: async () => {},
  _resetLspManagerForTesting: () => {},
}))

// Keeps this file from shelling out. Snapshot the real module BEFORE stubbing
// and put it back in afterAll: mock.module is process-global and mock.restore()
// does not revert it, so an unrestored stub here answers every other file's
// exec for the rest of the run — it was returning `{code: 1}` with no `error`
// to src/utils/proc/execFileNoThrow.test.ts, whose assertions are about the
// real validation messages.
const realExecFileNoThrow = { ...(await import('src/utils/proc/execFileNoThrow.js')) }

mock.module('src/utils/proc/execFileNoThrow.js', () => ({
  execFileNoThrow: async () => ({ code: 1, stdout: '', stderr: '' }),
  execFileNoThrowWithCwd: async () => ({ code: 1, stdout: '', stderr: '' }),
  execSyncWithDefaults_DEPRECATED: () => ({ code: 0, stdout: '', stderr: '' }),
}))

afterAll(() => {
  mock.module('src/utils/proc/execFileNoThrow.js', () => realExecFileNoThrow)
})

const { LSPTool } = await import('src/tools/LSPTool/LSPTool.js')

// ---------------------------------------------------------------------------
// Filesystem setup — one .ts file per test, cwd-rooted relative paths so the
// formatter output is stable across machines.
// ---------------------------------------------------------------------------

let dir: string
let filePath: string
let fileUri: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsp-regression-'))
  filePath = join(dir, 'sample.ts')
  writeFileSync(filePath, 'export const foo = 1\nexport function bar() {}\n')
  fileUri = pathToFileURL(filePath).href
  // Force LSPTool's getCwd() to resolve to our temp dir so formatter output
  // uses relative paths (stable across machines).
  setCwdState(dir)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const emptyPermissionContext = {
  mode: 'default' as const,
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
}

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: emptyPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

async function runOpAfterSeed(input: Record<string, unknown>): Promise<{
  formatted: string
  recorded: RecordedCall[]
}> {
  type LooseCall = (
    i: Record<string, unknown>,
    c: ToolUseContext,
  ) => Promise<{ data: { result: string } }>
  const callFn = LSPTool.call as unknown as LooseCall
  const result = await callFn({ filePath, ...input }, makeContext())
  return {
    formatted: String(result.data.result),
    recorded: recordedCalls.slice(),
  }
}

function seedFixtures(seed: Record<string, unknown>): void {
  clearFixtures()
  for (const [method, value] of Object.entries(seed)) {
    fixtures.set(method, value)
  }
}

// ---------------------------------------------------------------------------
// Tests — one per operation. Snapshot the recorded request shape and the
// formatted output. Replace fileUri at the wire layer with a stable placeholder
// so the snapshot is reproducible.
// ---------------------------------------------------------------------------

function stableRecord(rec: RecordedCall[]): RecordedCall[] {
  return rec.map(c => ({
    filePath: '<TMP>/sample.ts',
    method: c.method,
    params: JSON.parse(JSON.stringify(c.params).replaceAll(fileUri, 'file:///TMP/sample.ts')),
  }))
}

function stableOutput(out: string): string {
  return out.replaceAll(fileUri, 'file:///TMP/sample.ts')
}

describe('LSPTool read-only regression baseline', () => {
  test('goToDefinition: request shape + single-location format', async () => {
    seedFixtures({
      'textDocument/definition': {
        uri: fileUri,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
      },
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'goToDefinition',
      line: 1,
      character: 14,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('findReferences: request shape + multi-location format', async () => {
    seedFixtures({
      'textDocument/references': [
        { uri: fileUri, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } } },
        { uri: fileUri, range: { start: { line: 1, character: 16 }, end: { line: 1, character: 19 } } },
      ],
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'findReferences',
      line: 1,
      character: 14,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('hover: request shape + markdown extraction', async () => {
    seedFixtures({
      'textDocument/hover': {
        contents: { kind: 'markdown', value: '```ts\nconst foo: number\n```' },
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
      },
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'hover',
      line: 1,
      character: 14,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('documentSymbol: request shape + DocumentSymbol[] format', async () => {
    seedFixtures({
      'textDocument/documentSymbol': [
        {
          name: 'foo',
          kind: 13,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
        },
        {
          name: 'bar',
          kind: 12,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 24 } },
          selectionRange: { start: { line: 1, character: 16 }, end: { line: 1, character: 19 } },
        },
      ],
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'documentSymbol',
      line: 1,
      character: 1,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('workspaceSymbol: request shape + symbol format', async () => {
    seedFixtures({
      'workspace/symbol': [
        {
          name: 'foo',
          kind: 13,
          location: {
            uri: fileUri,
            range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
          },
        },
      ],
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'workspaceSymbol',
      line: 1,
      character: 1,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('goToImplementation: request shape + format reuses goToDefinition', async () => {
    seedFixtures({
      'textDocument/implementation': [
        { uri: fileUri, range: { start: { line: 1, character: 16 }, end: { line: 1, character: 19 } } },
      ],
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'goToImplementation',
      line: 1,
      character: 14,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('prepareCallHierarchy: request shape + item format', async () => {
    seedFixtures({
      'textDocument/prepareCallHierarchy': [
        {
          name: 'bar',
          kind: 12,
          uri: fileUri,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 24 } },
          selectionRange: { start: { line: 1, character: 16 }, end: { line: 1, character: 19 } },
        },
      ],
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'prepareCallHierarchy',
      line: 2,
      character: 17,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('incomingCalls: two-step (prepare → calls) request shape + format', async () => {
    const item = {
      name: 'bar',
      kind: 12,
      uri: fileUri,
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 24 } },
      selectionRange: { start: { line: 1, character: 16 }, end: { line: 1, character: 19 } },
    }
    seedFixtures({
      'textDocument/prepareCallHierarchy': [item],
      'callHierarchy/incomingCalls': [
        {
          from: {
            name: 'caller',
            kind: 12,
            uri: fileUri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
            selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
          },
          fromRanges: [
            { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
          ],
        },
      ],
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'incomingCalls',
      line: 2,
      character: 17,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('outgoingCalls: two-step request shape + format', async () => {
    const item = {
      name: 'bar',
      kind: 12,
      uri: fileUri,
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 24 } },
      selectionRange: { start: { line: 1, character: 16 }, end: { line: 1, character: 19 } },
    }
    seedFixtures({
      'textDocument/prepareCallHierarchy': [item],
      'callHierarchy/outgoingCalls': [
        {
          to: {
            name: 'callee',
            kind: 12,
            uri: fileUri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
            selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
          },
          fromRanges: [
            { start: { line: 1, character: 18 }, end: { line: 1, character: 21 } },
          ],
        },
      ],
    })
    const { formatted, recorded } = await runOpAfterSeed({
      operation: 'outgoingCalls',
      line: 2,
      character: 17,
    })
    expect(stableRecord(recorded)).toMatchSnapshot('request')
    expect(stableOutput(formatted)).toMatchSnapshot('output')
  })

  test('1-based → 0-based position conversion', async () => {
    seedFixtures({ 'textDocument/hover': null })
    await runOpAfterSeed({ operation: 'hover', line: 5, character: 7 })
    // line=5,character=7 (1-based) must reach the LSP server as line=4,character=6.
    const last = recordedCalls[recordedCalls.length - 1]
    expect(last?.params).toMatchObject({
      position: { line: 4, character: 6 },
    })
  })

})
