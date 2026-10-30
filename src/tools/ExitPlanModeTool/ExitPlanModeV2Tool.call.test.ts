import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getDossierPath } from 'src/agent/planDossier.js'
import { getPlanFilePath, getPlanSlug } from 'src/agent/plans/plans.js'
import { listTasks } from 'src/agent/tasks/tasks.js'
import { readMailbox } from 'src/agent/coordinator/teammateMailbox.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from 'src/agent/coordinator/teammateContext.js'
import {
  hasExitedPlanModeInSession,
  needsPlanModeExitAttachment,
  setHasExitedPlanMode,
  setNeedsPlanModeExitAttachment,
} from 'src/platform/bootstrap/state.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { TaskUpdateTool } from 'src/tools/TaskUpdateTool/TaskUpdateTool.js'

const TASK_LIST_ID = 'exitplan-call-test'
const PLAN = `# Plan

## Tasks
- [ ] First step
  - files: a.ts
- [ ] Second step
`

type State = {
  toolPermissionContext: Record<string, unknown>
  expandedView?: string
  tasks?: Record<string, Record<string, unknown>>
}

function makeCtx(state: { current: State }, extra: Partial<Record<string, unknown>> = {}): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => state.current,
    setAppState: (updater: (prev: State) => State) => {
      state.current = updater(state.current)
    },
    messages: [],
    options: { tools: [], mainLoopModel: 'test-model' },
    ...extra,
  } as unknown as ToolUseContext
}

let root: string
let project: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_ENABLE_TASKS',
  'CLAUDIN_TASK_LIST_ID',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDIN_PLAN_TASK_IDS',
  'ENABLE_TOOL_SEARCH',
]

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  root = mkdtempSync(join(tmpdir(), 'exitplan-call-'))
  project = join(root, 'project')
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDIN_ENABLE_TASKS = '1'
  process.env.CLAUDIN_TASK_LIST_ID = TASK_LIST_ID
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  delete process.env.CLAUDIN_PLAN_TASK_IDS
  mkdirSync(project, { recursive: true })
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  setHasExitedPlanMode(false)
  setNeedsPlanModeExitAttachment(false)
  rmSync(root, { recursive: true, force: true })
})

function callTool(input: unknown, ctx: ToolUseContext) {
  return ExitPlanModeV2Tool.call(input as never, ctx, undefined as never, undefined as never)
}

/** Runs `fn` with the session root at the temp project, where the plans dir resolves. */
function inProject<T>(fn: () => T): T {
  return runWithCwdOverride(project, fn)
}

// A `-p` session without CLAUDIN_ENABLE_TASKS has no Task tools in its pool
// (`isTodoV2Enabled`), so seeded tasks were tasks nothing could update, and the
// approval pointed at a TaskUpdate the session did not have.
describe('ExitPlanModeV2Tool.call — a session without Task tools', () => {
  test('seeds nothing and falls back to the generic hint', async () => {
    const { getIsInteractive, setIsInteractive } = await import('src/platform/bootstrap/state.js')
    const wasInteractive = getIsInteractive()
    delete process.env.CLAUDIN_ENABLE_TASKS
    setIsInteractive(false)
    try {
      const state = { current: { toolPermissionContext: { mode: 'plan' } } as State }
      const data = await inProject(async () => {
        writeFileSync(getPlanFilePath(), PLAN)
        return (await callTool({}, makeCtx(state))).data
      })
      expect(data.tasksSeeded).toBeUndefined()
      expect(await listTasks(TASK_LIST_ID)).toEqual([])
      const text = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam(data, 'u').content as string
      expect(text).toContain('Start with updating your todo list if applicable')
      expect(text).not.toContain('TaskUpdate')
    } finally {
      setIsInteractive(wasInteractive)
    }
  })
})

