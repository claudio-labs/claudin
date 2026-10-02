/**
 * Characterization of the headless stdin reader (`runControlLoop`), pinned
 * before the levers cut edits it.
 *
 * The loop is driven the way `runHeadlessStreaming` drives it: a real
 * `StructuredIO` reads NDJSON lines from a stdin the test writes into, and
 * every answer is read back from the session's outbound stream. The context's
 * MCP wiring is the real `mcpRuntime`; only the turn loop (`run`) is counted
 * instead of started, because it calls the model.
 *
 * Not pinned: `remote_control` (the bridge goes with the cut), the
 * file_attachments prepend (bridge code), and the `get_context_usage` success
 * answer, which counts tokens through the provider API.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getCommandQueue, enqueue, resetCommandQueue } from 'src/agent/messageQueueManager.js'
import { setCommandLifecycleListener } from 'src/commands/commandLifecycle.js'
import {
  getMainLoopModelOverride,
  getSdkAgentProgressSummariesEnabled,
  getSessionId,
  setMainLoopModelOverride,
  setSdkAgentProgressSummariesEnabled,
} from 'src/platform/bootstrap/state.js'
import { controlRequest, openSession, type HeadlessSession, type SessionSetup } from 'src/platform/headless/print/__testutils__/streamingHarness.js'
import { runControlLoop } from 'src/platform/headless/print/controlLoop.js'
import { __resetForTests as forgetReceivedUuids } from 'src/platform/headless/print/uuidDedupe.js'
import { getDefaultMainLoopModel } from 'src/providers/model/model.js'
import { envSnapshot, eventually, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { transcriptEntries, useRestoreSandbox, writeSession } from 'src/sessions/__testutils__/restoreHarness.js'
import { setSessionMetadataChangedListener } from 'src/sessions/sessionState.js'
import { switchSession } from 'src/platform/bootstrap/state.js'
import { asSessionId } from 'src/shared/types/ids.js'

useRestoreSandbox()

let env: EnvSnapshot
let home: string
let progressSummaries: boolean
const open: Array<{ session: HeadlessSession; loop: Promise<void> }> = []

beforeAll(() => {
  progressSummaries = getSdkAgentProgressSummariesEnabled()
})

beforeEach(() => {
  env = envSnapshot(['HOME', 'CLAUDIN_DISABLE_FILE_CHECKPOINTING', 'CLAUDE_CODE_OAUTH_TOKEN'])
  home = mkdtempSync(join(tmpdir(), 'control-loop-home-'))
  process.env.HOME = home
  // initialize describes the account, which under test refuses to have no credential at all.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-for-tests-only'
  process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
  resetCommandQueue()
  forgetReceivedUuids()
})

afterEach(async () => {
  for (const { session, loop } of open.splice(0)) {
    session.end()
    await loop
  }
  setCommandLifecycleListener(null)
  setSessionMetadataChangedListener(() => {})
  resetCommandQueue()
  forgetReceivedUuids()
  env.restore()
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  setSdkAgentProgressSummariesEnabled(progressSummaries)
  setMainLoopModelOverride(undefined)
})

/** A session whose control loop is already reading stdin. */
function start(setup: SessionSetup = {}) {
  const session = openSession(setup)
  const loop = runControlLoop(session.ctx)
  open.push({ session, loop })
  return { ...session, loop }
}

/** Send one control request and wait for its answer. */
async function ask(session: HeadlessSession, request: { subtype: string } & Record<string, unknown>) {
  const line = controlRequest(request)
  session.send(line)
  return session.answer(line.request_id)
}

/** A user turn as the SDK writes it to stdin. */
const userLine = (content: string, extra: Record<string, unknown> = {}) =>
  Object.assign({ type: 'user', message: { role: 'user', content } }, { parent_tool_use_id: null, session_id: '' }, extra)

