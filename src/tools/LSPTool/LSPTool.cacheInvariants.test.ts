/**
 * Cache invariants for the LSP tool.
 *
 * The whole point of making this tool unconditionally present, read-only, and
 * never `isLsp` is that its contribution to the prompt prefix is *static*: the
 * tool list never gains/loses an entry and its no-result output never varies as
 * LSP servers connect, disconnect, or fail to serve a language. If any of these
 * regress, every LSP state change busts the cached prompt prefix.
 *
 * These assertions live in their own file (with a self-contained manager mock)
 * so they can drive both the no-manager and no-server branches without the
 * fixture/state bleed that the shared regression-baseline harness is prone to.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'

import type { ToolUseContext } from 'src/Tool.js'

// Swappable manager handle. It lives on globalThis rather than a module-scope
// `let` because bun's mock.module factory does not observe later reassignments
// of a closed-over local — a globalThis property read is always live, so the
// tests can flip between the no-manager and no-server branches at will.
const MANAGER_KEY = '__lspCacheInvariantManager' as const
function setManager(m: unknown): void {
  ;(globalThis as Record<string, unknown>)[MANAGER_KEY] = m
}
function getManager(): unknown {
  return (globalThis as Record<string, unknown>)[MANAGER_KEY]
}

// noServerManager is a connected server that returns undefined for every
// request (i.e. no server handles the file's language).
const noServerManager = {
  isFileOpen: () => true, // skip the open-file branch — keeps the test fs-light
  openFile: async () => {},
  changeFile: async () => {},
  saveFile: async () => {},
  closeFile: async () => {},
  ensureServerStarted: async () => undefined,
  getServerForFile: () => undefined,
  getAllServers: () => new Map(),
  initialize: async () => {},
  shutdown: async () => {},
  sendRequest: async () => undefined,
}

mock.module('src/platform/lsp/manager.js', () => ({
  isLspConnected: () => getManager() !== undefined,
  getLspServerManager: () => getManager(),
  reinitializeLspServerManager: () => {},
  initializeLspServerManager: () => {},
  shutdownLspServerManager: async () => {},
  getInitializationStatus: () => ({ status: 'success' as const }),
  waitForInitialization: async () => {},
  _resetLspManagerForTesting: () => {},
}))

const { LSPTool } = await import('src/tools/LSPTool/LSPTool.js')

const FILE_PATH = '/tmp/lsp-cache-invariants/sample.ts'

const ALL_OPS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const

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

async function runOp(operation: string): Promise<string> {
  type LooseCall = (
    i: Record<string, unknown>,
    c: ToolUseContext,
  ) => Promise<{ data: { result: string } }>
  const callFn = LSPTool.call as unknown as LooseCall
  const result = await callFn(
    { filePath: FILE_PATH, operation, line: 1, character: 1 },
    makeContext(),
  )
  return String(result.data.result)
}

describe('LSPTool cache invariants', () => {
  // The tool wraps call() in the input-keyed result cache (wrapCallWithCache),
  // which short-circuits before call() on a repeat input. Disable it so each
  // run reflects the manager state we set, rather than replaying an earlier
  // identical-input result.
  let prevCacheEnv: string | undefined
  beforeAll(() => {
    prevCacheEnv = process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
  })
  afterAll(() => {
    if (prevCacheEnv === undefined) {
      delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    } else {
      process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = prevCacheEnv
    }
  })

  test('is always enabled and never flagged isLsp (static tool presence)', () => {
    // Presence must not depend on LSP connectivity — a toggling definition
    // mutates the tool list and busts the cached prompt prefix.
    expect(LSPTool.isEnabled()).toBe(true)
    // The `isLsp` flag routes a tool through the init-pending defer latch,
    // which toggles its presence as servers connect/disconnect. This tool must
    // never carry it.
    expect((LSPTool as unknown as { isLsp?: boolean }).isLsp).toBeFalsy()
  })

  // NOTE: both unavailable branches are exercised in a single test on purpose.
  // bun interleaves sibling async tests at their `await` points, and they would
  // share the one global manager handle — a second async test flipping the
  // handle mid-await would make this one read the wrong manager. Keeping it in
  // one body means nothing else mutates the handle while we run.
  test('no-manager and no-server branches both emit one input-independent constant', async () => {
    // No manager → disabled/uninitialized short-circuit. Drive every op and
    // confirm a single constant with no per-file/per-extension interpolation,
    // so repeated no-server calls across different files stay cache-stable.
    setManager(undefined)
    const noManagerOutputs: string[] = []
    for (const operation of ALL_OPS) {
      noManagerOutputs.push(await runOp(operation))
    }
    for (const out of noManagerOutputs) expect(out).toBe(noManagerOutputs[0])
    expect(noManagerOutputs[0]).not.toContain(FILE_PATH)
    expect(noManagerOutputs[0]).not.toContain('.ts')

    // Connected server that handles no method → undefined wire result → the
    // "no server for this language" branch. It must emit the identical constant
    // for every op, so the two LSP states are cache-equivalent.
    setManager(noServerManager)
    const noServerOutputs: string[] = []
    for (const operation of ALL_OPS) {
      noServerOutputs.push(await runOp(operation))
    }
    for (const out of noServerOutputs) expect(out).toBe(noManagerOutputs[0])
    expect(noServerOutputs[0]).not.toContain(FILE_PATH)
  })
})