describe('ExitPlanModeV2Tool.call', () => {
  test('approves the plan on disk: restores the pre-plan mode, seeds the tasks, opens the task view', async () => {
    const state = { current: { toolPermissionContext: { mode: 'plan', prePlanMode: 'acceptEdits' }, expandedView: 'none' } as State }
    const { data, planPath } = await inProject(async () => {
      const planPath = getPlanFilePath()
      writeFileSync(planPath, PLAN)
      const result = await callTool({} as never, makeCtx(state))
      return { data: result.data, planPath }
    })

    expect(data.plan).toBe(PLAN)
    expect(data.isAgent).toBe(false)
    expect(data.filePath).toBe(planPath)
    expect(data.tasksSeeded).toBe(2)
    expect(data.planWasEdited).toBeUndefined()
    expect(data.hasTaskTool).toBeUndefined()
    expect(state.current.toolPermissionContext.mode).toBe('acceptEdits')
    expect(state.current.toolPermissionContext.prePlanMode).toBeUndefined()
    expect(state.current.expandedView).toBe('tasks')
    expect(hasExitedPlanModeInSession()).toBe(true)
    expect(needsPlanModeExitAttachment()).toBe(true)
    expect((await listTasks(TASK_LIST_ID)).map(t => t.subject).sort()).toEqual(['First step', 'Second step'])
    expect(inProject(() => existsSync(getDossierPath(getPlanSlug())))).toBe(true)
  })

  test('an edited plan from the approval is written over the file and flagged as edited', async () => {
    const state = { current: { toolPermissionContext: { mode: 'plan' } } as State }
    const edited = '# Edited\n\nno tasks'
    const { data, onDisk } = await inProject(async () => {
      writeFileSync(getPlanFilePath(), PLAN)
      const result = await callTool({ plan: edited } as never, makeCtx(state))
      return { data: result.data, onDisk: readFileSync(getPlanFilePath(), 'utf8') }
    })
    expect(onDisk).toBe(edited)
    expect(data.plan).toBe(edited)
    expect(data.planWasEdited).toBe(true)
    expect(data.tasksSeeded).toBeUndefined()
    // No pre-plan mode recorded: back to default, and no task view to open.
    expect(state.current.toolPermissionContext.mode).toBe('default')
    expect(state.current.expandedView).toBeUndefined()
  })

  test('a sub-agent reads its own plan file and seeds nothing into the shared list', async () => {
    const state = { current: { toolPermissionContext: { mode: 'plan' } } as State }
    const data = await inProject(async () => {
      writeFileSync(getPlanFilePath('agent-1' as never), PLAN)
      return (await callTool({} as never, makeCtx(state, { agentId: 'agent-1' }))).data
    })
    expect(data.isAgent).toBe(true)
    expect(data.filePath).toEndWith('-agent-agent-1.md')
    expect(data.plan).toBe(PLAN)
    expect(data.tasksSeeded).toBeUndefined()
    expect(await listTasks(TASK_LIST_ID)).toEqual([])
  })

  test('outside plan mode the permission state is left as it is', async () => {
    const before = { toolPermissionContext: { mode: 'default', prePlanMode: 'auto' } } as State
    const state = { current: before }
    await inProject(async () => {
      writeFileSync(getPlanFilePath(), '# no tasks')
      await callTool({} as never, makeCtx(state))
    })
    expect(state.current).toBe(before)
    expect(hasExitedPlanModeInSession()).toBe(false)
  })

  test('stripped dangerous rules are put back when the restored mode is not auto', async () => {
    const stripped = { localSettings: ['Bash(*)'] }
    const state = { current: { toolPermissionContext: { mode: 'plan', prePlanMode: 'default', strippedDangerousRules: stripped } } as State }
    await inProject(async () => {
      writeFileSync(getPlanFilePath(), '# no tasks')
      await callTool({} as never, makeCtx(state))
    })
    // Under bun test the auto-mode module is folded away, so the context is kept as is.
    expect(state.current.toolPermissionContext.mode).toBe('default')
    expect(state.current.toolPermissionContext.strippedDangerousRules).toEqual(stripped)
  })

  test('with no plan at all it approves and seeds nothing', async () => {
    const state = { current: { toolPermissionContext: { mode: 'plan' } } as State }
    const data = await inProject(async () => (await callTool({} as never, makeCtx(state))).data)
    expect(data.plan).toBeNull()
    expect(data.tasksSeeded).toBeUndefined()
    expect(state.current.toolPermissionContext.mode).toBe('default')
  })

  test('reports the team hint only when swarms are on and the Agent tool is present', async () => {
    const approve = (tools: { name: string }[]) =>
      inProject(async () => {
        writeFileSync(getPlanFilePath(), '# no tasks')
        const state = { current: { toolPermissionContext: { mode: 'plan' } } as State }
        return (await callTool({} as never, makeCtx(state, { options: { tools } }))).data
      })
    expect((await approve([{ name: 'Agent' }])).hasTaskTool).toBeUndefined()
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    expect((await approve([{ name: 'Read' }])).hasTaskTool).toBeUndefined()
    expect((await approve([{ name: 'Agent' }])).hasTaskTool).toBe(true)
  })

  describe('as a teammate', () => {
    const teammate = (planModeRequired: boolean) =>
      createTeammateContext({
        agentId: 'researcher@crew',
        agentName: 'researcher',
        teamName: 'crew',
        planModeRequired,
        parentSessionId: 'parent',
        abortController: new AbortController(),
      })

    test('skips the local dialog and the plan-mode check', async () => {
      await runWithTeammateContext(teammate(false), async () => {
        expect(ExitPlanModeV2Tool.requiresUserInteraction?.()).toBe(false)
        const validated = await ExitPlanModeV2Tool.validateInput?.({} as never, makeCtx({ current: { toolPermissionContext: { mode: 'default' } } }))
        expect(validated?.result).toBe(true)
        const permission = await ExitPlanModeV2Tool.checkPermissions?.({ a: 1 } as never, makeCtx({ current: { toolPermissionContext: { mode: 'plan' } } }))
        expect(permission?.behavior).toBe('allow')
      })
    })

    test('when plan mode is required, sends the plan to the lead and waits', async () => {
      const state = {
        current: {
          toolPermissionContext: { mode: 'plan' },
          tasks: { t1: { id: 't1', type: 'in_process_teammate', identity: { agentName: 'researcher' } } },
        } as State,
      }
      const data = await inProject(() =>
        runWithTeammateContext(teammate(true), async () => {
          writeFileSync(getPlanFilePath('researcher@crew' as never), PLAN)
          return (await callTool({} as never, makeCtx(state, { agentId: 'researcher@crew' }))).data
        }),
      )
      expect(data.awaitingLeaderApproval).toBe(true)
      expect(data.isAgent).toBe(true)
      expect(data.requestId).toBeString()
      const inbox = await readMailbox('team-lead', 'crew')
      expect(inbox).toHaveLength(1)
      const request = JSON.parse(inbox[0]!.text)
      expect(request.type).toBe('plan_approval_request')
      expect(request.from).toBe('researcher')
      expect(request.planContent).toBe(PLAN)
      expect(request.requestId).toBe(data.requestId)
      // The leader decides: the teammate's own mode is not touched.
      expect(state.current.toolPermissionContext.mode).toBe('plan')
      expect(state.current.tasks?.t1?.awaitingPlanApproval).toBe(true)
    })

    test('when plan mode is required and no plan was written, it refuses', async () => {
      const state = { current: { toolPermissionContext: { mode: 'plan' } } as State }
      await expect(
        inProject(() =>
          runWithTeammateContext(teammate(true), () =>
            callTool({} as never, makeCtx(state, { agentId: 'researcher@crew' })),
          ),
        ),
      ).rejects.toThrow('No plan file found')
    })
  })
})