describe('control requests answered with an error', () => {
  const cases: Array<[string, { subtype: string } & Record<string, unknown>, string]> = [
    ['an unknown subtype', { subtype: 'make_coffee' }, 'Unsupported control request subtype: make_coffee'],
    ['reconnecting an unknown server', { subtype: 'mcp_reconnect', serverName: 'ghost' }, 'Server not found: ghost'],
    ['toggling an unknown server', { subtype: 'mcp_toggle', serverName: 'ghost', enabled: false }, 'Server not found: ghost'],
    ['authenticating an unknown server', { subtype: 'mcp_authenticate', serverName: 'ghost' }, 'Server not found: ghost'],
    ['clearing auth of an unknown server', { subtype: 'mcp_clear_auth', serverName: 'ghost' }, 'Server not found: ghost'],
    [
      'an OAuth callback with no flow',
      { subtype: 'claude_oauth_callback', authorizationCode: 'c', state: 's' },
      'No active claude_authenticate flow',
    ],
    [
      'waiting on an OAuth flow that never started',
      { subtype: 'claude_oauth_wait_for_completion', authorizationCode: '', state: '' },
      'No active claude_authenticate flow',
    ],
    ['stopping a task that does not exist', { subtype: 'stop_task', task_id: 'nope' }, 'No task found with ID: nope'],
    [
      'rewinding files with checkpointing off',
      { subtype: 'rewind_files', user_message_id: randomUUID() },
      'File rewinding is not enabled.',
    ],
  ]

  test.each(cases)('%s', async (_name, request, error) => {
    const session = start()
    const answer = await ask(session, request)
    expect(answer).toMatchObject({ subtype: 'error', error })
  })

  test('a callback URL for a server with no OAuth flow in progress', async () => {
    const answer = await ask(start(), { subtype: 'mcp_oauth_callback_url', serverName: 'ghost', callbackUrl: 'http://localhost/cb' })
    expect(answer.subtype).toBe('error')
    expect(answer.error).toContain('ghost')
  })

  test('a context-usage request whose tool assembly fails reports the failure', async () => {
    const session = start({
      wiring: {
        buildAllTools: () => {
          throw new Error('tool pool exploded')
        },
      },
    })
    const answer = await ask(session, { subtype: 'get_context_usage' })
    expect(answer).toMatchObject({ subtype: 'error', error: 'tool pool exploded' })
  })

  test('a side question whose fallback context cannot be built reports the failure', async () => {
    const session = start({
      wiring: {
        buildAllTools: () => {
          throw new Error('no tools for side questions')
        },
      },
    })
    const answer = await ask(session, { subtype: 'side_question', question: 'why?' })
    expect(answer).toMatchObject({ subtype: 'error', error: 'no tools for side questions' })
  })
})

describe('interrupting', () => {
  for (const subtype of ['interrupt', 'end_session']) {
    test(`${subtype} aborts the turn and drops the pending suggestion`, async () => {
      const session = start()
      const turn = new AbortController()
      const suggestion = new AbortController()
      session.ctx.abortController = turn
      Object.assign(session.ctx.suggestionState, {
        abortController: suggestion,
        lastEmitted: { text: 'try this', emittedAt: 1, promptId: 'user_intent', generationRequestId: null },
        pendingSuggestion: { type: 'prompt_suggestion', suggestion: 'x', uuid: randomUUID(), session_id: 's' },
      })

      const answer = await ask(session, { subtype })

      expect(answer.subtype).toBe('success')
      expect([turn.signal.aborted, suggestion.signal.aborted]).toEqual([true, true])
      expect(session.ctx.suggestionState).toMatchObject({
        abortController: null,
        lastEmitted: null,
        pendingSuggestion: null,
      })
    })
  }

  test('end_session stops reading stdin and closes the session', async () => {
    let cronStopped = 0
    const session = start()
    session.ctx.cronScheduler = { start() {}, stop: () => void cronStopped++ } as never
    const late = controlRequest({ subtype: 'mcp_status' })
    session.send(controlRequest({ subtype: 'end_session', reason: 'done' }), late)
    await session.loop

    expect(session.ctx.inputClosed).toBe(true)
    expect(cronStopped).toBe(1)
    expect(session.calls.closeOutput).toBe(1)
    const answered = session.emitted.map(m => (m as { response?: { request_id?: string } }).response?.request_id)
    expect(answered).not.toContain(late.request_id)
  })
})

describe('closing stdin', () => {
  const cases: Array<[string, boolean, number]> = [
    ['an idle session closes its output', false, 1],
    ['a session mid-turn leaves closing to the turn loop', true, 0],
  ]
  test.each(cases)('%s', async (_name, running, closes) => {
    const session = start()
    session.ctx.running = running
    session.end()
    await session.loop
    expect(session.ctx.inputClosed).toBe(true)
    expect(session.calls.closeOutput).toBe(closes)
  })
})

