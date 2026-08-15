import { describe, expect, test } from 'bun:test'
import { buildClassifierUnavailableMessage } from 'src/services/messages/rejection.js'

describe('buildClassifierUnavailableMessage', () => {
  test('strips the UI-only alias suffix from the model id', () => {
    const message = buildClassifierUnavailableMessage(
      'Bash',
      'claude-opus-4-8[1m]',
    )
    expect(message).toContain('claude-opus-4-8 is temporarily unavailable')
    expect(message).not.toContain('[1m]')
  })

  test('leaves an already-normalized model id unchanged', () => {
    const message = buildClassifierUnavailableMessage(
      'Bash',
      'claude-opus-4-8',
    )
    expect(message).toContain('claude-opus-4-8 is temporarily unavailable')
  })
})
