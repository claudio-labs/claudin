import { describe, expect, test } from 'bun:test'
import { getAnthropicAddendum } from 'src/constants/familyAddendums/anthropic.js'
import { CODEX_ADDENDUM } from 'src/constants/familyAddendums/codex.js'
import { DEFAULT_ADDENDUM } from 'src/constants/familyAddendums/default.js'
import { GEMINI_ADDENDUM } from 'src/constants/familyAddendums/gemini.js'
import { GLM_ADDENDUM } from 'src/constants/familyAddendums/glm.js'
import { getModelFamily, type ModelFamily } from 'src/constants/familyAddendums/index.js'
import { KIMI_ADDENDUM } from 'src/constants/familyAddendums/kimi.js'
import { OPENAI_REASONING_ADDENDUM } from 'src/constants/familyAddendums/openaiReasoning.js'

const SECRET_RE = /sk-[a-z0-9]{20,}|api[_-]?key\s*[:=]/i
const ABSOLUTE_PATH_RE = /(?:^|\s)\/(?:home|usr|var|etc|opt|tmp)\//
// Bumped from 800 → 2000 when GLM addendum gained concrete CORRECT/WRONG
// examples for parallel tool batching. Keep this small enough to be a
// genuine guard against prompt bloat; ~2000 chars is ~500 tokens, well
// under the cacheable static-section budget.
const MAX_ADDENDUM_CHARS = 2000

