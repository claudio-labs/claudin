/**
 * What every provider that is NOT the ChatGPT Codex backend receives, pinned so
 * the Codex reasoning replay cannot move it.
 *
 * The replay (reasoning items, real item ids, `phase`, `include`,
 * `reasoning.context`, `text.verbosity`) lives behind the Codex backend gate.
 * The functions it hooks into are shared: GitHub Copilot sends its GPT-5+
 * models through the same Responses body builder and stream reader, the
 * official OpenAI API reads the same model catalog, and every provider renders
 * and resumes through the same message pipeline. Each case here is one of those
 * shared points, called the way the other provider calls it, with the bytes it
 * gets today written out by hand.
 *
 * The history in these cases already carries Codex item state (`codex` on a
 * block). A provider other than the Codex backend must ignore it.
 *
 * Providers are switched through the real resolver: under `bun test` the
 * global config lives in memory, so a profile written with saveGlobalConfig is
 * the one tryGetActiveProvider resolves. No module is mocked.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { _resetCacheProfileForTesting, getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { resetModelStringsForTestingOnly } from 'src/platform/bootstrap/state.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { getModelOptions } from 'src/providers/model/modelOptions.js'
import {
  getOpenAIContextWindow,
  getOpenAIMaxOutputTokens,
} from 'src/providers/model/openaiContextWindows.js'
import { getAPIProvider } from 'src/providers/model/providers.js'
import { resolveShimEffortValues } from 'src/providers/model/reasoningCatalog.js'
import {
  invalidateActiveProviderCache,
  tryGetActiveProvider,
} from 'src/providers/presets/activeProvider.js'
import { renderMessagesForAPI, historyRedactions } from 'src/providers/shims/claude/renderMessages.js'
import { _resetReplayTrustForTesting } from 'src/providers/shims/codex/items.js'
import { isThinkingBlockMismatchError } from 'src/providers/transport/withRetry.js'
import { deserializeMessages } from 'src/sessions/conversationRecovery.js'
import type { Message } from 'src/shared/types/message.js'

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
}

const {
  codexStreamToAnthropic,
  convertCodexResponseToAnthropicMessage,
  performCodexRequest,
} = await import('src/providers/shims/codexShim.js')

const ANTHROPIC: ProviderProfile = {
  id: 'neutral-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
}
const OPENAI: ProviderProfile = {
  id: 'neutral-openai',
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6-terra',
  apiKey: 'sk-neutral',
}
const COPILOT: ProviderProfile = {
  id: 'neutral-copilot',
  name: 'Copilot',
  provider: 'openai',
  baseUrl: 'https://api.githubcopilot.com',
  model: 'gpt-5.5',
  extras: { githubToken: 'gh-neutral' },
}
const LOCAL: ProviderProfile = {
  id: 'neutral-local',
  name: 'Local proxy',
  provider: 'openai',
  baseUrl: 'http://localhost:8000/v1',
  model: 'gpt-6-luna',
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
  _resetCacheProfileForTesting()
  resetModelStringsForTestingOnly()
}

beforeEach(() => {
  _resetReplayTrustForTesting()
})

afterEach(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
  _resetReplayTrustForTesting()
})

afterAll(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

/** An assistant turn the Codex backend produced: reasoning, commentary, a call. */
const CODEX_ASSISTANT_BLOCKS = [
  { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_1', encrypted_content: 'enc-1' } },
  { type: 'text', text: 'Reading.', codex: { id: 'msg_1', phase: 'commentary' } },
  { type: 'tool_use', id: 'call_abc', name: 'Read', input: { file_path: '/x' }, codex: { id: 'fc_real' } },
]

const READ_TOOL = {
  name: 'Read',
  description: 'Reads a file.',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
}

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
}

/** A Responses stream with a reasoning item, a commentary message and a call. */
const RESPONSES_STREAM = [
  sse('response.output_item.added', { output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
  sse('response.output_item.done', {
    output_index: 0,
    item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
  }),
  sse('response.output_item.added', {
    output_index: 1,
    item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: 'commentary' },
  }),
  sse('response.content_part.added', { item_id: 'msg_1', part: { type: 'output_text', text: '' } }),
  sse('response.output_text.delta', { item_id: 'msg_1', delta: 'Reading.' }),
  sse('response.output_item.done', {
    output_index: 1,
    item: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Reading.' }],
      phase: 'commentary',
    },
  }),
  sse('response.output_item.added', {
    output_index: 2,
    item: { id: 'fc_real', type: 'function_call', call_id: 'call_abc', name: 'Read', arguments: '' },
  }),
  sse('response.function_call_arguments.delta', { item_id: 'fc_real', delta: '{"file_path":"/x"}' }),
  sse('response.output_item.done', {
    output_index: 2,
    item: {
      id: 'fc_real',
      type: 'function_call',
      call_id: 'call_abc',
      name: 'Read',
      arguments: '{"file_path":"/x"}',
      status: 'completed',
    },
  }),
]
const COMPLETED = sse('response.completed', {
  response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5 } },
})

