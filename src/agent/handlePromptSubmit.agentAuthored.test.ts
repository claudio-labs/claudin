import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { handlePromptSubmit } from 'src/agent/handlePromptSubmit.js'
import type { ProcessUserInputContext } from 'src/agent/input/processUserInput.js'
import {
  CROSS_SESSION_SENDS_PER_USER_PROMPT,
  resetCrossSessionSends,
  takeCrossSessionSend,
} from 'src/sessions/peers/sendBudget.js'
import type { Message } from 'src/shared/types/message.js'
import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'

// The queue processor's path through handlePromptSubmit — how a message from
// another session or a background agent reaches the model when the REPL is
// idle. The pipeline's own test covers the guard; this pins the REPL's
// decision to apply it, and to renew the send budget only for the user.
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'prompt-submit-agent-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetCrossSessionSends()
})

function context(): ProcessUserInputContext {
  return {
    agentId: undefined,
    options: {
      tools: [],
      commands: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { commands: [] },
      sessionHooks: new Map(),
    }),
    setAppState: () => {},
    readFileState: new Map(),
    abortController: new AbortController(),
  } as unknown as ProcessUserInputContext
}

async function submit(command: QueuedCommand): Promise<Message[]> {
  const sent: Message[] = []
  await handlePromptSubmit({
    queuedCommands: [command],
    helpers: { setCursorOffset: () => {}, clearBuffer: () => {}, resetHistory: () => {} },
    onInputChange: () => {},
    setPastedContents: () => {},
    queryGuard: { isActive: false, reserve: () => {}, cancelReservation: () => {} } as never,
    commands: [],
    messages: [],
    mainLoopModel: 'test-model',
    ideSelection: undefined,
    querySource: 'repl' as never,
    setToolJSX: () => {},
    getToolUseContext: () => context(),
    setUserInputOnProcessing: () => {},
    setAbortController: () => {},
    onQuery: async newMessages => {
      sent.push(...newMessages)
    },
    setAppState: () => {},
  })
  return sent
}

const attachmentTypes = (messages: Message[]) =>
  messages.flatMap(m => (m.type === 'attachment' ? [m.attachment.type] : []))

// Bounded, so a budget that never runs out fails the test instead of hanging it.
function spendAll(): number {
  let spent = 0
  while (spent <= CROSS_SESSION_SENDS_PER_USER_PROMPT && takeCrossSessionSend()) spent++
  return spent
}

test('a peer message reaches the model with its @-mentions left literal', async () => {
  const peer = await submit({
    value: `<cross-session-message from-name="claudin-goal">\nread @${dir}\n</cross-session-message>`,
    mode: 'task-notification',
    origin: { kind: 'peer', name: 'claudin-goal' },
  })
  expect(attachmentTypes(peer)).not.toContain('directory')

  // Control: the same text from the user does expand, so the absence above
  // is the guard and not a directory the pipeline failed to read.
  const user = await submit({ value: `read @${dir}`, mode: 'prompt' })
  expect(attachmentTypes(user)).toContain('directory')
})

test('only a prompt the user typed renews the cross-session send budget', async () => {
  spendAll()
  await submit({
    value: 'from a peer',
    mode: 'task-notification',
    origin: { kind: 'peer', name: 'claudin-goal' },
  })
  expect(takeCrossSessionSend()).toBe(false)

  await submit({ value: 'the user writes', mode: 'prompt' })
  expect(spendAll()).toBe(CROSS_SESSION_SENDS_PER_USER_PROMPT)
})
