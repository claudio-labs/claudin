// #227: the producers in allThreadAttachments that read state the PARENT owns.
//
// #226 fixed the four mode reminders; the same class of bug was left in four
// more. For a sub-agent this pipeline only ever runs mid-tool-loop (query.ts
// calls it with input === null), so anything these emit is merged into the same
// user turn as the tool_result before it — which is what made the leak in #224
// read as injected page content.
//
// Two of them do not take a bare agentId gate: an in-process teammate reaches
// runAgent like any sub-agent and therefore has an agentId, but it is a real
// owner of the mailbox and of the shared task list. Every test below that pins
// a gate pins the teammate's own loop going through it too — that pair is the
// point, not the sub-agent half on its own.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { AgentId } from 'src/shared/types/ids.js'
import type { Message } from 'src/shared/types/message.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { ownsSessionScopedState } from 'src/agent/attachments/threadOwnership.js'
import { getDateChangeAttachments } from 'src/agent/attachments/injections.js'
import { getTaskReminderAttachments } from 'src/agent/attachments/lifecycle.js'
import { getTeammateMailboxAttachments } from 'src/agent/attachments/services.js'
import { getCompanionIntroAttachment } from 'src/terminal/buddy/prompt.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
} from 'src/platform/config/config.js'
import {
  getLastEmittedDate,
  setLastEmittedDate,
} from 'src/platform/bootstrap/state.js'
import { getLocalISODate } from 'src/shared/constants/common.js'
import {
  createTask,
  getTaskListId,
  resetTaskList,
} from 'src/agent/tasks/tasks.js'
import {
  readMailbox,
  writeToMailbox,
} from 'src/agent/coordinator/teammateMailbox.js'

const CHILD = 'agent_227' as AgentId
const TASK_LIST_ID = 'subagent-shared-gates-test'
const TEAM = 'gates-test-team'
const LEAD = 'boss'

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'subagent-shared-gates-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDIN_TASK_LIST_ID = TASK_LIST_ID
  process.env.CLAUDIN_ENABLE_TASKS = '1'
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.CLAUDIN_CONFIG_DIR
  delete process.env.CLAUDIN_TASK_LIST_ID
  delete process.env.CLAUDIN_ENABLE_TASKS
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
})

type ContextArgs = {
  agentId?: AgentId
  isTeammateOwnLoop?: boolean
  toolNames?: string[]
}