function streamOf(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
  )
}

/** The Anthropic events a stream becomes, minus the per-run message id and usage. */
async function anthropicEventsOf(text: string): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const event of codexStreamToAnthropic(streamOf(text), 'gpt-5.5')) {
    if (event.type === 'message_start') out.push({ type: event.type })
    else if (event.type === 'message_delta') out.push({ type: event.type, delta: event.delta })
    else out.push(event)
  }
  return out
}

describe('the provider each profile resolves to', () => {
  test.each([
    [ANTHROPIC, 'anthropic', 'firstParty', 'retain'],
    [OPENAI, 'openai_compat', 'openai', 'retain'],
    [COPILOT, 'github_copilot', 'github', 'retain'],
    [LOCAL, 'openai_compat', 'openai', 'aggressive'],
  ] as const)('%#: %o', (profile, transport, provider, cacheProfile) => {
    useProfile(profile)
    expect(tryGetActiveProvider()?.transport).toBe(transport)
    expect(getAPIProvider()).toBe(provider)
    expect(getCacheProfile().name).toBe(cacheProfile)
  })
})

describe('GitHub Copilot on the Responses API', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('the request body ignores Codex item state and carries no Codex-only field', async () => {
    let body: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>
      return new Response('', { status: 200 })
    }) as typeof fetch

    await performCodexRequest({
      request: {
        transport: 'codex_responses',
        requestedModel: 'gpt-5.5',
        resolvedModel: 'gpt-5.5',
        baseUrl: 'https://api.githubcopilot.com',
        reasoning: { effort: 'high' },
      },
      credentials: { apiKey: 'gh-neutral', source: 'env' },
      params: {
        model: 'gpt-5.5',
        system: 'You are terse.',
        messages: [
          { role: 'user', content: 'read it' },
          { role: 'assistant', content: CODEX_ASSISTANT_BLOCKS },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: 'numbers' }] },
        ],
        tools: [READ_TOOL],
        max_tokens: 1024,
      },
      defaultHeaders: {},
    })

    expect(Object.keys(body ?? {}).sort()).toEqual([
      'input',
      'instructions',
      'model',
      'parallel_tool_calls',
      'reasoning',
      'store',
      'stream',
      'tool_choice',
      'tools',
    ])
    expect(body?.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
      { type: 'function_call', id: 'fc_abc', call_id: 'call_abc', name: 'Read', arguments: '{"file_path":"/x"}' },
      { type: 'function_call_output', call_id: 'call_abc', output: 'numbers' },
    ])
    expect(body?.instructions).toBe('You are terse.')
    expect(body?.model).toBe('gpt-5.5')
    expect(body?.parallel_tool_calls).toBe(true)
    expect(body?.reasoning).toEqual({ effort: 'high' })
    expect(body?.store).toBe(false)
    expect(body?.stream).toBe(true)
    expect(body?.tool_choice).toBe('auto')
    expect((body?.tools as unknown[]).length).toBe(1)
  })

  test('a stream with reasoning items reads as text and a tool call, nothing else', async () => {
    expect(await anthropicEventsOf(RESPONSES_STREAM.join('') + COMPLETED)).toEqual([
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading.' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call_abc', name: 'Read', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
      { type: 'message_stop' },
    ])
  })

  test('an error event in a stream that still completes changes nothing', async () => {
    const withError =
      RESPONSES_STREAM.join('') +
      sse('error', { error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' } }) +
      COMPLETED
    expect(await anthropicEventsOf(withError)).toEqual(
      await anthropicEventsOf(RESPONSES_STREAM.join('') + COMPLETED),
    )
  })

  test('a completed response with reasoning converts to text and a tool call', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.5',
        output: [
          { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'Reading.' }],
          },
          { id: 'fc_real', type: 'function_call', call_id: 'call_abc', name: 'Read', arguments: '{"file_path":"/x"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      'gpt-5.5',
    )
    expect(message.content).toEqual([
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'call_abc', name: 'Read', input: { file_path: '/x' } },
    ])
    expect(message.stop_reason).toBe('tool_use')
  })
})

