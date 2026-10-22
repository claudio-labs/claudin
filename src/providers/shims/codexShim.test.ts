import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { arch, platform, release, tmpdir } from 'node:os'

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
}

// providerConfig and codexShim consume tryGetActiveProvider() for transport
// routing and baseUrl/model resolution. The tests below still describe the
// desired provider via OPENAI_BASE_URL/OPENAI_MODEL envs; synthesize a
// profile that mirrors them so the resolver-driven branches see the same
// configuration. Spread + restore in afterAll to avoid leaks.
const realActiveProvider = { ...(await import('src/providers/presets/activeProvider.js')) }
const realActiveProviderSnapshot = { ...realActiveProvider }

mock.module('src/providers/presets/activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => {
    const env = process.env
    if (env.CLAUDIN_USE_GITHUB === '1' || env.CLAUDIN_USE_GITHUB === 'true') {
      return {
        transport: 'github_copilot' as const,
        baseUrl: env.OPENAI_BASE_URL ?? 'https://api.githubcopilot.com',
        model: env.OPENAI_MODEL ?? 'github:copilot',
        apiKey: env.OPENAI_API_KEY,
      }
    }
    if (!env.OPENAI_BASE_URL && !env.OPENAI_MODEL && !env.OPENAI_API_KEY) {
      return null
    }
    return {
      transport: 'openai_compat' as const,
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL ?? 'gpt-4o',
      apiKey: env.OPENAI_API_KEY,
    }
  },
}))

afterAll(() => {
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProviderSnapshot)
})

const {
  codexStreamToAnthropic,
  collectCodexCompletedResponse,
  convertAnthropicMessagesToResponsesInput,
  convertCodexResponseToAnthropicMessage,
  convertToolsToResponsesTools,
  performCodexRequest,
} = await import('src/providers/shims/codexShim.js')
const { getSessionId } = await import('src/platform/bootstrap/state.js')
const { __test: webSearchToolTest } = await import('src/tools/WebSearchTool/WebSearchTool.js')
const { _resetReplayTrustForTesting } = await import('src/providers/shims/codex/items.js')
const { getCodexLimits, resetCodexLimitsForTesting } = await import('src/providers/codexLimits.js')

// A refusal latches process-wide (codex/items.ts); the error-event tests raise one.
beforeEach(() => {
  _resetReplayTrustForTesting()
})
afterAll(() => {
  _resetReplayTrustForTesting()
})

const tempDirs: string[] = []
const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  CLAUDIN_USE_GITHUB: process.env.CLAUDIN_USE_GITHUB,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

afterEach(() => {
  if (originalEnv.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL

  if (originalEnv.OPENAI_API_BASE === undefined) delete process.env.OPENAI_API_BASE
  else process.env.OPENAI_API_BASE = originalEnv.OPENAI_API_BASE

  if (originalEnv.CLAUDIN_USE_GITHUB === undefined) delete process.env.CLAUDIN_USE_GITHUB
  else process.env.CLAUDIN_USE_GITHUB = originalEnv.CLAUDIN_USE_GITHUB

  if (originalEnv.OPENAI_MODEL === undefined) delete process.env.OPENAI_MODEL
  else process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function createTempAuthJson(payload: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudin-codex-'))
  tempDirs.push(dir)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, JSON.stringify(payload), 'utf8')
  return authPath
}

async function collectStreamEventTypes(responseText: string): Promise<string[]> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(responseText))
      controller.close()
    },
  })

  const events: string[] = []
  for await (const event of codexStreamToAnthropic(new Response(stream), 'gpt-5.4')) {
    events.push(event.type)
  }
  return events
}

async function importFreshProviderConfigModule() {
  return import(`src/providers/presets/providerConfig.js?ts=${Date.now()}-${Math.random()}`)
}

describe('Codex provider config', () => {
  const originalOpenaiBaseUrl = process.env.OPENAI_BASE_URL
  const originalOpenaiApiBase = process.env.OPENAI_API_BASE

  beforeEach(() => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
  })

  afterEach(() => {
    if (originalOpenaiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalOpenaiBaseUrl
    if (originalOpenaiApiBase === undefined) delete process.env.OPENAI_API_BASE
    else process.env.OPENAI_API_BASE = originalOpenaiApiBase
  })

  test('resolves codexplan alias to Codex transport with reasoning', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.CLAUDIN_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.resolvedModel).toBe('gpt-6-luna')
    expect(resolved.reasoning).toEqual({ effort: 'medium' })
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('resolves codexspark alias to Codex transport with Codex base URL', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.CLAUDIN_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'codexspark' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.resolvedModel).toBe('gpt-5.3-codex-spark')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('does not force Codex transport when a local non-Codex base URL is explicit', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    const resolved = resolveProviderRequest({
      model: 'codexplan',
      baseUrl: 'http://127.0.0.1:8080/v1',
    })

    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8080/v1')
    expect(resolved.resolvedModel).toBe('gpt-6-luna')
  })

  test('transportSendsStrictToolSchemas tracks the per-request model', async () => {
    const { transportSendsStrictToolSchemas } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.CLAUDIN_USE_GITHUB

    // This is the gate that decides whether tool inputs get placeholder-stripped
    // (`stripPlaceholderOptionalFields`). It has to answer for the model the
    // request actually uses — `/model`, a sub-agent override and the fallback
    // model all diverge from the profile's primary — and it has to agree with
    // `resolveProviderRequest`, which is why it just asks it.
    expect(transportSendsStrictToolSchemas('codexplan')).toBe(true)
    expect(transportSendsStrictToolSchemas('gpt-4o')).toBe(false)
    expect(transportSendsStrictToolSchemas('claude-sonnet-4-6')).toBe(false)
  })

  test('resolves codexplan to Codex transport even when OPENAI_BASE_URL is the string "undefined"', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    // On Windows, env vars can leak as the literal string "undefined" instead of
    // the JS value undefined when not properly unset (issue #336).
    process.env.OPENAI_BASE_URL = 'undefined'
    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
  })

  test('resolves codexplan to Codex transport even when OPENAI_BASE_URL is an empty string', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_BASE_URL = ''
    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
  })

  test('prefers explicit baseUrl option over env var', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_BASE_URL = 'https://example.com/v1'
    const resolved = resolveProviderRequest({ model: 'codexplan', baseUrl: 'https://chatgpt.com/backend-api/codex' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('default gpt-4o uses OpenAI base URL (no regression)', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.CLAUDIN_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'gpt-4o' })
    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1')
    expect(resolved.resolvedModel).toBe('gpt-4o')
  })

  test('resolves codexplan from env var OPENAI_MODEL to Codex endpoint', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_MODEL = 'codexplan'
    delete process.env.OPENAI_BASE_URL
    delete process.env.CLAUDIN_USE_GITHUB

    const resolved = resolveProviderRequest()
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
    expect(resolved.resolvedModel).toBe('gpt-6-luna')
  })

  test('does not override custom base URL for codexplan (e.g., local provider)', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_MODEL = 'codexplan'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    delete process.env.CLAUDIN_USE_GITHUB

    const resolved = resolveProviderRequest()
    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('http://localhost:11434/v1')
  })

  test('loads Codex credentials from auth.json fallback', async () => {
    const { resolveCodexApiCredentials } = await importFreshProviderConfigModule()
    const authPath = createTempAuthJson({
      tokens: {
        access_token: 'header.payload.signature',
        account_id: 'acct_test',
      },
    })

    const credentials = resolveCodexApiCredentials({
      CODEX_AUTH_JSON_PATH: authPath,
    } as NodeJS.ProcessEnv)

    expect(credentials.apiKey).toBe('header.payload.signature')
    expect(credentials.accountId).toBe('acct_test')
    expect(credentials.source).toBe('auth.json')
  })

  test('does not treat auth.json id_token as a Codex bearer credential', async () => {
    const { resolveCodexApiCredentials } = await importFreshProviderConfigModule()
    const idTokenPayload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_from_id_token',
        },
      }),
      'utf8',
    ).toString('base64url')
    const authPath = createTempAuthJson({
      tokens: {
        id_token: `header.${idTokenPayload}.signature`,
      },
    })

    const credentials = resolveCodexApiCredentials({
      CODEX_AUTH_JSON_PATH: authPath,
    } as NodeJS.ProcessEnv)

    expect(credentials.apiKey).toBe('')
    expect(credentials.accountId).toBe('acct_from_id_token')
    expect(credentials.source).toBe('none')
  })
})

