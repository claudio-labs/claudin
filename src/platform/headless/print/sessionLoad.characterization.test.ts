/**
 * Characterization of how `-p` loads the conversation it starts from
 * (`loadInitialMessages` in sessionLoad.ts), and of its error reporting
 * (`emitLoadError`), pinned before the levers cut edits the file.
 *
 * The transcripts are real: they are written with the session storage API into
 * a temp CLAUDIN_CONFIG_DIR and read back by the loader `-p` uses. Exiting the
 * process is the one boundary mocked: `gracefulShutdownSync` would end the test
 * runner, so while a test runs it is recorded instead. Outside a test the mock
 * hands every call to the real function.
 *
 * Not pinned, because the cut deletes them: `--teleport` and `-p --resume <url>`
 * (session ingress). The CLAUDE_CODE_USE_CCR_V2 branch is pinned as far as it
 * runs without a CCR transport: no internal-event reader is registered, so
 * nothing is hydrated, and the worker state the transport restored is applied.
 * Not reachable: the coordinator-mode branches, since `feature('COORDINATOR_MODE')`
 * is false under `bun test`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { join } from 'path'

import { getTotalCost } from 'src/agent/cost-tracker.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import {
  getMainLoopModelOverride,
  getSessionId,
  regenerateSessionId,
  setMainLoopModelOverride,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { envSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { useRestoreSandbox, writeSession } from 'src/sessions/__testutils__/restoreHarness.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getCurrentSessionTitle,
  getProject,
  recordTranscript,
  saveCustomTitle,
  resetProjectForTesting,
} from 'src/sessions/sessionStorage.js'
import type { Message } from 'src/shared/types/message.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

// --- the process-exit boundary ---------------------------------------------------

const realShutdown = { ...(await import('src/shared/proc/gracefulShutdown.js')) }
let exits: number[] | null = null
mock.module('src/shared/proc/gracefulShutdown.js', () => ({
  ...realShutdown,
  gracefulShutdownSync: (...args: Parameters<typeof realShutdown.gracefulShutdownSync>) => {
    if (exits === null) return realShutdown.gracefulShutdownSync(...args)
    exits.push(args[0] ?? 0)
  },
}))
const { emitLoadError, loadInitialMessages } = await import('src/platform/headless/print/sessionLoad.js')

afterAll(() => {
  mock.module('src/shared/proc/gracefulShutdown.js', () => realShutdown)
})

const sandbox = useRestoreSandbox()

beforeEach(() => {
  exits = []
})

afterEach(() => {
  exits = null
})

// --- helpers --------------------------------------------------------------------

type Options = Parameters<typeof loadInitialMessages>[1]

/** Run the loader as `runHeadless` does, with whatever it wrote to stdout and stderr. */
async function load(options: Partial<Options>) {
  let state: AppState = getDefaultAppState()
  const setAppState = (update: (prev: AppState) => AppState) => {
    state = update(state)
  }
  const written = { stdout: '', stderr: '' }
  const taps = (['stdout', 'stderr'] as const).map(stream =>
    spyOn(process[stream], 'write').mockImplementation(((chunk: string | Uint8Array) => {
      written[stream] += String(chunk)
      return true
    }) as never),
  )
  try {
    const result = await loadInitialMessages(setAppState, {
      continue: undefined,
      teleport: undefined,
      resume: undefined,
      resumeSessionAt: undefined,
      forkSession: undefined,
      outputFormat: undefined,
      restoredWorkerState: Promise.resolve(null),
      ...options,
    })
    return { result, written, state: () => state }
  } finally {
    for (const tap of taps) tap.mockRestore()
  }
}

const texts = (messages: Message[]) =>
  messages.flatMap(m => (m.type === 'user' || m.type === 'assistant' ? [m.message.content] : []))

/** The text turns `writeSession` records, in order. */
const RECORDED = ['Let us fix the parser.', 'On it.', 'That is all for now.']

const recordedTexts = (messages: Message[]) =>
  texts(messages).map(content =>
    typeof content === 'string' ? content : (content as Array<{ text?: string }>).map(b => b.text).join(''),
  )

/**
 * Record a session of alternating user and assistant turns, one second apart,
 * then leave the process as a new one would find it.
 */
