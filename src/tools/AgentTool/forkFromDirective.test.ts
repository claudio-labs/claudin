import { afterEach, describe, expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import type { CacheSafeParams } from 'src/agent/coordinator/forkedAgent.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import type { Message } from 'src/shared/types/message.js'
import { asAgentId } from 'src/shared/types/ids.js'
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
  const conversation: Message[] = [
    createUserMessage({ content: 'hi' }),
    createAssistantMessage({ content: 'hello' }),
  ]

  function deps(overrides: Partial<ForkFromDirectiveDeps> = {}): ForkFromDirectiveDeps {
    const abortController = new AbortController()
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
      savedParams: () => ({ systemPrompt: parentPrompt }) as CacheSafeParams,
      coordinatorMode: () => false,
      ...overrides,
    }
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

  test('nothing to fork before the first turn: no saved prompt, or no reply yet', async () => {
    expect(await spawnForkFromDirective('go', context(conversation).ctx, canUseTool, deps({ savedParams: () => null }))).toEqual({ kind: 'no-turn' })
    expect(await spawnForkFromDirective('go', context([createUserMessage({ content: 'hi' })]).ctx, canUseTool, deps())).toEqual({ kind: 'no-turn' })
    expect(calls.register).toBeUndefined()
  })

  test('refused in coordinator mode', async () => {
    expect(await spawnForkFromDirective('go', context(conversation).ctx, canUseTool, deps({ coordinatorMode: () => true }))).toEqual({ kind: 'coordinator' })
    expect(calls.register).toBeUndefined()
  })
})
