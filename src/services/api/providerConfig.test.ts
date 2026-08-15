import { describe, expect, test } from 'bun:test'

import { isKimiCodeBaseUrl, isXaiOAuthBaseUrl } from 'src/services/api/providerConfig.js'

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