describe('getModelFamily', () => {
  const cases: Array<{
    provider: Parameters<typeof getModelFamily>[0]
    model: string
    baseUrl: string | undefined
    expected: ModelFamily
  }> = [
    // Anthropic native paths
    { provider: 'firstParty', model: 'claude-opus-4-8', baseUrl: undefined, expected: 'anthropic' },
    { provider: 'bedrock', model: 'claude-sonnet-4-6', baseUrl: undefined, expected: 'anthropic' },
    { provider: 'vertex', model: 'claude-haiku-4-5', baseUrl: undefined, expected: 'anthropic' },
    // Bedrock-namespaced ids must still resolve to anthropic
    { provider: 'bedrock', model: 'anthropic.claude-opus-4-8-v1:0', baseUrl: undefined, expected: 'anthropic' },
    { provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6-v1:0', baseUrl: undefined, expected: 'anthropic' },
    { provider: 'bedrock', model: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8-v1:0', baseUrl: undefined, expected: 'anthropic' },
    // Vertex date-suffixed ids
    { provider: 'vertex', model: 'claude-opus-4-5@20251101', baseUrl: undefined, expected: 'anthropic' },
    // Bedrock/Vertex with a non-claude model → no addendum
    { provider: 'bedrock', model: 'llama-3', baseUrl: undefined, expected: 'default' },
    { provider: 'bedrock', model: 'amazon.titan-text-express-v1', baseUrl: undefined, expected: 'default' },
    // False-positive guard: 'claude' mid-name without the namespace dot
    { provider: 'firstParty', model: 'myclaude-finetune', baseUrl: undefined, expected: 'default' },

    // OpenAI reasoning models
    { provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', expected: 'openai-reasoning' },
    { provider: 'openai', model: 'gpt-5-codex', baseUrl: 'https://api.openai.com/v1', expected: 'openai-reasoning' },
    { provider: 'openai', model: 'o1-preview', baseUrl: 'https://api.openai.com/v1', expected: 'openai-reasoning' },
    { provider: 'openai', model: 'o3-mini', baseUrl: 'https://api.openai.com/v1', expected: 'openai-reasoning' },
    { provider: 'openai', model: 'o4', baseUrl: 'https://api.openai.com/v1', expected: 'openai-reasoning' },
    // Non-reasoning OpenAI → default
    { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', expected: 'default' },
    { provider: 'openai', model: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', expected: 'default' },

    // Gemini
    { provider: 'gemini', model: 'gemini-2.5-pro', baseUrl: undefined, expected: 'gemini' },
    { provider: 'gemini', model: 'gemini-2.0-flash', baseUrl: undefined, expected: 'gemini' },

    // Kimi via Moonshot baseUrl
    { provider: 'openai', model: 'kimi-k2', baseUrl: 'https://api.moonshot.ai/v1', expected: 'kimi' },
    { provider: 'openai', model: 'kimi-k2', baseUrl: 'https://api.moonshot.cn/v1', expected: 'kimi' },
    // Kimi by model name even if baseUrl is generic
    { provider: 'openai', model: 'moonshot-v1', baseUrl: 'https://proxy.example.com/v1', expected: 'kimi' },

    // GLM via baseUrl
    { provider: 'openai', model: 'glm-4.6', baseUrl: 'https://api.z.ai/api/anthropic', expected: 'glm' },
    { provider: 'openai', model: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', expected: 'glm' },
    { provider: 'openai', model: 'glm-4.5', baseUrl: 'https://bigmodel.cn/v1', expected: 'glm' },
    // GLM by model name even on a generic host
    { provider: 'openai', model: 'glm-5.1', baseUrl: 'https://proxy.example.com/v1', expected: 'glm' },
    { provider: 'openai', model: 'zhipu-test', baseUrl: 'https://proxy.example.com/v1', expected: 'glm' },

    // Codex
    { provider: 'codex', model: 'gpt-5', baseUrl: undefined, expected: 'codex' },
    { provider: 'codex', model: 'whatever', baseUrl: undefined, expected: 'codex' },

    // Generic OpenAI-compat (unknown provider) → default
    { provider: 'openai', model: 'some-model', baseUrl: 'https://proxy.example.com/v1', expected: 'default' },

    // OpenRouter-style namespaced ids: prefix slash should match
    { provider: 'openai', model: 'moonshotai/kimi-k2', baseUrl: 'https://openrouter.ai/api/v1', expected: 'kimi' },
    { provider: 'openai', model: 'zhipuai/glm-4.6', baseUrl: 'https://openrouter.ai/api/v1', expected: 'glm' },

    // False-positive guards: substring "kimi"/"glm" mid-name on a generic proxy MUST NOT match
    { provider: 'openai', model: 'mygpt-kimi-experiment', baseUrl: 'https://proxy.example.com/v1', expected: 'default' },
    { provider: 'openai', model: 'custom-glm-finetune', baseUrl: 'https://proxy.example.com/v1', expected: 'default' },
    { provider: 'openai', model: 'foo-zhipu-bar', baseUrl: 'https://proxy.example.com/v1', expected: 'default' },

    // BaseUrl precedence on Moonshot/GLM hosts (even with non-matching model name)
    { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.moonshot.ai/v1', expected: 'kimi' },
    { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.z.ai/api/anthropic', expected: 'glm' },
    // Moonshot baseUrl beats reasoning-model name (Kimi check runs first)
    { provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.moonshot.ai/v1', expected: 'kimi' },

    // Other providers → default
    { provider: 'mistral', model: 'mistral-large', baseUrl: undefined, expected: 'default' },
    { provider: 'github', model: 'gpt-4o', baseUrl: undefined, expected: 'default' },
    { provider: 'nvidia-nim', model: 'some-model', baseUrl: undefined, expected: 'default' },
    { provider: 'foundry', model: 'some-model', baseUrl: undefined, expected: 'default' },
    { provider: 'minimax', model: 'abab-7', baseUrl: undefined, expected: 'default' },
  ]

  for (const c of cases) {
    test(`${c.provider} + ${c.model} + ${c.baseUrl ?? 'no-baseUrl'} → ${c.expected}`, () => {
      expect(getModelFamily(c.provider, c.model, c.baseUrl)).toBe(c.expected)
    })
  }
})

describe('addendum contents', () => {
  const named: Array<{ name: ModelFamily; value: string | null; expectString: boolean }> = [
    // anthropic addendum is gated on feature('ANTI_NARRATION') which the
    // test preload (src/stubs/test-preload.ts) stubs to false — so under
    // tests we expect null here. Production builds set the flag to true
    // via scripts/build.ts and the resolved string is exercised by the
    // dedicated test below.
    { name: 'anthropic', value: getAnthropicAddendum(), expectString: false },
    { name: 'default', value: DEFAULT_ADDENDUM, expectString: false },
    { name: 'openai-reasoning', value: OPENAI_REASONING_ADDENDUM, expectString: true },
    { name: 'gemini', value: GEMINI_ADDENDUM, expectString: true },
    { name: 'kimi', value: KIMI_ADDENDUM, expectString: true },
    { name: 'glm', value: GLM_ADDENDUM, expectString: true },
    { name: 'codex', value: CODEX_ADDENDUM, expectString: true },
  ]

  for (const a of named) {
    test(`${a.name}: ${a.expectString ? 'non-empty content' : 'null'}`, () => {
      if (a.expectString) {
        expect(typeof a.value).toBe('string')
        expect((a.value as string).length).toBeGreaterThan(40)
        expect((a.value as string).length).toBeLessThan(MAX_ADDENDUM_CHARS)
      } else {
        expect(a.value).toBeNull()
      }
    })

    if (a.expectString) {
      test(`${a.name}: no secrets / absolute paths`, () => {
        const s = a.value as string
        expect(SECRET_RE.test(s)).toBe(false)
        expect(ABSOLUTE_PATH_RE.test(s)).toBe(false)
      })
    }
  }

  test('codex inherits openai-reasoning content', () => {
    expect(CODEX_ADDENDUM).toBe(OPENAI_REASONING_ADDENDUM)
  })
})
