/**
 * Characterization of the signals a running session gives off, pinned before
 * the clean-base rewrite of `sessions/lifecycle`:
 *
 * - sessionState.ts: idle / running / requires_action, mirrored to one state
 *   listener, to the external-metadata listener (the pending action and the
 *   mid-turn summary), and optionally to the SDK event stream;
 * - sessionActivity.ts: the reference-counted keep-alive heartbeat, observed
 *   through the diagnostics log it writes and the callback it fires, with
 *   Bun's fake timers standing in for the 30-second clock;
 * - sessionTitle.ts: the conversation text handed to the title model, and the
 *   title call itself. The model is the boundary: `queryHaiku` is replaced for
 *   this file, and the tests pin what reaches it and how its reply is used.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import { drainSdkEvents } from 'src/agent/sdkEventQueue.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
  setIsInteractive,
} from 'src/platform/bootstrap/state.js'
import {
  envSnapshot,
  runInFreshProcess,
  type EnvSnapshot,
} from 'src/sessions/__testutils__/lifecycleHarness.js'
import {
  isSessionActivityTrackingActive,
  registerSessionActivityCallback,
  sendSessionActivitySignal,
  type SessionActivityReason,
  startSessionActivity,
  stopSessionActivity,
  unregisterSessionActivityCallback,
} from 'src/sessions/sessionActivity.js'
import {
  getSessionState,
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  notifySessionStateChanged,
  type RequiresActionDetails,
  type SessionExternalMetadata,
  type SessionState,
  setPermissionModeChangedListener,
  setSessionMetadataChangedListener,
  setSessionStateChangedListener,
} from 'src/sessions/sessionState.js'
import type { Message } from 'src/shared/types/message.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const HEARTBEAT_MS = 30_000

// --- the model boundary --------------------------------------------------

type TitleRequest = {
  systemPrompt: readonly string[]
  userPrompt: string
  outputFormat?: unknown
  signal: AbortSignal
  options: Record<string, unknown>
}
const titleRequests: TitleRequest[] = []
let answerTitleRequest: (request: TitleRequest) => Promise<unknown> = async () =>
  createAssistantMessage({ content: '{"title":"Unset reply"}' })

const realProviderShim = { ...(await import('src/providers/shims/claude.js')) }
mock.module('src/providers/shims/claude.js', () => ({
  ...realProviderShim,
  queryHaiku: async (request: TitleRequest) => {
    titleRequests.push(request)
    return answerTitleRequest(request)
  },
}))
const { extractConversationText, generateSessionTitle } = await import(
  'src/sessions/sessionTitle.js'
)

// --- process-wide state this file touches ---------------------------------

let env: EnvSnapshot
let wasInteractive: boolean
let sandbox: string

beforeAll(() => {
  env = envSnapshot([
    'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
    'CLAUDE_CODE_REMOTE_SEND_KEEPALIVES',
    'CLAUDIN_DIAGNOSTICS_FILE',
  ])
  wasInteractive = !getIsNonInteractiveSession()
})

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-signals-')))
  delete process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS
  delete process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES
  delete process.env.CLAUDIN_DIAGNOSTICS_FILE
})

afterEach(() => {
  env.restore()
  setIsInteractive(wasInteractive)
  rmSync(sandbox, { recursive: true, force: true })
})

afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realProviderShim)
  env.restore()
  setIsInteractive(wasInteractive)
})

// --- sessionState ---------------------------------------------------------

/** A transition: a bare state, or a state with what it is blocked on. */
type Step = SessionState | [SessionState, RequiresActionDetails]

/** Put the session through each step, in order. */
function drive(...steps: Step[]): void {
  for (const step of steps) {
    const [state, details] = typeof step === 'string' ? [step, undefined] : step
    notifySessionStateChanged(state, details)
  }
}

function detachListeners(): void {
  setSessionStateChangedListener(null)
  setSessionMetadataChangedListener(null)
  setPermissionModeChangedListener(null)
}

