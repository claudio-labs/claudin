import { expect, test } from 'bun:test'

import { getErrorMessageIfRefusal } from 'src/providers/transport/errors.js'

function getText(message: ReturnType<typeof getErrorMessageIfRefusal>): string {
  if (!message) return ''
  const first = message.message.content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) return ''
  return typeof first.text === 'string' ? first.text : ''
}

test('returns undefined when stop_reason is not refusal', () => {
  expect(getErrorMessageIfRefusal('end_turn', 'claude-sonnet-4-20250514')).toBeUndefined()
  expect(getErrorMessageIfRefusal(null, 'claude-sonnet-4-20250514')).toBeUndefined()
})

test('falls back to generic message when stop_details is missing', () => {
  const message = getErrorMessageIfRefusal('refusal', 'claude-sonnet-4-20250514')
  const text = getText(message)

  expect(text).toContain('Usage Policy')
  expect(text).not.toContain('Reason from provider')
})

test('falls back to generic message when stop_details is null', () => {
  const message = getErrorMessageIfRefusal('refusal', 'claude-sonnet-4-20250514', null)
  const text = getText(message)

  expect(text).toContain('Usage Policy')
  expect(text).not.toContain('Reason from provider')
})

test('appends explanation on its own line when provided', () => {
  const message = getErrorMessageIfRefusal('refusal', 'claude-sonnet-4-20250514', {
    type: 'refusal',
    category: 'cyber',
    explanation: 'Request matched cyberweapons classifier.',
    fallback_credit_token: null,
    fallback_has_prefill_claim: null,
    recommended_model: null,
  })
  const text = getText(message)

  expect(text).toContain('Usage Policy')
  expect(text).toContain('\n\nReason from provider: Request matched cyberweapons classifier.')
})

test('omits explanation line when explanation is null', () => {
  const message = getErrorMessageIfRefusal('refusal', 'claude-sonnet-4-20250514', {
    type: 'refusal',
    category: 'bio',
    explanation: null,
    fallback_credit_token: null,
    fallback_has_prefill_claim: null,
    recommended_model: null,
  })
  const text = getText(message)

  expect(text).toContain('Usage Policy')
  expect(text).not.toContain('Reason from provider')
})

test('appends model switch suggestion for non-sonnet models', () => {
  const message = getErrorMessageIfRefusal('refusal', 'claude-opus-4-7', {
    type: 'refusal',
    category: 'cyber',
    explanation: 'blocked',
    fallback_credit_token: null,
    fallback_has_prefill_claim: null,
    recommended_model: null,
  })
  const text = getText(message)

  expect(text).toContain('Reason from provider: blocked')
  expect(text).toContain('/model claude-sonnet-4-20250514')
})