describe('initialize', () => {
  test('answers once with the session description, and refuses a second time', async () => {
    const session = start({
      commands: [
        { type: 'prompt', name: 'review', description: 'Review a diff', argumentHint: '<pr>' },
        { type: 'prompt', name: 'secret', description: 'hidden', userInvocable: false },
      ] as never,
    })
    const first = await ask(session, { subtype: 'initialize' })
    const second = await ask(session, { subtype: 'initialize' })

    expect(first.subtype).toBe('success')
    const commands = (first.response as { commands: Array<{ name: string; argumentHint: string }> }).commands
    expect(commands.map(c => [c.name, c.argumentHint])).toEqual([['review', '<pr>']])
    expect(second).toMatchObject({ subtype: 'error', error: 'Already initialized' })
  })

  test('registers a placeholder config for every SDK server it names', async () => {
    const session = start()
    await ask(session, { subtype: 'initialize', sdkMcpServers: ['alpha', 'beta'] })
    expect(session.ctx.sdkMcpConfigs).toEqual({
      alpha: { type: 'sdk', name: 'alpha' },
      beta: { type: 'sdk', name: 'beta' },
    })
  })

  test('turns on prompt suggestions and agent progress summaries when asked', async () => {
    setSdkAgentProgressSummariesEnabled(false)
    const session = start({ appState: { promptSuggestionEnabled: false } })
    await ask(session, { subtype: 'initialize', promptSuggestions: true, agentProgressSummaries: true })
    expect(session.state().promptSuggestionEnabled).toBe(true)
    expect(getSdkAgentProgressSummariesEnabled()).toBe(true)
  })

  test('leaves both off when not asked', async () => {
    setSdkAgentProgressSummariesEnabled(false)
    const session = start({ appState: { promptSuggestionEnabled: false } })
    await ask(session, { subtype: 'initialize' })
    expect(session.state().promptSuggestionEnabled).toBe(false)
    expect(getSdkAgentProgressSummariesEnabled()).toBe(false)
  })

  test('starts a turn only when a command is already queued', async () => {
    const idle = start()
    await ask(idle, { subtype: 'initialize' })
    expect(idle.calls.run).toBe(0)

    enqueue({ mode: 'prompt', value: 'resume me', uuid: randomUUID() })
    const queued = start()
    await ask(queued, { subtype: 'initialize' })
    expect(queued.calls.run).toBe(1)
  })
})

describe('session settings', () => {
  test('set_permission_mode changes the mode in the app state', async () => {
    const session = start()
    const answer = await ask(session, { subtype: 'set_permission_mode', mode: 'acceptEdits' })
    expect(answer).toMatchObject({ subtype: 'success', response: { mode: 'acceptEdits' } })
    expect(session.state().toolPermissionContext.mode).toBe('acceptEdits')
  })

  const models: Array<[string, string | undefined, () => string]> = [
    ['a named model', 'claude-opus-4-1', () => 'claude-opus-4-1'],
    ['"default"', 'default', () => getDefaultMainLoopModel()],
    ['no model at all', undefined, () => getDefaultMainLoopModel()],
  ]
  test.each(models)('set_model with %s', async (_name, model, expected) => {
    const metadata: unknown[] = []
    setSessionMetadataChangedListener(change => void metadata.push(change))
    const crumbs: Array<[string, string]> = []
    const session = start({ wiring: { injectModelSwitchBreadcrumbs: (arg, resolved) => void crumbs.push([arg, resolved]) } })

    const answer = await ask(session, { subtype: 'set_model', ...(model === undefined ? {} : { model }) })

    const resolved = expected()
    expect(answer.subtype).toBe('success')
    expect(session.ctx.activeUserSpecifiedModel).toBe(resolved)
    expect(getMainLoopModelOverride()).toBe(resolved)
    expect(metadata).toContainEqual({ model: resolved })
    expect(crumbs).toEqual([[model ?? 'default', resolved]])
  })

  const budgets: Array<[number | null, unknown]> = [
    [null, undefined],
    [0, { type: 'disabled' }],
    [4096, { type: 'enabled', budgetTokens: 4096 }],
  ]
  test.each(budgets)('set_max_thinking_tokens %p', async (tokens, config) => {
    const session = start({ options: { thinkingConfig: { type: 'enabled', budgetTokens: 1 } } })
    const answer = await ask(session, { subtype: 'set_max_thinking_tokens', max_thinking_tokens: tokens })
    expect(answer.subtype).toBe('success')
    expect(session.ctx.options.thinkingConfig).toEqual(config as never)
  })

  test('apply_flag_settings and get_settings both answer', async () => {
    const session = start()
    expect((await ask(session, { subtype: 'apply_flag_settings', settings: {} })).subtype).toBe('success')
    const settings = await ask(session, { subtype: 'get_settings' })
    expect(settings.subtype).toBe('success')
    expect(settings.response).toHaveProperty('applied')
  })

  test('seed_read_state answers even for a file that is not there', async () => {
    const session = start()
    const answer = await ask(session, { subtype: 'seed_read_state', path: join(home, 'missing.txt'), mtime: 0 })
    expect(answer.subtype).toBe('success')
  })

  test('generate_session_title with nothing to title answers with no title', async () => {
    const answer = await ask(start(), { subtype: 'generate_session_title', description: '   ' })
    expect(answer).toMatchObject({ subtype: 'success', response: { title: null } })
  })
})

