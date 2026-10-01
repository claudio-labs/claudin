/**
 * Invariant: every request the agent loop makes re-sends the previous request's
 * messages byte for byte — inside a turn, and across turns through each way the
 * next turn gets its history (the REPL's array, the transcript a --resume reads,
 * headless's raw accumulation).
 *
 * The real loop runs here (query.ts, tool execution, the attachment pipeline,
 * the REPL reducer, the transcript round trip); only the model is scripted
 * (__testutils__/loopHarness.ts). Each scenario stands for a way the loop
 * yields messages; a feature that adds a new way belongs here as a scenario.
 *
 * Why it matters beyond the cache: Opus 5.5 binds each thinking block to the
 * bytes before it, and drops it — and every later one — when they change. #273
 * was this suite's first case: a Skill's attachment rendered in-turn after the
 * tool_result and from the next turn on inside it.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { _resetCacheProfileForTesting } from 'src/agent/cache/cacheProfile.js'
import { type Attachment, createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import { ATTACHMENT_FIXTURES } from 'src/agent/attachments/__testutils__/attachmentFixtures.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import type { Message } from 'src/shared/types/message.js'
import type { Tool } from 'src/tools/Tool.js'
import {
  type Consumer,
  type ModelStep,
  runSession,
  stubTool,
} from 'src/agent/cache/__testutils__/loopHarness.js'
import {
  describePrefixBreak,
  findPrefixBreak,
  wireMessages,
} from 'src/agent/cache/__testutils__/prefixInvariant.js'

const savedProfile = process.env.CLAUDIN_CACHE_PROFILE

beforeEach(() => {
  // The profile every Anthropic-first-party user runs. Aggressive (providers
  // without prompt caching) stubs the display array on purpose; its own test
  // below pins that.
  process.env.CLAUDIN_CACHE_PROFILE = 'retain'
  _resetCacheProfileForTesting()
})

afterAll(() => {
  if (savedProfile === undefined) delete process.env.CLAUDIN_CACHE_PROFILE
  else process.env.CLAUDIN_CACHE_PROFILE = savedProfile
  _resetCacheProfileForTesting()
  resetGlobalConfigForTests()
})

type Scenario = {
  name: string
  tools: Tool[]
  /** One prompt per turn. */
  prompts: string[]
  script: ModelStep[]
  /** Requests the scenario must make — fewer means it did not run. */
  requests: number
}

const call = (name: string, input: Record<string, unknown> = {}) => ({ name, input })

const taskReconcile = () =>
  createAttachmentMessage({
    type: 'task_reconcile',
    reason: 'orphan_in_progress',
    stale: [{ id: '1', subject: 'Run the checks', status: 'in_progress' }],
    signature: '1:in_progress',
  })

/** ~3.7k tokens: over the 2k display-stub threshold, under persistence. */
const MID_SIZE_RESULT = 'line of output\n'.repeat(1000)

const SCENARIOS: Scenario[] = [
  {
    name: 'text replies across turns',
    tools: [],
    prompts: ['hello', 'and again'],
    script: [{ text: 'hi' }, { text: 'hi again' }],
    requests: 2,
  },
  {
    name: 'a tool loop with string results',
    tools: [stubTool({ name: 'Probe', result: 'probe output' })],
    prompts: ['run the probe twice', 'thanks'],
    script: [{ tools: [call('Probe')] }, { tools: [call('Probe')] }, { text: 'done' }, { text: 'ok' }],
    requests: 4,
  },
  {
    name: 'parallel tool calls in one response',
    tools: [
      stubTool({ name: 'Left', result: 'left output', concurrencySafe: true }),
      stubTool({ name: 'Right', result: 'right output', concurrencySafe: true }),
    ],
    prompts: ['run both', 'thanks'],
    script: [{ tools: [call('Left'), call('Right')] }, { text: 'done' }, { text: 'ok' }],
    requests: 3,
  },
  {
    // #273: the Skill's prompt command emits turn-start attachments.
    name: 'a Skill whose body comes with a turn-start attachment',
    tools: [
      stubTool({
        name: 'Skill',
        result: 'Launching skill: demo',
        newMessages: () => [
          createUserMessage({
            content: [{ type: 'text', text: 'Base directory for this skill: /repo/.claudin/skills/demo\n\nRun the checks.' }],
            isMeta: true,
          }),
          taskReconcile(),
        ],
      }),
      stubTool({ name: 'Probe', result: 'probe output' }),
    ],
    prompts: ['run the demo skill', 'is 221 prime?'],
    script: [{ tools: [call('Skill')] }, { tools: [call('Probe')] }, { text: 'done' }, { text: 'no' }],
    requests: 4,
  },
  {
    name: 'a PostToolUse hook that adds context to a string result',
    tools: [
      stubTool({
        name: 'Build',
        result: 'built in 1.2s',
        newMessages: () => [
          createAttachmentMessage({
            type: 'hook_additional_context',
            content: ['lint passed'],
            hookName: 'PostToolUse:Build',
            toolUseID: 'toolu_hook',
            hookEvent: 'PostToolUse',
          }),
        ],
      }),
    ],
    prompts: ['build it', 'thanks'],
    script: [{ tools: [call('Build')] }, { text: 'done' }, { text: 'ok' }],
    requests: 3,
  },
  {
    name: 'an array result followed by an attachment',
    tools: [
      stubTool({
        name: 'Fetch',
        result: [{ type: 'text', text: 'page one' }, { type: 'text', text: 'page two' }],
        newMessages: () => [taskReconcile()],
      }),
    ],
    prompts: ['fetch it', 'thanks'],
    script: [{ tools: [call('Fetch')] }, { text: 'done' }, { text: 'ok' }],
    requests: 3,
  },
  {
    name: 'progress ticks while a tool runs',
    tools: [
      stubTool({
        name: 'Sleep',
        result: 'slept',
        progress: [
          { type: 'sleep_progress', elapsedMs: 1000 },
          { type: 'sleep_progress', elapsedMs: 2000 },
          { type: 'hook_progress', hookName: 'PreToolUse:Sleep' },
        ],
      }),
    ],
    prompts: ['wait a bit', 'thanks'],
    script: [{ tools: [call('Sleep')] }, { text: 'done' }, { text: 'ok' }],
    requests: 3,
  },
  {
    // Over the display-stub threshold, under the persistence one: retain
    // keeps it whole in the REPL array, which seeds the next request.
    name: 'a mid-size tool result',
    tools: [stubTool({ name: 'Dump', result: MID_SIZE_RESULT })],
    prompts: ['dump it', 'thanks'],
    script: [{ tools: [call('Dump')] }, { text: 'done' }, { text: 'ok' }],
    requests: 3,
  },
  {
    // query.ts yields a clone whose tool_use input carries the fields a
    // tool's backfillObservableInput ADDS (SendMessage adds type/recipient/
    // content); the request in the turn carried the original input.
    name: 'a tool whose observable input gains fields',
    tools: [
      stubTool({
        name: 'Notify',
        result: 'sent',
        backfillObservableInput: input => {
          if (typeof input.to === 'string') {
            input.type = 'message'
            input.recipient = input.to
          }
        },
      }),
    ],
    prompts: ['tell main', 'thanks'],
    script: [{ tools: [call('Notify', { to: 'main', message: 'hi' })] }, { text: 'done' }, { text: 'ok' }],
    requests: 3,
  },
]

