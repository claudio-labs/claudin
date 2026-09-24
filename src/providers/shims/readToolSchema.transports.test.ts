// The Read tool's input schema on every transport's wire, now that the batch
// Read is on by default: `file_paths`, an optional `file_path`, and a `symbol`
// that is a name, a list or null. Each transport converts the Anthropic-shaped
// tool list its own way — nothing may drop the union, its null branch, the
// list bounds, or make a path field required.
//
//   native Anthropic, Bedrock, Vertex, Foundry — toolToAPISchema, as built
//   OpenAI-compatible (OpenAI, Azure, Groq, Mistral, Ollama, xAI, DeepSeek,
//     OpenRouter, GitHub Copilot…) — openaiShim convertTools, strict shape
//   Gemini — the same converter, non-strict
//   Codex (ChatGPT) — convertToolsToResponsesTools, strict with widening
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { clearToolSchemaCache } from 'src/agent/tools/toolSchemaCache.js'
import { enableConfigs } from 'src/platform/config/config.js'
import { convertToolsToResponsesTools } from 'src/providers/shims/codexShim.js'
import {
  createOpenAIShimClient,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'
import { toolToAPISchema } from 'src/providers/transport/api.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'

useShimHarness()

type Json = Record<string, unknown>

let readTool: { name: string; description: string; input_schema: Json }

beforeAll(async () => {
  // FileReadTool.prompt() reads the global config; the tool schema cache
  // keys on the name, so a 'Read' built elsewhere must not answer for it.
  enableConfigs()
  clearToolSchemaCache()
  const built = (await toolToAPISchema(FileReadTool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [FileReadTool],
    agents: [],
  })) as unknown as { name: string; description: string; input_schema: Json }
  readTool = { name: built.name, description: built.description, input_schema: built.input_schema }
})

afterAll(() => {
  clearToolSchemaCache()
})

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function typesOf(schema: Json): string[] {
  const { type } = schema
  return Array.isArray(type) ? (type as string[]) : typeof type === 'string' ? [type] : []
}

/** What every transport must still say about the batch fields. */
function expectBatchFields(parameters: Json): void {
  const properties = record(parameters.properties)
  // file_path is a string, file_paths a bounded list of strings…
  expect(typesOf(record(properties.file_path))).toContain('string')
  const paths = record(properties.file_paths)
  expect(typesOf(paths)).toContain('array')
  expect(record(paths.items).type).toBe('string')
  expect([paths.minItems, paths.maxItems]).toEqual([2, 20])
  // …and symbol a name, a list of up to ten, or null.
  const branches = (record(properties.symbol).anyOf as Json[] | undefined) ?? []
  expect(branches.map(branch => branch.type)).toEqual(['string', 'array', 'null'])
  expect(record(branches[1]?.items).type).toBe('string')
  expect([branches[1]?.minItems, branches[1]?.maxItems]).toEqual([1, 10])
}

/**
 * A path field is never one the model must send: it is either not required,
 * or required and declinable with null (the Responses-style widening).
 */
function expectPathsNotForced(parameters: Json): void {
  const required = (parameters.required as string[] | undefined) ?? []
  const properties = record(parameters.properties)
  for (const key of ['file_path', 'file_paths']) {
    const forced = required.includes(key) && !typesOf(record(properties[key])).includes('null')
    expect({ key, forced }).toEqual({ key, forced: false })
  }
}

type WireTool = { name?: string; parameters?: Json; function?: { name?: string; parameters?: Json } }

/**
 * Drive one request through the shim and return Read's parameters as the
 * first request put them on the wire — a chat-completions tool, or a
 * Responses one where the shim routes the model there.
 */
async function openAIWireParameters(model: string): Promise<Json> {
  let body: Json | undefined
  globalThis.fetch = (async (_input, init) => {
    body ??= JSON.parse(String(init?.body)) as Json
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-read-schema',
        model,
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  try {
    await client.beta.messages.create({
      model,
      system: 'test',
      messages: [{ role: 'user', content: 'read two files' }],
      tools: [readTool],
      max_tokens: 64,
      stream: false,
    })
  } catch {
    // A Responses route cannot parse this stub's reply; the request it sent
    // is what is under test.
  }
  const tools = (body?.tools as WireTool[] | undefined) ?? []
  const read = tools.find(tool => (tool.function?.name ?? tool.name) === 'Read')
  expect(read).toBeDefined()
  return read?.function?.parameters ?? read?.parameters ?? {}
}

describe('the default Read schema on every transport', () => {
  test('native Anthropic (and Bedrock, Vertex, Foundry): the schema as the tool built it', () => {
    expect(readTool.input_schema.required).toBeUndefined()
    expect(readTool.input_schema.additionalProperties).toBe(false)
    expectBatchFields(readTool.input_schema)
  })

  test('OpenAI-compatible, strict shape: nothing required, nothing dropped', async () => {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    const parameters = await openAIWireParameters('gpt-5.5')
    expect(parameters.required).toEqual([])
    expect(parameters.additionalProperties).toBe(false)
    expect(parameters.$schema).toBeUndefined()
    expectBatchFields(parameters)
  })

  test('GitHub Copilot: the batch fields kept, no path field forced', async () => {
    process.env.CLAUDIN_USE_GITHUB = '1'
    process.env.GITHUB_TOKEN = 'ghu-test'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    for (const model of ['gpt-4.1', 'gpt-5.5']) {
      const parameters = await openAIWireParameters(model)
      expectPathsNotForced(parameters)
      expectBatchFields(parameters)
    }
  })

  test('Gemini, non-strict: nothing required, the union and its null branch kept', async () => {
    process.env.OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
    const parameters = await openAIWireParameters('gemini-3-flash-preview')
    expect(parameters.required).toEqual([])
    expectBatchFields(parameters)
  })

  test('Codex: every key listed, each declinable, the union left whole', () => {
    const [converted] = convertToolsToResponsesTools([readTool])
    const parameters = record(converted?.parameters)
    const properties = record(parameters.properties)
    expect(parameters.required).toEqual(Object.keys(properties))
    expect(typesOf(record(properties.file_path))).toEqual(['string', 'null'])
    expect(typesOf(record(properties.file_paths))).toEqual(['array', 'null'])
    expectBatchFields(parameters)
  })
})
