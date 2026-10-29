// The native Gemini transport end to end through the shim client: what goes on
// the wire, and what comes back as Anthropic events. Same harness as the
// openaiShim suites, so the active profile comes from the CLAUDIN_USE_GEMINI /
// GEMINI_* envs.

import { describe, expect, test } from 'bun:test'

import {
  createOpenAIShimClient,
  makeSseResponse,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'

useShimHarness()

const NATIVE_BASE = 'https://generativelanguage.googleapis.com/v1beta'

type Captured = { url: string; headers: Record<string, string>; body: Record<string, any> }

function useGemini(baseUrl = NATIVE_BASE, model = 'gemini-3-flash-preview'): void {
  process.env.CLAUDIN_USE_GEMINI = '1'
  process.env.GEMINI_BASE_URL = baseUrl
  process.env.GEMINI_MODEL = model
  process.env.GEMINI_API_KEY = 'gemini-test-key'
}

function captureFetch(respond: () => Response): Captured[] {
  const calls: Captured[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    })
    return respond()
  }) as FetchType
  return calls
}

function sse(chunks: unknown[]): Response {
  return makeSseResponse(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`))
}

async function collect(stream: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = []
  for await (const event of stream) events.push(event)
  return events
}

const client = () => createOpenAIShimClient({}) as OpenAIShimClient

describe('the native Gemini request', () => {
  test('streams from models/{m}:streamGenerateContent with the API key header', async () => {
    useGemini()
    const calls = captureFetch(() => sse([{ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }]))

    const response = await client().beta.messages.create({
      model: 'gemini-3-flash-preview',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'Read',
          description: 'read a file',
          input_schema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ],
      max_tokens: 1024,
      stream: true,
    }).withResponse()
    await collect(response.data)

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.url).toBe(`${NATIVE_BASE}/models/gemini-3-flash-preview:streamGenerateContent?alt=sse`)
    expect(call!.headers['x-goog-api-key']).toBe('gemini-test-key')
    expect(call!.headers.Authorization).toBeUndefined()
    expect(call!.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemInstruction: { parts: [{ text: 'be brief' }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'Read',
              description: 'read a file',
              parametersJsonSchema: {
                type: 'object',
                properties: { file_path: { type: 'string' } },
                required: ['file_path'],
              },
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
      },
    })
  })

  test('replays history: signatures on calls, no thinking text, responses under the call name', async () => {
    useGemini()
    const calls = captureFetch(() => sse([{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]))

    const response = await client().beta.messages.create({
      model: 'gemini-3-flash-preview',
      messages: [
        { role: 'user', content: 'read two files' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should read both.', signature: 'sig-thought' },
            { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: '/a' }, signature: 'sig-a' },
            { type: 'tool_use', id: 'call_b', name: 'Read', input: { file_path: '/b' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_a', content: 'A' },
            { type: 'tool_result', tool_use_id: 'call_b', content: [{ type: 'text', text: 'boom' }], is_error: true },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_c', name: 'Read', input: { file_path: '/c' } }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_c', content: 'C' }] },
      ],
      max_tokens: 64,
      stream: true,
    }).withResponse()
    await collect(response.data)

    expect(calls[0]!.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'read two files' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'call_a', name: 'Read', args: { file_path: '/a' } }, thoughtSignature: 'sig-a' },
          { functionCall: { id: 'call_b', name: 'Read', args: { file_path: '/b' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call_a', name: 'Read', response: { output: 'A' } } },
          { functionResponse: { id: 'call_b', name: 'Read', response: { error: 'boom' } } },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'call_c', name: 'Read', args: { file_path: '/c' } },
            thoughtSignature: 'skip_thought_signature_validator',
          },
        ],
      },
      { role: 'user', parts: [{ functionResponse: { id: 'call_c', name: 'Read', response: { output: 'C' } } }] },
    ])
  })

  test('a profile on the OpenAI-compatible endpoint keeps Chat Completions', async () => {
    useGemini('https://generativelanguage.googleapis.com/v1beta/openai')
    const calls = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            model: 'gemini-3-flash-preview',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    )
    await client().beta.messages.create({
      model: 'gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      stream: false,
    })
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  })

  // The compat surface lives under /openai, so a profile stored with the
  // native URL must not post to /v1beta/chat/completions.
  test('CLAUDIN_GEMINI_NATIVE=0 sends a native profile to the OpenAI-compatible endpoint', async () => {
    useGemini()
    process.env.CLAUDIN_GEMINI_NATIVE = '0'
    try {
      const calls = captureFetch(
        () =>
          new Response(
            JSON.stringify({
              id: 'chatcmpl-1',
              model: 'gemini-3-flash-preview',
              choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      )
      await client().beta.messages.create({
        model: 'gemini-3-flash-preview',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
        stream: false,
      })
      expect(calls[0]!.url).toBe(`${NATIVE_BASE}/openai/chat/completions`)
    } finally {
      delete process.env.CLAUDIN_GEMINI_NATIVE
    }
  })

  test('an HTTP error becomes an APIError with the status and the body', async () => {
    useGemini()
    captureFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }), {
          status: 429,
        }),
    )
    const error = await client()
      .beta.messages.create({
        model: 'gemini-3-flash-preview',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
        stream: false,
      })
      .catch((e: unknown) => e)
    expect((error as { status?: number }).status).toBe(429)
    expect(String((error as Error).message)).toContain('Resource exhausted')
  })
})

describe('the native Gemini reply', () => {
  test('thoughts, text and a call stream as Anthropic blocks, with signatures and usage', async () => {
    useGemini()
    captureFetch(() =>
      sse([
        { candidates: [{ content: { role: 'model', parts: [{ text: '**Planning**', thought: true }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Reading it.', thoughtSignature: 'sig-1' }] } }] },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'Read', args: { file_path: '/x' } }, thoughtSignature: 'sig-2' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 1000,
            cachedContentTokenCount: 800,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 30,
          },
        },
      ]),
    )

    const response = await client().beta.messages.create({
      model: 'gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'read /x' }],
      max_tokens: 64,
      stream: true,
    }).withResponse()
    const events = await collect(response.data)

    const toolStart = events.find(
      e => e.type === 'content_block_start' && (e.content_block as { type: string }).type === 'tool_use',
    )!
    expect(events.map(e => e.type === 'content_block_delta' ? (e.delta as { type: string }).type : e.type)).toEqual([
      'message_start',
      'content_block_start',
      'thinking_delta',
      'signature_delta',
      'content_block_stop',
      'content_block_start',
      'text_delta',
      'content_block_stop',
      'content_block_start',
      'input_json_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[3]).toMatchObject({ delta: { type: 'signature_delta', signature: 'sig-1' } })
    expect(toolStart.content_block).toMatchObject({ type: 'tool_use', name: 'Read', signature: 'sig-2' })
    expect(events.at(-2)).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 200, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 },
    })
  })

  test('an empty MALFORMED_FUNCTION_CALL reply is an error the stream retry picks up', async () => {
    useGemini()
    captureFetch(() => sse([{ candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] }]))
    const response = await client().beta.messages.create({
      model: 'gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 64,
      stream: true,
    }).withResponse()
    const error = await collect(response.data).catch((e: unknown) => e)
    expect((error as { status?: number }).status).toBe(500)
    expect(String((error as Error).message)).toContain('MALFORMED_FUNCTION_CALL')
  })

  test('the non-streaming body converts to one Anthropic message', async () => {
    useGemini()
    const calls = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            responseId: 'resp-1',
            modelVersion: 'gemini-3-flash-preview',
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'think', thought: true },
                    { text: 'Done.', thoughtSignature: 'sig-t' },
                  ],
                },
                finishReason: 'MAX_TOKENS',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const message = await client().beta.messages.create({
      model: 'gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 64,
      stream: false,
    })
    expect(calls[0]!.url).toBe(`${NATIVE_BASE}/models/gemini-3-flash-preview:generateContent`)
    expect(message).toEqual({
      id: 'resp-1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'think', signature: 'sig-t' },
        { type: 'text', text: 'Done.' },
      ],
      model: 'gemini-3-flash-preview',
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
  })

  test('a blocked prompt is a 400 with the reason', async () => {
    useGemini()
    captureFetch(
      () =>
        new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const error = await client()
      .beta.messages.create({
        model: 'gemini-3-flash-preview',
        messages: [{ role: 'user', content: 'go' }],
        max_tokens: 64,
        stream: false,
      })
      .catch((e: unknown) => e)
    expect((error as { status?: number }).status).toBe(400)
    expect(String((error as Error).message)).toContain('SAFETY')
  })
})
