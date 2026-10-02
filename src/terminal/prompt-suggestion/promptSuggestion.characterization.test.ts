/**
 * Characterization of the prompt suggestion generator (promptSuggestion.ts):
 * when Claudin offers a "what you might type next" suggestion, when it holds
 * one back, and what it asks the model for.
 *
 * The forked agent is the model call, so it is the one double: it records each
 * request and answers from a script. Gates read real environment variables, a
 * real settings file in a temp config directory, real session flags and the
 * real rate-limit state.
 *
 * Speculation (pre-running the suggestion) is always off and is being cut, so
 * nothing here depends on it.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setDynamicTeamContext } from 'src/agent/coordinator/teammate.js'
import { createAssistantAPIErrorMessage, createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { getIsInteractive, setIsInteractive } from 'src/platform/bootstrap/state.js'
import { getSettingsFilePathForSource } from 'src/platform/settings/settings.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { currentLimits, emitStatusChange } from 'src/providers/claudeAiLimits.js'
import type { AssistantMessage, Message, UserMessage } from 'src/shared/types/message.js'
import { useSandbox } from 'src/terminal/prompt-input/__testutils__/promptRig.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type { CacheSafeParams, ForkedAgentParams, ForkedAgentResult } from 'src/agent/coordinator/forkedAgent.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'

// --- the forked agent, scripted -------------------------------------------------------

const genuineFork = { ...(await import('src/agent/coordinator/forkedAgent.js')) }

type Reply = (request: ForkedAgentParams) => Promise<Message[]>
const forkRequests: ForkedAgentParams[] = []
let reply: Reply = async () => []

mock.module('src/agent/coordinator/forkedAgent.js', () => ({
  ...genuineFork,
  runForkedAgent: async (request: ForkedAgentParams): Promise<ForkedAgentResult> => {
    forkRequests.push(request)
    const messages = await reply(request)
    return { messages, totalUsage: { input_tokens: 0, output_tokens: 0 } as ForkedAgentResult['totalUsage'] }
  },
}))

afterAll(() => {
  mock.module('src/agent/coordinator/forkedAgent.js', () => genuineFork)
})

const {
  abortPromptSuggestion,
  executePromptSuggestion,
  generateSuggestion,
  getParentCacheSuppressReason,
  getPromptVariant,
  getSuggestionSuppressReason,
  logSuggestionOutcome,
  logSuggestionSuppressed,
  shouldEnablePromptSuggestion,
  shouldFilterSuggestion,
  tryGenerateSuggestion,
} = await import('src/terminal/prompt-suggestion/promptSuggestion.js')

const sandbox = useSandbox()
const limitsBefore = { ...currentLimits }
const interactiveBefore = getIsInteractive()

beforeEach(() => {
  forkRequests.length = 0
  reply = async () => []
  emitStatusChange({ ...limitsBefore })
  setIsInteractive(interactiveBefore)
  setDynamicTeamContext(null)
})

afterAll(() => {
  emitStatusChange({ ...limitsBefore })
  setIsInteractive(interactiveBefore)
  setDynamicTeamContext(null)
})

// --- conversations -----------------------------------------------------------------------

function said(text: string): AssistantMessage {
  return createAssistantMessage({ content: text })
}

function heavyTurn(text: string, tokens: { input: number; cacheWrite: number; output: number }): AssistantMessage {
  const message = createAssistantMessage({ content: text })
  message.message.usage = {
    ...message.message.usage,
    input_tokens: tokens.input,
    cache_creation_input_tokens: tokens.cacheWrite,
    output_tokens: tokens.output,
  }
  return message
}

const OFFER = 'Patched the parser. Want me to run the tests?'
const conversation = (last: Message = said(OFFER)): Message[] => [createUserMessage({ content: 'fix the parser' }), last]

function idleState(over: Partial<AppState> = {}): AppState {
  return { ...getDefaultAppState(), promptSuggestionEnabled: true, ...over } as AppState
}

const cacheSafe = { forkContextMessages: [] } as unknown as CacheSafeParams

/** The model answering with these text blocks, one assistant message each. */
function modelSays(...texts: string[]): Reply {
  return async () => texts.map(text => said(text))
}

// =====================================================================================

