/**
 * Characterization of CostThresholdDialog, the one-answer notice the REPL
 * shows once a session's spend passes $5. Written before the clean-base
 * rewrite of permissions/sessionDialogs; the spec is
 * docs/tech/rewrite/permissions/sessionDialogs.md.
 *
 * The provider named in the headline comes from the active provider profile,
 * which is set here through the real config API (an in-memory store under
 * NODE_ENV=test).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { CostThresholdDialog } from 'src/permissions/ui/CostThresholdDialog.js'
import { flat, isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { type ProviderProfile, saveGlobalConfig } from 'src/platform/config/config.js'

const COSTS_URL = 'https://code.claude.com/docs/en/costs'

function useProfile(profile: Partial<ProviderProfile> | null): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: profile
      ? [{ id: 'cost-test', name: 'cost test', baseUrl: 'https://example.invalid/v1', model: 'some-model', ...profile } as ProviderProfile]
      : [],
    activeProviderProfileId: profile ? 'cost-test' : undefined,
  }))
}

describe('CostThresholdDialog', () => {
  isolatedWorld()
  afterEach(() => useProfile(null))

  const headlines: Array<{ profile: Partial<ProviderProfile> | null; label: string }> = [
    { profile: null, label: 'Anthropic API' },
    { profile: { provider: 'anthropic' }, label: 'Anthropic API' },
    { profile: { provider: 'bedrock' }, label: 'AWS Bedrock' },
    { profile: { provider: 'vertex' }, label: 'Google Vertex' },
    { profile: { provider: 'foundry' }, label: 'Azure Foundry' },
    { profile: { provider: 'openai' }, label: 'OpenAI-compatible API' },
    { profile: { provider: 'gemini' }, label: 'Gemini API' },
    // Every other provider gets the bare word.
    { profile: { provider: 'mistral' }, label: 'API' },
    { profile: { provider: 'openai', extras: { githubToken: 'gh' } }, label: 'API' },
    { profile: { provider: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1' }, label: 'API' },
    { profile: { provider: 'openai', baseUrl: 'https://api.minimax.io/v1' }, label: 'API' },
  ]
  for (const { profile, label } of headlines) {
    const which = profile ? JSON.stringify(profile) : 'no profile'
    test(
      `with ${which}, the headline names "${label}"`,
      async () => {
        useProfile(profile)
        const screen = await mount(<CostThresholdDialog onDone={() => {}} />, { columns: 120 })
        expect(flat(screen.text())).toContain(`You've spent $5 on the ${label} this session.`)
      },
      SLOW,
    )
  }

  test(
    'points at the spending guide and offers one answer',
    async () => {
      const screen = await mount(<CostThresholdDialog onDone={() => {}} />, { columns: 120 })
      const text = flat(screen.text())
      expect(text).toContain('Learn more about how to monitor your spending:')
      expect(screen.styled()).toContain(COSTS_URL)
      expect(text).toMatch(/❯ 1\. Got it, thanks!/)
      expect(text).not.toContain('2.')
      // Headline, guide, answer, in that order.
      const at = ["You've spent", 'Learn more', 'Got it'].map(fact => text.indexOf(fact))
      expect(at).toEqual([...at].sort((a, b) => a - b))
    },
    SLOW,
  )

  const dismissals: Array<{ how: string; keys: string[] }> = [
    { how: 'Enter', keys: [KEYS.enter] },
    { how: 'its number', keys: ['1'] },
    { how: 'Esc', keys: [KEYS.esc] },
  ]
  for (const { how, keys } of dismissals) {
    test(
      `${how} dismisses it with one call to onDone`,
      async () => {
        let done = 0
        const screen = await mount(<CostThresholdDialog onDone={() => (done += 1)} />)
        await screen.press(...keys)
        expect(done).toBe(1)
      },
      SLOW,
    )
  }
})