async function recordConversation(turns: readonly string[], title?: string) {
  const id = randomUUID()
  switchSession(asSessionId(id))
  resetProjectForTesting()
  const start = Date.parse('2026-09-30T12:00:00.000Z')
  const messages = turns.map((content, index) => {
    const message = index % 2 === 0 ? createUserMessage({ content }) : createAssistantMessage({ content })
    message.timestamp = new Date(start + index * 1000).toISOString()
    return message
  })
  await recordTranscript(messages)
  if (title) await saveCustomTitle(id, title)
  await flushSessionStorage()
  const transcript = getProject().sessionFile!
  resetProjectForTesting()
  clearSessionMessagesCache()
  regenerateSessionId()
  return { id, transcript, uuids: messages.map(m => m.uuid as string) }
}

const TURNS = ['Rename the flag.', 'Renamed it.', 'Now update the docs.', 'Docs updated.']

/** A session whose transcript is too large to resume. */
const writeOversizedSession = () => recordConversation(['x'.repeat(9 * 1024 * 1024)])

// --- emitLoadError ----------------------------------------------------------------

/** What `act` writes to stdout and stderr, kept off the real streams. */
function captured(act: () => void): { stdout: string; stderr: string } {
  const out = { stdout: '', stderr: '' }
  const spies = (['stdout', 'stderr'] as const).map(stream =>
    spyOn(process[stream], 'write').mockImplementation(((chunk: string) => {
      out[stream] += chunk
      return true
    }) as never),
  )
  try {
    act()
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  return out
}

describe('emitLoadError', () => {
  test('stream-json gets an error result line on stdout', () => {
    const out = captured(() => emitLoadError('it broke', 'stream-json'))
    expect(out.stderr).toBe('')
    expect(out.stdout.split('\n')).toHaveLength(2)

    const result = JSON.parse(out.stdout) as Record<string, unknown>
    const zeroes = ['duration_ms', 'duration_api_ms', 'num_turns', 'total_cost_usd']
    const fields: Array<[string, unknown]> = [
      ['type', 'result'],
      ['subtype', 'error_during_execution'],
      ['is_error', true],
      ['stop_reason', null],
      ['errors', ['it broke']],
      ['modelUsage', {}],
      ['permission_denials', []],
      ['session_id', getSessionId()],
      ...zeroes.map((field): [string, unknown] => [field, 0]),
    ]
    for (const [field, value] of fields) expect([field, result[field]]).toEqual([field, value])
    expect(result.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 })
    expect(String(result.uuid)).toMatch(/^[0-9a-f-]{36}$/)
  })

  test.each([['json'], ['text'], [undefined]])('format %p gets the bare message on stderr', format => {
    expect(captured(() => emitLoadError('it broke', format))).toEqual({ stdout: '', stderr: 'it broke\n' })
  })
})

// --- a fresh session --------------------------------------------------------------

describe('starting fresh', () => {
  test('hands back what the SessionStart hooks already produced', async () => {
    const fromHooks = [createUserMessage({ content: 'hook context' })]
    const { result } = await load({ sessionStartHooksPromise: Promise.resolve(fromHooks) as never })
    expect(result).toEqual({ messages: fromHooks })
  })

  test('runs the startup hooks itself when nobody started them', async () => {
    const { result } = await load({})
    expect(result).toEqual({ messages: [] })
    expect(exits).toEqual([])
  })

  test('--continue with no earlier session falls through to the startup hooks', async () => {
    const fromHooks = [createUserMessage({ content: 'nothing to continue' })]
    const { result } = await load({ continue: true, sessionStartHooksPromise: Promise.resolve(fromHooks) as never })
    expect(result.messages).toBe(fromHooks)
    expect(exits).toEqual([])
  })
})

// --- --continue -----------------------------------------------------------------

