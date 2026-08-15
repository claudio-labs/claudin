import { afterEach, describe, expect, test } from 'bun:test'
import { getTimeBasedMCConfig } from 'src/agent/compact/timeBasedMCConfig.js'
import {
  AGGRESSIVE_PROFILE,
  RETAIN_PROFILE,
  _resetCacheProfileForTesting,
  getCacheProfile,
  resolveProfileForProvider,
} from 'src/agent/cache/cacheProfile.js'

const originalEnv = process.env.CLAUDIN_CACHE_PROFILE

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.CLAUDIN_CACHE_PROFILE
  } else {
    process.env.CLAUDIN_CACHE_PROFILE = originalEnv
  }
  _resetCacheProfileForTesting()
})

function setMode(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.CLAUDIN_CACHE_PROFILE
  } else {
    process.env.CLAUDIN_CACHE_PROFILE = value
  }
  _resetCacheProfileForTesting()
}

describe('resolveProfileForProvider', () => {
  test('anthropic-native transports get the retain profile', () => {
    for (const t of ['anthropic', 'bedrock', 'vertex']) {
      expect(resolveProfileForProvider(t, 'https://api.anthropic.com', 'claude-sonnet-4-6')).toBe(RETAIN_PROFILE)
    }
  })

  test('deepseek over openai_compat gets the retain profile', () => {
    expect(
      resolveProfileForProvider('openai_compat', 'https://api.deepseek.com/v1', 'deepseek-chat'),
    ).toBe(RETAIN_PROFILE)
    expect(
      resolveProfileForProvider('openai_compat', 'https://openrouter.ai/v1', 'deepseek-v4-flash'),
    ).toBe(RETAIN_PROFILE)
  })

  test('generic openai_compat / gemini / unknown get the aggressive profile', () => {
    expect(resolveProfileForProvider('openai_compat', 'https://opencode.ai/zen/v1', 'glm-5.1')).toBe(AGGRESSIVE_PROFILE)
    expect(resolveProfileForProvider('gemini', undefined, 'gemini-3.1-pro')).toBe(AGGRESSIVE_PROFILE)
    expect(resolveProfileForProvider(undefined, undefined, undefined)).toBe(AGGRESSIVE_PROFILE)
  })
})

describe('getCacheProfile env gating', () => {
  test('unset env → auto (Phase 6 default; no active provider in tests → aggressive)', () => {
    setMode(undefined)
    // In the test environment tryGetActiveProvider() returns null, so auto
    // resolves to the aggressive profile — the assertion pins that the
    // UNSET default routes through provider resolution, not a hard default.
    expect(getCacheProfile()).toBe(AGGRESSIVE_PROFILE)
  })

  test('forced retain / aggressive ignore the active provider', () => {
    setMode('retain')
    expect(getCacheProfile()).toBe(RETAIN_PROFILE)
    setMode('aggressive')
    expect(getCacheProfile()).toBe(AGGRESSIVE_PROFILE)
  })

  test('garbage value falls back to aggressive', () => {
    setMode('turbo')
    expect(getCacheProfile()).toBe(AGGRESSIVE_PROFILE)
  })

  test('profile invariants: retain disables age knobs, aggressive disables the byte guard', () => {
    expect(RETAIN_PROFILE.keepTurns).toBe(Infinity)
    expect(RETAIN_PROFILE.immediateStubTokens).toBe(Infinity)
    expect(Number.isFinite(RETAIN_PROFILE.retainedHighWaterTokens)).toBe(true)
    expect(RETAIN_PROFILE.retainedLowWaterTokens).toBeLessThan(RETAIN_PROFILE.retainedHighWaterTokens)

    expect(AGGRESSIVE_PROFILE.keepTurns).toBe(1)
    expect(AGGRESSIVE_PROFILE.immediateStubTokens).toBe(2000)
    expect(AGGRESSIVE_PROFILE.retainedHighWaterTokens).toBe(Infinity)
  })
})

