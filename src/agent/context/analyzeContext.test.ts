import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'

import { invalidateClientCache } from 'src/providers/transport/clientCache.js'
import type { Tool } from 'src/tools/Tool.js'

const realClient = { ...(await import('src/providers/transport/client.js')) }
const realModel = { ...(await import('src/providers/model/model.js')) }

const {
  countToolDefinitionTokens,
  estimateAttachmentTokens,
  TOOL_TOKEN_COUNT_OVERHEAD,
} = await import('src/agent/context/analyzeContext.js')

// Shim-shaped client: beta.messages exists but has no countTokens method —
// this is what getAnthropicClient returns for any OpenAI-compatible provider.
function mockShimClient(): void {
  invalidateClientCache()
  mock.module('src/providers/transport/client.js', () => ({
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
  mock.module('src/providers/model/model.js', () => ({
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
  mock.module('src/providers/transport/client.js', () => realClient)
  mock.module('src/providers/model/model.js', () => realModel)
  invalidateClientCache()
})

afterAll(() => {
  mock.module('src/providers/transport/client.js', () => realClient)
  mock.module('src/providers/model/model.js', () => realModel)
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

describe('estimateAttachmentTokens — the attachment row of /context', () => {
  // A file attachment keeps the Read block it rendered at creation
  // (`rendered`, types.ts), for a resumed process to re-send: the same file
  // again, line-numbered. The row counts the file, not the file twice.
  it('counts a file attachment once, not again for the block it rendered', () => {
    const body = Array.from({ length: 200 }, (_, i) => `const row${i} = ${i}`).join('\n')
    const live = {
      type: 'file',
      filename: '/repo/src/rows.ts',
      displayPath: 'src/rows.ts',
      content: {
        type: 'text',
        file: { filePath: '/repo/src/rows.ts', content: body, numLines: 200, startLine: 1, totalLines: 200 },
      },
    } as unknown as Parameters<typeof estimateAttachmentTokens>[0]
    const rendered = body
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
      .join('\n')

    expect(estimateAttachmentTokens({ ...live, rendered } as typeof live)).toBe(
      estimateAttachmentTokens(live),
    )
  })
})