const CONSUMERS: Consumer[] = ['raw', 'repl', 'resume']

describe('every request re-sends the previous one', () => {
  for (const scenario of SCENARIOS) {
    for (const consumer of CONSUMERS) {
      test(`${scenario.name} — next turn via ${consumer}`, async () => {
        const session = await runSession({ ...scenario, consumer })

        // The scenario has to have run before its cache verdict means anything.
        expect(
          { requests: session.requests.length, unusedSteps: session.unusedSteps },
          'scenario did not run as scripted',
        ).toEqual({ requests: scenario.requests, unusedSteps: 0 })

        const broken = findPrefixBreak(session.requests.map(r => r.wire))
        expect(broken ? describePrefixBreak(broken) : null).toBeNull()
      })
    }
  }
})

// Every attachment type, as a tool would add it mid-turn (a Skill's prompt
// command, a hook): after a string result, then carried into the next turn.
// The payloads are the compile-time-complete table the render suite uses.
describe('every attachment type a tool adds mid-turn', () => {
  for (const type of Object.keys(ATTACHMENT_FIXTURES) as Attachment['type'][]) {
    // This one ends the turn right after the tool (shouldPreventContinuation).
    const stopsTheTurn = type === 'hook_stopped_continuation'
    for (const consumer of ['repl', 'resume'] as const) {
      test(`${type} — next turn via ${consumer}`, async () => {
        const session = await runSession({
          tools: [
            stubTool({
              name: 'Probe',
              result: 'probe output',
              newMessages: () => [createAttachmentMessage(ATTACHMENT_FIXTURES[type] as Attachment)],
            }),
          ],
          prompts: ['probe it', 'thanks'],
          script: stopsTheTurn
            ? [{ tools: [call('Probe')] }, { text: 'ok' }]
            : [{ tools: [call('Probe')] }, { text: 'done' }, { text: 'ok' }],
          consumer,
        })
        expect(
          { requests: session.requests.length, unusedSteps: session.unusedSteps },
          'scenario did not run as scripted',
        ).toEqual({ requests: stopsTheTurn ? 2 : 3, unusedSteps: 0 })
        const broken = findPrefixBreak(session.requests.map(r => r.wire))
        expect(broken ? describePrefixBreak(broken) : null).toBeNull()
      })
    }
  }
})

// The one break the REPL makes on purpose: under the aggressive profile
// (providers without prompt caching) the display array stubs large results
// at once (stubToolResultForDisplay), and that array seeds the next turn.
// Pinned so it stays this one known break and never reaches retain.
test('aggressive profile: the next turn sends a large result as its display stub', async () => {
  process.env.CLAUDIN_CACHE_PROFILE = 'aggressive'
  _resetCacheProfileForTesting()
  const session = await runSession({
    tools: [stubTool({ name: 'Dump', result: MID_SIZE_RESULT })],
    prompts: ['dump it', 'thanks'],
    script: [{ tools: [call('Dump')] }, { text: 'done' }, { text: 'ok' }],
    consumer: 'repl',
  })
  const broken = findPrefixBreak(session.requests.map(r => r.wire))
  expect(broken).toMatchObject({ from: 1, to: 2, index: 2, role: 'user' })
  expect(broken?.after).toContain('[clipped')
})

describe('the harness itself', () => {
  test('a byte changed in an old message is reported, with the message named', () => {
    const history: Message[] = [createUserMessage({ content: 'one' }), createUserMessage({ content: 'two' })]
    const first = wireMessages(history, [])
    const second = wireMessages(
      [createUserMessage({ content: 'one!' }), createUserMessage({ content: 'two' })],
      [],
    )
    const broken = findPrefixBreak([first, second])
    expect(broken).toMatchObject({ from: 0, to: 1, index: 0, role: 'user' })
  })
})