describe('time-based MC follows the cache profile', () => {
  test('retain enables the idle-gap clear; aggressive keeps it off', () => {
    setMode('retain')
    expect(getTimeBasedMCConfig().enabled).toBe(true)
    expect(getTimeBasedMCConfig().gapThresholdMinutes).toBe(60)
    setMode('aggressive')
    expect(getTimeBasedMCConfig().enabled).toBe(false)
  })
})

describe('head-chars and time-based knobs', () => {
  test('profile defaults: heads on in both profiles, time-based only under retain', () => {
    expect(AGGRESSIVE_PROFILE.stubKeepHeadChars).toBe(1000)
    expect(RETAIN_PROFILE.stubKeepHeadChars).toBe(2000)
    expect(AGGRESSIVE_PROFILE.timeBasedClipEnabled).toBe(false)
    expect(RETAIN_PROFILE.timeBasedClipEnabled).toBe(true)
    expect(RETAIN_PROFILE.timeBasedGapMinutes).toBe(60)
  })

  test('CLAUDIN_STUB_HEAD_CHARS overrides the profile value (0 disables heads)', () => {
    setMode('aggressive')
    process.env.CLAUDIN_STUB_HEAD_CHARS = '0'
    _resetCacheProfileForTesting()
    expect(getCacheProfile().stubKeepHeadChars).toBe(0)
    process.env.CLAUDIN_STUB_HEAD_CHARS = '3000'
    _resetCacheProfileForTesting()
    expect(getCacheProfile().stubKeepHeadChars).toBe(3000)
    delete process.env.CLAUDIN_STUB_HEAD_CHARS
    _resetCacheProfileForTesting()
    expect(getCacheProfile().stubKeepHeadChars).toBe(1000)
  })

  test('garbage CLAUDIN_STUB_HEAD_CHARS falls back to the profile value', () => {
    setMode('retain')
    process.env.CLAUDIN_STUB_HEAD_CHARS = 'lots'
    _resetCacheProfileForTesting()
    expect(getCacheProfile().stubKeepHeadChars).toBe(2000)
    delete process.env.CLAUDIN_STUB_HEAD_CHARS
    _resetCacheProfileForTesting()
  })
})

describe('server-side clearing knobs', () => {
  test('retain enables server tool clearing; aggressive stays env-gated', () => {
    expect(RETAIN_PROFILE.serverToolClearEnabled).toBe(true)
    expect(AGGRESSIVE_PROFILE.serverToolClearEnabled).toBe(false)
  })

  test('retain disables history redaction (client strips AND server clear_thinking)', () => {
    expect(RETAIN_PROFILE.historyRedactionEnabled).toBe(false)
    expect(AGGRESSIVE_PROFILE.historyRedactionEnabled).toBe(true)
  })
})

describe('retain coverage for cache-priced providers (research 2026-06)', () => {
  test('codex (ChatGPT OAuth) and GitHub Copilot get retain', () => {
    expect(resolveProfileForProvider('codex_responses', 'https://chatgpt.com/backend-api', 'gpt-5.5')).toBe(RETAIN_PROFILE)
    expect(resolveProfileForProvider('github_copilot', 'https://api.individual.githubcopilot.com', 'claude-sonnet-4-6')).toBe(RETAIN_PROFILE)
  })

  test('official OpenAI gets retain; generic routers stay aggressive', () => {
    expect(resolveProfileForProvider('openai_compat', 'https://api.openai.com/v1', 'gpt-5.2')).toBe(RETAIN_PROFILE)
    expect(resolveProfileForProvider('openai_compat', 'https://openrouter.ai/api/v1', 'gpt-5.2')).toBe(AGGRESSIVE_PROFILE)
    expect(resolveProfileForProvider('openai_compat', 'https://my-azure.openai.azure.com', 'gpt-5')).toBe(AGGRESSIVE_PROFILE)
    expect(resolveProfileForProvider('openai_compat', 'not a url', 'x')).toBe(AGGRESSIVE_PROFILE)
  })
})
