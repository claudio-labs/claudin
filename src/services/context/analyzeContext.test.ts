import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'

import { invalidateClientCache } from 'src/services/api/clientCache.js'
import type { Tool } from 'src/Tool.js'

const realClient = { ...(await import('src/services/api/client.js')) }
const realModel = { ...(await import('src/utils/model/model.js')) }

const {
  countToolDefinitionTokens,
  TOOL_TOKEN_COUNT_OVERHEAD,
} = await import('./analyzeContext.js')

// Shim-shaped client: beta.messages exists but has no countTokens method —
// this is what getAnthropicClient returns for any OpenAI-compatible provider.
function mockShimClient(): void {
  invalidateClientCache()
  mock.module('src/services/api/client.js', () => ({
    ...realClient,
    getAnthropicClient: async () => ({
      beta: {
        messages: {
          create: async () => {
            throw new Error('create must not be called for token counting')
          },
        },
      },
    }),
  }))
  mock.module('src/utils/model/model.js', () => ({
    ...realModel,
    getMainLoopModel: () => 'claude-opus-4-8-high',
    getSmallFastModel: () => 'claude-opus-4-8-high',
  }))
}

function fakeTool(name: string, description: string): Tool {
  return {
    name,
    prompt: async () => description,
    inputJSONSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
  } as unknown as Tool
}

const getToolPermissionContext = async () =>
  ({}) as never

afterEach(() => {
  mock.module('src/services/api/client.js', () => realClient)
  mock.module('src/utils/model/model.js', () => realModel)
  invalidateClientCache()
})

afterAll(() => {
  mock.module('src/services/api/client.js', () => realClient)
  mock.module('src/utils/model/model.js', () => realModel)
  invalidateClientCache()
})

describe('countToolDefinitionTokens — local estimation fallback on shim providers', () => {
  // Regression: on OpenAI-shim providers the client has no countTokens, so
  // every /context category funnelled through countTokensWithFallback
  // returned 0 and was hidden. The funnel must now fall back to local
  // estimation instead of null.
  it('returns a nonzero estimate when the client lacks countTokens', async () => {
    mockShimClient()

    const tokens = await countToolDefinitionTokens(
      [fakeTool('fake_tool', 'A fake tool used to test local estimation.')],
      getToolPermissionContext,
      null,
    )

    // Local estimate = serialized schema + the ~500-token request overhead
    // the real API would include (kept so downstream subtraction stays valid).
    expect(tokens).toBeGreaterThan(TOOL_TOKEN_COUNT_OVERHEAD)
  })

  it('scales with the tool description size (proves it is a content estimate)', async () => {
    mockShimClient()

    const small = await countToolDefinitionTokens(
      [fakeTool('small_tool', 'tiny')],
      getToolPermissionContext,
      null,
    )
    const large = await countToolDefinitionTokens(
      [fakeTool('large_tool', 'x'.repeat(3500))],
      getToolPermissionContext,
      null,
    )

    // 3500 chars at 3.5 bytes/token (claude family) ≈ 1000 tokens more.
    expect(large - small).toBeGreaterThan(800)
  })
})