function makeContext(args: ContextArgs = {}): ToolUseContext {
  return {
    agentId: args.agentId,
    isTeammateOwnLoop: args.isTeammateOwnLoop,
    options: {
      tools: (args.toolNames ?? ['TaskUpdate']).map(name => ({ name })),
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({
      todos: {},
      tasks: {},
      viewingAgentTaskId: undefined,
      inbox: { messages: [] },
      teamContext: {
        teamName: TEAM,
        leadAgentId: 'lead-uuid',
        teammates: { 'lead-uuid': { name: LEAD } },
      },
      toolPermissionContext: { mode: 'default' },
    }),
    setAppState: () => {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

describe('ownsSessionScopedState', () => {
  test('the main thread owns it', () => {
    expect(ownsSessionScopedState({ agentId: undefined })).toBe(true)
  })

  test('a sub-agent does not', () => {
    expect(ownsSessionScopedState({ agentId: CHILD })).toBe(false)
  })

  test("an in-process teammate's own loop does, despite having an agentId", () => {
    // The whole reason the field exists: a teammate is not the main thread and
    // cannot be told apart by identity, because AsyncLocalStorage propagates
    // its name into every agent it spawns.
    expect(
      ownsSessionScopedState({ agentId: CHILD, isTeammateOwnLoop: true }),
    ).toBe(true)
  })
})

describe('date_change is main-thread only (#227)', () => {
  afterEach(() => {
    // Process-global one-shot: a value left here fires in whatever file
    // `bun test` reaches next.
    setLastEmittedDate(null)
  })

  test('a sub-agent gets nothing AND does not consume the parent notice', () => {
    // The gate has to sit ahead of the read. Placed after it, the child would
    // still return [] — having already recorded today's date, so the parent
    // would never be told the day changed. That is the swallow #226 had to fix
    // for the plan/auto exit notices.
    setLastEmittedDate('2020-01-01')

    expect(getDateChangeAttachments({ agentId: CHILD })).toEqual([])
    expect(getLastEmittedDate()).toBe('2020-01-01')
  })

  test('the main thread still gets it, and advances the slot', () => {
    setLastEmittedDate('2020-01-01')

    const out = getDateChangeAttachments({ agentId: undefined })

    expect(out).toEqual([{ type: 'date_change', newDate: getLocalISODate() }])
    expect(getLastEmittedDate()).toBe(getLocalISODate())
  })
})

/** Assistant turns with no Task* call — the reminder needs 4 of them. */
function quietTurns(count = 8): Message[] {
  return Array.from({ length: count }, () => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  })) as unknown as Message[]
}

describe('the v2 task reminder follows session-state ownership (#227)', () => {
  beforeEach(async () => {
    await resetTaskList(getTaskListId())
    await createTask(getTaskListId(), {
      subject: 'parent work',
      description: '',
      activeForm: undefined,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata: undefined,
    })
  })

  test('a sub-agent is not handed the session task list', async () => {
    // TaskUpdate survives the sub-agent tool filter for a sync child, and the
    // reminder ends with "Keep this list current as you work" — so without the
    // gate the child is handed the parent's checklist and invited to mutate it.
    const out = await getTaskReminderAttachments(
      quietTurns(),
      makeContext({ agentId: CHILD }),
    )

    expect(out).toEqual([])
  })

  test("an in-process teammate's own loop still gets it", async () => {
    // getTaskListId() resolves to the leader's team list for a teammate on
    // purpose — sharing that list is what a team is.
    const out = await getTaskReminderAttachments(
      quietTurns(),
      makeContext({ agentId: CHILD, isTeammateOwnLoop: true }),
    )

    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('todo_reminder_delta')
  })

  test('the main thread still gets it', async () => {
    const out = await getTaskReminderAttachments(quietTurns(), makeContext())

    expect(out).toHaveLength(1)
  })
})

describe('teammate_mailbox follows session-state ownership (#227)', () => {
  beforeEach(async () => {
    await writeToMailbox(
      LEAD,
      {
        from: 'someone',
        text: 'a message for the lead',
        timestamp: new Date().toISOString(),
      },
      TEAM,
    )
  })

  afterEach(() => {
    rmSync(join(configDir, 'teams'), { recursive: true, force: true })
  })

  test('a sub-agent gets nothing AND leaves the message unread', async () => {
    // The harm is the mutation, not the text: a sub-agent has no agentId in
    // the teammate registry, so isTeamLead falls through to true and agentName
    // resolves to the lead's. Without the gate it reads the lead's DMs into an
    // ephemeral attachment and marks them read — they are simply gone.
    const out = await getTeammateMailboxAttachments(
      makeContext({ agentId: CHILD }),
    )

    expect(out).toEqual([])
    const inbox = await readMailbox(LEAD, TEAM)
    expect(inbox.map(m => m.read)).toEqual([false])
  })

  test("an in-process teammate's own loop still receives mail", async () => {
    // Its own loop is the only mid-turn mail path there is —
    // waitForNextPromptOrShutdown delivers only between turns.
    const out = await getTeammateMailboxAttachments(
      makeContext({ agentId: CHILD, isTeammateOwnLoop: true }),
    )

    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('teammate_mailbox')
    const inbox = await readMailbox(LEAD, TEAM)
    expect(inbox.map(m => m.read)).toEqual([true])
  })
})

describe('companion_intro is main-thread only (#227)', () => {
  // Without an adopted companion this producer returns [] for everyone, so a
  // test that only asserts the sub-agent case passes with the gate deleted —
  // it certifies nothing. Adopt one, so the empty result can only come from
  // the gate. (break-probe caught exactly this.)
  beforeEach(() => {
    saveGlobalConfig(c => ({
      ...c,
      companion: { name: 'Pip', personality: 'quiet', hatchedAt: 0 },
    }))
  })

  afterEach(() => {
    saveGlobalConfig(c => ({ ...c, companion: undefined }))
  })

  test('the main thread gets the intro — the control for the gate below', () => {
    expect(getGlobalConfig().companion).toBeDefined()
    expect(getCompanionIntroAttachment([], undefined)).toMatchObject([
      { type: 'companion_intro', name: 'Pip' },
    ])
  })

  test('a sub-agent gets nothing', () => {
    // Every line of that text is addressed to the REPL — a sprite beside the
    // input box, and a cap of ONE line on the reply. A child has no input box,
    // and its reply is the report its parent is waiting for.
    expect(getCompanionIntroAttachment([], CHILD)).toEqual([])
  })
})