describe('Codex request translation', () => {
  test('normalizes optional parameters into strict Responses schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Agent',
        description: 'Spawn a sub-agent',
        input_schema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            subagent_type: { type: 'string' },
          },
          required: ['description', 'prompt'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Agent',
        description: 'Spawn a sub-agent',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            // Strict mode forces every key into `required`; nullable is how an
            // optional argument stays skippable.
            subagent_type: { type: ['string', 'null'] },
          },
          required: ['description', 'prompt', 'subagent_type'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('keeps strict mode for tools whose schema already matches Responses requirements', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Ping',
        description: 'Ping tool',
        input_schema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Ping',
        description: 'Ping tool',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('preserves Grep tool pattern field in Codex strict schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Grep',
        description: 'Search file contents',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Grep',
        description: 'Search file contents',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: ['string', 'null'] },
          },
          required: ['pattern', 'path'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('preserves Glob tool pattern field in Codex strict schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Glob',
        description: 'Find files by pattern',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Glob',
        description: 'Find files by pattern',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: ['string', 'null'] },
          },
          required: ['pattern', 'path'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('widens optional types, including an optional enum', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            limit: { type: 'number' },
            // An enum needs `null` in the value list too, or the widened type
            // union and the enum contradict each other. Left un-widened, this
            // is the field the model is forced to send on every call.
            view: { type: 'string', enum: ['outline', 'full'] },
          },
          required: ['file_path'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools[0]?.parameters).toEqual({
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        limit: { type: ['number', 'null'] },
        view: { type: ['string', 'null'], enum: ['outline', 'full', null] },
      },
      required: ['file_path', 'limit', 'view'],
      additionalProperties: false,
    })
  })

  test('treats a missing required list as "everything optional"', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Legacy',
        description: 'MCP tool with a sloppy schema',
        input_schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      },
    ])

    // JSON Schema semantics: no `required` means nothing is required. Reading
    // it as "all required" left tools like ListMcpResources — whose only field
    // is optional — uncallable without an invented argument.
    expect(tools[0]?.parameters).toEqual({
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
      required: ['value'],
      additionalProperties: false,
    })
  })

  test('leaves a const property alone when widening', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Pinned',
        description: 'Tool with a const discriminator',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            // `type` matters: without it the `typeof type !== 'string'` bail
            // would answer for this case and the const guard would be dead
            // weight that no test can see.
            kind: { type: 'string', const: 'file' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ])

    const properties = (tools[0]?.parameters as { properties: Record<string, unknown> }).properties
    expect(properties.kind).toEqual({ type: 'string', const: 'file' })
  })

  test('leaves combinators and already-nullable types alone when widening', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Mixed',
        description: 'Optional union and optional null-typed field',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            nothing: { type: 'null' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ])

    const properties = (tools[0]?.parameters as { properties: Record<string, unknown> }).properties
    // A combinator already carries its own branch structure, and `null` cannot
    // be widened further. Both stay byte-identical — which also means the model
    // still has no way to decline them; the downstream strip covers that.
    expect(properties.value).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(properties.nothing).toEqual({ type: 'null' })
  })

  test('widens optionals inside nested objects and array items', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'ReportFindings',
        description: 'Nested optional properties',
        input_schema: {
          type: 'object',
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' },
                  line: { type: 'integer' },
                },
                required: ['file'],
              },
            },
            meta: {
              type: 'object',
              properties: { branch: { type: 'string' }, note: { type: 'string' } },
              required: ['branch'],
            },
          },
          required: ['findings'],
          additionalProperties: false,
        },
      },
    ])

    // The widening reaches every level, which is exactly why
    // stripPlaceholderOptionalFields has to walk the value the same way — a
    // top-level-only pass leaves `findings[].line: null` for zod to reject.
    const properties = (tools[0]?.parameters as { properties: Record<string, unknown> }).properties
    const items = (properties.findings as { items: { properties: Record<string, unknown> } }).items
    expect(items.properties.line).toEqual({ type: ['integer', 'null'] })
    expect(items.properties.file).toEqual({ type: 'string' })
    const meta = properties.meta as { type: unknown; properties: Record<string, unknown> }
    expect(meta.type).toEqual(['object', 'null'])
    expect(meta.properties.note).toEqual({ type: ['string', 'null'] })
  })

  test('strips validator pattern keyword but keeps string field named pattern in Codex schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'RegexProbe',
        description: 'Probe regex schema handling',
        input_schema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              pattern: '^[a-z]+$',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'RegexProbe',
        description: 'Probe regex schema handling',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('removes unsupported uri format from strict Responses schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'WebFetch',
        description: 'Fetch a URL',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'WebFetch',
        description: 'Fetch a URL',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('sanitizes malformed enum/default values for Responses tool schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        input_schema: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              default: true,
              enum: [false, 0, 1, 2, 3],
            },
          },
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        parameters: {
          type: 'object',
          properties: {
            priority: {
              // No upstream `required`, so `priority` is optional and gets
              // widened — malformed enum members are dropped first, then
              // `null` joins both the type union and the value list.
              type: ['integer', 'null'],
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              enum: [0, 1, 2, 3, null],
            },
          },
          required: ['priority'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('converts assistant tool use and user tool result into Responses items', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working...' },
          { type: 'tool_use', id: 'call_123', name: 'search', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_123', content: 'done' },
        ],
      },
    ])

    expect(items).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Working...' }],
      },
      {
        type: 'function_call',
        id: 'fc_123',
        call_id: 'call_123',
        name: 'search',
        arguments: '{"q":"x"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'done',
      },
    ])
  })

  test('converts completed Codex tool response into Anthropic message', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.3-codex-spark',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'ping',
            arguments: '{"value":"ping"}',
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.3-codex-spark',
    )

    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'ping',
        input: { value: 'ping' },
      },
    ])
  })

  test('strips <think> tag block from completed Codex text responses', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  '<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?',
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Hey! How can I help you today?',
      },
    ])
  })

  test('strips unterminated <think> tag at block boundary in Codex completed response', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  'Here is the answer.\n<think>wait, let me reconsider the user request',
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Here is the answer.',
      },
    ])
  })

  test('recovers Codex web search text and sources from sparse completed response', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            sources: [
              {
                title: 'Claudin repo',
                url: 'https://github.com/example/claudin',
              },
            ],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Claudin is available on GitHub.',
                sources: [
                  {
                    title: 'Docs',
                    url: 'https://docs.example.com/claudin',
                  },
                ],
              },
            ],
          },
        ],
      },
      'Claudin GitHub 2026',
      0.42,
    )

    expect(output.results).toEqual([
      'Claudin is available on GitHub.',
      {
        tool_use_id: 'codex-web-search',
        content: [
          {
            title: 'Claudin repo',
            url: 'https://github.com/example/claudin',
          },
          {
            title: 'Docs',
            url: 'https://docs.example.com/claudin',
          },
        ],
      },
    ])
  })

  test('falls back to a non-empty Codex web search result message', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      { output: [] },
      'Claudin GitHub 2026',
      0.11,
    )

    expect(output.results).toEqual(['No results found.'])
  })

  test('surfaces Codex web search failure reason with a message', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            error: { message: 'upstream search provider rate-limited' },
          },
        ],
      },
      'Claudin GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual([
      'Web search failed: upstream search provider rate-limited',
    ])
  })

  test('surfaces Codex web search failure reason nested under action.error', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            action: { error: { message: 'query blocked' } },
          },
        ],
      },
      'Claudin GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual(['Web search failed: query blocked'])
  })

  test('handles Codex web search failure with no reason attached', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
          },
        ],
      },
      'Claudin GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual(['Web search failed.'])
  })

  test('a failure item does not suppress sources from a later message item', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            error: { message: 'partial outage' },
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Partial results below.',
                sources: [
                  { title: 'Docs', url: 'https://docs.example.com/claudin' },
                ],
              },
            ],
          },
        ],
      },
      'Claudin GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual([
      'Web search failed: partial outage',
      'Partial results below.',
      {
        tool_use_id: 'codex-web-search',
        content: [
          { title: 'Docs', url: 'https://docs.example.com/claudin' },
        ],
      },
    ])
  })

  test('translates Codex SSE text stream into Anthropic events', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"ok","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"ok"}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const eventTypes = await collectStreamEventTypes(responseText)

    expect(eventTypes).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  test('strips <think> tag block from Codex SSE text stream', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?"}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas.join('')).toBe('Hey! How can I help you today?')
  })

  test('preserves prose without tags (no phrase-based false positive)', async () => {
    // Regression test: older phrase-based sanitizer would incorrectly strip text
    // starting with "I should" or "The user". The tag-based approach leaves it alone.
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"I should note that the user role requires a briefly concise friendly response format.","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"I should note that the user role requires a briefly concise friendly response format."}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I should note that the user role requires a briefly concise friendly response format."}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas.join('')).toBe(
      'I should note that the user role requires a briefly concise friendly response format.',
    )
  })
})

