/**
 * Characterization of streamingContext.ts, pinned before the levers cut edits
 * it (the cut removes the bridge fields).
 *
 * The module is types only: the context every headless unit shares, its
 * options bag, the suggestion and run-phase records, and the control-request
 * envelope. Its contract is what the type checker accepts, so this suite
 * compiles a client of those types with the repository's own `tsc` and
 * compiler options, and holds two things:
 *
 *   - every line of the client that must compile does;
 *   - every line marked `@ts-expect-error` is rejected, so the dependencies
 *     stay read-only, the run phases stay a closed set, and the required
 *     options stay required.
 *
 * One line, the sentinel, must fail to compile. It proves the checker ran and
 * reported on the client at all, so a silent `tsc` cannot pass this suite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { REPO_ROOT } from 'src/sessions/__testutils__/lifecycleHarness.js'

const SENTINEL = 'SENTINEL_MUST_FAIL'

const CLIENT = `
import type {
  ControlRequestWith,
  HeadlessStreamingContext,
  HeadlessStreamingOptions,
  McpSetServersOutcome,
  RunPhase,
  SuggestionState,
} from 'src/platform/headless/print/streamingContext.js'

declare const ctx: HeadlessStreamingContext

// The state a unit may write back for the others to read.
ctx.running = true
ctx.runPhase = 'waiting_for_agents'
ctx.runPhase = undefined
ctx.inputClosed = true
ctx.shutdownPromptInjected = false
ctx.heldBackResult = null
ctx.abortController = new AbortController()
ctx.abortController = undefined
ctx.readFileState = ctx.pendingSeeds
ctx.activeUserSpecifiedModel = 'some-model'
ctx.activeUserSpecifiedModel = undefined
ctx.sdkClients = []
ctx.sdkTools = []
ctx.dynamicMcpState = { clients: [], tools: [], configs: {} }
ctx.bridgeHandle = null
ctx.bridgeLastForwardedIndex = 3
ctx.mcpChangesPromise = Promise.resolve({ response: { added: [], removed: [], errors: {} }, sdkServersChanged: false })
ctx.pluginInstallPromise = null
ctx.pluginInstallPromise = Promise.resolve()
ctx.currentCommands = []
ctx.currentAgents = []
ctx.cronScheduler = null
ctx.claudeOAuth = null

// The wiring, attached after construction.
ctx.run = async () => {}
ctx.updateSdkMcp = async () => {}
ctx.applyMcpServerChanges = async servers => ({
  response: { added: Object.keys(servers), removed: [], errors: {} },
  sdkServersChanged: true,
})
ctx.refreshPluginState = async () => {}
ctx.applyPluginMcpDiff = async () => {}
ctx.buildAllTools = state => state.mcp.tools
ctx.registerElicitationHandlers = clients => void clients.length
ctx.buildMcpServerStatuses = () => []
ctx.forwardMessagesToBridge = () => {}
ctx.injectModelSwitchBreadcrumbs = (requested: string, resolved: string) => void (requested + resolved)
ctx.sendControlResponseSuccess = (message: { request_id: string }, response?: Record<string, unknown>) =>
  void [message.request_id, response]
ctx.sendControlResponseError = (message: { request_id: string }, error: string) => void [message.request_id, error]
ctx.closeOutput = async () => {}
ctx.sendControlResponseSuccess({ request_id: 'only-the-id' })
ctx.sendControlResponseError({ request_id: 'only-the-id' }, 'why')

// The shared records are mutated in place, never replaced.
ctx.sdkMcpConfigs['added'] = { type: 'sdk', name: 'added' }
ctx.mutableMessages.push(...[])
ctx.elicitationRegistered.add('server')
ctx.activeOAuthFlows.set('server', new AbortController())
ctx.oauthCallbackSubmitters.set('server', (url: string) => void url)
ctx.oauthManualCallbackUsed.add('server')
ctx.oauthAuthPromises.set('server', Promise.resolve())
ctx.suggestionState.abortController = null
ctx.options.thinkingConfig = { type: 'disabled' }
ctx.options.thinkingConfig = undefined
ctx.options.promptSuggestions = true

// @ts-expect-error a dependency is fixed for the session
ctx.structuredIO = ctx.structuredIO
// @ts-expect-error a dependency is fixed for the session
ctx.output = ctx.output
// @ts-expect-error a dependency is fixed for the session
ctx.initialMcpClients = []
// @ts-expect-error a dependency is fixed for the session
ctx.baseTools = []
// @ts-expect-error a dependency is fixed for the session
ctx.initialCommands = []
// @ts-expect-error a dependency is fixed for the session
ctx.initialAgents = []
// @ts-expect-error a dependency is fixed for the session
ctx.canUseTool = ctx.canUseTool
// @ts-expect-error a dependency is fixed for the session
ctx.getAppState = ctx.getAppState
// @ts-expect-error a dependency is fixed for the session
ctx.setAppState = ctx.setAppState
// @ts-expect-error the options object is shared, so it is never swapped
ctx.options = ctx.options
// @ts-expect-error the SDK configs are shared with the caller, so they are never swapped
ctx.sdkMcpConfigs = {}
// @ts-expect-error the message list is shared, so it is never swapped
ctx.mutableMessages = []
// @ts-expect-error a dependency is fixed for the session
ctx.pendingSeeds = ctx.pendingSeeds
// @ts-expect-error the suggestion record is shared, so it is never swapped
ctx.suggestionState = ctx.suggestionState
// @ts-expect-error a dependency is fixed for the session
ctx.elicitationRegistered = new Set()
// @ts-expect-error a dependency is fixed for the session
ctx.modelInfos = []
// @ts-expect-error a dependency is fixed for the session
ctx.idleTimeout = ctx.idleTimeout
// @ts-expect-error a dependency is fixed for the session
ctx.activeOAuthFlows = new Map()
// @ts-expect-error a dependency is fixed for the session
ctx.oauthCallbackSubmitters = new Map()
// @ts-expect-error a dependency is fixed for the session
ctx.oauthManualCallbackUsed = new Set()
// @ts-expect-error a dependency is fixed for the session
ctx.oauthAuthPromises = new Map()
// @ts-expect-error the run flag is a boolean
ctx.running = 'yes'
// @ts-expect-error the cursor is a number
ctx.bridgeLastForwardedIndex = '3'

// The run phases are a closed set.
const phases: RunPhase[] = ['draining_commands', 'waiting_for_agents', 'finally_flush', 'finally_post_flush', undefined]
// @ts-expect-error not a phase
const unknownPhase: RunPhase = 'idle'

// The options: these keys are required, even when undefined.
const fewest: HeadlessStreamingOptions = {
  verbose: undefined,
  jsonSchema: undefined,
  permissionPromptToolName: undefined,
  allowedTools: undefined,
  thinkingConfig: undefined,
  maxTurns: undefined,
  maxBudgetUsd: undefined,
  taskBudget: undefined,
  systemPrompt: undefined,
  appendSystemPrompt: undefined,
  userSpecifiedModel: undefined,
  fallbackModel: undefined,
}
const most: HeadlessStreamingOptions = {
  ...fewest,
  verbose: true,
  jsonSchema: { type: 'object' },
  permissionPromptToolName: 'mcp__perm__ask',
  allowedTools: ['Read'],
  maxTurns: 3,
  maxBudgetUsd: 1.5,
  taskBudget: { total: 10 },
  systemPrompt: 'sys',
  appendSystemPrompt: 'more',
  userSpecifiedModel: 'model',
  fallbackModel: 'fallback',
  replayUserMessages: true,
  includePartialMessages: false,
  enableAuthStatus: true,
  agent: 'reviewer',
  setSDKStatus: status => void status,
  promptSuggestions: false,
}
const { fallbackModel: _f, ...withoutFallback } = fewest
// @ts-expect-error fallbackModel is required
const missingFallback: HeadlessStreamingOptions = withoutFallback
const { verbose: _v, ...withoutVerbose } = fewest
// @ts-expect-error verbose is required
const missingVerbose: HeadlessStreamingOptions = withoutVerbose
// @ts-expect-error a task budget is an object with a total
const badBudget: HeadlessStreamingOptions = { ...fewest, taskBudget: 10 }

// The suggestion record.
const idle: SuggestionState = {
  abortController: null,
  inflightPromise: null,
  lastEmitted: null,
  pendingSuggestion: null,
  pendingLastEmittedEntry: null,
}
const emitted: SuggestionState = {
  ...idle,
  pendingSuggestion: { type: 'prompt_suggestion', suggestion: 'next', uuid: crypto.randomUUID(), session_id: 's' },
}
// @ts-expect-error a pending suggestion says what it is
const untyped: SuggestionState = { ...idle, pendingSuggestion: { suggestion: 'next', uuid: crypto.randomUUID(), session_id: 's' } }

// The outcome of applying MCP server changes.
const outcome: McpSetServersOutcome = { response: { added: ['a'], removed: [], errors: { b: 'failed' } }, sdkServersChanged: false }
// @ts-expect-error the outcome says whether SDK servers changed
const noFlag: McpSetServersOutcome = { response: outcome.response }

// The envelope keeps its own fields and carries the request it is given.
declare const envelope: ControlRequestWith<{ subtype: 'custom'; depth: number }>
const depth: number = envelope.request.depth
const subtype: 'custom' = envelope.request.subtype
const requestId: string = envelope.request_id
const kind: 'control_request' = envelope.type
// @ts-expect-error the request is the one given, not the schema's union
const missing: string = envelope.request.server_name

const ${SENTINEL}: RunPhase = 'not-a-phase'

export const used = [phases, unknownPhase, most, missingFallback, missingVerbose, badBudget, emitted, untyped, noFlag, depth, subtype, requestId, kind, missing, ${SENTINEL}]
`

let dir: string
let diagnostics: string[] = []
let clientLines: string[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'streaming-context-types-'))
  writeFileSync(join(dir, 'client.ts'), CLIENT)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: join(REPO_ROOT, 'tsconfig.json'),
      compilerOptions: {
        rootDir: '/',
        paths: { 'src/*': [join(REPO_ROOT, 'src/*')] },
        typeRoots: [join(REPO_ROOT, 'node_modules/@types')],
      },
      include: [],
      files: ['client.ts'],
    }),
  )
  const run = Bun.spawnSync([join(REPO_ROOT, 'node_modules/.bin/tsc'), '-p', 'tsconfig.json', '--pretty', 'false'], {
    cwd: dir,
  })
  diagnostics = run.stdout
    .toString()
    .split('\n')
    .filter(line => line.startsWith('client.ts('))
  clientLines = CLIENT.split('\n')
}, 120_000)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A diagnostic with the client line it points at, for a readable failure. */
const located = (diagnostic: string) => {
  const line = Number(/^client\.ts\((\d+),/.exec(diagnostic)?.[1])
  return { line, source: clientLines[line - 1]?.trim(), diagnostic }
}

describe('streamingContext types', () => {
  test('the module has nothing at run time', async () => {
    const module = await import('src/platform/headless/print/streamingContext.js')
    expect(Object.keys(module)).toEqual([])
  })

  test('the checker ran over the client and rejected the sentinel', () => {
    const sentinel = diagnostics.map(located).filter(d => d.source?.includes(SENTINEL))
    expect(sentinel).toHaveLength(1)
    expect(sentinel[0]!.diagnostic).toContain('TS2322')
  })

  test('the client compiles everywhere else, and every expected error happens', () => {
    const unexpected = diagnostics.map(located).filter(d => !d.source?.includes(SENTINEL))
    expect(unexpected).toEqual([])
  })
})
