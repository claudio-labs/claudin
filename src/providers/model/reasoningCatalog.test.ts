import { afterEach, describe, expect, test } from 'bun:test'

import {
  clampEffortToValues,
  lookupReasoningEffortValues,
  pickerEffortLevels,
  reasoningEffortWireFor,
  resolveCatalogProviderId,
  resolveShimEffortValues,
} from 'src/providers/model/reasoningCatalog.js'

afterEach(() => {
  delete process.env.CLAUDIN_DISABLE_REASONING_EFFORT_WIRE
})

describe('resolveCatalogProviderId', () => {
  test('separates the two OpenCode lanes by path', () => {
    expect(resolveCatalogProviderId('https://opencode.ai/zen/go/v1')).toBe('opencode-go')
    expect(resolveCatalogProviderId('https://opencode.ai/zen/v1')).toBe('opencode')
  })

  test('separates the Z.AI coding plan from the general endpoint', () => {
    // Same host, different plan, different model line-up. Matching on the
    // hostname alone would hand the coding plan the general endpoint's levels.
    expect(resolveCatalogProviderId('https://api.z.ai/api/coding/paas/v4')).toBe(
      'zai-coding-plan',
    )
    expect(resolveCatalogProviderId('https://api.z.ai/api/paas/v4')).toBe('zai')
  })

  test('matches hosts whose catalog entry carries no api URL', () => {
    expect(resolveCatalogProviderId('https://api.openai.com/v1')).toBe('openai')
    expect(resolveCatalogProviderId('https://my-res.openai.azure.com/openai/v1')).toBe(
      'azure',
    )
    expect(
      resolveCatalogProviderId('https://generativelanguage.googleapis.com/v1beta/openai'),
    ).toBe('google')
    expect(resolveCatalogProviderId('https://api.groq.com/openai/v1')).toBe('groq')
  })

  test('matches Vertex on the region separator, not a bare suffix', () => {
    expect(
      resolveCatalogProviderId('https://us-central1-aiplatform.googleapis.com'),
    ).toBe('google-vertex')
    expect(resolveCatalogProviderId('https://aiplatform.googleapis.com')).toBe(
      'google-vertex',
    )
    // Without the separator in the test, any host ending in those characters
    // would claim the row.
    expect(
      resolveCatalogProviderId('https://evilaiplatform.googleapis.com'),
    ).toBeUndefined()
  })

  test('treats an upstream placeholder segment as a wildcard', () => {
    // The catalog publishes .../accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1.
    expect(
      resolveCatalogProviderId(
        'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
      ),
    ).toBe('cloudflare-workers-ai')
  })

  test('returns undefined for an unknown or malformed endpoint', () => {
    expect(resolveCatalogProviderId('https://llm.example.test/v1')).toBeUndefined()
    expect(resolveCatalogProviderId('not-a-url')).toBeUndefined()
    expect(resolveCatalogProviderId(undefined)).toBeUndefined()
  })

  test('an unrecognized path on a known host claims no row', () => {
    // Same host and the same number of segments as the coding plan, different
    // path. Matching on segment COUNT alone would hand this the coding plan's
    // model list; the answer is to claim nothing.
    expect(resolveCatalogProviderId('https://api.z.ai/api/other/paas/v4')).toBeUndefined()
  })
})

