import { describe, expect, test } from 'bun:test'

import { isXaiOAuthBaseUrl } from './providerConfig.js'

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