describe('performCodexRequest prompt-cache params', () => {
  const realFetch = globalThis.fetch
  let capturedBody: Record<string, unknown> | undefined

  beforeEach(() => {
    capturedBody = undefined
    ;(globalThis as { fetch: typeof fetch }).fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return new Response('', { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
  })

  async function runRequest(baseUrl: string): Promise<void> {
    await performCodexRequest({
      request: {
        transport: 'codex_responses',
        requestedModel: 'gpt-5.4',
        resolvedModel: 'gpt-5.4',
        baseUrl,
      },
      credentials: { apiKey: 'test-key', source: 'env' },
      params: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1024,
      },
      defaultHeaders: {},
    })
  }

  test('sends prompt_cache_key (but not retention) against the Codex backend', async () => {
    await runRequest('https://chatgpt.com/backend-api/codex')

    expect(capturedBody?.prompt_cache_key).toBe(getSessionId())
    // The Codex backend rejects prompt_cache_retention with a 400 — never send it.
    expect(capturedBody?.prompt_cache_retention).toBeUndefined()
  })

  test('withholds the params against a custom baseUrl', async () => {
    await runRequest('http://localhost:8000/v1')

    expect(capturedBody).toBeDefined()
    expect(capturedBody?.prompt_cache_key).toBeUndefined()
    expect(capturedBody?.prompt_cache_retention).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Characterization: what the shim does today, pinned before the reasoning
// replay changes it. Every case below describes current behavior.
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
}

function responseFromChunks(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    }),
  )
}

async function streamEvents(
  chunks: string[],
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const event of codexStreamToAnthropic(responseFromChunks(chunks), 'gpt-5.4', signal)) {
    if (event.type === 'message_start') out.push({ type: event.type })
    else if (event.type === 'message_delta') out.push({ type: event.type, delta: event.delta })
    else out.push(event as unknown as Record<string, unknown>)
  }
  return out
}

const TEXT_STREAM = [
  sseEvent('response.output_item.added', {
    output_index: 0,
    item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
  }),
  sseEvent('response.content_part.added', { item_id: 'msg_1', part: { type: 'output_text', text: '' } }),
  sseEvent('response.output_text.delta', { item_id: 'msg_1', delta: 'ok' }),
  sseEvent('response.output_item.done', {
    output_index: 0,
    item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
  }),
  sseEvent('response.completed', {
    response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1 } },
  }),
].join('')

const TEXT_EVENTS = [
  { type: 'message_start' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
  { type: 'message_stop' },
]

describe('Codex input conversion (characterization)', () => {
  test('tool call ids: empty, fc_-prefixed, foreign and call_-prefixed', () => {
    expect(
      convertAnthropicMessagesToResponsesInput([
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: '', name: 'A', input: {} },
            { type: 'tool_use', id: 'fc_xyz', name: 'B', input: '{"raw":1}' },
            { type: 'tool_use', id: 'toolu_01', name: 'C' },
            { type: 'tool_use', id: 'call_9' },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
      ]),
    ).toEqual([
      { type: 'function_call', id: 'fc_unknown', call_id: 'call_unknown', name: 'A', arguments: '{}' },
      { type: 'function_call', id: 'fc_xyz', call_id: 'call_xyz', name: 'B', arguments: '{"raw":1}' },
      { type: 'function_call', id: 'fc_toolu_01', call_id: 'toolu_01', name: 'C', arguments: '{}' },
      { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_unknown', output: 'x' },
    ])
  })

  test('tool result content: block arrays, objects, errors, and text beside them', () => {
    expect(
      convertAnthropicMessagesToResponsesInput([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [
                { type: 'text', text: 'a' },
                { type: 'image', source: { type: 'url', url: 'https://img/1.png' } },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
                { type: 'document', text: 'b' },
                { type: 'other' },
              ],
            },
            { type: 'tool_result', tool_use_id: 'call_2', content: { unexpected: true } },
            { type: 'tool_result', tool_use_id: 'call_3', content: 'boom', is_error: true },
            { type: 'text', text: 'and this' },
          ],
        },
      ]),
    ).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'a\n[Image](https://img/1.png)\nb' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"unexpected":true}' },
      { type: 'function_call_output', call_id: 'call_3', output: 'Error: boom' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and this' }] },
    ])
  })

  test('message content: images, thinking, unknown blocks, strings, wrapped and system messages', () => {
    expect(
      convertAnthropicMessagesToResponsesInput([
        { role: 'system', content: 'ignored' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
            { type: 'image', source: { type: 'url', url: 'https://img/2.png' } },
            { type: 'image', source: { type: 'url' } },
            { type: 'thinking', thinking: 'hmm' },
            { type: 'thinking', thinking: '' },
            { type: 'custom', text: 'extra' },
            { type: 'custom' },
          ],
        },
        { role: 'assistant', content: 'plain answer' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'dropped', signature: 'sig' },
            { type: 'text', text: 'with pic' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B' } },
          ],
        },
        { role: 'user', content: 42 },
        { role: 'user', content: [] },
        { message: { role: 'user', content: 'wrapped' } },
      ]),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          { type: 'input_image', image_url: 'https://img/2.png' },
          { type: 'input_text', text: '<thinking>hmm</thinking>' },
          { type: 'input_text', text: 'extra' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'plain answer' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'with pic' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '42' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'wrapped' }] },
    ])
  })

  test('tool schemas: filtered names, missing schemas, uri formats and tuple items', () => {
    const tools = convertToolsToResponsesTools([
      { name: 'ToolSearchTool', input_schema: { type: 'object', properties: {} } },
      { description: 'no name' },
      { name: 'Bare' },
      { name: 'NoProps', input_schema: { type: 'object' } },
      {
        name: 'Web',
        description: 'Fetch',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
          },
          required: ['url'],
        },
      },
    ])

    expect(tools.map(tool => tool.name)).toEqual(['Bare', 'NoProps', 'Web'])
    expect(tools.every(tool => tool.strict === true)).toBe(true)
    expect(tools[0]?.description).toBe('')
    expect(tools[0]?.parameters).toMatchObject({ type: 'object', additionalProperties: false, required: [] })
    expect(tools[1]?.parameters).toMatchObject({ type: 'object', additionalProperties: false, required: [] })
    const web = tools[2]?.parameters as { properties: Record<string, Record<string, unknown>>; required: string[] }
    expect(web.required).toEqual(['url', 'pair'])
    expect(web.properties.url).toEqual({ type: 'string' })
    expect(web.properties.pair?.type).toEqual(['array', 'null'])
    expect(web.properties.pair?.items).toEqual([{ type: 'string' }, { type: 'number' }])
  })
})

