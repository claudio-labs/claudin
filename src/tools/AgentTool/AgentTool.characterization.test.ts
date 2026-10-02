/**
 * The Agent tool as its callers see it: the schema the model is given, the
 * checks a spawn request passes, how a sub-agent runs (inline, in the
 * background, moved to the background half way, in its own git worktree) and
 * what comes back to the parent as a tool result or a task notification.
 *
 * Only the model is fake. Each request a sub-agent sends is answered by the
 * next step of a script, so the real query loop, the real tools, task
 * registration, transcripts and git worktrees all run. Everything on disk
 * lives in a worktree lab (temp HOME, config directory and projects).
 *
 * The remote-agent launch is being cut and is not pinned here. The fork path
 * is not reachable from a test: it is chosen by feature('FORK_SUBAGENT'),
 * which reads false under `bun test`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'

import { getAgentPlanSlug } from 'src/agent/planDossier.js'
import { getPlanFilePath, setPlanSlug } from 'src/agent/plans/plans.js'
import { runWithTeammateContext, type TeammateContext } from 'src/agent/coordinator/teammateContext.js'
import { clearCommandQueue, getCommandQueue } from 'src/agent/messageQueueManager.js'
import { drainSdkEvents } from 'src/agent/sdkEventQueue.js'
import { backgroundAgentTask, killAsyncAgent } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import { getIsNonInteractiveSession, getSessionId, setIsInteractive } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import type { AssistantMessage, Message } from 'src/shared/types/message.js'
import { getDefaultAppState, type AppState } from 'src/terminal/state/AppStateStore.js'
import { getAgentColor } from 'src/tools/AgentTool/agentColorManager.js'
import { agentNameProblem } from 'src/tools/AgentTool/agentName.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { Tools } from 'src/tools/Tool.js'
import { assembleToolPool } from 'src/tools/tools.js'
import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

type ToolUse = { name: string; input: Record<string, unknown> }
/** `silent` ends the stream without a message. */
type Reply = { say?: string; use?: ToolUse[]; fail?: Error; silent?: boolean }
/** What the sub-agent sent, as the model received it. */
type Request = {
  messages: Message[]
  cwd: string
  model: string
  querySource: string
  toolNames: string[]
  signal: AbortSignal
}
type Step = (request: Request) => Reply | Promise<Reply>

const requests: Request[] = []
let pending: Step[] = []

/** Queue the answers to the next requests; an empty queue answers "done". */
function script(...steps: Array<Step | Reply>): void {
  pending = steps.map(step => (typeof step === 'function' ? step : () => step))
}

function answer(reply: Reply, index: number): AssistantMessage {
  const id = `msg_scripted_${index}`
  const content: unknown[] = []
  if (reply.say !== undefined) content.push({ type: 'text', text: reply.say })
  for (const [n, use] of (reply.use ?? []).entries()) {
    content.push({ type: 'tool_use', id: `toolu_scripted_${index}_${n}`, name: use.name, input: use.input })
  }
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: id,
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason: reply.use?.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  } as unknown as AssistantMessage
}

const realShim = { ...(await import('src/providers/shims/claude.js')) }
mock.module('src/providers/shims/claude.js', () => ({
  ...realShim,
  queryModelWithStreaming: async function* (args: {
    messages: Message[]
    tools: Tools
    signal: AbortSignal
    options: { model: string; querySource: string }
  }) {
    const request: Request = {
      messages: [...args.messages],
      cwd: getCwd(),
      model: args.options.model,
      querySource: args.options.querySource,
      toolNames: args.tools.map(t => t.name),
      signal: args.signal,
    }
    requests.push(request)
    const step: Step = pending.shift() ?? (() => ({ say: 'done' }))
    const reply = await step(request)
    if (reply.fail) throw reply.fail
    if (reply.silent) return
    yield answer(reply, requests.length)
  },
}))

const { AgentTool, inputSchema, outputSchema } = await import('src/tools/AgentTool/AgentTool.js')

// ---------------------------------------------------------------------------
// The parent session
// ---------------------------------------------------------------------------

let lab: WorktreeLab
let project: string

beforeAll(() => {
  lab = openWorktreeLab()
  for (const name of ['CLAUDIN_AUTO_BACKGROUND_TASKS', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDIN_COORDINATOR_MODE']) {
    lab.env.set(name, undefined)
  }
})

afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realShim)
  lab.close()
})

beforeEach(() => {
  requests.length = 0
  pending = []
  project = lab.git.tempDir('agent-project')
  clearCommandQueue()
  drainSdkEvents()
})

afterEach(() => {
  setIsInteractive(false)
  clearCommandQueue()
})

type Parent = {
  context: any
  state: () => AppState
  progress: Array<{ toolUseID: string; data: any }>
  jsx: unknown[]
  responseLength: () => number
}

const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never

type ParentSetup = Partial<{
  agents: AgentDefinition[]
  allowlist: string[]
  tools: Tools
  deny: string[]
  mcpClients: Array<{ name: string; type: string }>
  mcpTools: string[]
  teamName: string
  agentId: string
}>

/** Callbacks the loop calls that these tests have no use for. */
const IGNORED_CALLBACKS = ['setInProgressToolUseIDs', 'updateFileHistoryState', 'updateAttributionState']
/** Per-turn sets the attachment pipeline fills in. */
const TURN_SETS = ['nestedMemoryAttachmentTriggers', 'loadedNestedMemoryPaths', 'dynamicSkillDirTriggers']

