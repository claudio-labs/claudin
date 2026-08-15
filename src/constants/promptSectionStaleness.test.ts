import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

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

import type { ProviderProfile } from 'src/platform/config/config.js'

// Capture the real modules first so we can spread them and restore at teardown.
// Following CLAUDE.md mock.module rules — never narrow the namespace shape.
const realProviders = { ...(await import('src/utils/model/providers.js')) }

const state: { activeProfile: ProviderProfile | undefined } = {
  activeProfile: undefined,
}

// This file drives getAPIProvider() through state.activeProfile (its tests
// deliberately switch firstParty → bedrock mid-run), so it CANNOT hard-pin a
// single provider. It also cannot rely on the real resolution chain, because
// another test file may have leaked a getAPIProvider / tryGetActiveProvider
// mock (Bun's mock.module is process-global). So mock getAPIProvider itself —
// the single decision point — with a self-contained, state-driven impl:
// no profile → 'firstParty', a bedrock profile → 'bedrock' (the only two the
// tests exercise). Re-assert before each test to win the last-install-wins
// race, independent of whatever ran before this file.
const pinFromState = (): void => {
  mock.module('src/utils/model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () =>
      state.activeProfile ? state.activeProfile.provider : 'firstParty',
  }))
}
pinFromState()

const { getSystemPrompt } = await import('src/constants/prompts.js')
const { clearSystemPromptSections } = await import('src/constants/systemPromptSections.js')
// getAPIProvider is mocked directly (above), so the activeProvider cache no
// longer feeds provider resolution here; the in-test invalidateActiveProviderCache()
// calls are kept as harmless no-ops and just need a live binding.
const { invalidateActiveProviderCache } = await import(
  'src/providers/presets/activeProvider.js'
)
const { applyPermissionUpdate } = await import(
  'src/permissions/PermissionUpdate.js'
)
const { getEmptyToolPermissionContext } = await import('src/tools/Tool.js')

const originalSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
delete process.env.CLAUDE_CODE_SIMPLE

beforeEach(() => {
  state.activeProfile = undefined
  pinFromState()
})

afterEach(() => {
  state.activeProfile = undefined
  clearSystemPromptSections()
})

afterAll(() => {
  process.env.CLAUDE_CODE_SIMPLE = originalSimpleEnv
  mock.module('src/utils/model/providers.js', () => realProviders)
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