describe('session state', () => {
  const heard: Array<[SessionState, RequiresActionDetails?]> = []
  const published: SessionExternalMetadata[] = []

  const blockedOnEdit: RequiresActionDetails = {
    tool_name: 'Edit',
    action_description: 'Editing src/app.ts',
    tool_use_id: 'toolu_1',
    request_id: 'req_1',
    input: { file_path: 'src/app.ts' },
  }
  const blockedOnBash: RequiresActionDetails = {
    tool_name: 'Bash',
    action_description: 'Running npm test',
    tool_use_id: 'toolu_2',
    request_id: 'req_2',
  }

  beforeEach(() => {
    // Whatever an earlier test left: no listeners, and nothing pending.
    detachListeners()
    drive('idle')
    drainSdkEvents()
    heard.length = 0
    published.length = 0
    setSessionStateChangedListener((...transition) => void heard.push(transition))
    setSessionMetadataChangedListener(update => void published.push(update))
  })

  afterAll(() => {
    detachListeners()
    drive('idle')
    drainSdkEvents()
  })

  test('getSessionState reports the last transition', () => {
    const seen = (['running', ['requires_action', blockedOnEdit], 'idle'] as Step[]).map(
      step => {
        drive(step)
        return getSessionState()
      },
    )

    expect(seen).toEqual(['running', 'requires_action', 'idle'])
  })

  test('the state listener gets every transition with its details', () => {
    drive('running', ['requires_action', blockedOnEdit], 'running')

    expect(heard).toEqual([
      ['running', undefined],
      ['requires_action', blockedOnEdit],
      ['running', undefined],
    ])
  })

  test('a blocked session publishes its pending action, and the next transition withdraws it once', () => {
    drive('running', ['requires_action', blockedOnEdit], 'running', 'running')

    expect(published).toEqual([
      { pending_action: blockedOnEdit },
      { pending_action: null },
    ])
  })

  test('a second blocking request replaces the pending action without withdrawing it first', () => {
    drive(['requires_action', blockedOnEdit], ['requires_action', blockedOnBash])

    expect(published).toEqual([
      { pending_action: blockedOnEdit },
      { pending_action: blockedOnBash },
    ])
  })

  test('requires_action without details publishes nothing, but still withdraws an earlier pending action', () => {
    drive('requires_action')
    expect(published).toEqual([])

    drive(['requires_action', blockedOnEdit], 'requires_action')

    expect(published).toEqual([
      { pending_action: blockedOnEdit },
      { pending_action: null },
    ])
  })

  test('every idle transition clears the mid-turn summary, after withdrawing a pending action', () => {
    drive(['requires_action', blockedOnEdit], 'idle', 'idle', 'running')

    expect(published).toEqual([
      { pending_action: blockedOnEdit },
      { pending_action: null },
      { task_summary: null },
      { task_summary: null },
    ])
  })

  test('a replaced listener hears nothing more, and null detaches it', () => {
    const second: SessionState[] = []
    setSessionStateChangedListener(state => void second.push(state))
    drive('running')
    setSessionStateChangedListener(null)
    drive('idle')

    expect(heard).toEqual([])
    expect(second).toEqual(['running'])
    expect(getSessionState()).toBe('idle')
  })

  test('with no listener at all a transition is still recorded', () => {
    detachListeners()

    drive(['requires_action', blockedOnEdit])

    expect(getSessionState()).toBe('requires_action')
  })

  test('notifySessionMetadataChanged hands the update to the metadata listener as it is', () => {
    const update: SessionExternalMetadata = {
      permission_mode: 'plan',
      model: 'some-model',
      task_summary: 'Reading the parser',
    }

    notifySessionMetadataChanged(update)

    expect(published).toHaveLength(1)
    expect(published[0]).toBe(update)
  })

  test('permission-mode changes reach the one registered listener', () => {
    const modes: string[] = []
    setPermissionModeChangedListener(mode => void modes.push(mode))
    for (const mode of ['plan', 'acceptEdits'] as const) notifyPermissionModeChanged(mode)
    setPermissionModeChangedListener(null)
    notifyPermissionModeChanged('default')

    expect(modes).toEqual(['plan', 'acceptEdits'])
  })

  describe('SDK event stream', () => {
    const stripIds = (events: ReturnType<typeof drainSdkEvents>) =>
      events.map(({ uuid: _uuid, session_id: _sessionId, ...event }) => event)

    test('with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS set, each transition is queued as session_state_changed', () => {
      process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = 'true'

      drive('running', ['requires_action', blockedOnEdit], 'idle')

      const events = drainSdkEvents()
      const expected = (['running', 'requires_action', 'idle'] as const).map(state => ({
        type: 'system' as const,
        subtype: 'session_state_changed' as const,
        state,
      }))
      expect(stripIds(events)).toEqual(expected)
      expect(events.every(event => event.session_id === getSessionId())).toBe(true)
    })

    test('without it, nothing is queued', () => {
      drive('running', 'idle')

      expect(drainSdkEvents()).toEqual([])
    })

    test('the variable is read at every transition', () => {
      process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1'
      drive('running')
      delete process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS
      drive('idle')

      const states = stripIds(drainSdkEvents()).map(event =>
        event.subtype === 'session_state_changed' ? event.state : event.subtype,
      )
      expect(states).toEqual(['running'])
    })
  })
})