function parent(setup: ParentSetup = {}): Parent {
  const initial = getDefaultAppState()
  const permissions = initial.toolPermissionContext
  let state: AppState = {
    ...initial,
    toolPermissionContext: { ...permissions, alwaysDenyRules: { ...permissions.alwaysDenyRules, session: setup.deny ?? [] } },
    mcp: { ...initial.mcp, clients: (setup.mcpClients ?? []) as never, tools: (setup.mcpTools ?? []).map(name => ({ name })) as never },
  }
  if (setup.teamName) state = { ...state, teamContext: { teamName: setup.teamName } as never }
  const roster = setup.agents ?? [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]
  const record: Pick<Parent, 'progress' | 'jsx'> = { progress: [], jsx: [] }
  let streamed = 0

  const context: Record<string, unknown> = {
    agentId: setup.agentId,
    toolUseId: 'toolu_parent_call',
    messages: [],
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(20),
    getAppState: () => state,
    setAppState: (next: (prev: AppState) => AppState) => void (state = next(state)),
    setResponseLength: (grow: (n: number) => number) => void (streamed = grow(streamed)),
    setToolJSX: (shown: unknown) => void record.jsx.push(shown),
  }
  for (const name of IGNORED_CALLBACKS) context[name] = () => {}
  for (const name of TURN_SETS) context[name] = new Set<string>()
  const options: Record<string, unknown> = {
    mainLoopModel: 'claude-opus-5-5',
    tools: setup.tools ?? assembleToolPool(permissions, []),
    agentDefinitions: { activeAgents: roster, allAgents: roster, allowedAgentTypes: setup.allowlist },
    mcpResources: {},
  }
  for (const flag of ['debug', 'verbose']) options[flag] = false
  for (const list of ['commands', 'mcpClients']) options[list] = []
  // Thinking off keeps each scripted reply to the blocks the step names.
  options.thinkingConfig = { type: 'disabled' }
  options.isNonInteractiveSession = getIsNonInteractiveSession()
  context.options = options
  return { context, state: () => state, ...record, responseLength: () => streamed }
}

const PARENT_MESSAGE = { message: { id: 'msg_parent_turn' } } as never

function spawn(who: Parent, input: Record<string, unknown>, dir: string = project): Promise<{ data: any }> {
  return lab.inSession(dir, () =>
    AgentTool.call(
      { description: 'look around', prompt: 'list what is here', ...input } as never,
      who.context,
      allow,
      PARENT_MESSAGE,
      (event: { toolUseID: string; data: unknown }) => {
        who.progress.push(event as Parent['progress'][number])
      },
    ),
  ) as Promise<{ data: any }>
}

function failure(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

async function until<T>(read: () => T | undefined, label: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await tick()
  }
}

/** The tag values of the task notification queued for `taskId`. */
function notificationFor(taskId: string): Record<string, string> | undefined {
  for (const queued of getCommandQueue()) {
    const text = typeof queued.value === 'string' ? queued.value : ''
    if (!text.includes(`<task-id>${taskId}</task-id>`)) continue
    // Leaf elements only: <worktree> wraps its path and branch.
    const fields: Record<string, string> = { mode: String(queued.mode) }
    for (const [, tag, body] of text.matchAll(/<([a-zA-Z_-]+)>([^<]*)<\/\1>/g)) fields[tag!] = body!
    return fields
  }
  return undefined
}

function textOf(message: Message): string {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block as { text?: string }).text ?? '').join('\n')
}

function inTeammate<T>(teamName: string, action: () => T): T {
  const context: TeammateContext = {
    agentId: `worker@${teamName}`,
    agentName: 'worker',
    teamName,
    planModeRequired: false,
    parentSessionId: 'leader',
    isInProcess: true,
    abortController: new AbortController(),
  }
  return runWithTeammateContext(context, action)
}

function customAgent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    ...GENERAL_PURPOSE_AGENT,
    agentType: 'Custom',
    source: 'projectSettings',
    ...overrides,
  } as AgentDefinition
}

// ---------------------------------------------------------------------------
// The tool's fixed surface
// ---------------------------------------------------------------------------

