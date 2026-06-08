import { describe, expect, test } from 'bun:test'
import { extractAgentErrorSummary } from './UI.js'

describe('extractAgentErrorSummary', () => {
  test('returns undefined for missing content', () => {
    expect(extractAgentErrorSummary(undefined)).toBeUndefined()
  })

  test('returns undefined for empty string', () => {
    expect(extractAgentErrorSummary('')).toBeUndefined()
  })

  test('strips Error: prefix', () => {
    expect(extractAgentErrorSummary('Error: 529 overloaded')).toBe('529 overloaded')
  })

  test('strips Cancelled: prefix (case-insensitive)', () => {
    expect(extractAgentErrorSummary('cancelled: user aborted')).toBe('user aborted')
  })

  test('keeps only the first line', () => {
    expect(
      extractAgentErrorSummary('Error: provider down\nstack trace line 1\nstack trace line 2'),
    ).toBe('provider down')
  })

  test('unwraps <tool_use_error> tag', () => {
    expect(extractAgentErrorSummary('<tool_use_error>API request failed</tool_use_error>')).toBe(
      'API request failed',
    )
  })

  test('strips <error> tags', () => {
    expect(extractAgentErrorSummary('<error>boom</error>')).toBe('boom')
  })

  test('truncates long messages with ellipsis', () => {
    const long = 'x'.repeat(100)
    const out = extractAgentErrorSummary(`Error: ${long}`)!
    expect(out.length).toBe(80)
    expect(out.endsWith('…')).toBe(true)
  })

  test('flattens text blocks', () => {
    expect(
      extractAgentErrorSummary([
        { type: 'text', text: 'Error: overloaded_error' },
        { type: 'text', text: 'retry exhausted' },
      ]),
    ).toBe('overloaded_error')
  })
})