describe('lookupReasoningEffortValues', () => {
  const GO = 'https://opencode.ai/zen/go/v1'

  test('reports the exact per-model level list', () => {
    // glm-5.3 rejects `medium`; a provider-wide list cannot express that.
    expect(lookupReasoningEffortValues(GO, 'glm-5.3-flash')).toEqual([
      'low',
      'high',
      'max',
    ])
    expect(lookupReasoningEffortValues(GO, 'grok-4.6')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  test('reports nothing for a model the catalog gives no effort option', () => {
    // glm-5/5.1 declare an empty reasoning_options; minimax-m3 declares only a
    // toggle. Both mean "no effort control here".
    expect(lookupReasoningEffortValues(GO, 'glm-5.1')).toBeUndefined()
    expect(lookupReasoningEffortValues(GO, 'minimax-m3')).toBeUndefined()
  })

  test('ignores a ?reasoning= descriptor suffix on the model name', () => {
    expect(lookupReasoningEffortValues(GO, 'glm-5.3-flash?reasoning=high')).toEqual([
      'low',
      'high',
      'max',
    ])
  })

  test('falls back to a case-insensitive match', () => {
    expect(lookupReasoningEffortValues(GO, 'GLM-5.3-Flash')).toEqual([
      'low',
      'high',
      'max',
    ])
  })

  test('leaves DeepSeek and Moonshot to their own shim branches', () => {
    // Both write a different dialect (thinking + effort, thinking.effort) from
    // hand-written host branches; a row here would write the field twice.
    expect(
      lookupReasoningEffortValues('https://api.deepseek.com/v1', 'deepseek-v4-pro'),
    ).toBeUndefined()
    expect(
      lookupReasoningEffortValues('https://api.moonshot.ai/v1', 'kimi-k3'),
    ).toBeUndefined()
  })

  test('the killswitch reports no capability anywhere', () => {
    process.env.CLAUDIN_DISABLE_REASONING_EFFORT_WIRE = '1'
    expect(lookupReasoningEffortValues(GO, 'glm-5.3-flash')).toBeUndefined()
  })
})

describe('resolveShimEffortValues', () => {
  test('prefers the catalog over the GPT-5 family fallback', () => {
    // gpt-5.6-luna is a catalog row on this gateway, and its list is wider
    // than the generic GPT-5 one.
    expect(
      resolveShimEffortValues('https://opencode.ai/zen/go/v1', 'gpt-5.6-luna'),
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('falls back to the GPT-5 family list on an endpoint with no row', () => {
    expect(resolveShimEffortValues('https://llm.example.test/v1', 'gpt-5.4')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  test('reports nothing for a non-reasoning model on an unknown endpoint', () => {
    expect(
      resolveShimEffortValues('https://llm.example.test/v1', 'gpt-4o'),
    ).toBeUndefined()
  })

  test('the GPT-5 fallback does not leak onto a host the shim already owns', () => {
    // DeepSeek and Kimi Code have their own dialect branches. Without the
    // exclusion a `gpt-5*` id pointed at either host would pick up the generic
    // fallback and write a second effort field beside theirs.
    expect(
      resolveShimEffortValues('https://api.deepseek.com/v1', 'gpt-5.4'),
    ).toBeUndefined()
    expect(
      resolveShimEffortValues('https://api.moonshot.ai/v1', 'gpt-5.4'),
    ).toBeUndefined()
  })

  test('reports nothing when every declared level is one the picker hides', () => {
    // `none`/`minimal`/`default` mean "think less or not at all", which this UI
    // already spells `adaptive`. A row offering only those is not a control.
    expect(pickerEffortLevels(['none', 'minimal', 'default'])).toEqual([])
  })
})

describe('clampEffortToValues', () => {
  test('passes an accepted level through untouched', () => {
    expect(clampEffortToValues('high', ['low', 'high', 'max'])).toBe('high')
  })

  test('snaps down to the closest accepted level', () => {
    // The glm-5.3 case: a session sitting on `medium` must not 400 the request.
    expect(clampEffortToValues('medium', ['low', 'high', 'max'])).toBe('low')
    expect(clampEffortToValues('max', ['low', 'medium', 'high'])).toBe('high')
  })

  test('snaps up when nothing accepted sits below', () => {
    expect(clampEffortToValues('low', ['high', 'max'])).toBe('high')
  })

  test('reports nothing for an empty level list', () => {
    expect(clampEffortToValues('high', [])).toBeUndefined()
  })
})

describe('reasoningEffortWireFor', () => {
  test('OpenRouter takes the nested canonical form', () => {
    expect(reasoningEffortWireFor('https://openrouter.ai/api/v1')).toBe('reasoning.effort')
  })

  test('everything else takes the flat field', () => {
    expect(reasoningEffortWireFor('https://opencode.ai/zen/go/v1')).toBe('reasoning_effort')
    expect(reasoningEffortWireFor('https://api.openai.com/v1')).toBe('reasoning_effort')
    expect(reasoningEffortWireFor(undefined)).toBe('reasoning_effort')
  })
})