describe('getPromptVariant', () => {
  test('is always the user-intent prompt', () => {
    expect(getPromptVariant()).toBe('user_intent')
  })
})

describe('shouldEnablePromptSuggestion', () => {
  function writeUserSettings(settings: object): void {
    const path = getSettingsFilePathForSource('userSettings') as string
    expect(path.startsWith(sandbox().configDir)).toBe(true)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(settings))
    resetSettingsCache()
  }

  const cases: Array<{ when: string; env?: string; interactive: boolean; setup?: () => void; expected: boolean }> = [
    { when: 'the variable is 0, even when interactive', env: '0', interactive: true, expected: false },
    { when: 'the variable is false', env: 'false', interactive: true, expected: false },
    { when: 'the variable is 1, even in print mode', env: '1', interactive: false, expected: true },
    { when: 'the variable is true', env: 'true', interactive: false, expected: true },
    { when: 'unset, in print mode', interactive: false, expected: false },
    { when: 'unset, interactive, nothing configured', interactive: true, expected: true },
    {
      when: 'the user turned it off in settings',
      interactive: true,
      setup: () => writeUserSettings({ promptSuggestionEnabled: false }),
      expected: false,
    },
    {
      when: 'the user left it on in settings',
      interactive: true,
      setup: () => writeUserSettings({ promptSuggestionEnabled: true }),
      expected: true,
    },
    {
      when: 'this process is a swarm teammate',
      interactive: true,
      setup: () => {
        process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
        setDynamicTeamContext({ agentId: 'ada@crew', agentName: 'ada', teamName: 'crew', planModeRequired: false })
      },
      expected: false,
    },
    {
      when: 'teams are on but this process leads',
      interactive: true,
      setup: () => {
        process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      },
      expected: true,
    },
  ]
  for (const { when, env, interactive, setup, expected } of cases) {
    test(`${expected ? 'on' : 'off'} when ${when}`, () => {
      if (env !== undefined) process.env.CLAUDIN_ENABLE_PROMPT_SUGGESTION = env
      setIsInteractive(interactive)
      setup?.()
      expect(shouldEnablePromptSuggestion()).toBe(expected)
    })
  }
})

describe('getSuggestionSuppressReason', () => {
  const cases: Array<[string, () => AppState, string | null]> = [
    ['nothing in the way', () => idleState(), null],
    ['the feature switched off', () => idleState({ promptSuggestionEnabled: false }), 'disabled'],
    [
      'a worker waiting on a permission',
      () => idleState({ pendingWorkerRequest: { toolName: 'Bash' } } as unknown as Partial<AppState>),
      'pending_permission',
    ],
    [
      'the sandbox waiting on a permission',
      () => idleState({ pendingSandboxRequest: { host: 'example.com' } } as unknown as Partial<AppState>),
      'pending_permission',
    ],
    [
      'an MCP server asking the user something',
      () => idleState({ elicitation: { queue: [{ serverName: 'docs' }] } } as unknown as Partial<AppState>),
      'elicitation_active',
    ],
    [
      'plan mode',
      () => {
        const state = idleState()
        return { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'plan' } }
      },
      'plan_mode',
    ],
  ]
  for (const [when, state, expected] of cases) {
    test(`${expected ?? 'allowed'} with ${when}`, () => {
      expect(getSuggestionSuppressReason(state())).toBe(expected)
    })
  }

  test('rate_limit while the plan limit is not in the allowed state', () => {
    emitStatusChange({ ...limitsBefore, status: 'allowed_warning' })
    expect(getSuggestionSuppressReason(idleState())).toBe('rate_limit')
    emitStatusChange({ ...limitsBefore, status: 'rejected' })
    expect(getSuggestionSuppressReason(idleState())).toBe('rate_limit')
  })

  test('a disabled feature is reported before anything else', () => {
    emitStatusChange({ ...limitsBefore, status: 'rejected' })
    const state = idleState({ promptSuggestionEnabled: false })
    expect(getSuggestionSuppressReason({ ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'plan' } })).toBe(
      'disabled',
    )
  })
})

