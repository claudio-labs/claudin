/**
 * Regression pins for the 11k openaiShim split.
 *
 * The historical monolith (~2.2k LoC) was split across 10 leaf modules in
 * refactor 11k. The existing openaiShim.test.ts has thorough coverage of
 * top-level behavior but several leaf helpers were not directly asserted —
 * they only worked transitively through end-to-end tests. This file pins
 * those helpers behaviorally so a future internal re-shuffle of the shim
 * cannot silently change them.
 *
 * Add a test here when:
 *   - You extract a new pure helper out of the monolith.
 *   - You discover a subtle case (DeepSeek tool-result collapse, Gemini
 *     baseUrl detection, query-param redaction edge case) that the
 *     end-to-end tests would not have caught on regression.
 *
 * Do NOT add tests here for: streaming, request building, retry — those
 * belong in openaiShim.test.ts where the full client is wired up.
 */

import { describe, expect, test } from 'bun:test'

import { filterAnthropicHeaders, formatRetryAfterHint } from 'src/providers/shims/openaiShim/headers.js'
import { makeMessageId } from 'src/providers/shims/openaiShim/helpers.js'
import {
  convertContentBlocks,
  convertMessages,
  convertSystemPrompt,
  convertToolResultContent,
} from 'src/providers/shims/openaiShim/messageConverter.js'
import {
  hasGeminiApiHost,
  isDeepSeekBaseUrl,
  isGlmCompatibleBaseUrl,
  isMoonshotCompatibleBaseUrl,
  normalizeDeepSeekReasoningEffort,
} from 'src/providers/shims/openaiShim/providerModes.js'
import {
  convertChunkUsage,
  OpenAIShimStream,
  repairPossiblyTruncatedObjectJson,
} from 'src/providers/shims/openaiShim/streamParser.js'
import { convertTools } from 'src/providers/shims/openaiShim/toolConverter.js'
import {
  redactUrlForDiagnostics,
  shouldRedactUrlQueryParam,
} from 'src/providers/shims/openaiShim/urlRedaction.js'

describe('convertSystemPrompt', () => {
  test('empty/nullish → empty string', () => {
    expect(convertSystemPrompt(undefined)).toBe('')
    expect(convertSystemPrompt(null)).toBe('')
    expect(convertSystemPrompt('')).toBe('')
  })

  test('plain string passes through', () => {
    expect(convertSystemPrompt('hello')).toBe('hello')
  })

  test('array of text blocks joins with double newline', () => {
    const out = convertSystemPrompt([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])
    expect(out).toBe('one\n\ntwo')
  })

  test('non-text blocks become empty entries', () => {
    const out = convertSystemPrompt([
      { type: 'text', text: 'kept' },
      { type: 'image' },
    ])
    expect(out).toBe('kept\n\n')
  })

  test('non-string/non-array stringifies', () => {
    expect(convertSystemPrompt(42)).toBe('42')
  })
})