// --- sessionActivity ------------------------------------------------------

type DiagnosticEntry = {
  level: string
  event: string
  data: Record<string, unknown>
}

const REASONS: readonly SessionActivityReason[] = ['api_call', 'tool_exec']

/** Start one piece of work per reason given (a reason may repeat). */
function begin(...reasons: SessionActivityReason[]): void {
  reasons.forEach(reason => startSessionActivity(reason))
}

/** Finish one piece of work per reason given. */
function end(...reasons: SessionActivityReason[]): void {
  reasons.forEach(reason => stopSessionActivity(reason))
}

describe('session activity', () => {
  let diagnostics: string
  let keepAlives: number

  const logged = (event: string): DiagnosticEntry[] => {
    let text = ''
    try {
      text = readFileSync(diagnostics, 'utf8')
    } catch {
      return []
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as DiagnosticEntry)
      .filter(entry => entry.event === event)
  }
  const heartbeats = () => logged('session_keepalive_heartbeat')
  const idleNotes = () => logged('session_idle_30s')
  const countKeepAlive = () => {
    keepAlives++
  }
  const switchKeepAlivesOn = () => {
    process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES = '1'
  }

  beforeEach(() => {
    diagnostics = join(sandbox, 'diagnostics.jsonl')
    process.env.CLAUDIN_DIAGNOSTICS_FILE = diagnostics
    keepAlives = 0
    jest.useFakeTimers()
  })

  afterEach(() => {
    // Back to "nothing in flight, nothing registered": stops never go below 0.
    unregisterSessionActivityCallback()
    end(...REASONS.flatMap(reason => Array<SessionActivityReason>(8).fill(reason)))
    jest.useRealTimers()
  })

  test('tracking is active exactly while a keep-alive callback is registered', () => {
    const before = isSessionActivityTrackingActive()
    registerSessionActivityCallback(countKeepAlive)
    const during = isSessionActivityTrackingActive()
    unregisterSessionActivityCallback()

    expect([before, during, isSessionActivityTrackingActive()]).toEqual([false, true, false])
  })

  test('an explicit signal fires the callback only when keep-alives are switched on', () => {
    registerSessionActivityCallback(countKeepAlive)

    sendSessionActivitySignal()
    expect(keepAlives).toBe(0)

    switchKeepAlivesOn()
    for (const _ of [1, 2]) sendSessionActivitySignal()
    expect(keepAlives).toBe(2)
  })

  test('with no callback registered an explicit signal does nothing', () => {
    switchKeepAlivesOn()

    expect(() => sendSessionActivitySignal()).not.toThrow()
    expect(keepAlives).toBe(0)
  })

  test('while work is in flight a heartbeat fires every 30 seconds, and stops with the work', () => {
    process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES = 'true'
    registerSessionActivityCallback(countKeepAlive)
    begin('api_call')

    jest.advanceTimersByTime(HEARTBEAT_MS - 1)
    expect(keepAlives).toBe(0)
    jest.advanceTimersByTime(1)
    expect(keepAlives).toBe(1)
    jest.advanceTimersByTime(2 * HEARTBEAT_MS)
    expect(keepAlives).toBe(3)
    expect(heartbeats().map(entry => entry.data)).toEqual(Array(3).fill({ refcount: 1 }))
    expect(heartbeats()[0]?.level).toBe('debug')

    end('api_call')
    jest.advanceTimersByTime(3 * HEARTBEAT_MS)
    expect([keepAlives, heartbeats().length]).toEqual([3, 3])
  })

  test('without the keep-alive switch the heartbeat is only logged', () => {
    registerSessionActivityCallback(countKeepAlive)
    begin('tool_exec')

    jest.advanceTimersByTime(2 * HEARTBEAT_MS)

    expect([keepAlives, heartbeats().length]).toEqual([0, 2])
  })

  test('the switch is read at each beat', () => {
    registerSessionActivityCallback(countKeepAlive)
    begin('api_call')

    jest.advanceTimersByTime(HEARTBEAT_MS)
    switchKeepAlivesOn()
    jest.advanceTimersByTime(HEARTBEAT_MS)

    expect(keepAlives).toBe(1)
  })

  test('the work is counted across reasons: the beat runs until the last one stops', () => {
    switchKeepAlivesOn()
    registerSessionActivityCallback(countKeepAlive)
    begin('api_call', 'tool_exec', 'tool_exec')

    jest.advanceTimersByTime(HEARTBEAT_MS)
    expect(heartbeats().at(-1)?.data).toEqual({ refcount: 3 })

    end('api_call', 'tool_exec')
    jest.advanceTimersByTime(HEARTBEAT_MS)
    expect(heartbeats().at(-1)?.data).toEqual({ refcount: 1 })
    expect(keepAlives).toBe(2)

    end('tool_exec')
    jest.advanceTimersByTime(3 * HEARTBEAT_MS)
    expect(keepAlives).toBe(2)
  })

  test('stopping more often than starting never drives the count below zero', () => {
    registerSessionActivityCallback(countKeepAlive)
    end(...REASONS)

    begin('api_call')
    jest.advanceTimersByTime(HEARTBEAT_MS)

    expect(heartbeats().map(entry => entry.data)).toEqual([{ refcount: 1 }])
  })

  test('30 seconds after the last work ends an idle note is logged, once', () => {
    registerSessionActivityCallback(countKeepAlive)
    begin('api_call')
    end('api_call')

    jest.advanceTimersByTime(HEARTBEAT_MS - 1)
    expect(idleNotes()).toHaveLength(0)
    jest.advanceTimersByTime(1)
    expect(idleNotes()).toEqual([expect.objectContaining({ level: 'info', data: {} })])
    jest.advanceTimersByTime(3 * HEARTBEAT_MS)
    expect(idleNotes()).toHaveLength(1)
  })

  test('new work within the idle window cancels the idle note', () => {
    registerSessionActivityCallback(countKeepAlive)
    begin('api_call')
    end('api_call')
    jest.advanceTimersByTime(HEARTBEAT_MS / 2)

    begin('tool_exec')
    jest.advanceTimersByTime(HEARTBEAT_MS)

    expect([idleNotes().length, heartbeats().length]).toEqual([0, 1])
  })

  test('with no callback registered there is neither heartbeat nor idle note', () => {
    begin('api_call')
    jest.advanceTimersByTime(2 * HEARTBEAT_MS)
    end('api_call')
    jest.advanceTimersByTime(2 * HEARTBEAT_MS)

    expect([heartbeats().length, idleNotes().length]).toEqual([0, 0])
  })

  test('registering the callback while work is in flight starts the heartbeat from then', () => {
    switchKeepAlivesOn()
    begin('api_call')
    jest.advanceTimersByTime(2 * HEARTBEAT_MS)
    expect(heartbeats()).toHaveLength(0)

    registerSessionActivityCallback(countKeepAlive)
    jest.advanceTimersByTime(HEARTBEAT_MS)

    expect([keepAlives, heartbeats().length]).toEqual([1, 1])
  })

  test('re-registering during work keeps a single heartbeat, driving the newest callback', () => {
    switchKeepAlivesOn()
    const earlier = { calls: 0 }
    registerSessionActivityCallback(() => void earlier.calls++)
    begin('api_call')
    registerSessionActivityCallback(countKeepAlive)

    jest.advanceTimersByTime(2 * HEARTBEAT_MS)

    expect([earlier.calls, keepAlives, heartbeats().length]).toEqual([0, 2, 2])
  })

  test('unregistering stops the heartbeat and any pending idle note', () => {
    registerSessionActivityCallback(countKeepAlive)
    begin('api_call')
    unregisterSessionActivityCallback()
    jest.advanceTimersByTime(2 * HEARTBEAT_MS)
    expect(heartbeats()).toHaveLength(0)

    registerSessionActivityCallback(countKeepAlive)
    end('api_call')
    unregisterSessionActivityCallback()
    jest.advanceTimersByTime(2 * HEARTBEAT_MS)
    expect(idleNotes()).toHaveLength(0)
  })

  test('at shutdown the work still in flight is logged, once per process', async () => {
    const result = await runInFreshProcess(
      `
      const { readFileSync } = await import('fs')
      const activity = await load('src/sessions/sessionActivity.ts')
      const cleanup = await load('src/shared/cleanupRegistry.ts')
      const read = () => readFileSync(process.env.CLAUDIN_DIAGNOSTICS_FILE, 'utf8')
        .split('\\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(entry => entry.event === 'session_activity_at_shutdown')
      for (const reason of ['api_call', 'api_call', 'tool_exec']) activity.startSessionActivity(reason)
      activity.stopSessionActivity('api_call')
      await Bun.sleep(20)
      await cleanup.runCleanupFunctions()
      const busy = read()
      for (const reason of ['api_call', 'tool_exec']) activity.stopSessionActivity(reason)
      await cleanup.runCleanupFunctions()
      const quiet = read().slice(1)
      return { busy, quiet }
      `,
      { CLAUDIN_DIAGNOSTICS_FILE: join(sandbox, 'shutdown.jsonl') },
      sandbox,
    )

    const busy = result.busy as DiagnosticEntry[]
    const quiet = result.quiet as DiagnosticEntry[]
    expect(busy).toHaveLength(1)
    expect(busy[0]?.level).toBe('info')
    expect(busy[0]?.data).toEqual({
      refcount: 2,
      active: { api_call: 1, tool_exec: 1 },
      oldest_activity_ms: expect.any(Number),
    })
    expect(busy[0]?.data.oldest_activity_ms as number).toBeGreaterThanOrEqual(20)
    expect(quiet).toEqual([
      expect.objectContaining({
        data: { refcount: 0, active: {}, oldest_activity_ms: null },
      }),
    ])
  })
})