describe('what the tool declares', () => {
  test('identity and flags', async () => {
    const facts: Array<[string, unknown, unknown]> = [
      ['wire name', AgentTool.name, 'Agent'],
      ['legacy names', AgentTool.aliases, ['Task']],
      ['read-only', AgentTool.isReadOnly(), true],
      ['runs alongside other calls', AgentTool.isConcurrencySafe(), true],
      ['one-line description', await AgentTool.description(), 'Launch a new agent'],
      ['largest result kept inline', AgentTool.maxResultSizeChars, 100000],
      ['tool search hint', AgentTool.searchHint, 'delegate work to a subagent'],
    ]
    expect(facts.map(([what, actual]) => [what, actual])).toEqual(facts.map(([what, , expected]) => [what, expected]))
  })

  test('activity line and classifier text', () => {
    const rows: Array<[Record<string, unknown>, string]> = [
      [{ prompt: 'fix it' }, ': fix it'],
      [{ prompt: 'map it', subagent_type: 'Explore' }, '(Explore): map it'],
      [{ prompt: 'plan it', mode: 'plan' }, '(mode=plan): plan it'],
      [{ prompt: 'both', subagent_type: 'Plan', mode: 'acceptEdits' }, '(Plan, mode=acceptEdits): both'],
    ]
    expect(rows.map(([input]) => AgentTool.toAutoClassifierInput(input as never))).toEqual(rows.map(([, text]) => text))
    expect([AgentTool.getActivityDescription({ description: 'scan repo' } as never), AgentTool.getActivityDescription(undefined as never)]).toEqual([
      'scan repo',
      'Running task',
    ])
  })

  test('permission is always granted to the tool itself, with the input unchanged', async () => {
    const who = parent()
    const input = { description: 'd', prompt: 'p' }
    expect(await AgentTool.checkPermissions(input as never, who.context)).toEqual({ behavior: 'allow', updatedInput: input })
  })

  test('the input schema offers worktree isolation but not a working directory', () => {
    const shape = Object.keys((inputSchema() as unknown as { shape: Record<string, unknown> }).shape).sort()
    expect(shape).toEqual(['description', 'isolation', 'mode', 'model', 'name', 'prompt', 'readOnly', 'run_in_background', 'subagent_type', 'team_name'])
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ description: 'd', prompt: 'p' }, true],
      [{ description: 'd', prompt: 'p', isolation: 'worktree' }, true],
      [{ description: 'd', prompt: 'p', isolation: 'remote' }, false],
      [{ description: 'd', prompt: 'p', model: 'haiku' }, true],
      [{ description: 'd', prompt: 'p', model: 'gpt' }, false],
      [{ prompt: 'p' }, false],
    ]
    expect(cases.map(([input]) => inputSchema().safeParse(input).success)).toEqual(cases.map(([, ok]) => ok))
  })

  test('the output schema takes a finished run or a background launch', () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    }
    const cases: Array<[unknown, boolean]> = [
      [{ status: 'completed', prompt: 'p', agentId: 'a', content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 2, usage }, true],
      [{ status: 'async_launched', agentId: 'a', description: 'd', prompt: 'p', outputFile: '/x' }, true],
      [{ status: 'teammate_spawned', prompt: 'p' }, false],
    ]
    expect(cases.map(([value]) => outputSchema().safeParse(value).success)).toEqual(cases.map(([, ok]) => ok))
  })
})