describe('convertToolResultContent', () => {
  test('string result preserved; error prefix added when isError', () => {
    expect(convertToolResultContent('ok')).toBe('ok')
    expect(convertToolResultContent('boom', true)).toBe('Error: boom')
  })

  test('text-only array collapses to single string (DeepSeek #774)', () => {
    const out = convertToolResultContent([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
    expect(out).toBe('a\n\nb')
  })

  test('mixed text + image stays as array, error prefix mutates first text block', () => {
    const out = convertToolResultContent(
      [
        { type: 'text', text: 'hi' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
        },
      ],
      true,
    )
    expect(Array.isArray(out)).toBe(true)
    const arr = out as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(arr[0]).toEqual({ type: 'text', text: 'Error: hi' })
    expect(arr[1].type).toBe('image_url')
    expect(arr[1].image_url?.url).toBe('data:image/png;base64,AAA')
  })

  test('empty array → empty string', () => {
    expect(convertToolResultContent([])).toBe('')
  })

  test('object content gets JSON-stringified', () => {
    expect(convertToolResultContent({ a: 1 })).toBe('{"a":1}')
  })
})

describe('convertContentBlocks', () => {
  test('strips thinking / redacted_thinking blocks (3P providers reject them)', () => {
    const out = convertContentBlocks([
      { type: 'thinking', text: 'private' },
      { type: 'redacted_thinking', text: 'masked' },
      { type: 'text', text: 'public' },
    ])
    // Single surviving text block collapses to bare string.
    expect(out).toBe('public')
  })

  test('multiple text blocks survive as joined string (no thinking leakage)', () => {
    const out = convertContentBlocks([
      { type: 'thinking', text: 'private' },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
    expect(out).toBe('a\n\nb')
  })

  test('image url and base64 → image_url', () => {
    const out = convertContentBlocks([
      { type: 'image', source: { type: 'url', url: 'http://x/y.png' } },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'ZZZ' },
      },
    ])
    expect(out).toEqual([
      { type: 'image_url', image_url: { url: 'http://x/y.png' } },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZZZ' } },
    ])
  })

  test('plain string passes through', () => {
    expect(convertContentBlocks('raw')).toBe('raw')
  })
})

describe('providerModes — URL-driven detectors', () => {
  test('hasGeminiApiHost matches generativelanguage.googleapis.com only', () => {
    expect(hasGeminiApiHost('https://generativelanguage.googleapis.com/v1beta')).toBe(true)
    expect(hasGeminiApiHost('https://api.openai.com/v1')).toBe(false)
    expect(hasGeminiApiHost(undefined)).toBe(false)
    expect(hasGeminiApiHost('not-a-url')).toBe(false)
  })

  test('isMoonshotCompatibleBaseUrl covers both moonshot hosts + kimi /coding', () => {
    expect(isMoonshotCompatibleBaseUrl('https://api.moonshot.ai/v1')).toBe(true)
    expect(isMoonshotCompatibleBaseUrl('https://api.moonshot.cn/v1')).toBe(true)
    expect(isMoonshotCompatibleBaseUrl('https://api.kimi.com/coding/anthropic')).toBe(true)
    // kimi.com without /coding does NOT count as moonshot-compatible
    expect(isMoonshotCompatibleBaseUrl('https://api.kimi.com/v1')).toBe(false)
    expect(isMoonshotCompatibleBaseUrl(undefined)).toBe(false)
  })

  test('isDeepSeekBaseUrl matches api.deepseek.com only', () => {
    expect(isDeepSeekBaseUrl('https://api.deepseek.com/v1')).toBe(true)
    expect(isDeepSeekBaseUrl('https://deepseek.com/v1')).toBe(false)
    expect(isDeepSeekBaseUrl(undefined)).toBe(false)
  })

  test('isGlmCompatibleBaseUrl matches all GLM hosts', () => {
    expect(isGlmCompatibleBaseUrl('https://api.z.ai/v1')).toBe(true)
    expect(isGlmCompatibleBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(true)
    expect(isGlmCompatibleBaseUrl('https://bigmodel.cn/api/paas/v4')).toBe(true)
    expect(isGlmCompatibleBaseUrl('https://api.zhipuai.cn/v1')).toBe(true)
    expect(isGlmCompatibleBaseUrl('https://opencode.ai/zen/v1')).toBe(true)
    expect(isGlmCompatibleBaseUrl('https://opencode.ai/zen/go/v1')).toBe(true)
    expect(isGlmCompatibleBaseUrl('https://example.com/v1')).toBe(false)
    expect(isGlmCompatibleBaseUrl(undefined)).toBe(false)
  })

  test('normalizeDeepSeekReasoningEffort maps xhigh→max, everything else→high', () => {
    expect(normalizeDeepSeekReasoningEffort('low')).toBe('high')
    expect(normalizeDeepSeekReasoningEffort('medium')).toBe('high')
    expect(normalizeDeepSeekReasoningEffort('high')).toBe('high')
    expect(normalizeDeepSeekReasoningEffort('xhigh')).toBe('max')
  })
})

describe('urlRedaction', () => {
  test('shouldRedactUrlQueryParam covers known secret param names', () => {
    for (const name of [
      'api_key',
      'API_KEY',
      'key',
      'token',
      'access_token',
      'refresh_token',
      'signature',
      'sig',
      'secret',
      'password',
      'authorization',
    ]) {
      expect(shouldRedactUrlQueryParam(name)).toBe(true)
    }
    expect(shouldRedactUrlQueryParam('model')).toBe(false)
    expect(shouldRedactUrlQueryParam('region')).toBe(false)
  })

  test('redactUrlForDiagnostics replaces sensitive query params and userinfo', () => {
    const url = 'https://user:pw@api.example.com/v1?api_key=secret&model=gpt-4o&token=xyz'
    const out = redactUrlForDiagnostics(url)
    expect(out).toContain('api_key=redacted')
    expect(out).toContain('token=redacted')
    expect(out).toContain('model=gpt-4o')
    expect(out).toContain(':redacted@')
    expect(out).not.toContain('secret')
    expect(out).not.toContain('xyz')
    expect(out).not.toContain(':pw@')
  })

  test('redactUrlForDiagnostics on garbage input returns the original (no env match)', () => {
    const out = redactUrlForDiagnostics('not-a-url')
    expect(out).toBe('not-a-url')
  })

  test('redactUrlForDiagnostics on garbage input still runs env-secret pass', () => {
    // Pin the catch-block path: when URL parsing fails, the input is still
    // funneled through redactSecretValueForDisplay. The redactor matches
    // a whole-value secret OR a value that LOOKS like a secret (starts with
    // `sk-`, `sk-ant-`, `AIza`). Use a sk- prefix so the prefix-detector
    // fires regardless of env contents.
    const secret = 'sk-test-leak-9f8d7a6b5c4e3'
    const out = redactUrlForDiagnostics(secret)
    expect(out).not.toBe(secret)
    expect(out).not.toContain('leak-9f8d7a6b5c4e3')
  })
})

describe('streamParser leaf helpers', () => {
  test('convertChunkUsage returns undefined when usage is missing', () => {
    expect(convertChunkUsage(undefined)).toBeUndefined()
  })

  test('convertChunkUsage maps OpenAI-style prompt_tokens with cached_tokens (fresh-only invariant)', () => {
    const out = convertChunkUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30 },
    } as Parameters<typeof convertChunkUsage>[0])
    // Anthropic convention: input_tokens is FRESH only (100 - 30 = 70).
    expect(out?.input_tokens).toBe(70)
    expect(out?.cache_read_input_tokens).toBe(30)
    expect(out?.output_tokens).toBe(20)
  })

  test('repairPossiblyTruncatedObjectJson returns input unchanged when already valid', () => {
    expect(repairPossiblyTruncatedObjectJson('{"a":1}')).toBe('{"a":1}')
  })

  test('repairPossiblyTruncatedObjectJson appends closing brace combo when truncated', () => {
    // Missing only the final `}` — the simplest suffix should fix it.
    const repaired = repairPossiblyTruncatedObjectJson('{"a":1')
    expect(repaired).toBe('{"a":1}')
    // Truncated mid-string then mid-object — needs '"}' suffix.
    const repaired2 = repairPossiblyTruncatedObjectJson('{"a":"x')
    expect(repaired2).toBe('{"a":"x"}')
  })

  test('repairPossiblyTruncatedObjectJson rejects arrays and primitives', () => {
    // Whole-doc arrays and primitives must not be reported as "repaired".
    expect(repairPossiblyTruncatedObjectJson('[1,2,3]')).toBeNull()
    expect(repairPossiblyTruncatedObjectJson('"plain"')).toBeNull()
    expect(repairPossiblyTruncatedObjectJson('garbage')).toBeNull()
  })

  test('OpenAIShimStream forwards a generator and exposes an AbortController', async () => {
    async function* gen() {
      yield { type: 'message_stop' } as const
    }
    const stream = new OpenAIShimStream(
      gen() as unknown as ConstructorParameters<typeof OpenAIShimStream>[0],
    )
    // claude.ts uses presence of `controller` to distinguish streams from errors.
    expect(stream.controller).toBeInstanceOf(AbortController)
    const events: Array<{ type: string }> = []
    for await (const ev of stream) events.push(ev)
    expect(events).toEqual([{ type: 'message_stop' }])
  })
})