// --- sessionTitle ---------------------------------------------------------

describe('extractConversationText — the text a title is made from', () => {
  test('joins the text of user and assistant messages with newlines, in order', () => {
    const messages: Message[] = [
      createUserMessage({ content: 'Why does the login button fail?' }),
      createAssistantMessage({ content: 'Let me look at the handler.' }),
      createUserMessage({
        content: ['It only happens on mobile.', 'Safari, mostly.'].map(text => ({
          type: 'text' as const,
          text,
        })),
      }),
    ]

    expect(extractConversationText(messages).split('\n')).toEqual([
      'Why does the login button fail?',
      'Let me look at the handler.',
      'It only happens on mobile.',
      'Safari, mostly.',
    ])
  })

  test('leaves out meta messages and anything a human did not type', () => {
    const messages: Message[] = [
      createUserMessage({ content: 'typed', origin: { kind: 'human' } }),
      createUserMessage({ content: 'meta', isMeta: true }),
      createUserMessage({ content: 'notified', origin: { kind: 'task-notification' } }),
      createUserMessage({ content: 'from agent', origin: { kind: 'agent', name: 'a' } }),
      createUserMessage({ content: 'no origin' }),
    ]

    expect(extractConversationText(messages)).toBe('typed\nno origin')
  })

  test('takes only text blocks, and only from user and assistant messages', () => {
    const messages = [
      createAssistantMessage({
        content: [
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
        ] as never,
      }),
      createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }],
      }),
      createSystemMessage('a system note', 'info'),
    ] as Message[]

    expect(extractConversationText(messages)).toBe('Reading it now.')
  })

  test('keeps the last 1000 characters of a long conversation', () => {
    const tail = 't'.repeat(1_000)

    expect(extractConversationText([createUserMessage({ content: `head${tail}` })])).toBe(tail)
    expect(extractConversationText([createUserMessage({ content: tail })])).toBe(tail)
  })

  test('an empty conversation gives an empty string', () => {
    expect(extractConversationText([])).toBe('')
  })
})

