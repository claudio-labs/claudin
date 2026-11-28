import { describe, expect, test } from 'bun:test'
import {
  applyBedrockRegionPrefix,
  extractModelIdFromArn,
  findFirstMatch,
  getBedrockRegionPrefix,
  isFoundationModel,
} from 'src/providers/model/bedrock.js'

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

describe('Bedrock model id shapes', () => {
  const ARN = 'arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1'

  test('only an anthropic.* id is a foundation model', () => {
    expect(isFoundationModel('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true)
    expect(isFoundationModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(false)
    expect(isFoundationModel('claude-sonnet-4-5-20250929')).toBe(false)
  })

  test('an ARN yields the id after its last slash; anything else is returned as is', () => {
    expect(extractModelIdFromArn(ARN)).toBe('global.anthropic.claude-opus-4-6-v1')
    expect(
      extractModelIdFromArn('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0'),
    ).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0')
    expect(extractModelIdFromArn('arn:aws:bedrock:us-east-1:123456789012:no-slash')).toBe(
      'arn:aws:bedrock:us-east-1:123456789012:no-slash',
    )
    expect(extractModelIdFromArn('us.anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-6-v1')
  })

  test('the region prefix is read from a cross-region id or the profile inside an ARN', () => {
    expect(getBedrockRegionPrefix('eu.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('eu')
    expect(getBedrockRegionPrefix('apac.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('apac')
    expect(getBedrockRegionPrefix(ARN)).toBe('global')
  })

  test('foundation, first-party and non-Anthropic ids carry no region prefix', () => {
    expect(getBedrockRegionPrefix('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBeUndefined()
    expect(getBedrockRegionPrefix('claude-sonnet-4-5-20250929')).toBeUndefined()
    // A region prefix only counts in front of `anthropic.`.
    expect(getBedrockRegionPrefix('us.amazon.nova-pro-v1:0')).toBeUndefined()
  })

  test('applying a prefix replaces an existing one, including inside an ARN', () => {
    expect(applyBedrockRegionPrefix('us.anthropic.claude-sonnet-4-5-v1:0', 'eu')).toBe(
      'eu.anthropic.claude-sonnet-4-5-v1:0',
    )
    expect(applyBedrockRegionPrefix(ARN, 'us')).toBe(
      'arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1',
    )
  })

  test('applying a prefix to a foundation model adds it; other ids pass through', () => {
    expect(applyBedrockRegionPrefix('anthropic.claude-sonnet-4-5-v1:0', 'apac')).toBe(
      'apac.anthropic.claude-sonnet-4-5-v1:0',
    )
    expect(applyBedrockRegionPrefix('claude-sonnet-4-5-20250929', 'eu')).toBe('claude-sonnet-4-5-20250929')
    expect(applyBedrockRegionPrefix('us.amazon.nova-pro-v1:0', 'eu')).toBe('us.amazon.nova-pro-v1:0')
  })
})
