import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  enqueue,
  getCommandQueueSnapshot,
  resetCommandQueue,
} from 'src/agent/messageQueueManager.js'
import { resetAgentSendsForTesting, AGENT_SENDS_PER_AGENT } from 'src/sessions/peers/sendBudget.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { formatAgentMessage } from 'src/tools/SendMessageTool/agentMessage.js'
import {
  awaitReply,
  type AwaitReplyProbe,
  describeAwaitOutcome,
} from 'src/tools/SendMessageTool/awaitReply.js'
import { SendMessageTool } from 'src/tools/SendMessageTool/SendMessageTool.js'
import { renderToolUseMessage } from 'src/tools/SendMessageTool/UI.js'

// A name that is no agent is looked up among the other sessions on this
// machine — point the session directory somewhere empty, not at the developer's.
let configDir: string
const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'await-reply-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetAgentSendsForTesting()
})

// Every wait a test opens is aborted after 3s, and when the test ends. A
// broken build must fail fast, not hang: bun's per-test timeout does not fire
// while `expect(promise).rejects` waits on a promise that never settles.
const WAIT_CAP_MS = 3000
const controllers: AbortController[] = []
const caps: ReturnType<typeof setTimeout>[] = []

afterEach(() => {
  for (const cap of caps.splice(0)) clearTimeout(cap)
  for (const controller of controllers.splice(0)) controller.abort()
  resetCommandQueue()
})

function probe(overrides: Partial<AwaitReplyProbe>): AwaitReplyProbe {
  return {
    takeReplies: () => [],
    userWrote: () => false,
    targetEnded: () => null,
    ...overrides,
  }
}

const live = () => new AbortController().signal

describe('awaitReply — the loop', () => {
  test('returns the first messages addressed to the waiter', async () => {
    let polls = 0
    const outcome = await awaitReply(
      probe({ takeReplies: () => (++polls < 3 ? [] : ['<agent-message from="dev">\nok\n</agent-message>']) }),
      { signal: live(), pollMs: 1 },
    )
    expect(outcome).toEqual({ kind: 'replied', messages: ['<agent-message from="dev">\nok\n</agent-message>'] })
    expect(polls).toBe(3)
  })

  test('a reply outranks the end it came with', async () => {
    const outcome = await awaitReply(
      probe({
        takeReplies: () => ['answer'],
        targetEnded: () => ({ status: 'completed', unread: false }),
      }),
      { signal: live(), pollMs: 1 },
    )
    expect(outcome.kind).toBe('replied')
  })

  test('the target stopping ends the wait with its report', async () => {
    const outcome = await awaitReply(
      probe({ targetEnded: () => ({ status: 'completed', result: 'all green', unread: true }) }),
      { signal: live(), pollMs: 1 },
    )
    expect(outcome).toEqual({ kind: 'ended', status: 'completed', result: 'all green', unread: true })
  })

  test('the user writing ends the wait', async () => {
    expect(await awaitReply(probe({ userWrote: () => true }), { signal: live(), pollMs: 1 })).toEqual({
      kind: 'user-wrote',
    })
  })

  test('gives up at the deadline', async () => {
    let clock = 0
    const outcome = await awaitReply(probe({}), {
      signal: live(),
      pollMs: 1,
      timeoutMs: 1000,
      now: () => (clock += 400),
    })
    expect(outcome).toEqual({ kind: 'timed-out' })
  })

  test('an abort ends it at once', async () => {
    const controller = new AbortController()
    const waiting = awaitReply(probe({}), { signal: controller.signal, pollMs: 10_000 })
    controller.abort()
    expect(await waiting).toEqual({ kind: 'aborted' })
  })
})

describe('describeAwaitOutcome', () => {
  test('a stopped target that never read the message says how to reach it', () => {
    const text = describeAwaitOutcome('dev', { kind: 'ended', status: 'completed', result: 'done', unread: true }, false)
    expect(text).toContain('without reading your message')
    expect(text).toContain('Its final report:\ndone')
  })

  test("main is not handed the report — the task's completion notice carries it", () => {
    const text = describeAwaitOutcome('dev', { kind: 'ended', status: 'completed', result: 'done', unread: false }, true)
    expect(text).not.toContain('done')
  })

  test('a timeout says how to wait again', () => {
    expect(describeAwaitOutcome('dev', { kind: 'timed-out' }, false)).toContain(
      'to: "dev", await_reply: true and no message',
    )
  })
})

// --- through the tool, against the state a real session keeps -------------

const DEV = 'a0123456789abcdef'
const TESTER = 'a1123456789abcdef'
const INFRA = 'a2123456789abcdef'
const INLINE = 'a3123456789abcdef'

type FakeTask = {
  type: 'local_agent'
  agentType: string
  agentId: string
  description: string
  status: string
  isBackgrounded: boolean
  pendingMessages: string[]
  result?: { content: { type: 'text'; text: string }[] }
}

function agentTask(agentId: string, isBackgrounded = true): FakeTask {
  return {
    type: 'local_agent',
    agentType: 'Code',
    agentId,
    description: `task ${agentId}`,
    status: 'running',
    isBackgrounded,
    pendingMessages: [],
  }
}

