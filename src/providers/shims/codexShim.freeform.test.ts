// Patch as an OpenAI custom (freeform) tool on the Responses wire, behind
// CLAUDIN_FREEFORM_PATCH=1 (src/tools/ApplyPatchTool/freeformGrammar.ts): the
// declaration, the forced choice, the history replay and both readers. The
// stream shape is the recorded one (openrouter-responses/calls-a-freeform-text-tool).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '99.0.0', DISPLAY_VERSION: '0.0.0-test' }

const {
  codexStreamToAnthropic,
  convertAnthropicMessagesToResponsesInput,
  convertCodexResponseToAnthropicMessage,
  performCodexRequest,
} = await import('src/providers/shims/codexShim.js')
const { FREEFORM_TOOLS, PATCH_LARK_GRAMMAR, freeformDescription, modelTakesFreeformTools } = await import(
  'src/tools/ApplyPatchTool/freeformGrammar.js'
)
const { loadCassette } = await import('src/providers/__testutils__/cassetteServer.js')

const PATCH = {
  name: 'Patch',
  description: 'Apply a patch. The whole patch goes in the single `patchText` parameter.',
  input_schema: {
    type: 'object',
    properties: { patchText: { type: 'string' }, then: { type: 'array', items: { type: 'string' } } },
    required: ['patchText'],
  },
}
const READ = {
  name: 'Read',
  description: 'Reads',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
}
const PATCH_TEXT = '*** Begin Patch\n*** Update File: a.ts\n@@\n-const a = "x"\n+const a = "y\\n"\n \n*** End Patch\n'

const realFetch = globalThis.fetch
let bodies: Array<Record<string, any>>
let savedFlag: string | undefined

beforeEach(() => {
  bodies = []
  savedFlag = process.env.CLAUDIN_FREEFORM_PATCH
  process.env.CLAUDIN_FREEFORM_PATCH = '1'
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string))
    return new Response('', { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
  if (savedFlag === undefined) delete process.env.CLAUDIN_FREEFORM_PATCH
  else process.env.CLAUDIN_FREEFORM_PATCH = savedFlag
})

type Transport = 'codex_responses' | 'openai_responses'

async function send(options: {
  transport?: Transport
  baseUrl?: string
  model?: string
  params?: Record<string, unknown>
} = {}): Promise<Record<string, any>> {
  const model = options.model ?? 'gpt-5.5'
  await performCodexRequest({
    request: {
      transport: options.transport ?? 'codex_responses',
      requestedModel: model,
      resolvedModel: model,
      baseUrl: options.baseUrl ?? 'https://chatgpt.com/backend-api/codex',
    },
    credentials: { apiKey: 'test-key', accountId: 'acct', source: 'env' },
    params: { model, messages: [{ role: 'user', content: 'hi' }], tools: [READ, PATCH], max_tokens: 1024, ...options.params },
    defaultHeaders: {},
  })
  return bodies.at(-1)!
}