describe('validating a spawn', () => {
  test('a name must be usable as an address, unless it is a teammate name', async () => {
    const names = ['scout', 'Build_2.x', 'main', 'has space', '-dash', 'a1b2c3d4e5f6a7b8c']
    const solo = parent()
    const outcomes = []
    for (const name of names) outcomes.push(await AgentTool.validateInput!({ name } as never, solo.context))
    expect(outcomes).toEqual(
      names.map(name => {
        const problem = agentNameProblem(name)
        return problem ? { result: false, message: problem, errorCode: 9 } : { result: true }
      }),
    )
    expect(await AgentTool.validateInput!({} as never, solo.context)).toEqual({ result: true })

    lab.env.set('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', '1')
    try {
      const inTeam = parent({ teamName: 'crew' })
      expect(await AgentTool.validateInput!({ name: 'has space' } as never, inTeam.context)).toEqual({ result: true })
      expect(await AgentTool.validateInput!({ name: 'main', team_name: 'other' } as never, solo.context)).toEqual({ result: true })
    } finally {
      lab.env.set('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', undefined)
    }
  })

  test('requests refused before any agent runs', async () => {
    const reporter = customAgent({ agentType: 'Reporter', requiredMcpServers: ['tracker'] })
    const cases: Array<{ name: string; who: () => Parent; input: Record<string, unknown>; message: string }> = [
      {
        name: 'a team without agent teams enabled',
        who: () => parent(),
        input: { team_name: 'crew', name: 'helper' },
        message: 'Agent Teams is not yet available on your plan.',
      },
      {
        name: 'an unknown type',
        who: () => parent(),
        input: { subagent_type: 'Nobody' },
        message: "Agent type 'Nobody' not found. Available agents: Code, Explore",
      },
      {
        // DEFECT, pinned as it is: an Agent(x, y) allowlist that leaves the
        // type out is reported as a permission-rule denial "from settings",
        // naming a rule nobody wrote.
        name: 'a type outside the spawn allowlist',
        who: () => parent({ allowlist: ['Explore'] }),
        input: { subagent_type: 'Code' },
        message: "Agent type 'Code' has been denied by permission rule 'Agent(Code)' from settings.",
      },
      {
        name: 'an unknown type under an allowlist',
        who: () => parent({ allowlist: ['Explore'] }),
        input: { subagent_type: 'Nobody' },
        message: "Agent type 'Nobody' not found. Available agents: Explore",
      },
      {
        name: 'a type denied by a permission rule',
        who: () => parent({ deny: ['Agent(Explore)'] }),
        input: { subagent_type: 'Explore' },
        message: "Agent type 'Explore' has been denied by permission rule 'Agent(Explore)' from session.",
      },
      {
        name: 'an agent whose MCP server has no tools',
        who: () => parent({ agents: [reporter], mcpTools: ['mcp__other__read'] }),
        input: { subagent_type: 'Reporter' },
        message:
          "Agent 'Reporter' requires MCP servers matching: tracker. MCP servers with tools: other. Use /mcp to configure and authenticate the required MCP servers.",
      },
      {
        name: 'an agent whose MCP server is absent',
        who: () => parent({ agents: [reporter] }),
        input: { subagent_type: 'Reporter' },
        message:
          "Agent 'Reporter' requires MCP servers matching: tracker. MCP servers with tools: none. Use /mcp to configure and authenticate the required MCP servers.",
      },
    ]
    const seen = []
    for (const c of cases) seen.push({ name: c.name, message: await failure(spawn(c.who(), c.input)) })
    expect(seen).toEqual(cases.map(c => ({ name: c.name, message: c.message })))
    expect(requests).toEqual([])
  })

  test('a required MCP server still connecting is waited for, and a failure ends the wait', async () => {
    const reporter = customAgent({ agentType: 'Reporter', requiredMcpServers: ['tracker'] })
    const who = parent({ agents: [reporter], mcpClients: [{ name: 'tracker-server', type: 'pending' }] })
    setTimeout(() => {
      who.context.setAppState((prev: AppState) => ({
        ...prev,
        mcp: { ...prev.mcp, clients: [{ name: 'tracker-server', type: 'failed' }] as never },
      }))
    }, 50)
    const started = Date.now()
    const message = await failure(spawn(who, { subagent_type: 'Reporter' }))
    expect(message).toStartWith("Agent 'Reporter' requires MCP servers matching: tracker.")
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
  })

  test('an agent whose MCP server connects while waiting runs', async () => {
    const reporter = customAgent({ agentType: 'Reporter', requiredMcpServers: ['tracker'] })
    const who = parent({ agents: [reporter], mcpClients: [{ name: 'tracker', type: 'pending' }] })
    setTimeout(() => {
      who.context.setAppState((prev: AppState) => ({
        ...prev,
        mcp: { ...prev.mcp, clients: [{ name: 'tracker', type: 'connected' }] as never, tools: [{ name: 'mcp__tracker__list' }] as never },
      }))
    }, 50)
    script({ say: 'tracked' })
    const result = await spawn(who, { subagent_type: 'Reporter' })
    expect(result.data.status).toBe('completed')
    expect(result.data.content).toEqual([{ type: 'text', text: 'tracked' }])
  })

  test('teammates cannot spawn teammates or background agents', async () => {
    lab.env.set('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', '1')
    setIsInteractive(true)
    try {
      const background = customAgent({ agentType: 'Watcher', background: true })
      const cases = [
        { input: { name: 'nested', team_name: 'crew' }, message: 'Teammates cannot spawn other teammates — the team roster is flat. To spawn a subagent instead, omit the `name` parameter.' },
        { input: { team_name: 'crew', run_in_background: true }, message: 'In-process teammates cannot spawn background agents. Use run_in_background=false for synchronous subagents.' },
        { input: { team_name: 'crew', subagent_type: 'Watcher' }, message: "In-process teammates cannot spawn background agents. Agent 'Watcher' has background: true in its definition." },
      ]
      const seen = []
      for (const c of cases) {
        const who = parent({ agents: [GENERAL_PURPOSE_AGENT, background] })
        seen.push(await inTeammate('crew', () => failure(spawn(who, c.input))))
      }
      expect(seen).toEqual(cases.map(c => c.message))
    } finally {
      lab.env.set('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', undefined)
    }
  })
})

describe('the tool description', () => {
  // The description names Explore for codebase searches only when Explore is
  // among the agents the parent may actually spawn.
  test('Explore is offered only when its MCP servers have tools, no rule denies it and the allowlist has it', async () => {
    const gatedExplore = { ...EXPLORE_AGENT, requiredMcpServers: ['tracker'] } as AgentDefinition
    const offersExplore = (text: string) => text.includes('To search this codebase, use')
    const cases: Array<{ name: string; agents: AgentDefinition[]; tools: string[]; deny?: string[]; allowed?: string[]; offered: boolean }> = [
      { name: 'listed', agents: [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], tools: [], offered: true },
      { name: 'denied by rule', agents: [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], tools: [], deny: ['Agent(Explore)'], offered: false },
      { name: 'outside the allowlist', agents: [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], tools: [], allowed: ['Code'], offered: false },
      { name: 'its MCP server has no tools', agents: [GENERAL_PURPOSE_AGENT, gatedExplore], tools: ['mcp__other__x'], offered: false },
      { name: 'its MCP server has tools', agents: [GENERAL_PURPOSE_AGENT, gatedExplore], tools: ['mcp__tracker__file', 'mcp__tracker__close', 'Read'], offered: true },
    ]
    const seen = []
    for (const c of cases) {
      const who = parent({ deny: c.deny })
      const text = await AgentTool.prompt({
        agents: c.agents,
        tools: c.tools.map(name => ({ name })) as never,
        getToolPermissionContext: async () => who.state().toolPermissionContext,
        allowedAgentTypes: c.allowed,
      } as never)
      seen.push({ name: c.name, offered: offersExplore(text) })
    }
    expect(seen).toEqual(cases.map(c => ({ name: c.name, offered: c.offered })))
  })
})

// ---------------------------------------------------------------------------
// Mapping a result into the parent's tool_result
// ---------------------------------------------------------------------------

