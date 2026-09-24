/**
 * The diagnostics path as production drives it: a language server's
 * publishDiagnostics notification through the real handler into the registry,
 * then read back the ways the edit tools and the turn-level pull read it.
 *
 * The registry tests register `file://` URIs directly, which is the one form
 * production never stores — the handler converts to a path — so they could not
 * see that the edit tools' `file://` lookups missed, nor that a "file is clean"
 * publish was dropped before it reached the registry.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  awaitDiagnosticsForFile,
  checkForLSPDiagnostics,
  forgetDiagnosticsForEditedFile,
  peekPendingDiagnosticsForFile,
  resetAllLSPDiagnosticState,
} from 'src/platform/lsp/LSPDiagnosticRegistry.js'
import type { LSPServerManager } from 'src/platform/lsp/LSPServerManager.js'
import { registerLSPNotificationHandlers } from 'src/platform/lsp/passiveFeedback.js'

const PATH = '/tmp/passive-feedback.ts'
const URI = `file://${PATH}`

type Publish = (params: unknown) => void

/** Registers the real handler on fake servers; returns one publisher per server. */
function fakeServers(...names: string[]): Record<string, Publish> {
  const publishers: Record<string, Publish> = {}
  const servers = new Map(
    names.map(name => [
      name,
      {
        onNotification(method: string, handler: Publish) {
          if (method === 'textDocument/publishDiagnostics') publishers[name] = handler
        },
      },
    ]),
  )
  registerLSPNotificationHandlers({ getAllServers: () => servers } as unknown as LSPServerManager)
  return publishers
}

function diag(message: string, line = 0) {
  return {
    message,
    severity: 1,
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    source: 'ts',
  }
}

function delivered(): string[] {
  return checkForLSPDiagnostics().flatMap(set =>
    set.files.flatMap(f => f.diagnostics.map(d => d.message)),
  )
}

beforeEach(() => resetAllLSPDiagnosticState())
afterEach(() => resetAllLSPDiagnosticState())

describe('publishDiagnostics → registry', () => {
  test('a newer publish replaces the older one instead of adding to it', () => {
    const { ts } = fakeServers('ts')
    ts!({ uri: URI, diagnostics: [diag('Cannot find name foo')] })
    ts!({ uri: URI, diagnostics: [diag('Unused import bar', 2)] })
    expect(delivered()).toEqual(['Unused import bar'])
  })

  test('an empty publish clears what the server said before', () => {
    const { ts } = fakeServers('ts')
    ts!({ uri: URI, diagnostics: [diag('Cannot find name foo')] })
    ts!({ uri: URI, diagnostics: [] })
    expect(delivered()).toEqual([])
  })

  test('each server keeps its own latest list for the same file', () => {
    const { ts, eslint } = fakeServers('ts', 'eslint')
    ts!({ uri: URI, diagnostics: [diag('type error')] })
    eslint!({ uri: URI, diagnostics: [diag('lint error', 3)] })
    ts!({ uri: URI, diagnostics: [] })
    expect(delivered()).toEqual(['lint error'])
  })

  test('the edit tools find a published file by its path', async () => {
    const { ts } = fakeServers('ts')
    ts!({ uri: URI, diagnostics: [diag('type error')] })
    const files = await awaitDiagnosticsForFile(PATH, 50)
    expect(files?.[0]?.diagnostics.map(d => d.message)).toEqual(['type error'])
    expect(peekPendingDiagnosticsForFile(PATH).map(d => d.message)).toEqual(['type error'])
  })

  test('a clean publish answers a per-edit wait at once instead of timing out', async () => {
    const { ts } = fakeServers('ts')
    const waiting = awaitDiagnosticsForFile(PATH, 1500)
    const started = performance.now()
    ts!({ uri: URI, diagnostics: [] })
    const files = await waiting
    expect(performance.now() - started).toBeLessThan(200)
    expect(files?.[0]?.diagnostics).toEqual([])
  })

  test('an edit drops the diagnostics published before it', () => {
    const { ts } = fakeServers('ts')
    ts!({ uri: URI, diagnostics: [diag('describes the old content')] })
    forgetDiagnosticsForEditedFile(PATH)
    expect(delivered()).toEqual([])
  })

  test('an edit re-arms a diagnostic that survives it', () => {
    const { ts } = fakeServers('ts')
    ts!({ uri: URI, diagnostics: [diag('still wrong')] })
    expect(delivered()).toEqual(['still wrong'])
    forgetDiagnosticsForEditedFile(PATH)
    ts!({ uri: URI, diagnostics: [diag('still wrong')] })
    expect(delivered()).toEqual(['still wrong'])
  })

  test('a file:// URI and a path name the same file everywhere', async () => {
    const { ts } = fakeServers('ts')
    ts!({ uri: URI, diagnostics: [diag('type error')] })
    expect((await awaitDiagnosticsForFile(URI, 50))?.[0]?.uri).toBe(PATH)
    expect(peekPendingDiagnosticsForFile(URI).map(d => d.message)).toEqual(['type error'])
    forgetDiagnosticsForEditedFile(URI)
    expect(delivered()).toEqual([])
  })
})

describe('edit tools wiring', () => {
  // Each one must reset the file BEFORE telling the server about the new
  // content, or the fast path of the per-edit wait returns the pre-edit
  // diagnostics. No test drives these tools with an LSP manager, so the call
  // order is pinned on the source text.
  const sites: Array<[string, string]> = [
    ['src/tools/FileEditTool/FileEditTool.ts', 'forgetDiagnosticsForEditedFile(absoluteFilePath)'],
    ['src/tools/FileWriteTool/FileWriteTool.ts', 'forgetDiagnosticsForEditedFile(fullFilePath)'],
    ['src/tools/shared/stagedWrite/stagedWrite.ts', 'forgetDiagnosticsForEditedFile(target)'],
  ]
  test.each(sites)('%s resets the file before changeFile', (file, call) => {
    const src = readFileSync(file, 'utf8')
    const at = src.indexOf(call)
    expect(at).toBeGreaterThan(-1)
    expect(src.indexOf('.changeFile(', at)).toBeGreaterThan(at)
  })
})
