import { describe, expect, test } from 'bun:test'

import { resolveProviderLabel } from 'src/providers/providerLabel.js'

describe('resolveProviderLabel', () => {
  test('prefers the profile name over the transport tag', () => {
    // The tag is `openai` for xAI, Kimi, Ollama, MiniMax and every other
    // OpenAI-compatible endpoint, so it cannot name the provider on its own.
    expect(resolveProviderLabel('Kimi Code', 'openai')).toBe('Kimi Code')
    expect(resolveProviderLabel('xAI', 'openai')).toBe('xAI')
  })

  test('falls back to the transport tag for an env-var-only setup', () => {
    expect(resolveProviderLabel(undefined, 'github')).toBe('GitHub Copilot')
    expect(resolveProviderLabel(undefined, 'firstParty')).toBe('Anthropic')
    expect(resolveProviderLabel('', 'bedrock')).toBe('AWS Bedrock')
  })

  test('falls back again for a transport the map does not know', () => {
    expect(resolveProviderLabel(undefined, 'some-future-backend')).toBe(
      'this provider',
    )
  })
})