describe('the tool_result the parent model reads', () => {
  const finished = (extra: Record<string, unknown>) => ({
    status: 'completed',
    prompt: 'p',
    agentId: 'a0b1',
    content: [{ type: 'text', text: 'report body' }],
    totalToolUseCount: 3,
    totalDurationMs: 1500,
    totalTokens: 900,
    usage: {},
    ...extra,
  })
  const rows: Array<{ name: string; data: Record<string, unknown>; texts: string[] }> = [
    {
      name: 'a fresh agent',
      data: finished({ agentType: 'Code' }),
      texts: [
        'report body',
        "agentId: a0b1 (use SendMessage with to: 'a0b1' to continue this agent)\n<usage>total_tokens: 900\ntool_uses: 3\nduration_ms: 1500</usage>",
      ],
    },
    {
      name: 'a result from before agentType was recorded',
      data: finished({}),
      texts: [
        'report body',
        "agentId: a0b1 (use SendMessage with to: 'a0b1' to continue this agent)\n<usage>total_tokens: 900\ntool_uses: 3\nduration_ms: 1500</usage>",
      ],
    },
    { name: 'a one-shot built-in', data: finished({ agentType: 'Explore' }), texts: ['report body'] },
    {
      name: 'a one-shot built-in that kept its worktree',
      data: finished({ agentType: 'Explore', worktreePath: '/wt/x', worktreeBranch: 'agent-x' }),
      texts: [
        'report body',
        "agentId: a0b1 (use SendMessage with to: 'a0b1' to continue this agent)\nworktreePath: /wt/x\nworktreeBranch: agent-x\n<usage>total_tokens: 900\ntool_uses: 3\nduration_ms: 1500</usage>",
      ],
    },
    {
      name: 'an agent that said nothing',
      data: finished({ agentType: 'Explore', content: [] }),
      texts: ['(Subagent completed but returned no output.)'],
    },
    {
      name: 'a background launch the parent can follow',
      data: { status: 'async_launched', agentId: 'bg1', description: 'd', prompt: 'p', outputFile: '/out/bg1.output', canReadOutputFile: true },
      texts: [
        "Async agent launched successfully.\nagentId: bg1 (internal ID - do not mention to user. Use SendMessage with to: 'bg1' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\noutput_file: /out/bg1.output\nIf asked, you can check progress before completion by using Read or Bash tail on the output file.",
      ],
    },
    {
      name: 'a background launch the parent cannot read',
      data: { status: 'async_launched', agentId: 'bg2', description: 'd', prompt: 'p', outputFile: '/out/bg2.output', canReadOutputFile: false },
      texts: [
        "Async agent launched successfully.\nagentId: bg2 (internal ID - do not mention to user. Use SendMessage with to: 'bg2' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\nBriefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.",
      ],
    },
    {
      name: 'a spawned teammate',
      data: { status: 'teammate_spawned', prompt: 'p', teammate_id: 'scout@crew', name: 'scout', team_name: 'crew' },
      texts: ['Spawned successfully.\nagent_id: scout@crew\nname: scout\nteam_name: crew\nThe agent is now running and will receive instructions via mailbox.'],
    },
  ]

  for (const row of rows) {
    test(row.name, () => {
      const block = AgentTool.mapToolResultToToolResultBlockParam(row.data as never, 'toolu_map')
      expect(block.tool_use_id).toBe('toolu_map')
      expect(block.type).toBe('tool_result')
      expect((block.content as Array<{ text: string }>).map(b => b.text)).toEqual(row.texts)
    })
  }

  test('an unknown status is an error', () => {
    expect(() => AgentTool.mapToolResultToToolResultBlockParam({ status: 'lost' } as never, 'toolu_map')).toThrow(
      'Unexpected agent tool result status: lost',
    )
  })

  test('only a finished Explore report skips the result summarizer', () => {
    const rows: Array<[Record<string, unknown>, boolean]> = [
      [{ status: 'completed', agentType: 'Explore' }, true],
      [{ status: 'completed', agentType: 'Code' }, false],
      [{ status: 'completed' }, false],
      [{ status: 'async_launched', agentType: 'Explore' }, false],
    ]
    expect(rows.map(([data]) => AgentTool.skipsResultSummarizer!(data as never))).toEqual(rows.map(([, skip]) => skip))
  })
})

// ---------------------------------------------------------------------------
// A sub-agent running inline
// ---------------------------------------------------------------------------