describe('--continue', () => {
  test('takes over the newest session: its turns, its id, its cost and its metadata', async () => {
    const { id } = await writeSession({ title: 'Parser fixes', agentSetting: 'reviewer', costUSD: 0.25 })
    const { result } = await load({ continue: true })

    expect(recordedTexts(result.messages)).toEqual(RECORDED)
    expect(result.agentSetting).toBe('reviewer')
    expect(result.turnInterruptionState).toEqual({ kind: 'none' })
    expect(getSessionId()).toBe(asSessionId(id))
    expect(getTotalCost()).toBeCloseTo(0.25)
    expect(getCurrentSessionTitle(asSessionId(id))).toBe('Parser fixes')
  })

  test('a fork takes the turns and the metadata but keeps its own id', async () => {
    const { id } = await writeSession({ title: 'Parser fixes' })
    const before = getSessionId()
    const { result } = await load({ continue: true, forkSession: true })

    expect(recordedTexts(result.messages)).toEqual(RECORDED)
    expect(getSessionId()).toBe(before)
    expect(getSessionId()).not.toBe(asSessionId(id))
    expect(getCurrentSessionTitle(before)).toBe('Parser fixes')
  })

  test('a transcript that cannot be loaded exits with 1 and an empty conversation', async () => {
    await writeOversizedSession()
    const { result } = await load({ continue: true })
    expect(result).toEqual({ messages: [] })
    expect(exits).toEqual([1])
  })
})

// --- --resume <id> ------------------------------------------------------------------

describe('--resume', () => {
  test('a session id loads that session and takes it over', async () => {
    const older = await recordConversation(TURNS, 'Older')
    await recordConversation(['Something else.', 'Sure.'], 'Newer')
    const { result } = await load({ resume: older.id })

    expect(recordedTexts(result.messages)).toEqual(TURNS)
    expect(result.turnInterruptionState).toEqual({ kind: 'none' })
    expect(getSessionId()).toBe(asSessionId(older.id))
    expect(getCurrentSessionTitle(asSessionId(older.id))).toBe('Older')
    expect(exits).toEqual([])
  })

  test('restores the running cost of the session it resumes', async () => {
    const { id } = await writeSession({ costUSD: 0.5 })
    await load({ resume: id })
    expect(getTotalCost()).toBeCloseTo(0.5)
  })

  test('with --fork-session the id stays this process’s own', async () => {
    const { id } = await recordConversation(TURNS, 'Forked from')
    const before = getSessionId()
    const { result } = await load({ resume: id, forkSession: true })
    expect(recordedTexts(result.messages)).toEqual(TURNS)
    expect(getSessionId()).toBe(before)
    expect(getCurrentSessionTitle(before)).toBe('Forked from')
  })

  test('a .jsonl path loads the transcript at that path', async () => {
    const { transcript } = await recordConversation(TURNS)
    const { result } = await load({ resume: transcript })
    expect(recordedTexts(result.messages)).toEqual(TURNS)
    expect(exits).toEqual([])
  })

  test('--resume-session-at cuts the conversation after the named message', async () => {
    const { id, uuids } = await recordConversation(TURNS)
    const { result } = await load({ resume: id, resumeSessionAt: uuids[1] })
    expect(recordedTexts(result.messages)).toEqual(TURNS.slice(0, 2))
    expect(result.messages.at(-1)?.uuid).toBe(uuids[1] as never)
  })

  test('a .jsonl path with nothing there is reported as a missing session', async () => {
    const { result, written } = await load({ resume: join(sandbox.root, 'gone.jsonl') })
    expect(result).toEqual({ messages: [] })
    expect(exits).toEqual([1])
    expect(written.stderr).toMatch(/^No conversation found with session ID: [0-9a-f-]{36}\n$/)
  })

  test('a session that fails to load is reported with the reason', async () => {
    const { id } = await writeOversizedSession()
    const { result, written } = await load({ resume: id, outputFormat: 'stream-json' })
    expect(result).toEqual({ messages: [] })
    expect(exits).toEqual([1])
    const [error] = JSON.parse(written.stdout).errors as string[]
    expect(error).toStartWith('Failed to resume session: ')
    expect(error!.length).toBeGreaterThan('Failed to resume session: '.length)
  })

  const worktree = {
    originalCwd: '/work/repo',
    worktreePath: '/work/trees/feature',
    worktreeName: 'feature',
    worktreeBranch: 'feature',
    originalBranch: 'main',
    originalHeadCommit: 'abc123',
    sessionId: randomUUID(),
  }
  const carried: Array<[string, Partial<Options>, unknown]> = [
    ['--continue', { continue: true }, worktree],
    ['--continue --fork-session', { continue: true, forkSession: true }, undefined],
    ['--resume', {}, worktree],
    ['--resume --fork-session', { forkSession: true }, undefined],
  ]
  test.each(carried)('%s and the worktree the session was in', async (_name, options, expected) => {
    const { id } = await writeSession({ worktree })
    await load(options.continue ? options : { ...options, resume: id })
    expect(getProject().currentSessionWorktree).toEqual(expected as never)
  })

  const failures: Array<[string, () => Promise<Partial<Options>>, string]> = [
    [
      'an identifier that is neither a UUID, a .jsonl nor a URL',
      async () => ({ resume: 'not-a-session' }),
      'Error: --resume requires a valid session ID when used with --print. Usage: claudin -p --resume <session-id>. ' +
        'Session IDs must be in UUID format (e.g., 550e8400-e29b-41d4-a716-446655440000). Provided value "not-a-session" is not a valid UUID',
    ],
    [
      '--resume with no value',
      async () => ({ resume: true }),
      'Error: --resume requires a valid session ID when used with --print. Usage: claudin -p --resume <session-id>',
    ],
    [
      'a UUID with no transcript',
      async () => ({ resume: '00000000-0000-4000-8000-000000000001' }),
      'No conversation found with session ID: 00000000-0000-4000-8000-000000000001',
    ],
    [
      '--resume-session-at naming a message that is not there',
      async () => ({ resume: (await writeSession()).id, resumeSessionAt: 'no-such-message' }),
      'No message found with message.uuid of: no-such-message',
    ],
  ]

  describe.each([['text'], ['stream-json']])('reported as %s', format => {
    test.each(failures)('%s exits with 1', async (_name, options, message) => {
      const { result, written } = await load({ ...(await options()), outputFormat: format })
      expect(result).toEqual({ messages: [] })
      expect(exits).toEqual([1])
      if (format === 'stream-json') {
        expect(written.stderr).toBe('')
        expect(JSON.parse(written.stdout).errors).toEqual([message])
      } else {
        expect(written.stdout).toBe('')
        expect(written.stderr).toBe(message + '\n')
      }
    })
  })
})

