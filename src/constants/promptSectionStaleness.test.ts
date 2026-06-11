import { afterAll, afterEach, expect, mock, test } from 'bun:test'

// MACRO is replaced at build time by Bun.define but not in test mode.
// Define it globally so tests that import modules using MACRO don't crash.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import type { ProviderProfile } from '../utils/config.js'

// Capture the real module first so we can spread it and restore at teardown.
// Following CLAUDE.md mock.module rules — never narrow the namespace shape.
const realProviderProfiles = { ...(await import('../utils/providerProfiles.js')) }

const state: { activeProfile: ProviderProfile | undefined } = {
  activeProfile: undefined,
}

// Override `getActiveProviderProfile` so the test controls what
// getAPIProvider() resolves to. With activeProfile undefined the chain falls
// back to 'firstParty' — the same state every other test file runs in.
mock.module('../utils/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => state.activeProfile,
}))

const { getSystemPrompt } = await import('./prompts.js')
const { clearSystemPromptSections } = await import('./systemPromptSections.js')
const { invalidateActiveProviderCache } = await import(
  '../services/api/activeProvider.js'
)
const { applyPermissionUpdate } = await import(
  '../utils/permissions/PermissionUpdate.js'
)
const { getEmptyToolPermissionContext } = await import('../Tool.js')

const originalSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
delete process.env.CLAUDE_CODE_SIMPLE

afterEach(() => {
  state.activeProfile = undefined
  invalidateActiveProviderCache()
  clearSystemPromptSections()
})

afterAll(() => {
  process.env.CLAUDE_CODE_SIMPLE = originalSimpleEnv
  mock.module('../utils/providerProfiles.js', () => realProviderProfiles)
  invalidateActiveProviderCache()
  clearSystemPromptSections()
})

// Regression test for the provider-qualified env_info_simple cache key
// (`env_info_simple:${model}:${getAPIProvider()}`): a mid-session /provider
// switch must not serve the previous provider's memoized env section.
// Deliberately does NOT call clearSystemPromptSections() between the two
// prompts — nothing clears sections on a provider switch, so the key is the
// only thing standing between the switch and stale content.
test('mid-session provider switch recomputes the env section without a section clear', async () => {
  clearSystemPromptSections()
  invalidateActiveProviderCache()

  // No profile → getAPIProvider() falls back to 'firstParty'.
  const firstPartyText = (await getSystemPrompt([], 'claude-opus-4-8')).join('\n')
  expect(firstPartyText).toContain('most capable Claude models')
  expect(firstPartyText).toContain('Fast mode for Claudin')

  // Switch to a Bedrock profile mid-session: same model id, no section clear.
  state.activeProfile = {
    id: 'p_bedrock',
    name: 'Bedrock',
    provider: 'bedrock',
    baseUrl: '',
    model: 'claude-opus-4-8',
  } as ProviderProfile
  invalidateActiveProviderCache()

  const bedrockText = (await getSystemPrompt([], 'claude-opus-4-8')).join('\n')
  // Still the anthropic family → keeps the Claude model-list line…
  expect(bedrockText).toContain('most capable Claude models')
  // …but /fast only works on firstParty, so the fast-mode line must drop.
  // A stale cached section (or a deleted firstParty gate) leaves it in.
  expect(bedrockText).not.toContain('Fast mode for Claudin')
})

// Regression test for the Bedrock-namespaced id: the env section's
// Claude-family gate must survive ids like 'us.anthropic.claude-…'.
test('Bedrock-namespaced Claude id keeps the Claude model-list line', async () => {
  clearSystemPromptSections()
  state.activeProfile = {
    id: 'p_bedrock_ns',
    name: 'Bedrock',
    provider: 'bedrock',
    baseUrl: '',
    model: 'us.anthropic.claude-opus-4-8-v1:0',
  } as ProviderProfile
  invalidateActiveProviderCache()

  const text = (
    await getSystemPrompt([], 'us.anthropic.claude-opus-4-8-v1:0')
  ).join('\n')
  expect(text).toContain('most capable Claude models')
  expect(text).not.toContain('Fast mode for Claudin')
})

// Regression test for /add-dir staleness: applying an addDirectories
// permission update must invalidate the memoized env section so the next
// prompt lists the new directory. No clearSystemPromptSections() here — the
// update itself is responsible for the invalidation.
test('addDirectories permission update invalidates the memoized env section', async () => {
  clearSystemPromptSections()
  invalidateActiveProviderCache()

  const before = (
    await getSystemPrompt([], 'claude-opus-4-8', ['/tmp/staleness-dir-a'])
  ).join('\n')
  expect(before).toContain('/tmp/staleness-dir-a')
  expect(before).not.toContain('/tmp/staleness-dir-b')

  applyPermissionUpdate(getEmptyToolPermissionContext(), {
    type: 'addDirectories',
    directories: ['/tmp/staleness-dir-b'],
    destination: 'session',
  })

  const after = (
    await getSystemPrompt([], 'claude-opus-4-8', [
      '/tmp/staleness-dir-a',
      '/tmp/staleness-dir-b',
    ])
  ).join('\n')
  expect(after).toContain('/tmp/staleness-dir-b')
})
