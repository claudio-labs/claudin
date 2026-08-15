import { describe, expect, test } from 'bun:test'

import { buildIdentityHeaders } from 'src/providers/transport/identityHeaders.ts'

const INPUT = {
  sessionId: 'session-abc',
  firstPartyUserAgent: 'claude-cli/9.9.9 (cli)',
  claudinUserAgent: 'claudin/1.2.3 (cli)',
}

describe('buildIdentityHeaders', () => {
  test('keeps upstream identity on the first-party Anthropic lane', () => {
    const headers = buildIdentityHeaders({ ...INPUT, firstParty: true })
    expect(headers['x-app']).toBe('cli')
    expect(headers['User-Agent']).toBe(INPUT.firstPartyUserAgent)
    expect(headers['X-Claude-Code-Session-Id']).toBe('session-abc')
  })

  test('uses Claudin identity everywhere else', () => {
    const headers = buildIdentityHeaders({ ...INPUT, firstParty: false })
    expect(headers['x-app']).toBe('claudin')
    expect(headers['User-Agent']).toBe(INPUT.claudinUserAgent)
    expect(headers['X-Claudin-Session-Id']).toBe('session-abc')
  })

  test('emits exactly one session-id header, never both', () => {
    for (const firstParty of [true, false]) {
      const keys = Object.keys(buildIdentityHeaders({ ...INPUT, firstParty }))
      const sessionKeys = keys.filter(k => k.toLowerCase().endsWith('session-id'))
      expect(sessionKeys).toHaveLength(1)
    }
  })

  // The point of the split: this object reaches OpenAI, Gemini, Mistral,
  // Copilot, Ollama and the cloud resellers, not just Anthropic.
  test('leaks no upstream branding off the first-party lane', () => {
    const headers = buildIdentityHeaders({ ...INPUT, firstParty: false })
    const serialized = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
      .toLowerCase()
    expect(serialized).not.toContain('claude-code')
    expect(serialized).not.toContain('claude-cli')
  })
})