function session() {
  let state = {
    tasks: {
      [DEV]: agentTask(DEV),
      [TESTER]: agentTask(TESTER),
      [INFRA]: agentTask(INFRA),
      [INLINE]: agentTask(INLINE, false),
    } as Record<string, FakeTask>,
    agentNameRegistry: new Map([
      ['dev', DEV],
      ['tester', TESTER],
      ['infra', INFRA],
    ]),
    toolPermissionContext: { mode: 'default' },
  }
  const setAppState = (f: (prev: typeof state) => typeof state) => {
    state = f(state)
  }
  const contextFor = (agentId?: string, controller = new AbortController()) => {
    controllers.push(controller)
    caps.push(setTimeout(() => controller.abort(), WAIT_CAP_MS))
    return {
      agentId,
      abortController: controller,
      getAppState: () => state,
      setAppState,
    } as unknown as ToolUseContext
  }
  return {
    contextFor,
    task: (id: string) => state.tasks[id]!,
    update: (id: string, patch: Partial<FakeTask>) => {
      state = { ...state, tasks: { ...state.tasks, [id]: { ...state.tasks[id]!, ...patch } } }
    },
    remove: (id: string) => {
      const { [id]: _gone, ...rest } = state.tasks
      state = { ...state, tasks: rest }
    },
    /** What `from` would queue for `to` — the letter a SendMessage writes. */
    letter: (from: string, to: string, body: string) => formatAgentMessage({ from, body, to }),
  }
}

async function call(input: Record<string, unknown>, context: ToolUseContext) {
  const result = await SendMessageTool.call(input as never, context, (() => {}) as never, undefined as never)
  return result.data as { success: boolean; message: string; replies?: string[] }
}

describe('SendMessage with await_reply — agents of this conversation', () => {
  test('tester asks dev, dev answers, tester gets the answer as the result', async () => {
    const s = session()
    setTimeout(() => {
      // dev read the question and answered through SendMessage.
      s.update(TESTER, { pendingMessages: [s.letter('dev', 'tester', 'fixed in 3f2a, retest')] })
    }, 20)
    const data = await call(
      { to: 'dev', message: 'login fails on empty password', await_reply: true },
      s.contextFor(TESTER),
    )
    expect(data.success).toBe(true)
    expect(data.replies).toEqual([s.letter('dev', 'tester', 'fixed in 3f2a, retest')])
    // Taken out of the queue: it is not delivered a second time.
    expect(s.task(TESTER).pendingMessages).toEqual([])
    // dev learns tester is blocked on it.
    expect(s.task(DEV).pendingMessages[0]).toStartWith('<agent-message from="tester" awaiting-reply="true">')
    expect(s.task(DEV).pendingMessages[0]).toContain('login fails on empty password')
  })

  test('a background agent waiting on main marks its message for main too', async () => {
    const s = session()
    setTimeout(
      () => s.update(DEV, { pendingMessages: [s.letter('main', 'dev', 'use the v2 schema')] }),
      20,
    )
    await call({ to: 'main', message: 'v1 or v2 schema?', await_reply: true }, s.contextFor(DEV))
    const [asked] = getCommandQueueSnapshot()
    expect(String(asked?.value)).toStartWith('<agent-message from="dev" awaiting-reply="true">')
  })

  test('a mutual wait resolves: what the other already sent answers at once', async () => {
    const s = session()
    // dev asked tester first, and is itself waiting on tester.
    s.update(TESTER, { pendingMessages: [s.letter('dev', 'tester', 'which test fails?')] })
    const data = await call({ to: 'dev', message: 'which branch?', await_reply: true }, s.contextFor(TESTER))
    expect(data.replies).toEqual([s.letter('dev', 'tester', 'which test fails?')])
  })

  test("a third agent's message wakes the wait — no cycle can deadlock it", async () => {
    const s = session()
    setTimeout(() => {
      s.update(DEV, { pendingMessages: [s.letter('infra', 'dev', 'the pod already has the secret')] })
    }, 20)
    const data = await call({ to: 'tester', message: 'is it green?', await_reply: true }, s.contextFor(DEV))
    expect(data.replies?.[0]).toStartWith('<agent-message from="infra">')
    expect(data.message).toContain('check who sent it')
  })

  test('the target finishing ends the wait with its report, and says if it never read the message', async () => {
    const s = session()
    setTimeout(() => {
      const unread = s.task(DEV).pendingMessages
      s.update(DEV, {
        status: 'completed',
        pendingMessages: unread,
        result: { content: [{ type: 'text', text: 'shipped the fix' }] },
      })
    }, 20)
    const data = await call({ to: 'dev', message: 'one more thing', await_reply: true }, s.contextFor(TESTER))
    expect(data.replies).toBeUndefined()
    expect(data.message).toContain('dev finished without messaging you')
    expect(data.message).toContain('without reading your message')
    expect(data.message).toContain('shipped the fix')
  })

  test('an inline target that returns — its task unregisters — ends the wait too', async () => {
    const s = session()
    setTimeout(() => s.remove(INLINE), 20)
    const data = await call({ to: INLINE, message: 'which file?', await_reply: true }, s.contextFor(DEV))
    expect(data.message).toContain(`${INLINE} finished without messaging you`)
  })

  test('the user writing into the waiting agent stops the wait and keeps their text queued', async () => {
    const s = session()
    setTimeout(() => s.update(TESTER, { pendingMessages: ['stop, check b.ts first'] }), 20)
    const data = await call({ to: 'dev', message: 'status?', await_reply: true }, s.contextFor(TESTER))
    expect(data.message).toContain('the user wrote to you')
    expect(s.task(TESTER).pendingMessages).toEqual(['stop, check b.ts first'])
  })

  test('without a message it only waits', async () => {
    const s = session()
    setTimeout(() => s.update(TESTER, { pendingMessages: [s.letter('dev', 'tester', 'done')] }), 20)
    const data = await call({ to: 'dev', await_reply: true }, s.contextFor(TESTER))
    expect(data.replies).toHaveLength(1)
    expect(s.task(DEV).pendingMessages).toEqual([])
  })

  test('main waits on a background agent; the answer comes off the command queue', async () => {
    const s = session()
    setTimeout(() => {
      // infra answering "main", as handleMainMessage enqueues it.
      enqueue({
        value: s.letter('infra', 'main', 'yes, the config map exists'),
        mode: 'task-notification',
        priority: 'next',
        origin: { kind: 'subagent', name: 'infra' },
      })
    }, 20)
    const data = await call({ to: 'infra', message: 'does the config map exist?', await_reply: true }, s.contextFor())
    expect(data.replies?.[0]).toContain('yes, the config map exists')
    expect(getCommandQueueSnapshot()).toEqual([])
  })

  test('an inline agent cannot wait on main — main is blocked on it', async () => {
    const s = session()
    await expect(call({ to: 'main', await_reply: true }, s.contextFor(INLINE))).rejects.toThrow(
      'is for background agents',
    )
  })

  test('a recipient that is not an agent of this conversation is refused before anything is sent', async () => {
    const s = session()
    await expect(
      call({ to: 'somebody-else', message: 'hi', await_reply: true }, s.contextFor(TESTER)),
    ).rejects.toThrow('await_reply waits on an agent of this conversation')
    expect(s.task(DEV).pendingMessages).toEqual([])
  })

  test('an interrupt stops the wait', async () => {
    const s = session()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const data = await call({ to: 'dev', message: 'hi', await_reply: true }, s.contextFor(TESTER, controller))
    expect(data.message).toContain('interrupted')
  })
})

