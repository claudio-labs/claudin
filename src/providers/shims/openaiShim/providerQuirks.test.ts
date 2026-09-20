// Per-provider quirks: Moonshot, Kimi Code and DeepSeek each want a different
// shape for reasoning echo and thinking controls.

import type Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'

import {
  createOpenAIShimClient,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'

useShimHarness()

test('Moonshot: uses max_tokens (not max_completion_tokens) and strips store', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.moonshot.ai/v1'
  process.env.OPENAI_API_KEY = 'sk-moonshot-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-k2.6',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'kimi-k2.6',
    system: 'you are kimi',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    stream: false,
  })

  expect(requestBody?.max_tokens).toBe(256)
  expect(requestBody?.max_completion_tokens).toBeUndefined()
  expect(requestBody?.store).toBeUndefined()
})

test('Moonshot: echoes reasoning_content on assistant tool-call messages', async () => {
  // Regression for: "API Error: 400 {"error":{"message":"thinking is enabled
  // but reasoning_content is missing in assistant tool call message at index
  // N"}}" when the agent sends a prior-turn assistant response back to Kimi.
  // The thinking block captured from the inbound response must round-trip
  // as reasoning_content on the outgoing echoed assistant message.
  process.env.OPENAI_BASE_URL = 'https://api.moonshot.ai/v1'
  process.env.OPENAI_API_KEY = 'sk-moonshot-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-k2.6',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'kimi-k2.6',
    system: 'you are kimi',
    messages: [
      { role: 'user', content: 'check the logs' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Need to inspect logs via Bash; running a cat.',
          },
          { type: 'text', text: "I'll inspect the logs." },
          {
            type: 'tool_use',
            id: 'call_bash_1',
            name: 'Bash',
            input: { command: 'cat /tmp/app.log' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_bash_1',
            content: 'log line 1\nlog line 2',
          },
        ],
      },
    ],
    max_tokens: 256,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  expect(assistantWithToolCall?.reasoning_content).toBe(
    'Need to inspect logs via Bash; running a cat.',
  )
})

test('Moonshot: sets empty reasoning_content when thinking block was stripped', async () => {
  // After stripOldThinkingBlocks removes old thinking blocks, assistant
  // messages with tool_use lack a thinking block. Moonshot requires
  // reasoning_content on every assistant tool-call message — empty string
  // prevents the 400 "reasoning_content is missing" error.
  process.env.OPENAI_BASE_URL = 'https://api.moonshot.ai/v1'
  process.env.OPENAI_API_KEY = 'sk-moonshot-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-k2.6',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'kimi-k2.6',
    system: 'you are kimi',
    messages: [
      { role: 'user', content: 'check the logs' },
      {
        role: 'assistant',
        content: [
          // No thinking block — it was stripped by stripOldThinkingBlocks
          { type: 'text', text: '[thinking omitted]' },
          {
            type: 'tool_use',
            id: 'call_bash_1',
            name: 'Bash',
            input: { command: 'cat /tmp/app.log' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_bash_1',
            content: 'log line 1\nlog line 2',
          },
        ],
      },
    ],
    max_tokens: 256,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  expect(assistantWithToolCall?.reasoning_content).toBe('')
})

test('DeepSeek echoes reasoning_content on assistant tool-call messages', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-deepseek'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'deepseek-v4-flash',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'deepseek-v4-flash',
    system: 'test',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought' },
          { type: 'text', text: 'hello' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'files' },
        ],
      },
    ],
    max_tokens: 32,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  expect(assistantWithToolCall?.reasoning_content).toBe('thought')
})

test('generic OpenAI-compatible providers do not echo reasoning_content on assistant tool-call messages', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'sk-openai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought' },
          { type: 'text', text: 'hello' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'files' },
        ],
      },
    ],
    max_tokens: 32,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  expect(assistantWithToolCall?.reasoning_content).toBeUndefined()
})

test('Moonshot: cn host is also detected', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.moonshot.cn/v1'
  process.env.OPENAI_API_KEY = 'sk-moonshot-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-k2.6',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'kimi-k2.6',
    system: 'you are kimi',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    stream: false,
  })

  expect(requestBody?.store).toBeUndefined()
})

test('Kimi Code endpoint inherits Moonshot max_tokens/store compatibility', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  process.env.OPENAI_API_KEY = 'sk-kimi-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-for-coding',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'kimi-for-coding',
    system: 'you are kimi code',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    stream: false,
  })

  expect(requestBody?.max_tokens).toBe(256)
  expect(requestBody?.max_completion_tokens).toBeUndefined()
  expect(requestBody?.store).toBeUndefined()
})

test('Kimi Code endpoint echoes reasoning_content on assistant tool-call messages', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  process.env.OPENAI_API_KEY = 'sk-kimi-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-for-coding',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'kimi-for-coding',
    system: 'you are kimi code',
    messages: [
      { role: 'user', content: 'check the logs' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Need to inspect logs via Bash; running a cat.',
          },
          { type: 'text', text: "I'll inspect the logs." },
          {
            type: 'tool_use',
            id: 'call_bash_1',
            name: 'Bash',
            input: { command: 'cat /tmp/app.log' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_bash_1',
            content: 'log line 1\nlog line 2',
          },
        ],
      },
    ],
    max_tokens: 256,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  expect(assistantWithToolCall?.reasoning_content).toBe(
    'Need to inspect logs via Bash; running a cat.',
  )
})

test('DeepSeek sends thinking toggle and normalized reasoning effort', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-deepseek'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'deepseek-v4-pro',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({
    reasoningEffort: 'xhigh',
  }) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'deepseek-v4-pro',
    system: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
    thinking: { type: 'enabled' },
  })

  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBe('max')
  expect(requestBody?.max_tokens).toBe(64)
  expect(requestBody?.max_completion_tokens).toBeUndefined()
  expect(requestBody?.store).toBeUndefined()
})

test('DeepSeek omits thinking controls when the Anthropic-side request does not set them', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-deepseek'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'deepseek-v4-flash',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'deepseek-v4-flash',
    system: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32,
    stream: false,
  })

  expect(requestBody?.thinking).toBeUndefined()
  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('DeepSeek forwards an explicit thinking disable toggle for V4 models', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-deepseek'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'deepseek-v4-flash',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'deepseek-v4-flash',
    system: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32,
    stream: false,
    thinking: { type: 'disabled' },
  })

  expect(requestBody?.thinking).toEqual({ type: 'disabled' })
  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('Kimi Code K3 sends thinking.effort from per-request effortValue', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  process.env.OPENAI_API_KEY = 'sk-kimi-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'k3',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'k3',
    system: 'you are kimi code',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    stream: false,
    effortValue: 'max',
  })

  expect(requestBody?.thinking).toEqual({
    type: 'enabled',
    effort: 'max',
    keep: 'all',
  })
  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('Kimi Code non-K3 models do not send thinking.effort', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  process.env.OPENAI_API_KEY = 'sk-kimi-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-for-coding',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'kimi-for-coding',
    system: 'you are kimi code',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    stream: false,
    effortValue: 'high',
  })

  expect(requestBody?.thinking).toBeUndefined()
  expect(requestBody?.reasoning_effort).toBeUndefined()
})