describe('a fresh agent run inline', () => {
  test('the result carries the final text, usage and the agent type', async () => {
    script({ say: 'here is the list' })
    const who = parent()
    const result = await spawn(who, {})

    expect(result.data).toMatchObject({
      status: 'completed',
      prompt: 'list what is here',
      agentType: 'Code',
      content: [{ type: 'text', text: 'here is the list' }],
      totalTokens: 16,
      totalToolUseCount: 0,
    })
    expect(result.data.agentId).toMatch(/^a[0-9a-f]{16}$/)
    expect(result.data.worktreePath).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(textOf(requests[0]!.messages[0]!)).toBe('list what is here')
    expect(realpathSync(requests[0]!.cwd)).toBe(realpathSync(project))
    expect(who.responseLength()).toBeGreaterThan(0)
  })

  test('the type defaults to the general-purpose agent and the parent sees it start', async () => {
    const who = parent()
    const result = await spawn(who, {})
    expect(result.data.agentType).toBe(GENERAL_PURPOSE_AGENT.agentType)
    expect(who.progress[0]).toMatchObject({
      toolUseID: 'agent_msg_parent_turn',
      data: { type: 'agent_progress', prompt: 'list what is here', agentId: result.data.agentId },
    })
  })

  test('tool calls made by the agent run for real and reach the parent as progress', async () => {
    const notes = join(project, 'notes.md')
    writeFileSync(notes, 'alpha\nbeta\n')
    script({ say: 'reading', use: [{ name: 'Read', input: { file_path: notes } }] }, request => {
      const results = request.messages.map(m => JSON.stringify(m)).filter(json => json.includes('"tool_result"'))
      return { say: `saw: ${results.some(json => json.includes('beta')) ? 'beta' : 'nothing'}` }
    })
    const who = parent()
    const result = await spawn(who, {})

    expect(result.data.totalToolUseCount).toBe(1)
    expect(result.data.content).toEqual([{ type: 'text', text: 'saw: beta' }])
    const forwarded = who.progress.slice(1).map(p => p.data.message.message.content[0].type)
    expect(forwarded).toEqual(['tool_use', 'tool_result'])
    expect(who.progress.slice(1).every(p => p.data.prompt === '' && p.toolUseID === 'agent_msg_parent_turn')).toBe(true)
  })

  test('while it runs it is a foreground task; afterwards it is gone and its name still resolves', async () => {
    const who = parent()
    let during: unknown
    script(() => {
      during = Object.values(who.state().tasks).map(t => ({ type: t.type, status: t.status, backgrounded: (t as { isBackgrounded?: boolean }).isBackgrounded }))
      return { say: 'ok' }
    })
    const result = await spawn(who, { name: 'scout' })

    expect(during).toEqual([{ type: 'local_agent', status: 'running', backgrounded: false }])
    expect(Object.keys(who.state().tasks)).toEqual([])
    expect(who.state().agentNameRegistry.get('scout')).toBe(result.data.agentId)
  })

  test('a non-interactive session hears the task finish as an SDK event', async () => {
    const who = parent()
    const result = await spawn(who, { description: 'count files' })
    const events = drainSdkEvents().filter(e => e.subtype === 'task_notification')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      task_id: result.data.agentId,
      tool_use_id: 'toolu_parent_call',
      status: 'completed',
      summary: 'count files',
      usage: { total_tokens: 16, tool_uses: 0 },
    })
  })

  test('model, read-only brief and colour reach the child', async () => {
    const painted = customAgent({ agentType: 'Painter', color: 'green' })
    const who = parent({ agents: [GENERAL_PURPOSE_AGENT, painted] })
    await spawn(who, { subagent_type: 'Painter', model: 'haiku', readOnly: true })

    expect(requests[0]!.model).not.toBe('claude-opus-5-5')
    expect(requests[0]!.model.toLowerCase()).toContain('haiku')
    expect(requests[0]!.toolNames).toContain('Read')
    expect(requests[0]!.toolNames).not.toContain('Write')
    expect(requests[0]!.toolNames).not.toContain('Edit')
    expect(getAgentColor('Painter')).toBeDefined()
  })

  test('the plan slug is handed down while the child runs', async () => {
    const slugWhileRunning = (who: Parent): Step => () => {
      const id = Object.keys(who.state().tasks)[0]!
      return { say: `slug=${getAgentPlanSlug(id)}` }
    }
    const cases: Array<{ name: string; prepare: () => Parent; slug: string }> = [
      { name: 'no plan', prepare: () => parent(), slug: 'undefined' },
      {
        name: 'a main-thread plan on disk',
        prepare: () => {
          setPlanSlug(getSessionId(), 'parent-plan-slug')
          lab.inSession(project, () => writeFileSync(getPlanFilePath(), '# plan'))
          return parent()
        },
        slug: 'parent-plan-slug',
      },
    ]
    const seen = []
    for (const c of cases) {
      const who = c.prepare()
      script(slugWhileRunning(who))
      seen.push((await spawn(who, {})).data.content[0].text)
    }
    expect(seen).toEqual(cases.map(c => `slug=${c.slug}`))
  })

  test('a failed model call comes back as a finished run carrying the error text', async () => {
    script({ fail: new Error('upstream exploded') })
    const result = await spawn(parent(), {})
    expect(result.data).toMatchObject({
      status: 'completed',
      content: [{ type: 'text', text: 'upstream exploded' }],
      totalTokens: 0,
      totalToolUseCount: 0,
    })
  })

  test('aborting the parent turn interrupts the child', async () => {
    const who = parent()
    script(() => {
      who.context.abortController.abort()
      return { say: 'too late' }
    })
    const message = await failure(spawn(who, {}))
    expect(message).not.toBe('resolved')
    expect(Object.keys(who.state().tasks)).toEqual([])
  })

  test('a slow agent shows the background hint, and clears it at the end', async () => {
    const who = parent()
    script(
      async () => ({ say: 'thinking', use: [{ name: 'Glob', input: { pattern: '*.none' } }] }),
      async () => {
        await tick(2100)
        return { say: 'slow answer' }
      },
    )
    const result = await spawn(who, {})
    expect(result.data.content).toEqual([{ type: 'text', text: 'slow answer' }])
    expect(who.jsx.filter(v => v !== null)).toHaveLength(1)
    expect(who.jsx.at(-1)).toBeNull()
  }, 15000)

  test('opted-in result summaries replace the report with the summary', async () => {
    const before = getGlobalConfig().summarizeSubagentResult
    saveGlobalConfig(c => ({ ...c, summarizeSubagentResult: true }))
    try {
      script({ say: 'a very long raw report' }, request => ({ say: request.querySource === 'agent_summary' ? 'short summary' : 'unexpected' }))
      const result = await spawn(parent(), {})
      expect(result.data.content).toEqual([{ type: 'text', text: 'short summary' }])
      expect(requests.map(r => r.querySource)).toEqual(['agent:builtin:Code', 'agent_summary'])

      requests.length = 0
      script({ say: 'explore output' })
      const explore = await spawn(parent(), { subagent_type: 'Explore' })
      expect(explore.data.content).toEqual([{ type: 'text', text: 'explore output' }])
      expect(requests.map(r => r.querySource)).toEqual(['agent:builtin:Explore'])
    } finally {
      saveGlobalConfig(c => ({ ...c, summarizeSubagentResult: before }))
    }
  })
})