describe('getParentCacheSuppressReason', () => {
  const cases: Array<[string, Message | undefined, string | null]> = [
    ['no assistant turn', undefined, null],
    ['a light turn', heavyTurn('ok', { input: 10, cacheWrite: 20, output: 30 }), null],
    ['exactly the ceiling', heavyTurn('ok', { input: 40_000, cacheWrite: 40_000, output: 20_000 }), null],
    ['one token over the ceiling', heavyTurn('ok', { input: 40_000, cacheWrite: 40_000, output: 20_001 }), 'cache_cold'],
    ['a turn heavy on output alone', heavyTurn('ok', { input: 0, cacheWrite: 0, output: 150_000 }), 'cache_cold'],
  ]
  for (const [when, message, expected] of cases) {
    test(`${expected ?? 'warm'} for ${when}`, () => {
      expect(getParentCacheSuppressReason(message as Parameters<typeof getParentCacheSuppressReason>[0])).toBe(expected)
    })
  }

  test('missing usage counts read as zero', () => {
    const message = said('ok')
    message.message.usage = {} as typeof message.message.usage
    expect(getParentCacheSuppressReason(message as Parameters<typeof getParentCacheSuppressReason>[0])).toBeNull()
  })
})

describe('shouldFilterSuggestion', () => {
  const kept = [
    'run the tests',
    'yes',
    'Push',
    'ok',
    'commit',
    '/review',
    'go ahead',
    'add a test for the parser please now quickly here',
    'try it out',
  ]
  const dropped = [
    '',
    'done',
    'Nothing found',
    'nothing found.',
    'nothing to suggest here',
    'No suggestion',
    'Silence is best here',
    'I would stay silent',
    '...silence...',
    '(silence — nothing obvious)',
    '[no suggestion]',
    'API Error: overloaded',
    'Prompt is too long',
    'Request timed out',
    'Invalid API key',
    'Image was too large',
    'Next: run the tests',
    'maybe',
    'one two three four five six seven eight nine ten eleven twelve thirteen',
    `run ${'the tests '.repeat(10)}`,
    'Run it. Then commit',
    'run\nthe tests',
    'run the **tests**',
    'looks good to me',
    'thanks for that',
    'great work there',
    'Let me check',
    "I'll run it",
    "Here's the plan",
    'You should commit',
    'Sure, go ahead',
  ]
  for (const suggestion of kept) {
    test(`keeps ${JSON.stringify(suggestion)}`, () => {
      expect(shouldFilterSuggestion(suggestion, 'user_intent', 'cli')).toBe(false)
    })
  }
  for (const suggestion of dropped) {
    test(`drops ${JSON.stringify(suggestion)}`, () => {
      expect(shouldFilterSuggestion(suggestion, 'user_intent')).toBe(true)
    })
  }

  test('a null suggestion is dropped', () => {
    expect(shouldFilterSuggestion(null, 'stated_intent', 'sdk')).toBe(true)
  })

  test('a suggestion of exactly 99 characters is kept, 100 is dropped', () => {
    const atLimit = (length: number) => `run ${'x'.repeat(length - 4)}`
    expect([shouldFilterSuggestion(atLimit(99), 'user_intent'), shouldFilterSuggestion(atLimit(100), 'user_intent')]).toEqual([
      false,
      true,
    ])
  })
})