describe('the shared message pipeline', () => {
  const anthropicThinking = { type: 'thinking', thinking: 'deep', signature: 'sig-anthropic' }

  function history(): Message[] {
    return [
      createUserMessage({ content: 'hi' }),
      createAssistantMessage({
        content: [anthropicThinking, { type: 'text', text: 'answer', citations: [] }] as never,
      }),
      createUserMessage({ content: 'and then?' }),
    ]
  }

  test.each([ANTHROPIC, OPENAI, COPILOT, LOCAL])(
    'a Codex session continued under %o renders no Codex state',
    profile => {
      useProfile(profile)
      const { messages } = renderMessagesForAPI(
        [
          createUserMessage({ content: 'hi' }),
          createAssistantMessage({ content: CODEX_ASSISTANT_BLOCKS as never }),
          createUserMessage({
            content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: 'numbers' }] as never,
          }),
        ],
        [],
        { useToolSearch: false, advisor: false, ...historyRedactions() },
      )
      const wire = JSON.stringify(messages.map(m => m.message.content))
      expect(wire).not.toContain('"codex"')
      expect(wire).not.toContain('enc-1')
      const assistant = messages.find(m => m.type === 'assistant')
      expect((assistant?.message.content as Array<{ type: string }>).map(block => block.type)).toEqual([
        'text',
        'tool_use',
      ])
    },
  )

  test('Anthropic renders its own thinking block byte for byte', () => {
    useProfile(ANTHROPIC)
    const { messages } = renderMessagesForAPI(history(), [], {
      useToolSearch: false,
      advisor: false,
      ...historyRedactions(),
    })
    const assistant = messages.find(m => m.type === 'assistant')
    expect(assistant?.message.content[0]).toEqual(anthropicThinking as never)
  })

  test.each([
    [ANTHROPIC, ['thinking', 'text']],
    [OPENAI, ['text']],
    [COPILOT, ['text']],
    [LOCAL, ['text']],
  ] as const)('resume under %o keeps the thinking blocks it kept before', (profile, kinds) => {
    useProfile(profile)
    const restored = deserializeMessages(history())
    const assistant = restored.find(m => m.type === 'assistant')
    expect(
      (assistant?.message.content as Array<{ type: string }>).map(block => block.type),
    ).toEqual([...kinds])
  })

  test.each([
    ['messages.1.content.0: Invalid `signature` in `thinking` block', 400, true],
    ['messages.3: `thinking` blocks in the latest assistant message cannot be modified', 400, true],
    ['prompt is too long: 210000 tokens > 200000 maximum', 400, false],
    ['Invalid `signature` in `thinking` block', 500, false],
  ] as const)('the retry reads "%s" (%d) as a thinking mismatch: %p', (message, status, verdict) => {
    const error = APIError.generate(status, { error: { message } }, message, new Headers())
    expect(isThinkingBlockMismatchError(error)).toBe(verdict)
  })
})

describe('the model catalog the OpenAI API reads', () => {
  test('context windows and output limits', () => {
    useProfile(OPENAI)
    expect(getOpenAIContextWindow('gpt-5.6-terra')).toBe(1_050_000)
    expect(getOpenAIContextWindow('gpt-5.6-luna')).toBe(1_050_000)
    expect(getOpenAIContextWindow('gpt-5.6-sol')).toBe(1_050_000)
    // gpt-6-luna has no published API window; the ChatGPT account's stands in.
    expect(getOpenAIContextWindow('gpt-6-luna')).toBe(272_000)
    expect(getOpenAIMaxOutputTokens('gpt-5.6-terra')).toBe(128_000)
    expect(getOpenAIMaxOutputTokens('gpt-6-luna')).toBe(128_000)
  })

  test.each([
    ['https://api.openai.com/v1', 'gpt-5.6-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['https://api.openai.com/v1', 'gpt-6-luna', undefined],
    ['http://localhost:8000/v1', 'gpt-5.6-terra', ['low', 'medium', 'high', 'xhigh']],
    ['http://localhost:8000/v1', 'gpt-6-luna', undefined],
  ] as const)('effort levels for %s %s', (baseUrl, model, levels) => {
    expect(resolveShimEffortValues(baseUrl, model)).toEqual(levels as never)
  })

  test.each([
    [OPENAI, [null, 'gpt-5.6-terra']],
    [
      COPILOT,
      [
        null,
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.2-codex',
        'gpt-5-mini',
        'gpt-4o',
        'gpt-4.1',
        'claude-opus-4.7',
        'claude-sonnet-4.6',
        'claude-haiku-4.5',
        'gemini-3.1-pro-preview',
        'grok-code-fast-1',
      ],
    ],
  ] as const)('the /model picker under %o', (profile, values) => {
    useProfile(profile)
    expect(getModelOptions(false).map(option => option.value)).toEqual([...values])
  })
})
