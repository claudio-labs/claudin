import { describe, expect, test } from 'bun:test'
import {
  buildGeminiRequestBody,
  convertMessagesToGeminiContents,
} from 'src/providers/shims/gemini/request.js'

const PNG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }
const inline = { inlineData: { mimeType: 'image/png', data: 'iVBOR' } }

function screenshotHistory() {
  return [
    { role: 'user', content: 'look' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Screenshot', input: {}, signature: 's' }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'here' }, PNG] }],
    },
  ]
}

describe('convertMessagesToGeminiContents', () => {
  test('Gemini 3: an image in a tool result travels inside the response', () => {
    expect(convertMessagesToGeminiContents(screenshotHistory(), 'gemini-3-flash-preview')[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'Screenshot', response: { output: 'here' }, parts: [inline] } }],
    })
  })

  test('earlier models: next to the response', () => {
    expect(convertMessagesToGeminiContents(screenshotHistory(), 'gemini-2.5-pro')[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'Screenshot', response: { output: 'here' } } }, inline],
    })
  })

  test('user media: base64 images and PDFs inline, URLs as file data, text documents as text', () => {
    const [content] = convertMessagesToGeminiContents(
      [
        {
          role: 'user',
          content: [
            PNG,
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
            { type: 'document', source: { type: 'text', data: 'plain' } },
            { type: 'text', text: '' },
          ],
        },
      ],
      'gemini-3-flash-preview',
    )
    expect(content!.parts).toEqual([
      inline,
      { inlineData: { mimeType: 'application/pdf', data: 'JVBER' } },
      { fileData: { fileUri: 'https://example.com/a.png' } },
      { text: 'plain' },
    ])
  })

  test('a turn that thought and answered in text: the thought signature rides the first text part', () => {
    const contents = convertMessagesToGeminiContents(
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig-t' },
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'again' },
          ],
        },
      ],
      'gemini-3-flash-preview',
    )
    expect(contents[1]).toEqual({ role: 'model', parts: [{ text: 'Hello', thoughtSignature: 'sig-t' }, { text: 'again' }] })
  })

  test('a call keeps the signature an OpenAI-compatible session stored in extra_content', () => {
    const contents = convertMessagesToGeminiContents(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'c1', name: 'Bash', input: {}, extra_content: { google: { thought_signature: 'sig-compat' } } },
          ],
        },
      ],
      'gemini-3-flash-preview',
    )
    expect(contents[1]!.parts[0]).toMatchObject({ thoughtSignature: 'sig-compat' })
  })

  test('a turn left empty is skipped and its neighbours merge; internal messages are read too', () => {
    const contents = convertMessagesToGeminiContents(
      [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] },
        { message: { role: 'user', content: 'two' } },
      ],
      'gemini-3-flash-preview',
    )
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'one' }, { text: 'two' }] }])
  })

  test('a result for a call the history does not hold goes out as "unknown"', () => {
    const contents = convertMessagesToGeminiContents(
      [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] }],
      'gemini-3-flash-preview',
    )
    expect(contents[0]!.parts[0]).toEqual({ functionResponse: { id: 'gone', name: 'unknown', response: { output: 'x' } } })
  })
})

describe('buildGeminiRequestBody', () => {
  const base = { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const tools = [
    { name: 'Read', description: 'r', input_schema: { type: 'object', properties: {} } },
    { type: 'web_search_20250305', name: 'web_search' },
  ]

  test('server tools are dropped; tool_choice maps to functionCallingConfig', () => {
    const body = buildGeminiRequestBody(
      { ...base, tools, tool_choice: { type: 'tool', name: 'Read' } },
      { model: 'gemini-2.5-flash', baseUrl: undefined, effort: 'low' },
    )
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: 'Read', description: 'r', parametersJsonSchema: { type: 'object', properties: {} } }] }])
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['Read'] } })
  })

  test.each([
    ['auto', { functionCallingConfig: { mode: 'AUTO' } }],
    ['any', { functionCallingConfig: { mode: 'ANY' } }],
    ['none', { functionCallingConfig: { mode: 'NONE' } }],
  ])('tool_choice %s', (type, expected) => {
    const body = buildGeminiRequestBody({ ...base, tools, tool_choice: { type } }, { model: 'gemini-2.5-flash', baseUrl: undefined, effort: undefined })
    expect(body.toolConfig).toEqual(expected)
  })

  test('no tools: no tools and no toolConfig', () => {
    const body = buildGeminiRequestBody({ ...base, tool_choice: { type: 'auto' } }, { model: 'gemini-2.5-flash', baseUrl: undefined, effort: undefined })
    expect(body.tools).toBeUndefined()
    expect(body.toolConfig).toBeUndefined()
  })

  test('sampling and the effort reach generationConfig; disabled thinking turns summaries off', () => {
    expect(
      buildGeminiRequestBody(
        { ...base, temperature: 0.2, top_p: 0.9 },
        { model: 'gemini-2.5-flash', baseUrl: undefined, effort: 'low' },
      ).generationConfig,
    ).toEqual({ maxOutputTokens: 100, temperature: 0.2, topP: 0.9, thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } })
    expect(
      buildGeminiRequestBody(
        { ...base, thinking: { type: 'disabled' } },
        { model: 'gemini-2.5-flash', baseUrl: undefined, effort: 'high' },
      ).generationConfig,
    ).toEqual({ maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0, includeThoughts: false } })
  })
})