describe('generateSuggestion', () => {
  test('asks a fork that may not use tools, skips the transcript and the cache write', async () => {
    reply = modelSays('  run the tests  ')
    const controller = new AbortController()
    const result = await generateSuggestion(controller, 'user_intent', cacheSafe)
    expect(result).toEqual({ suggestion: 'run the tests', generationRequestId: null })

    const [request] = forkRequests
    expect(request?.cacheSafeParams).toBe(cacheSafe)
    expect(request?.querySource).toBe('prompt_suggestion')
    expect(request?.forkLabel).toBe('prompt_suggestion')
    expect(request?.skipTranscript).toBe(true)
    expect(request?.skipCacheWrite).toBe(true)
    expect(request?.overrides?.abortController).toBe(controller)
    expect(request?.maxOutputTokens).toBeUndefined()
    expect(request?.promptMessages).toHaveLength(1)
    const prompt = (request?.promptMessages[0] as UserMessage | undefined)?.message.content as string
    expect(prompt.startsWith('[SUGGESTION MODE: Suggest what the user might naturally type next into Claudin.]')).toBe(true)
    expect(prompt).toContain('Format: 2-12 words')
    expect(prompt.endsWith('Reply with ONLY the suggestion, no quotes or explanation.')).toBe(true)

    const decision = await request?.canUseTool(
      ...([undefined, {}, undefined, undefined, 'toolu_1'] as unknown as Parameters<ForkedAgentParams['canUseTool']>),
    )
    expect(decision).toEqual({
      behavior: 'deny',
      message: 'No tools needed for suggestion',
      decisionReason: { type: 'other', reason: 'suggestion only' },
    })
  })

  test('both prompt variants send the same prompt', async () => {
    await generateSuggestion(new AbortController(), 'user_intent', cacheSafe)
    await generateSuggestion(new AbortController(), 'stated_intent', cacheSafe)
    const [first, second] = forkRequests.map(r => (r.promptMessages[0] as UserMessage | undefined)?.message.content)
    expect(second).toBe(first)
  })

  test('takes the first non-blank text from any assistant message, and the first request id', async () => {
    reply = async () => {
      const toolCall = createAssistantMessage({
        content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} }] as never,
      })
      toolCall.requestId = 'req_first'
      const blank = said('   ')
      blank.requestId = 'req_second'
      const answer = said('commit this')
      answer.requestId = 'req_third'
      return [createUserMessage({ content: 'denied' }), toolCall, blank, answer]
    }
    expect(await generateSuggestion(new AbortController(), 'user_intent', cacheSafe)).toEqual({
      suggestion: 'commit this',
      generationRequestId: 'req_first',
    })
  })

  test('no text at all gives a null suggestion', async () => {
    reply = async () => [createUserMessage({ content: 'only a user turn' })]
    expect(await generateSuggestion(new AbortController(), 'user_intent', cacheSafe)).toEqual({
      suggestion: null,
      generationRequestId: null,
    })
  })
})

describe('tryGenerateSuggestion', () => {
  const run = (messages: Message[], state: AppState = idleState(), controller = new AbortController()) =>
    tryGenerateSuggestion(controller, messages, () => state, cacheSafe, 'cli')

  test('returns the suggestion, the prompt variant and the request id', async () => {
    reply = async () => {
      const answer = said('run the tests')
      answer.requestId = 'req_42'
      return [answer]
    }
    expect(await run(conversation())).toEqual({
      suggestion: 'run the tests',
      promptId: 'user_intent',
      generationRequestId: 'req_42',
    })
    expect(forkRequests).toHaveLength(1)
  })

  const heldBack: Array<[string, () => Promise<unknown>]> = [
    [
      'the request was already aborted',
      () => {
        const controller = new AbortController()
        controller.abort()
        return run(conversation(), idleState(), controller)
      },
    ],
    ['there is no assistant turn yet', () => run([createUserMessage({ content: 'hi' })])],
    ['the last reply was an API error', () => run(conversation(createAssistantAPIErrorMessage({ content: 'Overloaded?' })))],
    [
      'the last turn was too heavy to fork cheaply',
      () => run(conversation(heavyTurn(OFFER, { input: 90_000, cacheWrite: 0, output: 20_000 }))),
    ],
    ['the assistant did not invite a reply', () => run(conversation(said('Patched the parser and the tests pass.')))],
    ['a permission prompt is open', () => run(conversation(), idleState({ pendingWorkerRequest: {} } as Partial<AppState>))],
  ]
  for (const [when, attempt] of heldBack) {
    test(`null, without asking the model, when ${when}`, async () => {
      reply = modelSays('run the tests')
      expect(await attempt()).toBeNull()
      expect(forkRequests).toEqual([])
    })
  }

  test('one assistant turn is enough, so a resumed session gets suggestions', async () => {
    reply = modelSays('yes')
    expect((await run([said(OFFER)]))?.suggestion).toBe('yes')
  })

  test('null when the model answers nothing usable', async () => {
    for (const answer of [[], ['   '], ['looks good']]) {
      reply = modelSays(...answer)
      expect(await run(conversation())).toBeNull()
    }
    expect(forkRequests).toHaveLength(3)
  })

  test('null when the request is aborted while the model answers', async () => {
    const controller = new AbortController()
    reply = async () => {
      controller.abort()
      return [said('run the tests')]
    }
    expect(await run(conversation(), idleState(), controller)).toBeNull()
  })
})

