/**
 * Tests for buildPostEditDiagnosticsMessages — the per-edit injection helper
 * called by FileEditTool/FileWriteTool right before they return.
 *
 * NOTE: We deliberately use the REAL LSPDiagnosticRegistry (no mock.module on
 * it) — Bun's mock.module leaks across files in the same shard, so a fake
 * `awaitDiagnosticsForFile` would corrupt sibling tests. Instead we drive the
 * helper by pre-populating pendingDiagnostics or letting it time out.
 *
 * Covers:
 *  - LSP off → []
 *  - no manager → []
 *  - no server for language → []
 *  - timeout (no diagnostics arrive) → []
 *  - happy path: returns a single diagnostics AttachmentMessage and pollutes
 *    the dedup LRU so the next checkForLSPDiagnostics skips
 *  - empty-but-published diagnostic batch → []
 *  - settings clamp: respects min/max bounds (verified indirectly via timing)
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { DiagnosticFile } from '../diagnosticTracking.js'
import {
  _resetFileWaitersForTesting,
  checkForLSPDiagnostics,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from './LSPDiagnosticRegistry.js'

const mockIsLspGloballyEnabled = mock(() => true)
const realUserSettingsDiag = { ...(await import('./userSettings.js')) }
mock.module('./userSettings.js', () => ({
  ...realUserSettingsDiag,
  isLspGloballyEnabled: mockIsLspGloballyEnabled,
  getUserLspSettings: () => ({}),
}))

const mockGetServerForFile = mock((_path: string) => undefined as unknown)
const mockGetLspServerManager = mock(() => ({
  getServerForFile: mockGetServerForFile,
}))
mock.module('./manager.js', () => ({
  getLspServerManager: mockGetLspServerManager,
  isLspConnected: () => true,
  reinitializeLspServerManager: () => {},
  initializeLspServerManager: () => {},
  shutdownLspServerManager: async () => {},
  getInitializationStatus: () => ({ status: 'success' }),
  waitForInitialization: async () => {},
  _resetLspManagerForTesting: () => {},
}))

// Capture real settings module before mocking so afterAll can restore it.
const realSettingsDiag = { ...(await import('../../utils/settings/settings.js')) }

const mockGetInitialSettings = mock(
  () => ({}) as { lsp?: { diagnosticsTimeoutMs?: number } },
)
mock.module('../../utils/settings/settings.js', () => ({
  getInitialSettings: mockGetInitialSettings,
  updateSettingsForSource: async () => {},
  setSetting: async () => {},
  loadSettings: async () => ({}),
  getSettingsForSource: () => ({}),
  getSettingsWithSources: () => ({}),
  getSettingsWithErrors: () => ({ settings: {}, errors: [] }),
  getSettings_DEPRECATED: () => ({}),
  loadManagedFileSettings: () => ({ settings: {}, errors: [] }),
  getManagedFileSettingsPresence: () => ({}),
  parseSettingsFile: () => ({ settings: {}, errors: [] }),
  getSettingsRootPathForSource: () => '',
  getSettingsFilePathForSource: () => '',
  getRelativeSettingsFilePathForSource: () => '',
  getPolicySettingsOrigin: () => ({}),
  settingsMergeCustomizer: () => undefined,
  getManagedSettingsKeysForLogging: () => [],
  hasSkipDangerousModePermissionPrompt: () => false,
  hasAllowBypassPermissionsMode: () => false,
  hasAutoModeOptIn: () => false,
  getUseAutoModeDuringPlan: () => false,
  getAutoModeConfig: () => ({}),
  rawSettingsContainsKey: () => false,
}))

const fileWithDiag: DiagnosticFile = {
  uri: 'file:///tmp/x.ts',
  diagnostics: [
    {
      message: 'Type error',
      severity: 'Error',
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 4 },
      },
    },
  ],
}

beforeEach(() => {
  resetAllLSPDiagnosticState()
  _resetFileWaitersForTesting()
  mockIsLspGloballyEnabled.mockReset()
  mockIsLspGloballyEnabled.mockImplementation(() => true)
  mockGetServerForFile.mockReset()
  mockGetServerForFile.mockImplementation(() => ({}) as unknown)
  mockGetLspServerManager.mockReset()
  mockGetLspServerManager.mockImplementation(() => ({
    getServerForFile: mockGetServerForFile,
  }))
  mockGetInitialSettings.mockReset()
  mockGetInitialSettings.mockImplementation(() => ({}))
})

afterEach(() => {
  resetAllLSPDiagnosticState()
  _resetFileWaitersForTesting()
})

describe('buildPostEditDiagnosticsMessages', () => {
  test('returns [] when LSP is globally disabled', async () => {
    mockIsLspGloballyEnabled.mockImplementation(() => false)
    const { buildPostEditDiagnosticsMessages } = await import(
      './diagnosticsForToolResult.js'
    )
    const out = await buildPostEditDiagnosticsMessages('/tmp/x.ts')
    expect(out).toEqual([])
  })

  test('returns [] when no LSP manager is available', async () => {
    mockGetLspServerManager.mockImplementation(() => undefined as never)
    const { buildPostEditDiagnosticsMessages } = await import(
      './diagnosticsForToolResult.js'
    )
    const out = await buildPostEditDiagnosticsMessages('/tmp/x.ts')
    expect(out).toEqual([])
  })

  test('returns [] when no server handles the file extension', async () => {
    mockGetServerForFile.mockImplementation(() => undefined)
    const { buildPostEditDiagnosticsMessages } = await import(
      './diagnosticsForToolResult.js'
    )
    const out = await buildPostEditDiagnosticsMessages('/tmp/x.unknownext')
    expect(out).toEqual([])
  })

  test('returns [] on timeout (registry empty for this URI)', async () => {
    // Use a tight timeout for fast test; settings clamp to 100ms minimum.
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { diagnosticsTimeoutMs: 100 },
    }))
    const { buildPostEditDiagnosticsMessages } = await import(
      './diagnosticsForToolResult.js'
    )
    const start = performance.now()
    const out = await buildPostEditDiagnosticsMessages('/tmp/x.ts')
    const elapsed = performance.now() - start
    expect(out).toEqual([])
    // Confirm the configured timeout was used (rather than the default 1500).
    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(elapsed).toBeLessThan(400)
  })

  test('returns [] when the published batch has empty diagnostics array', async () => {
    // Pre-register an empty diagnostics file — same URI but no diagnostics entries.
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [{ uri: 'file:///tmp/x.ts', diagnostics: [] }],
    })
    const { buildPostEditDiagnosticsMessages } = await import(
      './diagnosticsForToolResult.js'
    )
    const out = await buildPostEditDiagnosticsMessages('/tmp/x.ts')
    expect(out).toEqual([])
  })

  test('happy path: returns 1 diagnostics AttachmentMessage and dedup-marks it', async () => {
    // Pre-populate the registry with a real diagnostic for this URI — fast path
    // resolves immediately.
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileWithDiag],
    })
    const { buildPostEditDiagnosticsMessages } = await import(
      './diagnosticsForToolResult.js'
    )
    const out = await buildPostEditDiagnosticsMessages('/tmp/x.ts')

    expect(out).toHaveLength(1)
    const msg = out[0]!
    expect(msg.type).toBe('attachment')
    expect(msg.attachment.type).toBe('diagnostics')
    if (msg.attachment.type === 'diagnostics') {
      expect(msg.attachment.isNew).toBe(true)
      expect(msg.attachment.files).toHaveLength(1)
      expect(msg.attachment.files[0]!.uri).toBe('file:///tmp/x.ts')
      expect(msg.attachment.files[0]!.diagnostics[0]!.message).toBe('Type error')
    }

    // The helper must have called markDiagnosticsAsDelivered: simulate the next
    // turn-level pull and confirm the same diagnostic is dedup-skipped.
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileWithDiag],
    })
    const next = checkForLSPDiagnostics()
    expect(next).toEqual([])
  })

  test('uses default 1500ms when setting is absent (timing sanity)', async () => {
    mockGetInitialSettings.mockImplementation(() => ({}))
    // Pre-populated → fast-path resolves immediately, regardless of timeout
    // (we only verify the helper does not throw & returns the message).
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileWithDiag],
    })
    const { buildPostEditDiagnosticsMessages } = await import(
      './diagnosticsForToolResult.js'
    )
    const out = await buildPostEditDiagnosticsMessages('/tmp/x.ts')
    expect(out).toHaveLength(1)
  })
})

describe('armFileForLateDiagnostics + awaitLateDiagnosticsForTurn', () => {
  beforeEach(async () => {
    const { clearArmedFiles } = await import('./diagnosticsForToolResult.js')
    clearArmedFiles()
  })

  test('arm + 1st publish + stability stable → injects', async () => {
    const {
      armFileForLateDiagnostics,
      awaitLateDiagnosticsForTurn,
    } = await import('./diagnosticsForToolResult.js')
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { diagnosticsTimeoutMs: 200 },
    }))
    armFileForLateDiagnostics('/tmp/x.ts', undefined)
    // Publish before await starts → fast path resolves immediately, stability
    // window then peeks the same pending entry.
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileWithDiag],
    })
    const out = await awaitLateDiagnosticsForTurn()
    expect(out).toHaveLength(1)
    expect(out[0]!.uri).toBe('file:///tmp/x.ts')
    expect(out[0]!.diagnostics).toHaveLength(1)
  })

  test('arm + 1st publish (errors) + 2nd publish empty in stability window → discards', async () => {
    const {
      armFileForLateDiagnostics,
      awaitLateDiagnosticsForTurn,
    } = await import('./diagnosticsForToolResult.js')
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { diagnosticsTimeoutMs: 200 },
    }))
    armFileForLateDiagnostics('/tmp/x.ts', undefined)
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileWithDiag],
    })
    // Schedule the "all clear" republish to land inside the stability window.
    setTimeout(() => {
      registerPendingLSPDiagnostic({
        serverName: 'tsserver',
        files: [{ uri: 'file:///tmp/x.ts', diagnostics: [] }],
      })
    }, 100)
    const out = await awaitLateDiagnosticsForTurn()
    // peekPendingDiagnosticsForFile returns the LATEST entry's diagnostics for
    // this URI — which is now empty, so the file is dropped.
    expect(out).toEqual([])
  })

  test('arm + 3 URIs, only 1 publishes → injects the 1', async () => {
    const {
      armFileForLateDiagnostics,
      awaitLateDiagnosticsForTurn,
    } = await import('./diagnosticsForToolResult.js')
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { diagnosticsTimeoutMs: 200 },
    }))
    armFileForLateDiagnostics('/tmp/a.ts', undefined)
    armFileForLateDiagnostics('/tmp/b.ts', undefined)
    armFileForLateDiagnostics('/tmp/c.ts', undefined)
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [{ uri: 'file:///tmp/b.ts', diagnostics: fileWithDiag.diagnostics }],
    })
    const out = await awaitLateDiagnosticsForTurn()
    expect(out).toHaveLength(1)
    expect(out[0]!.uri).toBe('file:///tmp/b.ts')
  })

  test('arm + zero publish before timeout → returns []', async () => {
    const {
      armFileForLateDiagnostics,
      awaitLateDiagnosticsForTurn,
    } = await import('./diagnosticsForToolResult.js')
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { diagnosticsTimeoutMs: 100 },
    }))
    armFileForLateDiagnostics('/tmp/x.ts', undefined)
    const start = performance.now()
    const out = await awaitLateDiagnosticsForTurn()
    const elapsed = performance.now() - start
    expect(out).toEqual([])
    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(elapsed).toBeLessThan(400)
  })

  test('abort during wait → returns [] quickly', async () => {
    const {
      armFileForLateDiagnostics,
      awaitLateDiagnosticsForTurn,
    } = await import('./diagnosticsForToolResult.js')
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { diagnosticsTimeoutMs: 500 },
    }))
    armFileForLateDiagnostics('/tmp/x.ts', undefined)
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileWithDiag],
    })
    // Publish triggers fast-path resolve; stability window then waits 400ms.
    // Aborting mid-stability should short-circuit return.
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const start = performance.now()
    const out = await awaitLateDiagnosticsForTurn({ signal: controller.signal })
    const elapsed = performance.now() - start
    expect(out).toEqual([])
    expect(elapsed).toBeLessThan(300)
  })

  test('arm with agentId → no-op', async () => {
    const {
      armFileForLateDiagnostics,
      _getArmedFilesForTesting,
    } = await import('./diagnosticsForToolResult.js')
    armFileForLateDiagnostics('/tmp/x.ts', 'subagent-1')
    expect(_getArmedFilesForTesting()).toEqual([])
  })

  test('arm without LSP globally enabled → no-op', async () => {
    mockIsLspGloballyEnabled.mockImplementation(() => false)
    const {
      armFileForLateDiagnostics,
      _getArmedFilesForTesting,
    } = await import('./diagnosticsForToolResult.js')
    armFileForLateDiagnostics('/tmp/x.ts', undefined)
    expect(_getArmedFilesForTesting()).toEqual([])
  })

  test('arm with path that has no server → no-op', async () => {
    mockGetServerForFile.mockImplementation(() => undefined)
    const {
      armFileForLateDiagnostics,
      _getArmedFilesForTesting,
    } = await import('./diagnosticsForToolResult.js')
    armFileForLateDiagnostics('/tmp/x.unknownext', undefined)
    expect(_getArmedFilesForTesting()).toEqual([])
  })

  test('same-turn dedup: per-edit already delivered → tail-wait drops it', async () => {
    // Scenario: FileEditTool runs buildPostEditDiagnosticsMessages (which
    // markDiagnosticsAsDelivered), then arms the file. Assistant ends turn
    // with no tool_use. Tail-wait must NOT re-surface the same diagnostic.
    const {
      buildPostEditDiagnosticsMessages,
      armFileForLateDiagnostics,
      awaitLateDiagnosticsForTurn,
    } = await import('./diagnosticsForToolResult.js')
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { diagnosticsTimeoutMs: 200 },
    }))

    // Per-edit publishes & marks delivered.
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileWithDiag],
    })
    const perEdit = await buildPostEditDiagnosticsMessages('/tmp/x.ts')
    expect(perEdit).toHaveLength(1)

    // Edit tool arms after per-edit.
    armFileForLateDiagnostics('/tmp/x.ts', undefined)

    // Tail-wait: pending entry is still present (per-edit doesn't drain it),
    // fast-path resolves immediately, peek surfaces the same diag — but the
    // delivered-LRU filter must drop it.
    const out = await awaitLateDiagnosticsForTurn()
    expect(out).toEqual([])
  })

  test('same-turn dedup: per-edit delivered diag A, new diag B published in stability window → only B surfaces', async () => {
    const {
      buildPostEditDiagnosticsMessages,
      armFileForLateDiagnostics,
      awaitLateDiagnosticsForTurn,
    } = await import('./diagnosticsForToolResult.js')
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { diagnosticsTimeoutMs: 200 },
    }))

    // Per-edit publishes & marks delivered for diag A.
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileWithDiag],
    })
    const perEdit = await buildPostEditDiagnosticsMessages('/tmp/x.ts')
    expect(perEdit).toHaveLength(1)

    armFileForLateDiagnostics('/tmp/x.ts', undefined)

    // Force the 2nd register to land on a later Date.now() tick than the 1st,
    // so peekPendingDiagnosticsForFile picks the new entry. Without this,
    // synchronous back-to-back registers can share a timestamp and the older
    // entry wins.
    await new Promise(r => setTimeout(r, 5))

    // Now LSP publishes both A and B (latest pending entry replaces the old).
    const diagB = {
      message: 'Different error',
      severity: 'error' as const,
      range: {
        start: { line: 5, character: 0 },
        end: { line: 5, character: 10 },
      },
      source: 'ts',
      code: 9999,
    }
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [
        {
          uri: 'file:///tmp/x.ts',
          diagnostics: [...fileWithDiag.diagnostics, diagB],
        },
      ],
    })

    const out = await awaitLateDiagnosticsForTurn()
    expect(out).toHaveLength(1)
    expect(out[0]!.diagnostics).toHaveLength(1)
    expect(out[0]!.diagnostics[0]!.message).toBe('Different error')
  })

  test('clearArmedFiles empties the set between turns', async () => {
    const {
      armFileForLateDiagnostics,
      clearArmedFiles,
      _getArmedFilesForTesting,
    } = await import('./diagnosticsForToolResult.js')
    armFileForLateDiagnostics('/tmp/a.ts', undefined)
    armFileForLateDiagnostics('/tmp/b.ts', undefined)
    expect(_getArmedFilesForTesting()).toHaveLength(2)
    clearArmedFiles()
    expect(_getArmedFilesForTesting()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('./userSettings.js', () => realUserSettingsDiag)
  mock.module('src/services/lsp/userSettings.js', () => realUserSettingsDiag)
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
  mock.module('../../utils/settings/settings.js', () => realSettingsDiag)
})