describe('performCodexRequest body, headers and URL (characterization)', () => {
  const realFetch = globalThis.fetch
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined
  let reply: () => Response

  beforeEach(() => {
    captured = undefined
    reply = () => new Response('', { status: 200 })
    ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      }
      return reply()
    }) as typeof fetch
  })

  afterEach(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
  })

  async function send(options: {
    baseUrl?: string
    model?: string
    params?: Record<string, unknown>
    accountId?: string
    defaultHeaders?: Record<string, string>
    reasoning?: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  } = {}): Promise<{ url: string; headers: Headers; body: Record<string, unknown> }> {
    const model = options.model ?? 'gpt-5.4'
    await performCodexRequest({
      request: {
        transport: 'codex_responses',
        requestedModel: model,
        resolvedModel: model,
        baseUrl: options.baseUrl ?? 'https://chatgpt.com/backend-api/codex',
        ...(options.reasoning && { reasoning: options.reasoning }),
      },
      credentials: { apiKey: 'test-key', accountId: options.accountId, source: 'env' },
      params: {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1024,
        ...options.params,
      },
      defaultHeaders: options.defaultHeaders ?? {},
    })
    if (!captured) throw new Error('fetch was not called')
    return captured
  }

  const READ = {
    name: 'Read',
    description: 'Reads',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  }

  test('an empty history sends one empty user message', async () => {
    const { body } = await send({ params: { messages: [] } })
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }])
  })

  test("a response's x-codex-* headers reach the live limits", async () => {
    resetCodexLimitsForTesting()
    reply = () =>
      new Response('', {
        status: 200,
        headers: {
          'x-codex-plan-type': 'plus',
          'x-codex-primary-used-percent': '76',
          'x-codex-primary-window-minutes': '300',
        },
      })
    await send()
    expect(getCodexLimits()?.snapshots[0]?.primary).toMatchObject({ usedPercent: 76, windowMinutes: 300 })
    resetCodexLimitsForTesting()
  })

  test('the system prompt becomes instructions, from a string, blocks or anything else', async () => {
    expect((await send({ params: { system: 'be terse' } })).body.instructions).toBe('be terse')
    expect(
      (await send({ params: { system: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } }))
        .body.instructions,
    ).toBe('a\n\n\n\nb')
    expect((await send({ params: { system: 5 } })).body.instructions).toBe('5')
    expect((await send()).body).not.toHaveProperty('instructions')
  })

  test.each([
    [{ type: 'auto' }, 'auto'],
    [{ type: 'any' }, 'required'],
    [{ type: 'none' }, 'none'],
    [{ type: 'tool', name: 'Read' }, { type: 'function', name: 'Read' }],
    [{ type: 'mystery' }, 'auto'],
    [undefined, 'auto'],
  ])('tool_choice %o with tools becomes %o', async (choice, expected) => {
    const { body } = await send({ params: { tools: [READ], tool_choice: choice } })
    expect(body.tool_choice).toEqual(expected)
    expect(body.parallel_tool_calls).toBe(true)
    expect((body.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(['Read'])
  })

  test('without usable tools there is no tools field and no parallel flag', async () => {
    const forced = await send({ params: { tool_choice: { type: 'any' } } })
    expect(forced.body.tool_choice).toBe('required')
    expect(forced.body).not.toHaveProperty('tools')
    expect(forced.body).not.toHaveProperty('parallel_tool_calls')

    const onlySearch = await send({ params: { tools: [{ name: 'ToolSearchTool' }] } })
    expect(onlySearch.body).not.toHaveProperty('tools')
    expect(onlySearch.body).not.toHaveProperty('tool_choice')
  })

  test('reasoning goes out as resolved, and sampling only for models that are not GPT or Codex', async () => {
    // The Codex backend also gets the context the Codex CLI sends; see the replay tests.
    expect((await send({ reasoning: { effort: 'xhigh' } })).body.reasoning).toEqual({
      effort: 'xhigh',
      context: 'all_turns',
    })
    expect(
      (await send({ baseUrl: 'https://api.githubcopilot.com', reasoning: { effort: 'xhigh' } })).body.reasoning,
    ).toEqual({ effort: 'xhigh' })
    expect((await send()).body).not.toHaveProperty('reasoning')

    const gpt = await send({ params: { temperature: 0.2, top_p: 0.9 } })
    expect(gpt.body).not.toHaveProperty('temperature')
    expect(gpt.body).not.toHaveProperty('top_p')

    const other = await send({ model: 'local-llama', params: { temperature: 0.2, top_p: 0.9 } })
    expect(other.body.temperature).toBe(0.2)
    expect(other.body.top_p).toBe(0.9)
    expect((await send({ model: 'local-llama' })).body).not.toHaveProperty('temperature')
  })

  test('headers: Codex-shaped user agent, bearer, account id, session id, originator', async () => {
    const { headers } = await send({
      accountId: 'acct-1',
      defaultHeaders: { 'User-Agent': 'generic/1.0', Authorization: 'Bearer stale', 'X-Extra': 'kept' },
    })
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('user-agent')).toBe(`claudin/0.0.0-test (${platform()} ${release()}; ${arch()})`)
    expect(headers.get('authorization')).toBe('Bearer test-key')
    expect(headers.get('chatgpt-account-id')).toBe('acct-1')
    expect(headers.get('session-id')).toBe(getSessionId())
    expect(headers.get('originator')).toBe('claudin')
    expect(headers.get('x-extra')).toBe('kept')

    const custom = await send({ defaultHeaders: { originator: 'custom' } })
    expect(custom.headers.get('originator')).toBe('custom')
    expect(custom.headers.has('chatgpt-account-id')).toBe(false)
  })

  test.each([
    ['https://chatgpt.com/backend-api/codex', 'https://chatgpt.com/backend-api/codex/responses'],
    ['https://proxy.example/v1/responses', 'https://proxy.example/backend-api/codex/responses'],
    ['https://proxy.example/openai/chat/completions', 'https://proxy.example/backend-api/codex/responses'],
    ['not a url', 'not a url/responses'],
  ])('base URL %s is sent to %s', async (baseUrl, expected) => {
    expect((await send({ baseUrl })).url).toBe(expected)
  })

  test('an HTTP error becomes an APIError carrying the status and the body', async () => {
    reply = () => new Response('{"detail":"bad"}', { status: 400 })
    const json = await send().then(
      () => null,
      (error: unknown) => error as { status?: number; message?: string; error?: unknown },
    )
    expect(json?.status).toBe(400)
    // With a JSON body the SDK builds the message from the parsed error.
    expect(json?.message).toBe('400 {"detail":"bad"}')
    expect(json?.error).toEqual({ detail: 'bad' })

    reply = () => new Response('gateway down', { status: 502 })
    const raw = await send().then(
      () => null,
      (error: unknown) => error as { status?: number; message?: string },
    )
    expect(raw?.status).toBe(502)
    expect(raw?.message).toContain('Codex API error 502: gateway down')
  })
})