// --- CLAUDE_CODE_USE_CCR_V2 -----------------------------------------------------------

describe('--resume under CLAUDE_CODE_USE_CCR_V2', () => {
  const env = envSnapshot(['CLAUDE_CODE_USE_CCR_V2'])
  const noModelPicked = () => setMainLoopModelOverride(undefined)
  beforeEach(() => {
    process.env.CLAUDE_CODE_USE_CCR_V2 = '1'
    noModelPicked()
  })
  afterEach(() => {
    noModelPicked()
    env.restore()
  })

  const restored: Array<[string, Record<string, unknown> | null, string, string | undefined]> = [
    ['a mode and a model', { permission_mode: 'plan', model: 'claude-haiku-4-5' }, 'plan', 'claude-haiku-4-5'],
    ['a mode and no model', { permission_mode: 'acceptEdits' }, 'acceptEdits', undefined],
    ['a model that is not a string', { model: 42 }, 'default', undefined],
    ['nothing restored', null, 'default', undefined],
  ]
  test.each(restored)('applies the restored worker state: %s', async (_name, metadata, mode, model) => {
    const fromHooks = [createUserMessage({ content: 'fresh start' })]
    const { result, state } = await load({
      resume: '00000000-0000-4000-8000-0000000000c2',
      restoredWorkerState: Promise.resolve(metadata as never),
      sessionStartHooksPromise: Promise.resolve(fromHooks) as never,
    })
    expect(state().toolPermissionContext.mode).toBe(mode as never)
    expect(getMainLoopModelOverride()).toBe(model)
    expect(result).toEqual({ messages: fromHooks })
    expect(exits).toEqual([])
  })

  test('an empty session starts fresh instead of failing, running the startup hooks itself', async () => {
    const { result } = await load({ resume: '00000000-0000-4000-8000-0000000000c3' })
    expect(result).toEqual({ messages: [] })
    expect(exits).toEqual([])
  })

  test('a session with turns on disk is still resumed from them', async () => {
    const { id } = await recordConversation(TURNS)
    const { result } = await load({ resume: id })
    expect(recordedTexts(result.messages)).toEqual(TURNS)
    expect(getSessionId()).toBe(asSessionId(id))
  })
})
