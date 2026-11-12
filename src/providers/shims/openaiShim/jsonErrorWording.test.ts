// An OpenAI-compatible error now carries its category marker even when the
// body is JSON, so it reaches the per-category messages. Those used to replace
// the server's own words with a generic hint; errorDetails is shown nowhere,
// so the words have to stay on the line itself.

import { expect, test } from 'bun:test'
import type { APIError } from '@anthropic-ai/sdk'

import { getAssistantMessageFromError } from 'src/providers/transport/errors.js'
import {
  createOpenAIShimClient,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'

useShimHarness()

async function shimErrorFor(status: number, body: unknown): Promise<APIError> {
  process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1'
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as FetchType
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  return client.beta.messages
    .create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
    .then(
      () => {
        throw new Error('expected a rejection')
      },
      (e: unknown) => e as APIError,
    )
}

function shown(error: unknown): string {
  const message = getAssistantMessageFromError(error, 'deepseek-chat')
  const content = message.message.content as Array<{ text?: string }>
  return content[0]?.text ?? ''
}

test('a JSON 400 about a dangling tool_call_id shows the server wording', async () => {
  const error = await shimErrorFor(400, {
    error: {
      message:
        "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: call_abc",
      type: 'invalid_request_error',
    },
  })
  expect(shown(error)).toContain('call_abc')
})

test('a JSON 500 shows the server wording', async () => {
  const error = await shimErrorFor(500, { error: { message: 'CUDA out of memory. Tried to allocate 2.00 GiB' } })
  expect(shown(error)).toContain('CUDA out of memory')
})

test('a JSON 401 shows the server wording', async () => {
  const error = await shimErrorFor(401, {
    error: { message: 'Incorrect API key provided: sk-abc***', code: 'invalid_api_key' },
  })
  expect(shown(error)).toContain('Incorrect API key provided')
})

test('the wording carries neither the marker, the hint nor the JSON envelope', async () => {
  const error = await shimErrorFor(500, { error: { message: 'CUDA out of memory' } })
  const text = shown(error)
  expect(text).not.toContain('openai_category')
  expect(text).not.toContain('Hint:')
  expect(text).not.toContain('{"error"')
})

for (const wording of [
  '`max_tokens` exceeds the limit of 8192 for this model',
  'Number of tools exceeds the limit of 128',
  'Your monthly token limit exceeded. Upgrade your plan.',
]) {
  test(`a JSON 400 "${wording}" is not reported as prompt-too-long`, async () => {
    const error = await shimErrorFor(400, { error: { message: wording } })
    expect(shown(error).startsWith('Prompt is too long')).toBe(false)
  })
}