describe('the Patch declaration', () => {
  test('on the Codex backend Patch is a custom tool with the Codex grammar, and Read stays a function', async () => {
    const body = await send()
    const [read, patch] = body.tools
    expect(read).toMatchObject({ type: 'function', name: 'Read' })
    expect(patch).toEqual({
      type: 'custom',
      name: 'Patch',
      description: freeformDescription(PATCH.description),
      format: { type: 'grammar', syntax: 'lark', definition: PATCH_LARK_GRAMMAR },
    })
    // Raw text has no room for `then`, and the description stops asking for JSON.
    expect(JSON.stringify(patch)).not.toContain('"then"')
    expect(patch.description).toContain('FREEFORM')
    expect(patch.description).not.toContain('patchText')
  })

  test('the OpenAI Responses API gets it too', async () => {
    const body = await send({ transport: 'openai_responses', baseUrl: 'https://api.openai.com/v1' })
    expect(body.tools[1].type).toBe('custom')
  })

  test.each([
    ['the flag is off', { flag: undefined }],
    ['the model predates freeform', { model: 'gpt-5.4' }],
    ['Copilot runs it', { baseUrl: 'https://api.githubcopilot.com' }],
  ] as const)('a JSON function when %s', async (_, options: { flag?: undefined; model?: string; baseUrl?: string }) => {
    if ('flag' in options) delete process.env.CLAUDIN_FREEFORM_PATCH
    const body = await send({ model: options.model, baseUrl: options.baseUrl })
    expect(body.tools[1]).toMatchObject({ type: 'function', name: 'Patch' })
  })

  test('a forced Patch is a custom choice; a forced Read stays a function', async () => {
    expect((await send({ params: { tool_choice: { type: 'tool', name: 'Patch' } } })).tool_choice).toEqual({
      type: 'custom',
      name: 'Patch',
    })
    expect((await send({ params: { tool_choice: { type: 'tool', name: 'Read' } } })).tool_choice).toEqual({
      type: 'function',
      name: 'Read',
    })
  })

  test('the models the Codex CLI marks freeform', () => {
    for (const model of ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.6-terra', 'gpt-6-sol', 'GPT-6', 'gpt-10']) {
      expect(modelTakesFreeformTools(model)).toBe(true)
    }
    for (const model of ['gpt-5', 'gpt-5.4', 'gpt-5.50', 'gpt-4.1', 'o3', 'codexplan']) {
      expect(modelTakesFreeformTools(model)).toBe(false)
    }
  })

  test('a description without the input sentence gets the freeform one appended', () => {
    expect(freeformDescription('Edits files.')).toMatch(/^Edits files\.\n\nThis is a FREEFORM tool/)
  })
})

describe('the history', () => {
  const HISTORY = [
    { role: 'user', content: 'edit a.ts' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_p1', name: 'Patch', input: { patchText: PATCH_TEXT } },
        { type: 'tool_use', id: 'call_r1', name: 'Read', input: { file_path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_p1', content: 'Patched a.ts' },
        { type: 'tool_result', tool_use_id: 'call_r1', content: 'const a = "y"' },
      ],
    },
  ]

  test('a Patch call goes back as a custom call with its raw text, and its result as a custom output', async () => {
    const body = await send({ params: { messages: HISTORY } })
    const items = body.input.filter((i: { type: string }) => i.type !== 'message')
    expect(items).toEqual([
      { type: 'custom_tool_call', id: 'fc_p1', call_id: 'call_p1', name: 'Patch', input: PATCH_TEXT },
      { type: 'function_call', id: 'fc_r1', call_id: 'call_r1', name: 'Read', arguments: '{"file_path":"a.ts"}' },
      { type: 'custom_tool_call_output', call_id: 'call_p1', output: 'Patched a.ts' },
      { type: 'function_call_output', call_id: 'call_r1', output: 'const a = "y"' },
    ])
  })

  test('the backend ids replay as given, and the same history without the flag is all functions', () => {
    const replayed = convertAnthropicMessagesToResponsesInput(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_p1', name: 'Patch', input: { patchText: PATCH_TEXT }, codex: { id: 'ctc_9' } }],
        },
      ],
      { replayCodexItems: true, freeformTools: FREEFORM_TOOLS },
    )
    expect(replayed).toEqual([{ type: 'custom_tool_call', id: 'ctc_9', call_id: 'call_p1', name: 'Patch', input: PATCH_TEXT }])

    const plain = convertAnthropicMessagesToResponsesInput(HISTORY)
    expect(plain.map(i => i.type)).toEqual([
      'message',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
    ])
  })

  test('a Patch call without text replays an empty input', () => {
    const [item] = convertAnthropicMessagesToResponsesInput(
      [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_p1', name: 'Patch', input: {} }] }],
      { freeformTools: FREEFORM_TOOLS },
    )
    expect(item).toMatchObject({ type: 'custom_tool_call', input: '' })
  })
})

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(e => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** The tool_use blocks the Anthropic events add up to. */
async function toolUses(response: Response): Promise<Array<{ id: string; name: string; input: unknown }>> {
  const blocks = new Map<number, { id: string; name: string; json: string }>()
  for await (const event of codexStreamToAnthropic(response, 'gpt-5.5')) {
    const e = event as Record<string, any>
    if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') {
      blocks.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: '' })
    }
    if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') {
      blocks.get(e.index)!.json += e.delta.partial_json
    }
  }
  return [...blocks.values()].map(b => ({ id: b.id, name: b.name, input: JSON.parse(b.json) }))
}

