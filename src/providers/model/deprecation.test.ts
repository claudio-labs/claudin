import { expect, test } from 'bun:test'

import {
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
} from 'src/providers/model/configs.js'
import { getModelDeprecationWarning } from 'src/providers/model/deprecation.js'

// Sonnet 4.5's retirement date is set by Anthropic for the platforms it
// operates — the Claude API and Microsoft Foundry. Foundry also defaults to
// it, so its users are the ones who need the warning. Bedrock and Vertex are
// partner-operated and set their own schedules.
test('Sonnet 4.5 warns where Anthropic has scheduled its retirement', () => {
  for (const provider of ['firstParty', 'foundry'] as const) {
    expect(
      getModelDeprecationWarning(CLAUDE_SONNET_4_5_CONFIG[provider], provider),
    ).toBe(
      '⚠ Claude Sonnet 4.5 will be retired on November 30, 2026. Consider switching to a newer model.',
    )
  }
})

test('Sonnet 4.5 does not warn on the partner-operated platforms', () => {
  for (const provider of ['bedrock', 'vertex'] as const) {
    expect(
      getModelDeprecationWarning(CLAUDE_SONNET_4_5_CONFIG[provider], provider),
    ).toBeNull()
  }
})

test('the Sonnet 4.5 entry does not catch Sonnet 4.6', () => {
  expect(
    getModelDeprecationWarning(CLAUDE_SONNET_4_6_CONFIG.firstParty, 'firstParty'),
  ).toBeNull()
})