describe('MCP requests', () => {
  test('mcp_status lists the servers the runtime knows', async () => {
    const session = start()
    session.ctx.dynamicMcpState = {
      clients: [{ type: 'pending', name: 'later', config: { type: 'stdio', command: 'x', args: [], scope: 'dynamic' } }],
      tools: [],
      configs: {},
    } as never
    const answer = await ask(session, { subtype: 'mcp_status' })
    expect(answer.subtype).toBe('success')
    const servers = (answer.response as { mcpServers: Array<{ name: string; status: string }> }).mcpServers
    expect(servers.map(s => [s.name, s.status])).toEqual([['later', 'pending']])
  })

  test('mcp_message hands the payload to the connected SDK server transport', async () => {
    const delivered: unknown[] = []
    const session = start()
    session.ctx.sdkClients = [
      { type: 'connected', name: 'sdk-one', client: { transport: { onmessage: (m: unknown) => void delivered.push(m) } } },
      { type: 'pending', name: 'sdk-two' },
    ] as never
    const payload = { jsonrpc: '2.0', method: 'notifications/progress' }

    const answers = [
      await ask(session, { subtype: 'mcp_message', server_name: 'sdk-one', message: payload }),
      await ask(session, { subtype: 'mcp_message', server_name: 'sdk-two', message: payload }),
      await ask(session, { subtype: 'mcp_message', server_name: 'absent', message: payload }),
    ]
    expect(answers.map(a => a.subtype)).toEqual(['success', 'success', 'success'])
    expect(delivered).toEqual([payload])
  })

  test('mcp_set_servers answers with the diff and connects SDK servers afterwards', async () => {
    const session = start()
    const answer = await ask(session, {
      subtype: 'mcp_set_servers',
      servers: { inproc: { type: 'sdk', name: 'inproc' } },
    })
    expect(answer.subtype).toBe('success')
    expect(answer.response).toMatchObject({ added: ['inproc'], removed: [] })
    expect(session.calls.applyMcpServerChanges).toBe(1)
    expect(session.calls.updateSdkMcp).toBe(1)
  })

  test('mcp_set_servers with no change leaves the SDK servers alone', async () => {
    const session = start()
    const answer = await ask(session, { subtype: 'mcp_set_servers', servers: {} })
    expect(answer.response).toMatchObject({ added: [], removed: [] })
    expect(session.calls.updateSdkMcp).toBe(0)
  })

  test('reload_plugins answers with the reloaded lists', async () => {
    const session = start()
    const answer = await ask(session, { subtype: 'reload_plugins' })
    expect(answer.subtype).toBe('success')
    expect(Object.keys(answer.response ?? {}).sort()).toEqual(['agents', 'commands', 'error_count', 'mcpServers', 'plugins'])
  })
})

describe('the command queue', () => {
  test('cancel_async_message removes a queued command once', async () => {
    const target = randomUUID()
    enqueue({ mode: 'prompt', value: 'later', uuid: target as never })
    const session = start()
    const first = await ask(session, { subtype: 'cancel_async_message', message_uuid: target })
    const again = await ask(session, { subtype: 'cancel_async_message', message_uuid: target })
    expect([first.response, again.response]).toEqual([{ cancelled: true }, { cancelled: false }])
    expect(getCommandQueue()).toEqual([])
  })

  test('stop_task stops a running shell task', async () => {
    const session = start({
      appState: {
        tasks: {
          shell1: { id: 'shell1', type: 'local_bash', status: 'running', description: 'sleep', command: 'sleep 9' },
        } as never,
      },
    })
    const answer = await ask(session, { subtype: 'stop_task', task_id: 'shell1' })
    expect(answer).toMatchObject({ subtype: 'success', response: {} })
    expect((session.state().tasks as Record<string, { status: string }>).shell1!.status).toBe('killed')
  })
})