// ---------------------------------------------------------------------------
// Background agents
// ---------------------------------------------------------------------------

describe('a background agent', () => {
  test('returns a launch record at once and notifies the parent when it finishes', async () => {
    setIsInteractive(true)
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    script(async () => {
      await gate
      return { say: 'background report' }
    })
    const who = parent()
    const launch = await spawn(who, { run_in_background: true, name: 'runner', description: 'scan in background' })

    expect(launch.data).toEqual({
      isAsync: true,
      status: 'async_launched',
      agentId: launch.data.agentId,
      description: 'scan in background',
      prompt: 'list what is here',
      outputFile: getTaskOutputPath(launch.data.agentId),
      canReadOutputFile: true,
    })
    const task = who.state().tasks[launch.data.agentId] as { status: string; isBackgrounded: boolean } | undefined
    expect(task).toMatchObject({ status: 'running', isBackgrounded: true })
    expect(who.state().agentNameRegistry.get('runner')).toBe(launch.data.agentId)

    release()
    const note = await until(() => notificationFor(launch.data.agentId), 'background notification')
    expect(note).toMatchObject({ mode: 'task-notification', status: 'completed', result: 'background report' })
    expect(note.summary).toBe('Agent "scan in background" completed')
  })

  test('a parent without Read or Bash is told not to read the output file', async () => {
    setIsInteractive(true)
    const who = parent({ tools: [] as never })
    const launch = await spawn(who, { run_in_background: true })
    expect(launch.data.canReadOutputFile).toBe(false)
    await until(() => notificationFor(launch.data.agentId), 'notification')
  })

  test('what sends an agent to the background', async () => {
    const watcher = customAgent({ agentType: 'Watcher', background: true })
    const cases: Array<{ name: string; interactive: boolean; env?: string; input: Record<string, unknown>; status: string }> = [
      { name: 'run_in_background in an interactive session', interactive: true, input: { run_in_background: true }, status: 'async_launched' },
      { name: 'run_in_background under -p is ignored', interactive: false, input: { run_in_background: true }, status: 'completed' },
      { name: 'an agent defined as background', interactive: false, input: { subagent_type: 'Watcher' }, status: 'async_launched' },
      { name: 'auto-background in an interactive session', interactive: true, env: '1', input: {}, status: 'async_launched' },
      { name: 'auto-background with an explicit false', interactive: true, env: '1', input: { run_in_background: false }, status: 'completed' },
      { name: 'auto-background for a one-shot built-in', interactive: true, env: '1', input: { subagent_type: 'Explore' }, status: 'completed' },
      { name: 'auto-background under -p', interactive: false, env: '1', input: {}, status: 'completed' },
      { name: 'nothing asked', interactive: true, input: {}, status: 'completed' },
    ]
    const seen = []
    for (const c of cases) {
      setIsInteractive(c.interactive)
      lab.env.set('CLAUDIN_AUTO_BACKGROUND_TASKS', c.env)
      try {
        const result = await spawn(parent({ agents: [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, watcher] }), c.input)
        seen.push({ name: c.name, status: result.data.status })
        if (result.data.status === 'async_launched') await until(() => notificationFor(result.data.agentId), c.name)
      } finally {
        lab.env.set('CLAUDIN_AUTO_BACKGROUND_TASKS', undefined)
      }
    }
    expect(seen).toEqual(cases.map(c => ({ name: c.name, status: c.status })))
  })

  test('an in-process teammate keeps its sub-agents inline even with auto-background on', async () => {
    setIsInteractive(true)
    lab.env.set('CLAUDIN_AUTO_BACKGROUND_TASKS', '1')
    try {
      const result = await inTeammate('crew', () => spawn(parent(), {}))
      expect(result.data.status).toBe('completed')
    } finally {
      lab.env.set('CLAUDIN_AUTO_BACKGROUND_TASKS', undefined)
    }
  })
})