describe('ExitPlanModeV2Tool result text', () => {
  const map = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam

  test('without seeded tasks it points at the todo list, with a team it suggests one', () => {
    const plain = map({ plan: 'P', isAgent: false, filePath: '/p.md' }, 'u')
    expect(plain.content).toContain('Start with updating your todo list if applicable')
    expect(plain.content).not.toContain('TeamCreate')

    const team = map({ plan: 'P', isAgent: false, filePath: '/p.md', hasTaskTool: true }, 'u')
    expect(team.content).toContain('consider using the TeamCreate tool')
  })

  test('the descriptive surface', async () => {
    expect(await ExitPlanModeV2Tool.description({} as never, {} as never)).toBe('Prompts the user to exit plan mode and start coding')
    expect(await ExitPlanModeV2Tool.prompt({} as never)).toContain('plan')
    expect(ExitPlanModeV2Tool.userFacingName({} as never)).toBe('')
    expect(ExitPlanModeV2Tool.outputSchema?.safeParse({ plan: null, isAgent: false }).success).toBe(true)
  })
})

describe('CLAUDIN_PLAN_TASK_IDS: the seeded tasks by id, and how to update them', () => {
  const toolSearch = { name: 'ToolSearch' }
  const loadedTaskUpdate = {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't0', content: [{ type: 'tool_reference', tool_name: 'TaskUpdate' }] },
      ],
    },
  }

  async function approve(extra: Partial<Record<string, unknown>> = {}) {
    const state = { current: { toolPermissionContext: { mode: 'plan' } } as State }
    return inProject(async () => {
      writeFileSync(getPlanFilePath(), PLAN)
      const ctx = makeCtx(state, { options: { tools: [toolSearch, TaskUpdateTool] }, ...extra })
      return (await callTool({}, ctx)).data
    })
  }

  test('CLAUDIN_PLAN_TASK_IDS=0: the result carries the count only, as before', async () => {
    process.env.CLAUDIN_PLAN_TASK_IDS = '0'
    process.env.ENABLE_TOOL_SEARCH = 'true'
    const data = await approve()
    expect(data.tasksSeeded).toBe(2)
    expect(data.seededTasks).toBeUndefined()
    expect(data.taskUpdateUnloaded).toBeUndefined()
  })

  test('by default the result names each seeded task and whether TaskUpdate still needs loading', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    const data = await approve()
    expect(data.tasksSeeded).toBe(2)
    expect(data.seededTasks).toEqual([
      { id: '1', subject: 'First step' },
      { id: '2', subject: 'Second step' },
    ])
    expect(data.taskUpdateUnloaded).toBe(true)
  })

  test('on: a TaskUpdate already loaded, or no tool search at all, needs no direct-call line', async () => {
    process.env.CLAUDIN_PLAN_TASK_IDS = '1'
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect((await approve({ messages: [loadedTaskUpdate] })).taskUpdateUnloaded).toBe(false)
    // A fresh list, or the same plan dedups to nothing seeded.
    process.env.CLAUDIN_TASK_LIST_ID = `${TASK_LIST_ID}-no-search`
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect((await approve()).taskUpdateUnloaded).toBe(false)
  })

  test('the text lists the tasks and gives the exact TaskUpdate call when it is not loaded', () => {
    const map = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam
    const seededTasks = [
      { id: '1', subject: 'First step' },
      { id: '2', subject: 'Second step' },
    ]
    const unloaded = map(
      { plan: PLAN, isAgent: false, filePath: '/p.md', tasksSeeded: 2, seededTasks, taskUpdateUnloaded: true },
      'u',
    ).content as string
    expect(unloaded).toContain('#1 First step\n#2 Second step')
    expect(unloaded).toContain('TaskUpdate({"taskId": "1", "status": "in_progress"})')
    expect(unloaded).toContain('no ToolSearch')

    const loaded = map(
      { plan: PLAN, isAgent: false, filePath: '/p.md', tasksSeeded: 2, seededTasks, taskUpdateUnloaded: false },
      'u',
    ).content as string
    expect(loaded).toContain('#2 Second step')
    expect(loaded).not.toContain('TaskUpdate({')
  })

  test('a long plan lists its first 30 tasks and counts the rest', () => {
    const map = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam
    const seededTasks = Array.from({ length: 35 }, (_, i) => ({ id: String(i + 1), subject: `s${i + 1}` }))
    const text = map(
      { plan: PLAN, isAgent: false, filePath: '/p.md', tasksSeeded: 35, seededTasks },
      'u',
    ).content as string
    expect(text).toContain('#30 s30')
    expect(text).not.toContain('#31 s31')
    expect(text).toContain('and 5 more')
  })
})
