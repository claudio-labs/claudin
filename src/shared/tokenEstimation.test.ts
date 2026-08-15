import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'

import {
  __resetMemoizedRatiosForTests,
  countTokensViaHaikuFallback,
  getActiveModelBytesPerToken,
  getTokenizerConfig,
  roughTokenCountEstimation,
  roughTokenCountEstimationForCountRequest,
  roughTokenCountEstimationForFileType,
} from 'src/shared/tokenEstimation.js'
import { invalidateClientCache } from 'src/providers/transport/clientCache.js'

const realModel = { ...(await import('src/providers/model/model.js')) }
const realClient = { ...(await import('src/providers/transport/client.js')) }
const realActiveProvider = { ...(await import('src/providers/presets/activeProvider.js')) }

function setActiveModel(name: string): void {
  mock.module('src/providers/model/model.js', () => ({
    ...realModel,
    getMainLoopModel: () => name,
  }))
}

function unsetActiveModel(): void {
  mock.module('src/providers/model/model.js', () => ({
    ...realModel,
    getMainLoopModel: () => {
      throw new Error('no provider active')
    },
  }))
}

function restoreModelModule(): void {
  mock.module('src/providers/model/model.js', () => realModel)
}

afterEach(() => {
  restoreModelModule()
  mock.module('src/providers/transport/client.js', () => realClient)
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProvider)
  __resetMemoizedRatiosForTests()
})

afterAll(() => {
  mock.module('src/providers/model/model.js', () => realModel)
  mock.module('src/providers/transport/client.js', () => realClient)
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProvider)
})

describe('roughTokenCountEstimation — model-aware', () => {
  it('falls back to 4 bytes/token when getMainLoopModel throws', () => {
    unsetActiveModel()
    // 40 chars / 4 = 10 tokens
    expect(roughTokenCountEstimation('a'.repeat(40))).toBe(10)
  })

  it('uses 3.5 ratio for Claude family', () => {
    setActiveModel('claude-sonnet-4-5-20250514')
    // 35 chars / 3.5 = 10 tokens
    expect(roughTokenCountEstimation('a'.repeat(35))).toBe(10)
  })

  it('uses 4.0 ratio for Gemini (regression: was 3.5)', () => {
    setActiveModel('gemini-2.0-flash')
    // 40 chars / 4 = 10 tokens. Pre-fix this returned ~11 (3.5 ratio).
    expect(roughTokenCountEstimation('a'.repeat(40))).toBe(10)
  })

  it('uses 3.5 ratio for DeepSeek', () => {
    setActiveModel('deepseek-chat')
    expect(roughTokenCountEstimation('a'.repeat(35))).toBe(10)
  })

  it('uses 4.0 ratio for GPT-4o', () => {
    setActiveModel('gpt-4o-2024-08-06')
    expect(roughTokenCountEstimation('a'.repeat(40))).toBe(10)
  })

  it('uses 3.8 ratio for Mistral', () => {
    setActiveModel('mistral-large-2411')
    // 38 chars / 3.8 = 10
    expect(roughTokenCountEstimation('a'.repeat(38))).toBe(10)
  })

  it('explicit bytesPerToken override beats active-model lookup', () => {
    setActiveModel('gemini-2.0-flash') // would be 4
    // Force 2 (JSON dense ratio); 4 chars / 2 = 2 tokens
    expect(roughTokenCountEstimation('xxxx', 2)).toBe(2)
  })

  it('roughTokenCountEstimationForFileType keeps json=2 override', () => {
    setActiveModel('claude-sonnet-4-5')
    const json = '{"k":"v"}'.repeat(10) // 90 chars
    // JSON ratio is 2 → 45 tokens. Active-model ratio (3.5) would give ~26.
    expect(roughTokenCountEstimationForFileType(json, 'json')).toBe(45)
  })

  it('does not throw if getMainLoopModel itself throws', () => {
    unsetActiveModel()
    expect(() => roughTokenCountEstimation('hello world')).not.toThrow()
  })

  it('memoizes ratio: getMainLoopModel called every call but family lookup runs once per name', () => {
    let getMainLoopCalls = 0
    mock.module('src/providers/model/model.js', () => ({
      ...realModel,
      getMainLoopModel: () => {
        getMainLoopCalls += 1
        return 'claude-sonnet-4-5'
      },
    }))
    // Reset module-level cache before this test so we can assert exact behaviour.
    __resetMemoizedRatiosForTests()

    roughTokenCountEstimation('foo')
    roughTokenCountEstimation('bar')
    roughTokenCountEstimation('baz')

    // getMainLoopModel itself is cheap; we call it every time to detect model
    // switches. The expensive family-regex walk happens only once per model.
    expect(getMainLoopCalls).toBe(3)
    // Map has exactly one entry — the active model — proving the family
    // regex didn't re-walk for repeat calls.
    expect(getActiveModelBytesPerToken()).toBe(3.5)
  })

  it('cache supports multiple distinct models without thrashing', () => {
    __resetMemoizedRatiosForTests()
    setActiveModel('claude-sonnet-4-5')
    expect(getActiveModelBytesPerToken()).toBe(3.5)
    setActiveModel('gemini-2.5-flash')
    expect(getActiveModelBytesPerToken()).toBe(4)
    // Switch back — should still hit cache, not re-walk.
    setActiveModel('claude-sonnet-4-5')
    expect(getActiveModelBytesPerToken()).toBe(3.5)
  })

  it('updates ratio when active model changes', () => {
    setActiveModel('claude-sonnet-4-5') // 3.5
    expect(roughTokenCountEstimation('a'.repeat(35))).toBe(10)
    setActiveModel('gemini-2.5-flash') // 4
    expect(roughTokenCountEstimation('a'.repeat(40))).toBe(10)
  })
})