describe('an inline agent moved to the background', () => {
  /** Starts an inline agent whose first request backgrounds it, and returns its launch. */
  async function startAndBackground(who: Parent, ...later: Array<Step | Reply>): Promise<{ data: any }> {
    script(async () => {
      const id = await until(() => Object.keys(who.state().tasks)[0], 'foreground task')
      backgroundAgentTask(id, who.state, who.context.setAppState)
      await tick(20)
      return { say: 'first pass, abandoned' }
    }, ...later)
    return spawn(who, { description: 'long job' })
  }

  test('the call returns a launch record and the rerun reports completion', async () => {
    setIsInteractive(true)
    const who = parent()
    const launch = await startAndBackground(
      who,
      { say: 'checking', use: [{ name: 'Glob', input: { pattern: '*.none' } }] },
      { say: 'finished in background' },
    )

    expect(launch.data).toMatchObject({ status: 'async_launched', isAsync: true, description: 'long job' })
    expect(launch.data.outputFile).toBe(getTaskOutputPath(launch.data.agentId))
    const note = await until(() => notificationFor(launch.data.agentId), 'notification')
    expect(note).toMatchObject({ status: 'completed', result: 'finished in background' })
    expect(note.summary).toBe('Agent "long job" completed')
    expect((who.state().tasks[launch.data.agentId] as { status: string }).status).toBe('completed')
  })

  test('a rerun that fails is reported as failed', async () => {
    setIsInteractive(true)
    const who = parent()
    const launch = await startAndBackground(who, () => ({ silent: true }))
    const note = await until(() => notificationFor(launch.data.agentId), 'notification')
    expect(note.status).toBe('failed')
    expect(note.summary).toStartWith('Agent "long job" failed: ')
    expect((who.state().tasks[launch.data.agentId] as { status: string }).status).toBe('failed')
  })

  test('a rerun that is stopped is reported as stopped', async () => {
    setIsInteractive(true)
    const who = parent()
    const launch = await startAndBackground(who, async request => {
      killAsyncAgent(Object.keys(who.state().tasks)[0]!, who.context.setAppState)
      await tick(20)
      expect(request.signal.aborted).toBe(true)
      return { say: 'partial words' }
    })
    const note = await until(() => notificationFor(launch.data.agentId), 'notification')
    expect(note.status).toBe('killed')
    expect(note.summary).toBe('Agent "long job" was stopped')
  })
})

// ---------------------------------------------------------------------------
// Worktree isolation
// ---------------------------------------------------------------------------

describe('worktree isolation', () => {
  test('an agent that changes nothing leaves no worktree behind', async () => {
    const repo = lab.git.repo('agent-repo')
    const result = await spawn(parent(), { isolation: 'worktree' }, repo)

    const childCwd = requests[0]!.cwd
    expect(realpathSync(repo) === childCwd).toBe(false)
    expect(childCwd).toContain('agent-')
    expect(existsSync(childCwd)).toBe(false)
    expect(result.data.worktreePath).toBeUndefined()
    const notice = requests[0]!.messages.map(textOf).find(text => text.includes(childCwd))
    expect(notice).toBeDefined()
  })

  test('an agent that writes a file keeps its worktree and says where', async () => {
    const repo = lab.git.repo('agent-repo-dirty')
    script(
      request => ({ say: 'writing', use: [{ name: 'Write', input: { file_path: join(request.cwd, 'made-by-agent.txt'), content: 'hello\n' } }] }),
      { say: 'wrote it' },
    )
    const result = await spawn(parent(), { isolation: 'worktree' }, repo)

    expect(result.data.content).toEqual([{ type: 'text', text: 'wrote it' }])
    expect(result.data.worktreePath).toBe(requests[0]!.cwd)
    expect(readFileSync(join(result.data.worktreePath, 'made-by-agent.txt'), 'utf8')).toBe('hello\n')
    expect(result.data.worktreeBranch).toBeTruthy()
    const text = (AgentTool.mapToolResultToToolResultBlockParam(result.data, 't').content as Array<{ text: string }>).at(-1)!.text
    expect(text).toContain(`worktreePath: ${result.data.worktreePath}\nworktreeBranch: ${result.data.worktreeBranch}`)
  })

  test('a background agent reports its kept worktree in the notification', async () => {
    setIsInteractive(true)
    const repo = lab.git.repo('agent-repo-bg')
    script(
      request => ({ use: [{ name: 'Write', input: { file_path: join(request.cwd, 'bg.txt'), content: 'x' } }] }),
      { say: 'background wrote' },
    )
    const launch = await spawn(parent(), { isolation: 'worktree', run_in_background: true }, repo)
    const note = await until(() => notificationFor(launch.data.agentId), 'notification')
    expect(note.status).toBe('completed')
    expect(note.worktreePath).toBe(requests[0]!.cwd)
  })

  const outsideGit: Array<{ name: string; input: Record<string, unknown>; agents?: AgentDefinition[]; outcome: string }> = [
    {
      name: 'asked for explicitly, outside a repository it is an error',
      input: { isolation: 'worktree' },
      outcome: 'Cannot create agent worktree: not in a git repository',
    },
    {
      name: 'asked for by the agent definition, outside a repository it runs in place',
      input: { subagent_type: 'Isolated' },
      agents: [customAgent({ agentType: 'Isolated', isolation: 'worktree' })],
      outcome: 'resolved',
    },
  ]
  for (const c of outsideGit) {
    test(c.name, async () => {
      const outcome = await failure(spawn(parent({ agents: c.agents }), c.input))
      expect(outcome).toContain(c.outcome)
      if (c.outcome === 'resolved') expect(realpathSync(requests[0]!.cwd)).toBe(realpathSync(project))
    })
  }
})