describe('SendMessage — the budget between agents', () => {
  test(`an agent gets ${AGENT_SENDS_PER_AGENT} sends to other agents, then a refusal that says what to do`, async () => {
    const s = session()
    for (let i = 0; i < AGENT_SENDS_PER_AGENT; i++) {
      await call({ to: 'dev', message: `round ${i}` }, s.contextFor(TESTER))
    }
    await expect(call({ to: 'dev', message: 'again' }, s.contextFor(TESTER))).rejects.toThrow(
      'final report',
    )
    // Another agent's budget is its own.
    expect((await call({ to: 'tester', message: 'hi' }, s.contextFor(DEV))).success).toBe(true)
  })
})

describe('SendMessage await_reply — validation and display', () => {
  const validate = (input: Record<string, unknown>, context: unknown = {}) =>
    SendMessageTool.validateInput!(input as never, context as never)

  test('a bare wait is valid; notify_when_idle alongside it is not', async () => {
    expect((await validate({ to: 'dev', await_reply: true })).result).toBe(true)
    expect((await validate({ to: 'dev', await_reply: true, notify_when_idle: true })).result).toBe(false)
  })

  test('a broadcast cannot be waited on', async () => {
    expect((await validate({ to: '*', message: 'hi', await_reply: true })).result).toBe(false)
  })

  test('writing to yourself is refused, by name or by id', async () => {
    const s = session()
    const context = s.contextFor(TESTER)
    expect((await validate({ to: 'tester', message: 'hi' }, context)).result).toBe(false)
    expect((await validate({ to: TESTER, message: 'hi' }, context)).result).toBe(false)
    expect((await validate({ to: 'dev', message: 'hi' }, context)).result).toBe(true)
  })

  test('the replies reach the model as text, not escaped JSON', () => {
    const block = SendMessageTool.mapToolResultToToolResultBlockParam!(
      { success: true, message: 'Sent.', replies: ['<agent-message from="dev">\nline 1\nline 2\n</agent-message>'] },
      'u1',
    )
    const text = (block.content as { text: string }[])[0]!.text
    expect(text).toBe('Sent.\n\n<agent-message from="dev">\nline 1\nline 2\n</agent-message>')
  })

  test('the transcript line says the call waits', () => {
    expect(renderToolUseMessage({ to: 'dev', await_reply: true })).toBe('dev: wait for reply')
    expect(renderToolUseMessage({ to: 'dev', message: 'status?', await_reply: true })).toBe(
      'dev: status? (waits for reply)',
    )
  })
})
