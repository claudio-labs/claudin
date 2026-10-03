/**
 * Characterization of the settings and session control requests of the
 * headless host (settingsControlHandlers.ts), pinned before the levers cut
 * edits the file.
 *
 * Every request goes in on stdin and its answer is read from the outbound
 * stream, with the control loop running as the streaming host runs it. Files,
 * settings and transcripts are real and live in temp directories.
 *
 * The model is the one boundary mocked: `queryHaiku` (session titles) and
 * `queryModelWithStreaming` (the side question's forked agent) are answered by
 * the test while one of its requests is in flight, and handed to the real
 * provider otherwise.
 *
 * Not pinned: `remote_control`, which starts the bridge and goes with the cut.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createAssistantMessage } from 'src/agent/messages/messages.js'
import {
  getFlagSettingsInline,
  getMainLoopModelOverride,
  getInlinePlugins,
  getSessionId,
  setFlagSettingsInline,
  setInlinePlugins,
  setMainLoopModelOverride,
} from 'src/platform/bootstrap/state.js'
import { clearAllCaches } from 'src/plugins/cacheUtils.js'
import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { useRestoreSandbox } from 'src/sessions/__testutils__/restoreHarness.js'
import { getTranscriptPathForSession } from 'src/sessions/sessionStorage.js'
import { setSessionMetadataChangedListener } from 'src/sessions/sessionState.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

// --- the model boundary ---------------------------------------------------------

type ModelCall = { kind: 'title' | 'side'; signal?: AbortSignal; prompt: unknown }
let modelCalls: ModelCall[] | null = null
let titleReply = '{"title":"Fix the flaky parser test"}'
let sideReply = 'Because the cache was cold.'

const realProvider = { ...(await import('src/providers/shims/claude.js')) }
mock.module('src/providers/shims/claude.js', () => ({
  ...realProvider,
  queryHaiku: async (request: Parameters<typeof realProvider.queryHaiku>[0]) => {
    if (modelCalls === null) return realProvider.queryHaiku(request)
    modelCalls.push({ kind: 'title', signal: request.signal, prompt: request.userPrompt })
    return createAssistantMessage({ content: titleReply })
  },
  queryModelWithStreaming: (...args: Parameters<typeof realProvider.queryModelWithStreaming>) => {
    if (modelCalls === null) return realProvider.queryModelWithStreaming(...args)
    const calls = modelCalls
    const { signal, messages } = args[0]
    return (async function* () {
      calls.push({ kind: 'side', signal, prompt: messages.at(-1) })
      // As the provider does, a request whose signal is already aborted is never sent.
      if (signal.aborted) throw new Error('Request was aborted.')
      yield createAssistantMessage({ content: sideReply })
    })()
  },
}))

const { controlRequest, openSession, useBuildMacro } = await import('src/platform/headless/print/__testutils__/streamingHarness.js')
const { runControlLoop } = await import('src/platform/headless/print/controlLoop.js')
const { saveCacheSafeParams, getLastCacheSafeParams } = await import('src/agent/coordinator/forkedAgent.js')
const { buildSideQuestionFallbackParams } = await import('src/agent/queryContext.js')
type Session = ReturnType<typeof openSession>
type Setup = Parameters<typeof openSession>[0]

// --- process-wide state -----------------------------------------------------------

const sandbox = useRestoreSandbox()
useBuildMacro()

let env: EnvSnapshot
let home: string
let flags: Record<string, unknown> | null
let savedParams: ReturnType<typeof getLastCacheSafeParams>
const running: Array<{ session: Session; loop: Promise<void> }> = []

beforeAll(() => {
  flags = getFlagSettingsInline()
  savedParams = getLastCacheSafeParams()
})

beforeEach(() => {
  env = envSnapshot(['HOME', 'CLAUDIN_EFFORT_LEVEL', 'CLAUDIN_ALWAYS_ENABLE_EFFORT', 'CLAUDE_CODE_OAUTH_TOKEN', 'ENABLE_CLAUDEAI_MCP_SERVERS'])
  home = mkdtempSync(join(tmpdir(), 'settings-handlers-home-'))
  process.env.HOME = home
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = '0'
  // The side question's agent describes the account; under test that needs a credential.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-for-tests-only'
  delete process.env.CLAUDIN_EFFORT_LEVEL
  delete process.env.CLAUDIN_ALWAYS_ENABLE_EFFORT
  modelCalls = []
  setFlagSettingsInline(null)
  setMainLoopModelOverride(undefined)
  saveCacheSafeParams(null)
})

afterEach(async () => {
  for (const { session, loop } of running.splice(0)) {
    session.end()
    await loop
  }
  modelCalls = null
  setSessionMetadataChangedListener(() => {})
  setFlagSettingsInline(flags)
  setMainLoopModelOverride(undefined)
  saveCacheSafeParams(savedParams)
  env.restore()
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realProvider)
})

function start(setup: Setup = {}) {
  const session = openSession(setup)
  running.push({ session, loop: runControlLoop(session.ctx) })
  return session
}

async function ask(session: Session, request: { subtype: string } & Record<string, unknown>) {
  const line = controlRequest(request)
  session.send(line)
  return session.answer(line.request_id)
}

// --- seed_read_state ----------------------------------------------------------------

describe('seed_read_state', () => {
  const OBSERVED = 1_700_000_000_000

  const contents: Array<[string, string, string]> = [
    ['plain text as it is', 'one\ntwo\n', 'one\ntwo\n'],
    ['a byte-order mark dropped', '\uFEFFheader\n', 'header\n'],
    ['Windows line endings made Unix ones', 'a\r\nb\r\n', 'a\nb\n'],
  ]
  test.each(contents)('seeds a file the client saw, with %s', async (_name, onDisk, seeded) => {
    const file = join(sandbox.projectDir, 'seen.txt')
    writeFileSync(file, onDisk)
    utimesSync(file, OBSERVED / 1000, OBSERVED / 1000)
    const session = start()

    const answer = await ask(session, { subtype: 'seed_read_state', path: file, mtime: OBSERVED })

    expect(answer.subtype).toBe('success')
    expect(session.ctx.pendingSeeds.get(file)).toEqual({ content: seeded, timestamp: OBSERVED, offset: undefined, limit: undefined })
    expect(session.ctx.readFileState.get(file)).toBeUndefined()
  })

  test('a relative path is resolved against the working directory', async () => {
    writeFileSync(join(sandbox.projectDir, 'rel.txt'), 'x')
    utimesSync(join(sandbox.projectDir, 'rel.txt'), OBSERVED / 1000, OBSERVED / 1000)
    const session = start()
    await ask(session, { subtype: 'seed_read_state', path: 'rel.txt', mtime: OBSERVED })
    expect(session.ctx.pendingSeeds.get(join(sandbox.projectDir, 'rel.txt'))?.content).toBe('x')
  })

  test('a file changed since the client saw it is not seeded', async () => {
    const file = join(sandbox.projectDir, 'changed.txt')
    writeFileSync(file, 'newer')
    utimesSync(file, (OBSERVED + 5000) / 1000, (OBSERVED + 5000) / 1000)
    const session = start()
    const answer = await ask(session, { subtype: 'seed_read_state', path: file, mtime: OBSERVED })
    expect(answer.subtype).toBe('success')
    expect(session.ctx.pendingSeeds.get(file)).toBeUndefined()
  })
})

// --- apply_flag_settings / get_settings ---------------------------------------------------

describe('apply_flag_settings', () => {
  test('merges into the inline flag settings, and null removes a key', async () => {
    setFlagSettingsInline({ cleanupPeriodDays: 3, includeCoAuthoredBy: true })
    const session = start()
    const answer = await ask(session, {
      subtype: 'apply_flag_settings',
      settings: { includeCoAuthoredBy: null, outputStyle: 'Explanatory' },
    })
    expect(answer.subtype).toBe('success')
    expect(getFlagSettingsInline()).toEqual({ cleanupPeriodDays: 3, outputStyle: 'Explanatory' })
  })

  test('a new model takes effect, is announced, and leaves a breadcrumb', async () => {
    const metadata: unknown[] = []
    setSessionMetadataChangedListener(change => void metadata.push(change))
    const crumbs: Array<[string, string]> = []
    const session = start({ wiring: { injectModelSwitchBreadcrumbs: (arg, model) => void crumbs.push([arg, model]) } })

    await ask(session, { subtype: 'apply_flag_settings', settings: { model: 'claude-haiku-4-5' } })

    const model = getMainLoopModelOverride() ?? undefined
    expect(model).toBe('claude-haiku-4-5')
    expect(session.ctx.activeUserSpecifiedModel).toBe(model)
    expect(metadata).toContainEqual({ model })
    expect(crumbs).toEqual([['claude-haiku-4-5', model!]])
  })

  test('a null model clears the override and is announced as the default', async () => {
    setMainLoopModelOverride('claude-haiku-4-5')
    const crumbs: Array<[string, string]> = []
    const session = start({ wiring: { injectModelSwitchBreadcrumbs: (arg, model) => void crumbs.push([arg, model]) } })

    await ask(session, { subtype: 'apply_flag_settings', settings: { model: null } })

    expect(getMainLoopModelOverride()).toBeUndefined()
    expect(crumbs.map(([arg]) => arg)).toEqual(['default'])
    expect(session.ctx.activeUserSpecifiedModel).toBe(crumbs[0]![1])
  })

  test('settings that leave the model alone leave no breadcrumb', async () => {
    const session = start({ options: { userSpecifiedModel: 'kept' } })
    await ask(session, { subtype: 'apply_flag_settings', settings: { cleanupPeriodDays: 9 } })
    expect(session.calls.injectModelSwitchBreadcrumbs).toBe(0)
    expect(session.ctx.activeUserSpecifiedModel).toBe('kept')
  })
})

describe('get_settings', () => {
  test('reports the settings by source, the flag settings included', async () => {
    const session = start()
    await ask(session, { subtype: 'apply_flag_settings', settings: { cleanupPeriodDays: 11 } })
    const answer = await ask(session, { subtype: 'get_settings' })
    const response = answer.response as { effective: Record<string, unknown>; sources: Array<{ source: string; settings: unknown }> }
    expect(response.effective.cleanupPeriodDays).toBe(11)
    expect(response.sources).toContainEqual({ source: 'flagSettings', settings: { cleanupPeriodDays: 11 } })
  })

  const applied: Array<[string, string, unknown, string | null]> = [
    ['a model with effort reports the effort in use', 'claude-opus-4-7', 'low', 'low'],
    ['a numeric effort is reported as null', 'claude-opus-4-7', 42, null],
    ['a model without effort reports none', 'claude-3-5-haiku-20241022', 'high', null],
  ]
  test.each(applied)('%s', async (_name, model, effortValue, effort) => {
    setMainLoopModelOverride(model)
    const session = start({ appState: { effortValue } as never })
    const answer = await ask(session, { subtype: 'get_settings' })
    expect((answer.response as { applied: unknown }).applied).toEqual({ model, effort })
  })
})

// --- reload_plugins -------------------------------------------------------------------

describe('reload_plugins', () => {
  const agent = (agentType: string, source: string, model?: string) =>
    ({ agentType, whenToUse: `for ${agentType}`, source, model, getSystemPrompt: () => '' }) as unknown as AgentDefinition

  test('answers with the reloaded commands, agents, plugins and servers', async () => {
    const session = start({ agents: [agent('from-sdk', 'flagSettings', 'inherit'), agent('dropped', 'projectSettings')] })
    session.ctx.sdkClients = [{ type: 'pending', name: 'pinned-sdk', config: { type: 'sdk', name: 'pinned-sdk', scope: 'dynamic' } }] as never
    const answer = await ask(session, { subtype: 'reload_plugins' })

    expect(answer.subtype).toBe('success')
    const response = answer.response as {
      commands: Array<{ name: string; description: string; argumentHint: string }>
      agents: Array<{ name: string; description: string; model?: string }>
      plugins: unknown[]
      mcpServers: unknown[]
      error_count: number
    }
    expect(response.agents.at(-1)).toEqual({ name: 'from-sdk', description: 'for from-sdk', model: undefined })
    expect(response.agents.map(a => a.name)).not.toContain('dropped')
    expect(response.commands.length).toBeGreaterThan(0)
    expect(response.commands.every(c => typeof c.argumentHint === 'string')).toBe(true)
    expect(response).toMatchObject({ plugins: [], error_count: 0 })
    // In a full run, MCP config another file left in the process reaches app
    // state through the plugin refresh, so assert on a server this session owns
    // rather than on an empty list.
    expect((response.mcpServers as Array<{ name: string }>).map(s => s.name)).toContain('pinned-sdk')
    expect(session.ctx.currentCommands.length).toBe(response.commands.length + session.ctx.currentCommands.filter(c => c.userInvocable === false).length)
    expect(session.calls.applyPluginMcpDiff).toBe(1)
  })

  test('lists the plugins enabled for the session', async () => {
    const before = getInlinePlugins()
    const plugin = join(sandbox.root, 'plugins', 'tidy')
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tidy', version: '1.0.0' }))
    setInlinePlugins([plugin])
    // src/platform/lsp/config.test.ts pins an empty loadAllPluginsCacheOnly for
    // the rest of the run on purpose (REPL baselines must not discover plugins).
    // Swap a fresh, real copy in for this test and put back whatever was live.
    const live = { ...(await import('src/plugins/pluginLoader.js')) }
    const { loadAllPluginsCacheOnly } = await import(`src/plugins/pluginLoader.js?reload-plugins=${Date.now()}`)
    mock.module('src/plugins/pluginLoader.js', () => ({ ...live, loadAllPluginsCacheOnly }))
    try {
      const answer = await ask(start(), { subtype: 'reload_plugins' })
      const plugins = (answer.response as { plugins: Array<{ name: string; path: string; source: string }> }).plugins
      expect(plugins.map(p => [p.name, p.path])).toEqual([['tidy', plugin]])
      expect(plugins[0]!.source).toContain('tidy')
    } finally {
      mock.module('src/plugins/pluginLoader.js', () => live)
      setInlinePlugins(before)
      clearAllCaches()
    }
  })

  test('a failing MCP re-diff does not fail the reload', async () => {
    const session = start({
      wiring: {
        applyPluginMcpDiff: async () => {
          throw new Error('mcp config unreadable')
        },
      },
    })
    expect((await ask(session, { subtype: 'reload_plugins' })).subtype).toBe('success')
  })

  test('a reload that cannot write the app state is answered with the error', async () => {
    const session = start()
    ;(session.ctx as { setAppState: unknown }).setAppState = () => {
      throw new Error('state is frozen')
    }
    expect(await ask(session, { subtype: 'reload_plugins' })).toMatchObject({ subtype: 'error', error: 'state is frozen' })
  })
})

// --- generate_session_title ---------------------------------------------------------------

describe('generate_session_title', () => {
  const transcript = () => getTranscriptPathForSession(getSessionId())

  test('answers with the title and does not keep it unless asked', async () => {
    const answer = await ask(start(), { subtype: 'generate_session_title', description: 'fix the flaky parser test' })
    expect(answer).toMatchObject({ subtype: 'success', response: { title: 'Fix the flaky parser test' } })
    expect(modelCalls!.map(c => [c.kind, c.prompt])).toEqual([['title', 'fix the flaky parser test']])
    expect(existsSync(transcript())).toBe(false)
  })

  test('with persist, records the title in the session transcript', async () => {
    await ask(start(), { subtype: 'generate_session_title', description: 'rename things', persist: true })
    const entries = readFileSync(transcript(), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(entries).toEqual([{ type: 'ai-title', aiTitle: 'Fix the flaky parser test', sessionId: getSessionId() }])
  })

  test('a title that cannot be recorded is still answered', async () => {
    mkdirSync(transcript(), { recursive: true })
    const answer = await ask(start(), { subtype: 'generate_session_title', description: 'anything', persist: true })
    expect(answer).toMatchObject({ subtype: 'success', response: { title: 'Fix the flaky parser test' } })
  })

  test('a reply with no title is answered with null and recorded nowhere', async () => {
    titleReply = 'not json at all'
    try {
      const answer = await ask(start(), { subtype: 'generate_session_title', description: 'anything', persist: true })
      expect(answer.response).toEqual({ title: null })
      expect(existsSync(transcript())).toBe(false)
    } finally {
      titleReply = '{"title":"Fix the flaky parser test"}'
    }
  })

  const signals: Array<[string, 'live' | 'aborted' | 'none', boolean]> = [
    ['shares the live turn signal', 'live', true],
    ['gets its own signal when the turn was aborted', 'aborted', false],
    ['gets its own signal between turns', 'none', false],
  ]
  test.each(signals)('%s', async (_name, turn, shared) => {
    const session = start()
    const controller = new AbortController()
    if (turn === 'aborted') controller.abort()
    if (turn !== 'none') session.ctx.abortController = controller
    await ask(session, { subtype: 'generate_session_title', description: 'anything' })
    const [call] = modelCalls!
    expect(call!.signal === controller.signal).toBe(shared)
    expect(call!.signal!.aborted).toBe(false)
  })
})

// --- side_question ----------------------------------------------------------------------

describe('side_question', () => {
  test('with no earlier turn, rebuilds the context and answers from the model', async () => {
    const session = start()
    const answer = await ask(session, { subtype: 'side_question', question: 'why was it slow?' })
    expect(answer).toMatchObject({ subtype: 'success', response: { response: 'Because the cache was cold.' } })
    const [call] = modelCalls!
    expect(call!.kind).toBe('side')
    expect(JSON.stringify(call!.prompt)).toContain('why was it slow?')
    expect(session.calls.buildAllTools).toBe(1)
  })

  test('after a turn, reuses that turn’s context with a fresh abort controller', async () => {
    const session = start()
    const { ctx } = session
    const lastTurn = await buildSideQuestionFallbackParams({
      tools: [],
      commands: [],
      mcpClients: [],
      messages: [],
      readFileState: ctx.readFileState,
      getAppState: ctx.getAppState,
      setAppState: ctx.setAppState,
      customSystemPrompt: 'the last turn',
      appendSystemPrompt: undefined,
      thinkingConfig: undefined,
      agents: [],
    })
    const spent = new AbortController()
    spent.abort()
    saveCacheSafeParams({ ...lastTurn, toolUseContext: { ...lastTurn.toolUseContext, abortController: spent } })
    const built = session.calls.buildAllTools

    const answer = await ask(session, { subtype: 'side_question', question: 'second?' })

    expect(answer).toMatchObject({ subtype: 'success', response: { response: 'Because the cache was cold.' } })
    expect(session.calls.buildAllTools).toBe(built)
    const sent = modelCalls!.filter(c => c.kind === 'side')
    expect(sent.map(c => c.signal!.aborted)).toEqual([false])
  })
})