describe('Codex SSE stream reading (characterization)', () => {
  test('events split across reads at any byte read the same', async () => {
    const pieces: string[] = []
    for (let i = 0; i < TEXT_STREAM.length; i += 7) pieces.push(TEXT_STREAM.slice(i, i + 7))
    expect(await streamEvents(pieces)).toEqual(TEXT_EVENTS)
  })

  test('chunks without an event line, [DONE], broken and non-object data are skipped', async () => {
    const noise = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'orphan' })}\n\n`,
      'event: response.output_text.delta\ndata: [DONE]\n\n',
      'event: response.output_text.delta\ndata: {nope\n\n',
      'event: response.output_text.delta\ndata: 5\n\n',
      '\n\n',
    ].join('')
    expect(await streamEvents([noise + TEXT_STREAM])).toEqual(TEXT_EVENTS)
  })

  test('a caller signal that never fires leaves the stream unchanged', async () => {
    expect(await streamEvents([TEXT_STREAM], new AbortController().signal)).toEqual(TEXT_EVENTS)
  })

  test('a partial tag held back by the think filter is flushed when the message ends', async () => {
    const stream = [
      sseEvent('response.content_part.added', { item_id: 'msg_1', part: { type: 'output_text', text: '' } }),
      sseEvent('response.output_text.delta', { item_id: 'msg_1', delta: 'a <' }),
      sseEvent('response.output_item.done', { item: { id: 'msg_1', type: 'message' } }),
      sseEvent('response.completed', { response: { output: [] } }),
    ].join('')
    const deltas = (await streamEvents([stream]))
      .filter(event => event.type === 'content_block_delta')
      .map(event => (event.delta as { text: string }).text)
    expect(deltas).toEqual(['a ', '<'])
  })

  test('tool calls: arguments on the added item, unknown deltas, unclosed calls, other parts', async () => {
    const stream = [
      sseEvent('response.output_item.added', {
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"a":' },
      }),
      sseEvent('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '1}' }),
      sseEvent('response.function_call_arguments.delta', { item_id: 'fc_ghost', delta: 'lost' }),
      sseEvent('response.content_part.added', { item_id: 'msg_x', part: { type: 'refusal' } }),
      sseEvent('response.output_item.added', { item: { id: 'fc_2', type: 'function_call' } }),
      sseEvent('response.output_item.done', { item: { id: 'fc_1', type: 'function_call' } }),
      sseEvent('response.completed', { response: { output: [] } }),
    ].join('')
    expect(await streamEvents([stream])).toEqual([
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'fc_2', name: 'tool', input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
      { type: 'message_stop' },
    ])
  })

  test('an incomplete response for output tokens ends with max_tokens', async () => {
    const stream = sseEvent('response.incomplete', {
      response: { output: [], incomplete_details: { reason: 'max_output_tokens' } },
    })
    expect((await streamEvents([stream])).at(-2)).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens', stop_sequence: null },
    })
  })

  test.each([
    [{ response: { error: { message: 'from response' } } }, 'from response'],
    [{ error: { message: 'from error' } }, 'from error'],
    [{}, 'Codex response failed'],
  ])('response.failed %o throws "%s"', async (data, message) => {
    await expect(streamEvents([sseEvent('response.failed', data)])).rejects.toThrow(message)
  })
})

describe('collectCodexCompletedResponse (characterization)', () => {
  test('a codex.rate_limits event on the way reaches the live limits', async () => {
    resetCodexLimitsForTesting()
    const response = responseFromChunks([
      sseEvent('codex.rate_limits', {
        plan_type: 'plus',
        rate_limits: { primary: { used_percent: 91, window_minutes: 10080, reset_at: 1795289225 }, secondary: null },
      }),
      sseEvent('response.completed', { response: { id: 'resp_rl', output: [] } }),
    ])
    expect(await collectCodexCompletedResponse(response)).toEqual({ id: 'resp_rl', output: [] })
    expect(getCodexLimits()?.snapshots[0]?.primary).toMatchObject({ usedPercent: 91, windowMinutes: 10080 })
    resetCodexLimitsForTesting()
  })

  test.each(['response.completed', 'response.incomplete'])('returns the payload of %s', async event => {
    const response = responseFromChunks([
      sseEvent('response.output_text.delta', { delta: 'ignored' }),
      sseEvent(event, { response: { id: 'resp_9', output: [] } }),
      sseEvent('response.completed', { response: { id: 'never_read' } }),
    ])
    expect(await collectCodexCompletedResponse(response)).toEqual({ id: 'resp_9', output: [] })
  })

  test.each([
    [{ response: { error: { message: 'from response' } } }, 'from response'],
    [{ error: { message: 'from error' } }, 'from error'],
    [{}, 'Codex response failed'],
  ])('response.failed %o throws "%s"', async (data, message) => {
    await expect(
      collectCodexCompletedResponse(responseFromChunks([sseEvent('response.failed', data)])),
    ).rejects.toThrow(message)
  })

  test('a stream that ends without a completed payload throws', async () => {
    await expect(
      collectCodexCompletedResponse(responseFromChunks([sseEvent('response.output_text.delta', { delta: 'x' })])),
    ).rejects.toThrow('Codex response ended without a completed payload')
  })

  test('a response without a body throws the same way', async () => {
    await expect(collectCodexCompletedResponse(new Response(null))).rejects.toThrow(
      'Codex response ended without a completed payload',
    )
  })
})

describe('convertCodexResponseToAnthropicMessage (characterization)', () => {
  test('arguments, ids and parts it cannot use', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        output: [
          {
            type: 'message',
            content: [
              { type: 'refusal', refusal: 'no' },
              { type: 'output_text', text: '<think>hidden</think>shown' },
            ],
          },
          { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{broken' },
          { type: 'function_call', id: 'fc_2' },
          { type: 'function_call' },
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
          { type: 'message', content: 'not an array' },
        ],
      },
      'fallback-model',
    )
    const content = message.content as Array<Record<string, unknown>>
    expect(content.slice(0, 3)).toEqual([
      { type: 'text', text: 'shown' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { raw: '{broken' } },
      { type: 'tool_use', id: 'fc_2', name: 'tool', input: {} },
    ])
    expect(content[3]).toMatchObject({ type: 'tool_use', name: 'tool', input: {} })
    expect(String(content[3]?.id)).toStartWith('msg_')
    expect(content).toHaveLength(4)
    expect(String(message.id)).toStartWith('msg_')
    expect(message.model).toBe('fallback-model')
    expect(message.stop_reason).toBe('tool_use')
  })

  test('no output, and an incomplete response for output tokens', () => {
    const message = convertCodexResponseToAnthropicMessage(
      { id: 'resp_1', model: 'gpt-5.4', incomplete_details: { reason: 'max_output_tokens' } },
      'unused',
    )
    expect(message.content).toEqual([])
    expect(message.id).toBe('resp_1')
    expect(message.model).toBe('gpt-5.4')
    expect(message.stop_reason).toBe('max_tokens')
  })
})

// The Codex backend answers some rejections with HTTP 200 and an SSE `error`
// event instead of a status code — a replayed reasoning item it cannot decrypt
// is one (payload captured live on 2026-10-16). A stream that ends on that
// event must surface it, not read as an empty reply.
describe('Codex SSE error events', () => {
  const NESTED_ERROR = sseEvent('error', {
    error: {
      message:
        'The encrypted content for item rs_097878fbd24a06d9016ad2ad77486481918186e4aff871592e could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
      type: 'invalid_request_error',
      param: 'input',
      code: 'invalid_encrypted_content',
    },
    sequence_number: 0,
  })
  // The Responses API reference puts the fields on the event itself.
  const FLAT_ERROR = sseEvent('error', {
    code: 'server_error',
    message: 'The server had an error while processing your request.',
    param: null,
    sequence_number: 3,
  })

  async function rejectionOf(run: () => Promise<unknown>): Promise<{ status?: number; message: string }> {
    try {
      await run()
    } catch (error) {
      return error as { status?: number; message: string }
    }
    throw new Error('expected a rejection, got a reply')
  }

  test('a stream that ends on an error event throws the server error, as a 400', async () => {
    const error = await rejectionOf(() => streamEvents([NESTED_ERROR]))
    expect(error.status).toBe(400)
    expect(error.message).toContain('invalid_encrypted_content')
    expect(error.message).toContain('could not be verified')
  })

  test('collect throws the server error instead of "ended without a completed payload"', async () => {
    const error = await rejectionOf(() => collectCodexCompletedResponse(responseFromChunks([NESTED_ERROR])))
    expect(error.status).toBe(400)
    expect(error.message).toContain('invalid_encrypted_content')
  })

  test('an error event with the fields on the event itself, not an invalid request, is a 500', async () => {
    const error = await rejectionOf(() => streamEvents([FLAT_ERROR]))
    expect(error.status).toBe(500)
    expect(error.message).toContain('server_error')
    expect(error.message).toContain('The server had an error')
  })

  test('text streamed before the error event is still delivered before the throw', async () => {
    const seen: string[] = []
    const error = await rejectionOf(async () => {
      for await (const event of codexStreamToAnthropic(
        responseFromChunks([TEXT_STREAM.split('event: response.completed')[0]!, NESTED_ERROR]),
        'gpt-5.4',
      )) {
        seen.push(event.type)
      }
    })
    expect(error.status).toBe(400)
    expect(seen).toContain('content_block_delta')
  })
})

// With captureCodexItems the reader keeps each Responses item's state on the
// block it becomes, so the next request can replay it (codex/items.ts). Only
// the Codex backend's caller asks for it.
describe('Codex item capture', () => {
  const ITEM_STREAM = [
    sseEvent('response.output_item.added', { item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
    sseEvent('response.output_item.done', {
      item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
    }),
    sseEvent('response.output_item.added', {
      item: { id: 'msg_1', type: 'message', role: 'assistant', content: [], phase: 'commentary' },
    }),
    sseEvent('response.content_part.added', { item_id: 'msg_1', part: { type: 'output_text', text: '' } }),
    sseEvent('response.output_text.delta', { item_id: 'msg_1', delta: 'Reading.' }),
    sseEvent('response.output_item.done', {
      item: { id: 'msg_1', type: 'message', role: 'assistant', phase: 'commentary', content: [] },
    }),
    sseEvent('response.output_item.added', {
      item: { id: 'fc_real', type: 'function_call', call_id: 'call_abc', name: 'Read', arguments: '' },
    }),
    sseEvent('response.function_call_arguments.delta', { item_id: 'fc_real', delta: '{"file_path":"/x"}' }),
    sseEvent('response.output_item.done', { item: { id: 'fc_real', type: 'function_call', call_id: 'call_abc' } }),
    sseEvent('response.completed', { response: { output: [] } }),
  ].join('')

  async function capturedEvents(chunks: string[]): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = []
    for await (const event of codexStreamToAnthropic(responseFromChunks(chunks), 'gpt-5.6-terra', undefined, {
      captureCodexItems: true,
    })) {
      if (event.type === 'message_start') out.push({ type: event.type })
      else if (event.type === 'message_delta') out.push({ type: event.type, delta: event.delta })
      else out.push(event as unknown as Record<string, unknown>)
    }
    return out
  }

  test('reasoning, commentary and a call each keep their item state, in output order', async () => {
    expect(await capturedEvents([ITEM_STREAM])).toEqual([
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_1', encrypted_content: 'enc-1' } },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '', codex: { id: 'msg_1', phase: 'commentary' } },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading.' } },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'call_abc', name: 'Read', input: {}, codex: { id: 'fc_real' } },
      },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
      { type: 'message_stop' },
    ])
  })

  test('a reasoning item without a payload, and text outside any message item, carry nothing', async () => {
    const stream = [
      sseEvent('response.output_item.done', { item: { id: 'rs_2', type: 'reasoning', summary: [] } }),
      sseEvent('response.output_item.added', { item: { id: 'msg_1', type: 'message', phase: 'commentary' } }),
      sseEvent('response.output_text.delta', { item_id: 'msg_1', delta: 'one' }),
      sseEvent('response.output_item.done', { item: { id: 'msg_1', type: 'message' } }),
      sseEvent('response.output_text.delta', { item_id: 'msg_x', delta: 'two' }),
      sseEvent('response.completed', { response: { output: [] } }),
    ].join('')
    const starts = (await capturedEvents([stream]))
      .filter(event => event.type === 'content_block_start')
      .map(event => event.content_block)
    expect(starts).toEqual([
      { type: 'text', text: '', codex: { id: 'msg_1', phase: 'commentary' } },
      { type: 'text', text: '' },
    ])
  })

  test('a completed response keeps the same state on the same blocks', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' },
          { type: 'reasoning', id: 'rs_2', summary: [] },
          {
            type: 'message',
            id: 'msg_1',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
          { type: 'function_call', id: 'fc_real', call_id: 'call_abc', name: 'Read', arguments: '{}' },
        ],
      },
      'gpt-5.6-terra',
      { captureCodexItems: true },
    )
    expect(message.content).toEqual([
      { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_1', encrypted_content: 'enc-1' } },
      { type: 'text', text: 'Done.', codex: { id: 'msg_1', phase: 'final_answer' } },
      { type: 'tool_use', id: 'call_abc', name: 'Read', input: {}, codex: { id: 'fc_real' } },
    ])
  })
})

describe('which client branch captures Codex item state', () => {
  const realFetch = globalThis.fetch
  const managed = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_ACCOUNT_ID', 'GITHUB_TOKEN'] as const
  const saved = Object.fromEntries(managed.map(key => [key, process.env[key]]))

  afterEach(() => {
    globalThis.fetch = realFetch
    for (const key of managed) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  async function streamThroughClient(): Promise<Array<Record<string, unknown>>> {
    globalThis.fetch = (async () =>
      new Response(
        [
          sseEvent('response.output_item.done', {
            item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
          }),
          sseEvent('response.output_item.added', {
            item: { id: 'msg_1', type: 'message', role: 'assistant', content: [], phase: 'final_answer' },
          }),
          sseEvent('response.output_text.delta', { item_id: 'msg_1', delta: 'ok' }),
          sseEvent('response.output_item.done', { item: { id: 'msg_1', type: 'message' } }),
          sseEvent('response.completed', { response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
        ].join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

    const { createOpenAIShimClient } = await import('src/providers/shims/openaiShim.js')
    const client = createOpenAIShimClient({}) as {
      beta: {
        messages: {
          create: (params: Record<string, unknown>) => {
            withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>> }>
          }
        }
      }
    }
    const { data } = await client.beta.messages
      .create({ model: process.env.OPENAI_MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, stream: true })
      .withResponse()
    const starts: Array<Record<string, unknown>> = []
    for await (const event of data) {
      if (event.type === 'content_block_start') starts.push(event.content_block as Record<string, unknown>)
    }
    return starts
  }

  test('the Codex OAuth branch keeps the reasoning item and the message state', async () => {
    process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/codex'
    process.env.OPENAI_MODEL = 'codexplan'
    process.env.OPENAI_API_KEY = 'profile-key'
    process.env.CODEX_API_KEY = 'codex-key'
    process.env.CHATGPT_ACCOUNT_ID = 'acct-1'
    expect(await streamThroughClient()).toEqual([
      { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_1', encrypted_content: 'enc-1' } },
      { type: 'text', text: '', codex: { id: 'msg_1', phase: 'final_answer' } },
    ])
  })

  test('the GitHub Copilot branch reads the same stream without any of it', async () => {
    process.env.CLAUDIN_USE_GITHUB = '1'
    process.env.OPENAI_MODEL = 'gpt-5.5'
    process.env.OPENAI_API_KEY = 'gh-key'
    expect(await streamThroughClient()).toEqual([{ type: 'text', text: '' }])
  })
})

// On the Codex backend each assistant turn goes back the way Codex CLI 0.162.1
// sends it (captured 2026-10-16): reasoning → message(commentary) → call →
// output → reasoning → message(final_answer), under the backend's own ids.
describe('Codex item replay', () => {
  const REASONING_1 = { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_1', encrypted_content: 'enc-1' } }
  const REASONING_2 = { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_2', encrypted_content: 'enc-2' } }
  const COMMENTARY = { type: 'text', text: 'Reading.', codex: { id: 'msg_1', phase: 'commentary' } }
  const CALL = { type: 'tool_use', id: 'call_abc', name: 'Read', input: { file_path: '/x' }, codex: { id: 'fc_real' } }
  const FINAL = { type: 'text', text: 'It has 5 numbers.', codex: { id: 'msg_2', phase: 'final_answer' } }

  const TURN = [
    { role: 'user', content: 'how many numbers?' },
    { role: 'assistant', content: [REASONING_1, COMMENTARY, CALL] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: '14 17 22 29 35' }] },
    { role: 'assistant', content: [REASONING_2, FINAL] },
  ]

  const REPLAYED = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'how many numbers?' }] },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }], id: 'msg_1', phase: 'commentary' },
    { type: 'function_call', id: 'fc_real', call_id: 'call_abc', name: 'Read', arguments: '{"file_path":"/x"}' },
    { type: 'function_call_output', call_id: 'call_abc', output: '14 17 22 29 35' },
    { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'enc-2' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It has 5 numbers.' }], id: 'msg_2', phase: 'final_answer' },
  ]

  test('a turn replays its items in order, under the ids the backend gave them', () => {
    expect(convertAnthropicMessagesToResponsesInput(TURN, { replayCodexItems: true })).toEqual(REPLAYED as never)
  })

  test('without the option the same history converts as before', () => {
    expect(convertAnthropicMessagesToResponsesInput(TURN)).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'how many numbers?' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
      { type: 'function_call', id: 'fc_abc', call_id: 'call_abc', name: 'Read', arguments: '{"file_path":"/x"}' },
      { type: 'function_call_output', call_id: 'call_abc', output: '14 17 22 29 35' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It has 5 numbers.' }] },
    ])
  })

  test('text blocks of one message merge, another message or a call splits them', () => {
    const second = { type: 'text', text: 'more', codex: { id: 'msg_1', phase: 'commentary' } }
    const other = { type: 'text', text: 'other', codex: { id: 'msg_9' } }
    expect(
      convertAnthropicMessagesToResponsesInput(
        [{ role: 'assistant', content: [COMMENTARY, second, other, { type: 'text', text: 'loose' }, { type: 'text', text: 'too' }, CALL, { type: 'text', text: 'after' }] }],
        { replayCodexItems: true },
      ),
    ).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Reading.' }, { type: 'output_text', text: 'more' }],
        id: 'msg_1',
        phase: 'commentary',
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'other' }], id: 'msg_9' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'loose' }, { type: 'output_text', text: 'too' }],
      },
      { type: 'function_call', id: 'fc_real', call_id: 'call_abc', name: 'Read', arguments: '{"file_path":"/x"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after' }] },
    ] as never)
  })

  test('blocks without item state keep their place and synthetic ids; foreign thinking is dropped', () => {
    expect(
      convertAnthropicMessagesToResponsesInput(
        [
          { role: 'assistant', content: 'a plain reply' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'anthropic', signature: 'sig' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'first' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } },
              { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
              { type: 'text', text: 'then' },
            ],
          },
        ],
        { replayCodexItems: true },
      ),
    ).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a plain reply' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'then' }] },
    ] as never)
  })

  test('an empty assistant turn replays as nothing', () => {
    expect(convertAnthropicMessagesToResponsesInput([{ role: 'assistant', content: [] }], { replayCodexItems: true })).toEqual([])
  })

  describe('the request body', () => {
    const realFetch = globalThis.fetch
    const originalSwitch = process.env.CLAUDIN_CODEX_REASONING_REPLAY
    let bodies: Array<Record<string, unknown>> = []

    beforeEach(() => {
      bodies = []
      ;(globalThis as { fetch: typeof fetch }).fetch = (async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>)
        return new Response('', { status: 200 })
      }) as typeof fetch
    })

    afterEach(() => {
      ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
      if (originalSwitch === undefined) delete process.env.CLAUDIN_CODEX_REASONING_REPLAY
      else process.env.CLAUDIN_CODEX_REASONING_REPLAY = originalSwitch
    })

    async function sendTurn(
      messages: Array<Record<string, unknown>>,
      baseUrl = 'https://chatgpt.com/backend-api/codex',
    ): Promise<Record<string, unknown>> {
      await performCodexRequest({
        request: {
          transport: 'codex_responses',
          requestedModel: 'gpt-5.6-terra',
          resolvedModel: 'gpt-5.6-terra',
          baseUrl,
          reasoning: { effort: 'medium' },
        },
        credentials: { apiKey: 'test-key', accountId: 'acct', source: 'env' },
        params: {
          model: 'gpt-5.6-terra',
          system: 'You are terse.',
          messages,
          tools: [{ name: 'Read', description: 'Reads', input_schema: { type: 'object', properties: {} } }],
          max_tokens: 1024,
        },
        defaultHeaders: {},
      })
      return bodies.at(-1)!
    }

    test('the Codex backend gets the fields the Codex CLI sends, and the replayed items', async () => {
      const body = await sendTurn(TURN)
      expect(body.include).toEqual(['reasoning.encrypted_content'])
      expect(body.reasoning).toEqual({ effort: 'medium', context: 'all_turns' })
      expect(body.text).toEqual({ verbosity: 'low' })
      expect(body.parallel_tool_calls).toBe(true)
      expect(body.store).toBe(false)
      expect(body.input).toEqual(REPLAYED)
    })

    test('with the killswitch off the body is the one sent before the replay', async () => {
      process.env.CLAUDIN_CODEX_REASONING_REPLAY = '0'
      const body = await sendTurn(TURN)
      expect(body).not.toHaveProperty('include')
      expect(body).not.toHaveProperty('text')
      expect(body.reasoning).toEqual({ effort: 'medium' })
      expect(body.input).toEqual(convertAnthropicMessagesToResponsesInput(TURN))
    })

    test('every request of a session sends the previous one as a prefix of its input', async () => {
      const history: Array<Record<string, unknown>> = [TURN[0]!]
      const inputs: unknown[][] = [(await sendTurn([...history])).input as unknown[]]
      for (const next of TURN.slice(1)) {
        history.push(next)
        inputs.push((await sendTurn([...history])).input as unknown[])
      }
      history.push({ role: 'user', content: 'and the sum?' })
      inputs.push((await sendTurn([...history])).input as unknown[])

      for (let i = 1; i < inputs.length; i++) {
        const previous = inputs[i - 1]!
        expect(JSON.stringify(inputs[i]!.slice(0, previous.length))).toBe(JSON.stringify(previous))
      }
      expect(inputs.at(-1)).toHaveLength(REPLAYED.length + 1)
    })
  })
})

// After the backend refuses a replayed reasoning item (the payload no longer
// decrypts, as after a switch of ChatGPT account), the items captured before
// the refusal stop going out, and the ones captured after keep going out.
describe('a refused reasoning replay', () => {
  const OLD = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_old', encrypted_content: 'old' } },
        { type: 'text', text: 'hello', codex: { id: 'msg_old', phase: 'final_answer' } },
      ],
    },
    { role: 'user', content: 'again' },
  ]
  const REFUSAL = {
    message: 'The encrypted content for item rs_old could not be verified.',
    type: 'invalid_request_error',
    param: 'input',
    code: 'invalid_encrypted_content',
  }

  function reasoningIdsIn(messages: Array<Record<string, unknown>>): string[] {
    return convertAnthropicMessagesToResponsesInput(messages, { replayCodexItems: true })
      .filter(item => item.type === 'reasoning')
      .map(item => (item as { id: string }).id)
  }

  test('an SSE refusal stops the earlier items and keeps the later ones', async () => {
    expect(reasoningIdsIn(OLD)).toEqual(['rs_old'])
    await expect(streamEvents([sseEvent('error', { error: REFUSAL })])).rejects.toThrow('invalid_encrypted_content')
    expect(reasoningIdsIn(OLD)).toEqual([])

    const reply = convertCodexResponseToAnthropicMessage(
      { output: [{ type: 'reasoning', id: 'rs_new', summary: [], encrypted_content: 'new' }] },
      'gpt-5.6-terra',
      { captureCodexItems: true },
    )
    expect(reasoningIdsIn([...OLD, { role: 'assistant', content: reply.content }])).toEqual(['rs_new'])
  })

  test('an HTTP 400 with the same code does the same', async () => {
    const realFetch = globalThis.fetch
    ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ error: REFUSAL }), { status: 400 })) as unknown as typeof fetch
    try {
      await expect(
        performCodexRequest({
          request: {
            transport: 'codex_responses',
            requestedModel: 'gpt-5.6-terra',
            resolvedModel: 'gpt-5.6-terra',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
          },
          credentials: { apiKey: 'k', accountId: 'a', source: 'env' },
          params: { model: 'gpt-5.6-terra', messages: OLD, max_tokens: 64 },
          defaultHeaders: {},
        }),
      ).rejects.toMatchObject({ status: 400 })
    } finally {
      ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
    }
    expect(reasoningIdsIn(OLD)).toEqual([])
  })

  test('any other error leaves the replay alone', async () => {
    await expect(
      streamEvents([sseEvent('error', { error: { ...REFUSAL, code: 'context_length_exceeded' } })]),
    ).rejects.toThrow()
    expect(reasoningIdsIn(OLD)).toEqual(['rs_old'])
  })
})

// Review finding, 2026-10-17: the refusal used to be noted when the event was
// read, so a stream that recovered still stopped the replay.
describe('an error event the stream recovers from', () => {
  const HISTORY = [
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_keep', encrypted_content: 'k' } }],
    },
  ]
  const REFUSAL_THEN_COMPLETED = [
    sseEvent('error', { error: { code: 'invalid_encrypted_content', type: 'invalid_request_error', message: 'x' } }),
    sseEvent('response.completed', { response: { output: [] } }),
  ]
  const replayedReasoning = () =>
    convertAnthropicMessagesToResponsesInput(HISTORY, { replayCodexItems: true }).filter(item => item.type === 'reasoning')

  test('a refusal followed by a completed stream leaves the replay alone', async () => {
    await streamEvents(REFUSAL_THEN_COMPLETED)
    expect(replayedReasoning()).toHaveLength(1)
  })

  test('the same through collect', async () => {
    await collectCodexCompletedResponse(responseFromChunks(REFUSAL_THEN_COMPLETED))
    expect(replayedReasoning()).toHaveLength(1)
  })
})

const { _setCodexSocketTransportForTesting } = await import('src/providers/shims/codex/websocket.js')

describe('performCodexRequest over the Codex WebSocket', () => {
  const realFetch = globalThis.fetch
  const savedFlag = process.env.CLAUDIN_CODEX_WEBSOCKET
  type SocketCall = { url: string; socketUrl: string; headers: Record<string, string>; body: Record<string, unknown>; http: () => Promise<Response> }
  let calls: SocketCall[]
  let posted: Array<{ url: string; body: Record<string, unknown> }>

  beforeEach(() => {
    calls = []
    posted = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      posted.push({ url: String(input), body: JSON.parse(init?.body as string) as Record<string, unknown> })
      return new Response(TEXT_STREAM, { status: 200 })
    }) as typeof fetch
    _setCodexSocketTransportForTesting({
      request: async request => {
        calls.push(request)
        return new Response(TEXT_STREAM, { status: 200 })
      },
      closeAll: () => {},
      latched: false,
    })
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    _setCodexSocketTransportForTesting(undefined)
    if (savedFlag === undefined) delete process.env.CLAUDIN_CODEX_WEBSOCKET
    else process.env.CLAUDIN_CODEX_WEBSOCKET = savedFlag
  })

  async function send(baseUrl: string): Promise<Response> {
    return performCodexRequest({
      request: { transport: 'codex_responses', requestedModel: 'gpt-5.6-terra', resolvedModel: 'gpt-5.6-terra', baseUrl, reasoning: { effort: 'medium' } },
      credentials: { apiKey: 'tok', accountId: 'acct', source: 'env' },
      params: { model: 'gpt-5.6-terra', system: 'be brief', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 },
      defaultHeaders: {},
    })
  }

  test('the Codex backend sends over the socket the body it would POST; the POST is its fallback', async () => {
    process.env.CLAUDIN_CODEX_WEBSOCKET = '1'
    const response = await send('https://chatgpt.com/backend-api/codex')
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(posted).toHaveLength(0)
    const call = calls[0]!
    expect(call.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(call.socketUrl).toBe('wss://chatgpt.com/backend-api/codex/responses')
    expect(call.headers['OpenAI-Beta']).toBe('responses_websockets=2026-02-06')
    expect(call.headers['Content-Type']).toBeUndefined()
    expect(call.headers.Authorization).toBe('Bearer tok')
    expect(call.headers['ChatGPT-Account-Id']).toBe('acct')

    await call.http()
    expect(posted).toHaveLength(1)
    expect(posted[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(posted[0]!.body).toEqual(call.body)
  })

  test('the killswitch POSTs as before and never touches the socket', async () => {
    process.env.CLAUDIN_CODEX_WEBSOCKET = '0'
    await send('https://chatgpt.com/backend-api/codex')
    expect(calls).toHaveLength(0)
    expect(posted).toHaveLength(1)
  })

  test('a relay with its own baseUrl POSTs even with the socket on', async () => {
    process.env.CLAUDIN_CODEX_WEBSOCKET = '1'
    await send('http://localhost:8000/v1')
    expect(calls).toHaveLength(0)
    expect(posted).toHaveLength(1)
  })

  test('a refused socket answer surfaces like a refused POST', async () => {
    process.env.CLAUDIN_CODEX_WEBSOCKET = '1'
    _setCodexSocketTransportForTesting({
      request: async () => new Response('{"error":{"message":"expired"}}', { status: 401 }),
      closeAll: () => {},
      latched: false,
    })
    const error = await send('https://chatgpt.com/backend-api/codex').catch((e: unknown) => e)
    expect((error as { status?: number }).status).toBe(401)
  })
})

describe('events only the WebSocket sends', () => {
  // Codex CLI 0.163 capture (2026-10-17): these arrive between the usual
  // events of every response, and none of them belongs in the message.
  const WS_ONLY = [
    sseEvent('codex.rate_limits', { plan_type: 'plus', rate_limits: { primary: { used_percent: 46 } } }),
    sseEvent('codex.response.metadata', { headers: { 'x-codex-turn-state': 'gAAA', 'x-models-etag': 'W/"1"' } }),
    sseEvent('response.metadata', { metadata: {} }),
    sseEvent('responsesapi.websocket_timing', { timing: { queue_ms: 3 } }),
  ]

  test('a stream that carries them reads exactly as one that does not', async () => {
    const [rateLimits, metadata, responseMetadata, timing] = WS_ONLY
    const withThem = [rateLimits!, metadata!, TEXT_STREAM.replace('event: response.completed', `${responseMetadata}${timing}event: response.completed`)]
    expect(await streamEvents(withThem)).toEqual(await streamEvents([TEXT_STREAM]))
    expect(await streamEvents(withThem)).toEqual(TEXT_EVENTS)
  })

  test('the completed response is found past them', async () => {
    const completed = await collectCodexCompletedResponse(responseFromChunks([...WS_ONLY, TEXT_STREAM]))
    expect(completed.id).toBe('resp_1')
  })
})