describe('generateSessionTitle — the call to the title model', () => {
  const titleReply = (...texts: string[]) => async () =>
    createAssistantMessage({
      content: texts.map(text => ({ type: 'text', text })) as never,
    })
  const ask = (description: string, signal = new AbortController().signal) =>
    generateSessionTitle(description, signal)

  beforeEach(() => {
    titleRequests.length = 0
    answerTitleRequest = titleReply('{"title":"Fix login button on mobile"}')
  })

  test('a blank description gives null without calling the model', async () => {
    expect(await ask('  \n\t ')).toBeNull()
    expect(titleRequests).toHaveLength(0)
  })

  test('sends the trimmed description with structured-output instructions, and returns the title', async () => {
    const signal = new AbortController().signal

    const title = await ask('  the login button is broken on phones \n', signal)

    expect(title).toBe('Fix login button on mobile')
    expect(titleRequests).toHaveLength(1)
    const request = titleRequests[0]!
    expect(request.userPrompt).toBe('the login button is broken on phones')
    expect(request.signal).toBe(signal)
    expect(request.outputFormat).toEqual(
      JSON.parse(readFileSync(join(FIXTURES, 'title-output-format.json'), 'utf8')),
    )
    const sent = request.options
    expect(Object.keys(sent).sort()).toEqual([
      'agents',
      'hasAppendSystemPrompt',
      'isNonInteractiveSession',
      'mcpTools',
      'querySource',
    ])
    expect(sent.querySource).toBe('generate_session_title')
    expect([sent.agents, sent.mcpTools]).toEqual([[], []])
    expect(sent.hasAppendSystemPrompt).toBe(false)
    expect(sent.isNonInteractiveSession).toBe(getIsNonInteractiveSession())
  })

  test('the instructions ask for a short sentence-case title as JSON with a title field', async () => {
    await ask('anything')

    const { systemPrompt } = titleRequests[0]!
    expect(systemPrompt).toHaveLength(1)
    const instructions = systemPrompt[0]!
    expect(instructions).toMatch(/\b3\s*[-–]\s*7 words\b/)
    expect(instructions).toMatch(/sentence[- ]case/i)
    expect(instructions).toMatch(/JSON/)
    expect(instructions).toMatch(/"title"/)
  })

  test('tells the model whether the session is interactive', async () => {
    for (const interactive of [true, false]) {
      setIsInteractive(interactive)
      await ask('anything')
    }

    expect(titleRequests.map(request => request.options.isNonInteractiveSession)).toEqual([
      false,
      true,
    ])
  })

  test('the reply title is trimmed', async () => {
    answerTitleRequest = titleReply('{"title":"  Debug failing CI tests \\n"}')

    expect(await ask('ci')).toBe('Debug failing CI tests')
  })

  test('the reply may arrive split across text blocks, and other blocks are ignored', async () => {
    answerTitleRequest = async () =>
      createAssistantMessage({
        content: [
          { type: 'text', text: '{"title":' },
          { type: 'tool_use', id: 'toolu_x', name: 'Noise', input: {} },
          { type: 'text', text: '"Add OAuth authentication"}' },
        ] as never,
      })

    expect(await ask('oauth')).toBe('Add OAuth authentication')
  })

  test('extra fields in the reply are ignored', async () => {
    answerTitleRequest = titleReply('{"title":"Refactor API client","confidence":0.9}')

    expect(await ask('api')).toBe('Refactor API client')
  })

  test.each([
    ['not JSON', 'Fix the thing'],
    ['a blank title', '{"title":"   "}'],
    ['no title field', '{"name":"fix-the-thing"}'],
    ['a title that is not a string', '{"title":42}'],
    ['a JSON array', '["Fix the thing"]'],
  ])('a reply with %s gives null', async (_case, text) => {
    answerTitleRequest = titleReply(text)

    expect(await ask('something')).toBeNull()
  })

  test('a failed model call gives the product name as the title', async () => {
    answerTitleRequest = async () => {
      throw new Error('json_schema output is not supported by this provider')
    }

    expect(await ask('something')).toBe('Claudin')
  })

  test('an aborted call does too', async () => {
    const controller = new AbortController()
    controller.abort()
    answerTitleRequest = async request => {
      request.signal.throwIfAborted()
      return createAssistantMessage({ content: '{"title":"Never"}' })
    }

    expect(await ask('something', controller.signal)).toBe('Claudin')
  })
})

describe('the session state machine in a fresh process', () => {
  test('starts idle', async () => {
    const result = await runInFreshProcess(
      `
      const state = await load('src/sessions/sessionState.ts')
      return { initial: state.getSessionState() }
      `,
      {},
      sandbox,
    )

    expect(result).toEqual({ initial: 'idle' })
  })
})
