import { afterEach, describe, expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import type { CacheSafeParams } from 'src/agent/coordinator/forkedAgent.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import type { Message } from 'src/shared/types/message.js'
import { asAgentId } from 'src/shared/types/ids.js'
import { agentNameProblem } from 'src/tools/AgentTool/agentName.js'
import {
  forkDescription,
  forkNameFromDirective,
  spawnForkFromDirective,
  type ForkFromDirectiveDeps,
} from 'src/tools/AgentTool/forkFromDirective.js'
import { FORK_AGENT } from 'src/tools/AgentTool/forkSubagent.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'

describe('forkNameFromDirective', () => {
  test('slugs the first three words', () => {
    expect(forkNameFromDirective('Summarize what we did in two lines')).toBe('summarize-what-we')
  })

  test('drops what is not a slug character and caps at 24 chars', () => {
    expect(forkNameFromDirective('  Fix  the   flaky\ttest now')).toBe('fix-the-flaky')
    expect(forkNameFromDirective('Investigate everything-related-to authentication')).toBe('investigate-everything-r')
    expect(forkNameFromDirective('revisar ação pendente')).toBe('revisar-ao-pendente')
  })

  test('falls back to fork when nothing survives', () => {
    expect(forkNameFromDirective('???  !!!')).toBe('fork')
  })

  test('a name SendMessage can address: not "main", not an agentId shape', () => {
    expect(forkNameFromDirective('main')).toBe('fork')
    expect(forkNameFromDirective('a0123456789abcdef')).toBe('fork')
    for (const directive of ['main', 'Main', 'a0123456789abcdef', 'fix the bug']) {
      expect(agentNameProblem(forkNameFromDirective(directive))).toBeUndefined()
    }
  })

  test('the 24-char cut leaves no trailing hyphen', () => {
    expect(forkNameFromDirective(`${'a'.repeat(23)} bbb`)).toBe('a'.repeat(23))
  })
})

test('forkDescription flattens whitespace and caps at 50 chars', () => {
  expect(forkDescription('look\n  at   this')).toBe('look at this')
  const long = 'a'.repeat(60)
  expect(forkDescription(long)).toBe(`${'a'.repeat(49)}…`)
})

describe('spawnForkFromDirective', () => {
  const calls: Record<string, unknown> = {}
  afterEach(() => {
    for (const key of Object.keys(calls)) delete calls[key]
  })

  const parentPrompt = asSystemPrompt(['You are the parent.'])
  const rebuiltPrompt = asSystemPrompt(['Rebuilt for this model and session.'])
  const conversation: Message[] = [
    createUserMessage({ content: 'hi' }),
    createAssistantMessage({ content: 'hello' }),
  ]
  /** What stopHooks saves at the end of a main turn of `conversation`. */
  const savedFor = (messages: Message[], mainLoopModel = 'claude-opus-5-5') =>
    ({
      systemPrompt: parentPrompt,
      toolUseContext: { options: { mainLoopModel } },
      forkContextMessages: messages,
    }) as unknown as CacheSafeParams

  function deps(overrides: Partial<ForkFromDirectiveDeps> = {}): ForkFromDirectiveDeps {
    const abortController = new AbortController()
    calls.abortController = abortController
    return {
      register: (input => {
        calls.register = input
        return { agentId: 'fork-agent-abcd', abortController }
      }) as ForkFromDirectiveDeps['register'],
      runLifecycle: (async input => {
        calls.lifecycle = input
        input.makeStream(undefined)
      }) as ForkFromDirectiveDeps['runLifecycle'],
      stream: (input => {
        calls.stream = input
        return (async function* () {})()
      }) as ForkFromDirectiveDeps['stream'],
      savedParams: () => savedFor(conversation),
      buildPrompt: async () => rebuiltPrompt,
      coordinatorMode: () => false,
      ...overrides,
    } as ForkFromDirectiveDeps
  }

  function context(messages: Message[], taken: string[] = []) {
    let registry = new Map(taken.map(n => [n, asAgentId(`a-${n}`)]))
    const setAppStateForTasks = (f: (prev: never) => { agentNameRegistry: typeof registry }) => {
      registry = f({ agentNameRegistry: registry } as never).agentNameRegistry
    }
    const ctx = {
      agentId: undefined,
      messages,
      setAppState: () => {},
      setAppStateForTasks,
      getAppState: () => ({
        agentNameRegistry: registry,
        toolPermissionContext: getEmptyToolPermissionContext(),
      }),
      options: { tools: [], mainLoopModel: 'claude-opus-5-5' },
    } as unknown as ToolUseContext
    return { ctx, registry: () => registry }
  }

  const canUseTool = (async () => ({})) as never

  test('runs a background fork over the whole conversation with the parent prompt and tools', async () => {
    const { ctx, registry } = context(conversation, ['summarize-what-we'])
    const result = await spawnForkFromDirective('Summarize what we did', ctx, canUseTool, deps())

    expect(result).toEqual({ kind: 'spawned', name: 'summarize-what-we-2', agentId: 'fork-agent-abcd' })
    expect(registry().get('summarize-what-we-2')).toBe(asAgentId('fork-agent-abcd'))
    expect(calls.register).toMatchObject({
      description: 'Summarize what we did',
      prompt: 'Summarize what we did',
      selectedAgent: FORK_AGENT,
    })
    expect(calls.lifecycle).toMatchObject({ taskId: 'fork-agent-abcd', enableSummarization: true })
    const stream = calls.stream as Record<string, unknown>
    expect(stream).toMatchObject({
      agentDefinition: FORK_AGENT,
      isAsync: true,
      querySource: 'agent:builtin:fork',
      forkContextMessages: conversation,
      useExactTools: true,
      availableTools: [],
      agentName: 'summarize-what-we-2',
      model: undefined,
    })
    expect((stream.override as { systemPrompt: unknown }).systemPrompt).toBe(parentPrompt)
    const [directive] = stream.promptMessages as Message[]
    expect(JSON.stringify(directive)).toContain('Summarize what we did')
    expect(JSON.stringify(directive)).toContain('You are a forked worker process.')
  })

  test('prefers the prompt rendered on the context over the saved one', async () => {
    const { ctx } = context(conversation)
    const rendered = asSystemPrompt(['rendered'])
    ;(ctx as { renderedSystemPrompt?: unknown }).renderedSystemPrompt = rendered
    await spawnForkFromDirective('go', ctx, canUseTool, deps())
    expect(((calls.stream as Record<string, unknown>).override as { systemPrompt: unknown }).systemPrompt).toBe(rendered)
  })

  test("wires the task to the root store, the caller's permissions and the task's own abort", async () => {
    const { ctx } = context(conversation)
    Object.assign(ctx, { agentId: 'parent-agent', toolUseId: 'toolu_1' })
    await spawnForkFromDirective('go', ctx, canUseTool, deps())
    const register = calls.register as Record<string, unknown>
    // setAppStateForTasks, not setAppState: an in-process teammate's is a no-op.
    expect(register.setAppState).toBe(ctx.setAppStateForTasks)
    expect(register).toMatchObject({ parentAgentId: 'parent-agent', toolUseId: 'toolu_1' })
    const lifecycle = calls.lifecycle as Record<string, unknown>
    expect(lifecycle.rootSetAppState).toBe(ctx.setAppStateForTasks)
    expect(lifecycle.toolUseContext).toBe(ctx)
    expect(lifecycle.abortController).toBe(calls.abortController)
    const stream = calls.stream as Record<string, unknown>
    expect(stream.canUseTool).toBe(canUseTool)
    expect(stream.toolUseContext).toBe(ctx)
    expect(stream.override).toMatchObject({ agentId: asAgentId('fork-agent-abcd') })
    expect((stream.override as { abortController: unknown }).abortController).toBe(calls.abortController)
  })

  test('nothing to fork before the first reply', async () => {
    expect(await spawnForkFromDirective('go', context([createUserMessage({ content: 'hi' })]).ctx, canUseTool, deps())).toEqual({ kind: 'no-turn' })
    expect(calls.register).toBeUndefined()
  })

  const usedPrompt = () => ((calls.stream as Record<string, unknown>).override as { systemPrompt: unknown }).systemPrompt

  test('a resumed conversation with no turn of its own yet forks on a rebuilt prompt', async () => {
    const result = await spawnForkFromDirective('go', context(conversation).ctx, canUseTool, deps({ savedParams: () => null }))
    expect(result.kind).toBe('spawned')
    expect(usedPrompt()).toBe(rebuiltPrompt)
  })

  test('a prompt saved for another model, or another conversation, is rebuilt', async () => {
    await spawnForkFromDirective('go', context(conversation).ctx, canUseTool, deps({ savedParams: () => savedFor(conversation, 'gpt-5') }))
    expect(usedPrompt()).toBe(rebuiltPrompt)
    const other = [createUserMessage({ content: 'another session' }), createAssistantMessage({ content: 'yes' })]
    await spawnForkFromDirective('go', context(conversation).ctx, canUseTool, deps({ savedParams: () => savedFor(other) }))
    expect(usedPrompt()).toBe(rebuiltPrompt)
  })

  test('hands the child only what follows the last compaction', async () => {
    const old = [createUserMessage({ content: 'old question' }), createAssistantMessage({ content: 'old answer' })]
    const boundary = createCompactBoundaryMessage('auto', 150_000)
    const after = [
      createUserMessage({ content: 'summary', isCompactSummary: true }),
      createUserMessage({ content: 'next' }),
      createAssistantMessage({ content: 'reply' }),
    ]
    const all = [...old, boundary, ...after]
    await spawnForkFromDirective('go', context(all).ctx, canUseTool, deps({ savedParams: () => savedFor(all) }))
    const forwarded = (calls.stream as { forkContextMessages: Message[] }).forkContextMessages
    expect(forwarded).not.toContain(old[0]!)
    expect(forwarded).not.toContain(old[1]!)
    expect(forwarded.at(-1)).toBe(after[2]!)
    expect(usedPrompt()).toBe(parentPrompt)
  })

  test('refused in coordinator mode', async () => {
    expect(await spawnForkFromDirective('go', context(conversation).ctx, canUseTool, deps({ coordinatorMode: () => true }))).toEqual({ kind: 'coordinator' })
    expect(calls.register).toBeUndefined()
  })
})