function customCallEvents(name: string, deltas: string[], done = deltas.join('')): Array<Record<string, unknown>> {
  const item = { id: 'ctc_1', type: 'custom_tool_call', call_id: 'call_c1', name }
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', input: '' } },
    ...deltas.map(delta => ({ type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: 'ctc_1', delta })),
    { type: 'response.custom_tool_call_input.done', output_index: 0, item_id: 'ctc_1', input: done },
    { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', input: done } },
    {
      type: 'response.completed',
      response: { status: 'completed', output: [{ ...item, input: done }], usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ]
}

describe('the answer', () => {
  test('the recorded freeform stream becomes a tool_use whose text fills its input field', async () => {
    const cassette = loadCassette('openrouter-responses/calls-a-freeform-text-tool')
    // OpenRouter writes no `event:` lines (OpenAI does), and OpenRouter is not
    // on this wire: the events are replayed with them.
    const events = cassette.interactions[0]!.response.body!
      .split('\n')
      .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
    const uses = await toolUses(sse(events))
    // `run` is not a tool Claudin sends freeform, so its text lands under `input`.
    expect(uses).toEqual([{ id: 'call_jlLLytaby5F4w22U0yMR8kvU', name: 'run', input: { input: 'print(1)' } }])
  })

  test('a streamed Patch call is {patchText} with quotes, backslashes and newlines intact', async () => {
    const pieces = [PATCH_TEXT.slice(0, 7), PATCH_TEXT.slice(7, 40), PATCH_TEXT.slice(40)]
    const uses = await toolUses(sse(customCallEvents('Patch', pieces)))
    expect(uses).toEqual([{ id: 'call_c1', name: 'Patch', input: { patchText: PATCH_TEXT } }])
  })

  test('text the deltas never carried arrives whole on the done item', async () => {
    const uses = await toolUses(sse(customCallEvents('Patch', [PATCH_TEXT.slice(0, 10)], PATCH_TEXT)))
    expect(uses[0]!.input).toEqual({ patchText: PATCH_TEXT })
  })

  test('a stream cut before the call is done still closes its input', async () => {
    const [added, delta] = customCallEvents('Patch', ['*** Begin'])
    const uses = await toolUses(sse([added!, delta!]))
    expect(uses[0]!.input).toEqual({ patchText: '*** Begin' })
  })

  test('the stop reason is tool_use', async () => {
    let stop: string | undefined
    for await (const event of codexStreamToAnthropic(sse(customCallEvents('Patch', ['x'])), 'gpt-5.5')) {
      const e = event as Record<string, any>
      if (e.type === 'message_delta') stop = e.delta.stop_reason
    }
    expect(stop).toBe('tool_use')
  })

  test('a stream whose only word of the call is the completed response still stops for tool use', async () => {
    const [, , , , completed] = customCallEvents('Patch', ['x'])
    let stop: string | undefined
    for await (const event of codexStreamToAnthropic(sse([completed!]), 'gpt-5.5')) {
      const e = event as Record<string, any>
      if (e.type === 'message_delta') stop = e.delta.stop_reason
    }
    expect(stop).toBe('tool_use')
  })

  test('a whole response carries the call as {patchText}', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        status: 'completed',
        output: [{ id: 'ctc_1', type: 'custom_tool_call', call_id: 'call_c1', name: 'Patch', input: PATCH_TEXT }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'gpt-5.5',
    ) as { content: Array<Record<string, unknown>>; stop_reason: string }
    expect(message.content).toEqual([{ type: 'tool_use', id: 'call_c1', name: 'Patch', input: { patchText: PATCH_TEXT } }])
    expect(message.stop_reason).toBe('tool_use')
  })
})