describe('user messages', () => {
  test('are queued as prompts and start a turn each', async () => {
    const session = start()
    const id = randomUUID()
    session.send(userLine('first', { uuid: id, priority: 'now' }), userLine('second'))
    session.end()
    await session.loop

    expect(getCommandQueue().map(c => [c.value, c.uuid, c.priority, c.mode])).toEqual([
      ['first', id, 'now', 'prompt'],
      ['second', undefined, 'next', 'prompt'],
    ])
    expect(session.calls.run).toBe(2)
  })

  test('a uuid seen earlier in this run is dropped', async () => {
    const session = start()
    const id = randomUUID()
    session.send(userLine('once', { uuid: id }), userLine('twice', { uuid: id }))
    session.end()
    await session.loop
    expect(getCommandQueue().map(c => c.value)).toEqual(['once'])
    expect(session.calls.run).toBe(1)
  })

  test('with replay on, a dropped duplicate is acknowledged as a replay', async () => {
    const session = start({ options: { replayUserMessages: true } })
    const id = randomUUID()
    session.send(userLine('once', { uuid: id }), userLine('once', { uuid: id, timestamp: 'T' }))
    session.end()
    await session.loop
    const replays = session.emitted.filter(m => m.type === 'user')
    const acknowledged = { ...userLine('once', { uuid: id, timestamp: 'T' }), session_id: getSessionId(), isReplay: true }
    expect(replays).toEqual([acknowledged as never])
  })

  test('a message already in the transcript is closed out and not run again', async () => {
    const { id: sessionId, transcript } = await writeSession()
    const recorded = transcriptEntries(transcript).find(e => e.type === 'user')!.uuid as string
    switchSession(asSessionId(sessionId))
    const lifecycle: Array<[string, string]> = []
    setCommandLifecycleListener((uuid, state) => void lifecycle.push([uuid, state]))

    const session = start()
    session.send(userLine('replayed from history', { uuid: recorded }))
    session.end()
    await session.loop

    expect(getCommandQueue()).toEqual([])
    expect(session.calls.run).toBe(0)
    expect(lifecycle).toEqual([[recorded, 'completed']])
  })
})

describe('other stdin traffic', () => {
  test('assistant history joins the conversation; system lines without content do not', async () => {
    const session = start()
    const said = randomUUID()
    session.send(
      { type: 'assistant', uuid: said, session_id: '', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] } },
      { type: 'system', subtype: 'init', uuid: randomUUID(), session_id: '' },
    )
    session.end()
    await session.loop
    expect(session.ctx.mutableMessages.map(m => [m.type, m.uuid])).toEqual([['assistant', said]])
    expect(session.emitted.filter(m => m.type === 'assistant')).toEqual([])
  })

  test('with replay on, assistant history is echoed back', async () => {
    const session = start({ options: { replayUserMessages: true } })
    const line = { type: 'assistant', uuid: randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'assistant', content: [] } }
    session.send(line)
    session.end()
    await session.loop
    expect(session.emitted.filter(m => m.type === 'assistant')).toEqual([line as never])
  })

  test('a non-user line carrying a uuid is reported completed', async () => {
    const lifecycle: Array<[string, string]> = []
    setCommandLifecycleListener((uuid, state) => void lifecycle.push([uuid, state]))
    const session = start()
    const marked = randomUUID()
    session.send({ type: 'system', subtype: 'init', uuid: marked, session_id: '' }, userLine('plain', { uuid: randomUUID() }))
    session.end()
    await session.loop
    expect(lifecycle).toEqual([[marked, 'completed']])
  })

  const replay: Array<[string, boolean, number]> = [
    ['echoed with replay on', true, 1],
    ['swallowed with replay off', false, 0],
  ]
  test.each(replay)('a control_response the host sends back is %s', async (_name, on, echoed) => {
    const session = start({ options: { replayUserMessages: on }, replayUserMessages: true })
    const pending = session.ctx.structuredIO.sendMcpMessage('sdk', { jsonrpc: '2.0', id: 1, method: 'ping' })
    const asked = (await eventually(
      () => session.emitted.find(m => m.type === 'control_request'),
      found => found !== undefined,
    )) as { request_id: string }
    session.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: asked.request_id, response: { mcp_response: { jsonrpc: '2.0', id: 1, result: {} } } },
    })
    expect(await pending).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    session.end()
    await session.loop
    expect(session.emitted.filter(m => m.type === 'control_response')).toHaveLength(echoed)
  })
})