describe('convertMessages — orphan tool_result drop', () => {
  test('drops tool_result whose tool_use_id was never declared by an assistant', () => {
    // Synthesized scenario: user ESC'd mid-tool, a tool_result was synthesized
    // for an ID that no prior assistant message declared. Emitting it would
    // trigger "role must alternate" / "unexpected role" on Mistral/OpenAI.
    const out = convertMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'never-declared', content: 'x' },
          ],
        },
      ],
      '',
    )
    // No system prompt, no tool message, no user message (only-orphan input).
    expect(out).toEqual([])
  })

  test('keeps tool_result when a prior assistant declared the matching tool_use', () => {
    const out = convertMessages(
      [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'Calc', input: { a: 1 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: '2' },
          ],
        },
      ],
      '',
    )
    const tool = out.find(m => m.role === 'tool')
    expect(tool).toBeDefined()
    expect((tool as { tool_call_id: string }).tool_call_id).toBe('call_1')
  })
})

describe('headers', () => {
  test('filterAnthropicHeaders drops anthropic-* / x-anthropic-* / auth headers', () => {
    const out = filterAnthropicHeaders({
      'anthropic-version': '2023-06-01',
      'X-Anthropic-Foo': 'bar',
      'x-claude-bar': 'baz',
      'x-app': 'claudin',
      'x-client-app': 'claudin',
      Authorization: 'Bearer x',
      'x-api-key': 'sk-xxx',
      'api-key': 'azure-key',
      'Content-Type': 'application/json',
      'X-Custom-Trace': 'keep-me',
    })
    expect(out).toEqual({
      'Content-Type': 'application/json',
      'X-Custom-Trace': 'keep-me',
    })
  })

  test('filterAnthropicHeaders returns {} for undefined input', () => {
    expect(filterAnthropicHeaders(undefined)).toEqual({})
  })

  test('formatRetryAfterHint formats / omits based on header presence', () => {
    const withHdr = new Response(null, { headers: { 'retry-after': '12' } })
    const withoutHdr = new Response(null)
    expect(formatRetryAfterHint(withHdr)).toBe(' (Retry-After: 12)')
    expect(formatRetryAfterHint(withoutHdr)).toBe('')
  })
})