describe('executePromptSuggestion', () => {
  function hookContext(over: Partial<REPLHookContext> = {}): { context: REPLHookContext; state: () => AppState } {
    let state = idleState()
    const toolUseContext = {
      getAppState: () => state,
      setAppState: (update: (prev: AppState) => AppState) => {
        state = update(state)
      },
    }
    const context = {
      messages: conversation(),
      systemPrompt: ['be brief'],
      userContext: { cwd: '/work' },
      systemContext: { os: 'linux' },
      toolUseContext,
      querySource: 'repl_main_thread',
      ...over,
    } as unknown as REPLHookContext
    return { context, state: () => state }
  }

  test('stores the suggestion in app state, not yet shown or accepted', async () => {
    reply = async () => {
      const answer = said('run the tests')
      answer.requestId = 'req_7'
      return [answer]
    }
    const { context, state } = hookContext()
    await executePromptSuggestion(context)
    expect(state().promptSuggestion).toEqual({
      text: 'run the tests',
      promptId: 'user_intent',
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: 'req_7',
    })
  })

  test('forks from the main thread context it was handed', async () => {
    reply = modelSays('run the tests')
    const { context } = hookContext()
    await executePromptSuggestion(context)
    const sent = forkRequests[0]?.cacheSafeParams as unknown as Record<string, unknown>
    const handed = context as unknown as Record<string, unknown>
    // The same objects, not copies: the fork must hit the parent's prompt cache.
    for (const field of ['systemPrompt', 'userContext', 'systemContext', 'toolUseContext']) {
      expect(sent[field]).toBe(handed[field])
    }
    expect(sent.forkContextMessages).toBe(context.messages)
    expect(Object.keys(sent).length).toBe(5)
  })

  test('does nothing for a turn that is not the main thread', async () => {
    for (const querySource of ['agent:custom', undefined]) {
      reply = modelSays('run the tests')
      const { context, state } = hookContext({ querySource: querySource as REPLHookContext['querySource'] })
      await executePromptSuggestion(context)
      expect(state().promptSuggestion.text).toBeNull()
    }
    expect(forkRequests).toEqual([])
  })

  test('leaves app state alone when the suggestion is held back', async () => {
    reply = modelSays('looks good')
    const { context, state } = hookContext()
    await executePromptSuggestion(context)
    expect(forkRequests).toHaveLength(1)
    expect(state().promptSuggestion.text).toBeNull()
  })

  test('abortPromptSuggestion cancels the one in flight', async () => {
    let signal: AbortSignal | undefined
    reply = async request => {
      signal = request.overrides?.abortController?.signal
      abortPromptSuggestion()
      return [said('run the tests')]
    }
    const { context, state } = hookContext()
    await executePromptSuggestion(context)
    expect(signal?.aborted).toBe(true)
    expect(state().promptSuggestion.text).toBeNull()
    // Nothing is left in flight to abort afterwards.
    expect(() => abortPromptSuggestion()).not.toThrow()
  })

  test('a fork that fails, aborted or otherwise, is swallowed', async () => {
    for (const name of ['AbortError', 'APIUserAbortError', 'Error']) {
      reply = async () => {
        const failure = new Error('fork failed')
        failure.name = name
        throw failure
      }
      const { context, state } = hookContext()
      await expect(executePromptSuggestion(context)).resolves.toBeUndefined()
      expect(state().promptSuggestion.text).toBeNull()
    }
    reply = async () => {
      throw 'not an Error'
    }
    const { context } = hookContext()
    await expect(executePromptSuggestion(context)).resolves.toBeUndefined()
  })
})

describe('the outcome loggers', () => {
  test('return nothing and throw nothing', () => {
    expect(logSuggestionOutcome('run the tests', 'run the tests', Date.now() - 500, 'user_intent', 'req_1')).toBeUndefined()
    expect(logSuggestionOutcome('', 'x', Date.now() + 500, 'stated_intent', null)).toBeUndefined()
    expect(logSuggestionSuppressed('timing', 'run the tests', 'user_intent', 'cli')).toBeUndefined()
    expect(logSuggestionSuppressed('aborted')).toBeUndefined()
  })
})
