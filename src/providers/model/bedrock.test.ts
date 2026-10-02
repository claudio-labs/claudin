import { expect, test } from 'bun:test'
import { findFirstMatch } from 'src/providers/model/bedrock.js'

// getBedrockModelStrings (modelStrings.ts) looks each config's first-party id up
// in the account's inference profiles, in the order AWS lists them. A plain
// substring match let a model id pick its own successor's profile.

test('a model id does not match its successor one minor version up', () => {
  const profiles = ['us.anthropic.claude-sonnet-5-5', 'us.anthropic.claude-sonnet-5']
  expect(findFirstMatch(profiles, 'claude-sonnet-5')).toBe('us.anthropic.claude-sonnet-5')
  expect(findFirstMatch(profiles, 'claude-sonnet-5-5')).toBe('us.anthropic.claude-sonnet-5-5')
})

test('the Opus 5 ↔ 5.5 collision is closed the same way', () => {
  const profiles = ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5']
  expect(findFirstMatch(profiles, 'claude-opus-5')).toBe('global.anthropic.claude-opus-5')
})

test('version and date suffixes still name the model', () => {
  expect(findFirstMatch(['eu.anthropic.claude-opus-4-6-v1'], 'claude-opus-4-6')).toBe('eu.anthropic.claude-opus-4-6-v1')
  expect(
    findFirstMatch(['us.anthropic.claude-sonnet-4-5-20250929-v1:0'], 'claude-sonnet-4-5-20250929'),
  ).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0')
  // A date after the id is not a minor version.
  expect(findFirstMatch(['us.anthropic.claude-opus-4-20250514-v1:0'], 'claude-opus-4')).toBe(
    'us.anthropic.claude-opus-4-20250514-v1:0',
  )
})

test('a successor listed alone is not a match, so the caller falls back to its own id', () => {
  expect(findFirstMatch(['us.anthropic.claude-sonnet-5-5'], 'claude-sonnet-5')).toBeNull()
  expect(findFirstMatch(['us.anthropic.claude-opus-4-1-20250805-v1:0'], 'claude-opus-4')).toBeNull()
})