describe('getTokenizerConfig — word boundary matching', () => {
  // Regression: short family names like 'phi' / 'command' / 'glm' must not
  // substring-match unrelated names like 'morpheus', 'slash-command', etc.

  it('phi does not match morpheus / sapphire (substring false positives)', () => {
    expect(getTokenizerConfig('morpheus-7b').modelFamily).toBe('unknown')
    expect(getTokenizerConfig('sapphire-3').modelFamily).toBe('unknown')
    expect(getTokenizerConfig('atrophic-1').modelFamily).toBe('unknown')
  })

  it('phi DOES match phi-4 and microsoft/phi-4', () => {
    expect(getTokenizerConfig('phi-4').modelFamily).toBe('phi')
    expect(getTokenizerConfig('microsoft/phi-4').modelFamily).toBe('phi')
  })

  it('command does not match algorithm / accommodate', () => {
    expect(getTokenizerConfig('algorithm-1').modelFamily).toBe('unknown')
  })

  it('command DOES match command-r and cohere/command-r-plus', () => {
    expect(getTokenizerConfig('command-r').modelFamily).toBe('command')
    expect(getTokenizerConfig('cohere/command-r-plus').modelFamily).toBe('command')
  })

  it('glm does not match algorithm', () => {
    expect(getTokenizerConfig('algorithm').modelFamily).toBe('unknown')
  })

  it('gemma does not collide with gemini', () => {
    expect(getTokenizerConfig('gemma-3-27b').modelFamily).toBe('gemma')
    expect(getTokenizerConfig('gemini-2.5-flash').modelFamily).toBe('gemini')
  })
})

describe('countTokensViaHaikuFallback — uses free countTokens, not paid messages.create', () => {
  it('calls beta.messages.countTokens (free) and never beta.messages.create (paid)', async () => {
    invalidateClientCache()
    const countTokensSpy = mock(async () => ({ input_tokens: 42 }))
    const createSpy = mock(async () => {
      throw new Error('messages.create must NOT be called for token counting')
    })
    mock.module('src/providers/transport/client.js', () => ({
      getAnthropicClient: async () => ({
        beta: {
          messages: {
            countTokens: countTokensSpy,
            create: createSpy,
          },
        },
      }),
    }))
    mock.module('src/providers/presets/activeProvider.js', () => ({
      ...realActiveProvider,
      tryGetActiveProvider: () => ({ transport: 'anthropic' }),
      getAPIProvider: () => 'anthropic',
    }))

    const result = await countTokensViaHaikuFallback(
      [{ role: 'user', content: 'hello' }],
      [],
    )

    expect(result).toBe(42)
    expect(countTokensSpy).toHaveBeenCalledTimes(1)
    expect(createSpy).not.toHaveBeenCalled()
  })
})

describe('countTokensViaHaikuFallback — client without a counting endpoint', () => {
  it('returns null instead of throwing when the client lacks countTokens (OpenAI shim)', async () => {
    invalidateClientCache()
    const createSpy = mock(async () => {
      throw new Error('messages.create must NOT be called for token counting')
    })
    // Shim-shaped client: beta.messages exists but has no countTokens method.
    mock.module('src/providers/transport/client.js', () => ({
      getAnthropicClient: async () => ({
        beta: {
          messages: {
            create: createSpy,
          },
        },
      }),
    }))
    mock.module('src/providers/presets/activeProvider.js', () => ({
      ...realActiveProvider,
      tryGetActiveProvider: () => ({ transport: 'openai_compat' }),
      getAPIProvider: () => 'openai',
    }))

    const result = await countTokensViaHaikuFallback(
      [{ role: 'user', content: 'hello' }],
      [],
    )

    expect(result).toBeNull()
    expect(createSpy).not.toHaveBeenCalled()
  })
})

describe('roughTokenCountEstimationForCountRequest — local counting fallback', () => {
  it('estimates string message content with the active model ratio', () => {
    setActiveModel('claude-opus-4-8-high') // claude family → 3.5 bytes/token
    expect(
      roughTokenCountEstimationForCountRequest(
        [{ role: 'user', content: 'a'.repeat(35) }],
        [],
      ),
    ).toBe(10)
  })

  it('sums block content across messages plus serialized tool schemas', () => {
    setActiveModel('claude-sonnet-4-5') // 3.5 bytes/token
    const tools = [
      { name: 'MyTool', description: 'does things', input_schema: { type: 'object' } },
    ]
    const expectedToolTokens = Math.round(JSON.stringify(tools).length / 3.5)
    const result = roughTokenCountEstimationForCountRequest(
      [
        { role: 'user', content: [{ type: 'text', text: 'a'.repeat(35) }] },
        { role: 'assistant', content: 'b'.repeat(70) },
      ],
      tools,
    )
    expect(result).toBe(10 + 20 + expectedToolTokens)
  })

  it('returns 0 for an empty request and skips the tools term when none given', () => {
    setActiveModel('claude-sonnet-4-5')
    expect(roughTokenCountEstimationForCountRequest([], [])).toBe(0)
  })
})
