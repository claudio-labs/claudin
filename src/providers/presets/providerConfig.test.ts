import { describe, expect, test } from 'bun:test'

import {
  isKimiCodeBaseUrl,
  isXaiOAuthBaseUrl,
  supportsCodexReasoningEffort,
} from 'src/providers/presets/providerConfig.js'

describe('supportsCodexReasoningEffort', () => {
  test.each(['gpt-5', 'gpt-5.4', 'gpt-5-mini', 'gpt-5.6-sol', 'gpt-6', 'gpt-6-luna', 'gpt-6.2-sol', 'gpt-10.1'])(
    'GPT-5 and later takes an effort: %s',
    model => {
      expect(supportsCodexReasoningEffort(model)).toBe(true)
    },
  )

  test.each(['gpt-4o', 'gpt-4.1', 'gpt-3.5-turbo', 'gpt-5o', 'claude-opus-5-5', 'o3'])(
    'an earlier or unrelated id does not: %s',
    model => {
      expect(supportsCodexReasoningEffort(model)).toBe(false)
    },
  )

  test('the Codex aliases with a default take one, Spark does not', () => {
    expect(supportsCodexReasoningEffort('codexplan')).toBe(true)
    expect(supportsCodexReasoningEffort('gpt-5.3-codex-spark')).toBe(false)
    expect(supportsCodexReasoningEffort('codexspark')).toBe(false)
  })

  test('reads the id under case and a ?reasoning= suffix', () => {
    expect(supportsCodexReasoningEffort(' GPT-6.2-Sol?reasoning=high ')).toBe(true)
  })
})

describe('isXaiOAuthBaseUrl', () => {
  test('exact api.x.ai host matches', () => {
    expect(isXaiOAuthBaseUrl('https://api.x.ai/v1')).toBe(true)
    expect(isXaiOAuthBaseUrl('https://api.x.ai')).toBe(true)
  })

  test('subdomain does NOT match (security: prevent DNS spoof)', () => {
    expect(isXaiOAuthBaseUrl('https://evil.api.x.ai/v1')).toBe(false)
    expect(isXaiOAuthBaseUrl('https://attacker.api.x.ai')).toBe(false)
  })

  test('wrong host does NOT match', () => {
    expect(isXaiOAuthBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isXaiOAuthBaseUrl('https://x.ai/v1')).toBe(false)
    expect(isXaiOAuthBaseUrl('https://api.x.ai.evil.com/v1')).toBe(false)
  })

  test('malformed URL returns false', () => {
    expect(isXaiOAuthBaseUrl('not-a-url')).toBe(false)
    expect(isXaiOAuthBaseUrl('')).toBe(false)
    expect(isXaiOAuthBaseUrl(undefined)).toBe(false)
  })
})

describe('isKimiCodeBaseUrl', () => {
  test('exact api.kimi.com host on the /coding path matches', () => {
    expect(isKimiCodeBaseUrl('https://api.kimi.com/coding/v1')).toBe(true)
    expect(isKimiCodeBaseUrl('https://api.kimi.com/coding')).toBe(true)
  })

  test('bare host or non-coding path does NOT match', () => {
    // Aligns with isMoonshotCompatibleBaseUrl (/coding required), so the
    // token-swap + device headers never fire for a non-coding api.kimi.com URL.
    expect(isKimiCodeBaseUrl('https://api.kimi.com')).toBe(false)
    expect(isKimiCodeBaseUrl('https://api.kimi.com/v1')).toBe(false)
  })

  test('subdomain / wrong host does NOT match', () => {
    expect(isKimiCodeBaseUrl('https://evil.api.kimi.com/coding/v1')).toBe(false)
    expect(isKimiCodeBaseUrl('https://api.kimi.com.evil.com/coding/v1')).toBe(false)
    expect(isKimiCodeBaseUrl('https://api.moonshot.ai/v1')).toBe(false)
  })

  test('malformed URL returns false', () => {
    expect(isKimiCodeBaseUrl('not-a-url')).toBe(false)
    expect(isKimiCodeBaseUrl('')).toBe(false)
    expect(isKimiCodeBaseUrl(undefined)).toBe(false)
  })
})