describe('helpers', () => {
  test('makeMessageId produces a stable msg_ prefix + 32 hex chars', () => {
    const id = makeMessageId()
    expect(id).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(makeMessageId()).not.toBe(id)
  })
})

describe('convertTools', () => {
  test('drops ToolSearchTool and Anthropic server-side tools', () => {
    const out = convertTools([
      {
        name: 'ToolSearchTool',
        description: 'noop',
        input_schema: { type: 'object', properties: {} },
      },
      { name: 'web_search_20250305', type: 'web_search_20250305' },
      {
        name: 'MyTool',
        description: 'real',
        input_schema: { type: 'object', properties: {} },
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].function.name).toBe('MyTool')
  })

  test("keeps type:'custom' user tools (e.g. the auto-mode classifier schema)", () => {
    // Regression: type:'custom' is a regular user tool with an input_schema, not
    // a server tool. Dropping it starved the auto-mode classifier's forced
    // tool_choice on every openai_compat provider (the tool never reached the
    // model), so non-Claude auto mode could never pass its capability probe.
    const out = convertTools([
      {
        name: 'classify_result',
        type: 'custom',
        description: 'Report the security classification result',
        input_schema: {
          type: 'object',
          properties: {
            thinking: { type: 'string' },
            shouldBlock: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['thinking', 'shouldBlock', 'reason'],
        },
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].function.name).toBe('classify_result')
  })

  test('strict mode keeps only originally-required keys and adds additionalProperties:false', () => {
    const out = convertTools([
      {
        name: 'Calc',
        description: 'add',
        input_schema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
            note: { type: 'string' },
          },
          required: ['a'],
        },
      },
    ])
    const params = out[0].function.parameters as Record<string, unknown>
    expect(params.required).toEqual(['a'])
    expect(params.additionalProperties).toBe(false)
  })

  test('Agent tool promotes message + subagent_type into required when present', () => {
    const out = convertTools([
      {
        name: 'Agent',
        description: '',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            subagent_type: { type: 'string' },
            other: { type: 'string' },
          },
        },
      },
    ])
    const params = out[0].function.parameters as Record<string, unknown>
    const required = params.required as string[]
    expect(required).toContain('message')
    expect(required).toContain('subagent_type')
    expect(required).not.toContain('other')
  })
})
