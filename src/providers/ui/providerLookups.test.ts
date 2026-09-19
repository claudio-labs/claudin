// Unit coverage for the pure lookup/diagnostic helpers behind ProviderManager.
//
// Written against ProviderManager.tsx as it stands, BEFORE the extraction
// commit moves these out, so the suite is a real before/after rather than a
// self-consistency check on the moved copy.
//
// The load-bearing assertions here are the NEAR-MISSES. Each `find*OAuthProfile`
// matches a profile by id OR by a provider+baseUrl+keyless signature, and the
// failure mode that matters is a widened predicate silently adopting somebody
// else's profile — a re-login would then overwrite an unrelated API-key profile
// instead of appending. A test that only checks the happy path cannot see that.

import { describe, expect, test } from 'bun:test'
import type { ProviderProfile } from 'src/platform/config/config.js'
import { DEFAULT_XAI_BASE_URL } from 'src/providers/presets/providerConfig.js'
import type {
  AtomicChatReadiness,
  OllamaGenerationReadiness,
} from 'src/providers/presets/providerDiscovery.js'
import {
  describeAtomicChatSelectionIssue,
  describeOllamaSelectionIssue,
  findAnthropicOAuthProfile,
  findCodexOAuthProfile,
  findKimiOAuthProfile,
  findXaiOAuthProfile,
  isCodexOAuthProfile,
} from 'src/providers/ui/providerLookups.js'
import { KIMI_OAUTH_BASE_URL } from 'src/providers/ui/providerManagerConstants.js'

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    name: 'Some provider',
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-5',
    ...overrides,
  }
}

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

describe('findCodexOAuthProfile', () => {
  test('returns the profile whose id matches', () => {
    const target = profile({ id: 'codex-1' })
    expect(
      findCodexOAuthProfile([profile({ id: 'other' }), target], 'codex-1'),
    ).toBe(target)
  })

  test('a near-miss id does not match', () => {
    expect(
      findCodexOAuthProfile([profile({ id: 'codex-1' })], 'codex-10'),
    ).toBeUndefined()
  })

  test('with no stored id it refuses to guess a profile', () => {
    // Codex has no signature fallback: without the id from the credentials
    // there is nothing to safely update, so the caller must append instead.
    expect(findCodexOAuthProfile([profile({ id: 'codex-1' })])).toBeUndefined()
  })

  test('an empty profile list yields undefined', () => {
    expect(findCodexOAuthProfile([], 'codex-1')).toBeUndefined()
  })
})

describe('isCodexOAuthProfile', () => {
  test('true only when both ids are present and equal', () => {
    expect(isCodexOAuthProfile(profile({ id: 'codex-1' }), 'codex-1')).toBe(true)
  })

  test('a different id is not the Codex profile', () => {
    expect(isCodexOAuthProfile(profile({ id: 'codex-1' }), 'other')).toBe(false)
  })

  test('a null or undefined profile is never the Codex profile', () => {
    expect(isCodexOAuthProfile(null, 'codex-1')).toBe(false)
    expect(isCodexOAuthProfile(undefined, 'codex-1')).toBe(false)
  })

  test('without a stored id nothing is the Codex profile', () => {
    expect(isCodexOAuthProfile(profile({ id: 'codex-1' }))).toBe(false)
  })

  test('returns a boolean, never the id string', () => {
    // The body is a Boolean(...) wrap over a `&&` chain, which would otherwise
    // leak `undefined` to a `=== true` caller.
    expect(isCodexOAuthProfile(null, undefined)).toBe(false)
  })
})

describe('findKimiOAuthProfile', () => {
  const kimi = (overrides: Partial<ProviderProfile> = {}) =>
    profile({
      id: 'kimi-1',
      provider: 'openai',
      baseUrl: KIMI_OAUTH_BASE_URL,
      ...overrides,
    })

  test('the OAuth base URL is the Kimi coding host', () => {
    expect(KIMI_OAUTH_BASE_URL).toBe('https://api.kimi.com/coding/v1')
  })

  test('the stored id wins over the signature match', () => {
    const byId = profile({ id: 'stored', baseUrl: 'https://elsewhere/v1' })
    const bySignature = kimi({ id: 'kimi-2' })
    expect(findKimiOAuthProfile([bySignature, byId], 'stored')).toBe(byId)
  })

  test('falls back to the signature when the stored id matches nothing', () => {
    const bySignature = kimi({ id: 'kimi-2' })
    expect(findKimiOAuthProfile([bySignature], 'gone')).toBe(bySignature)
  })

  test('matches by signature when no id is stored at all', () => {
    const bySignature = kimi()
    expect(findKimiOAuthProfile([bySignature])).toBe(bySignature)
  })

  test('a Kimi-hosted profile that carries an API key is NOT adopted', () => {
    // The key-bearing profile is the user's own API-key profile on the same
    // host; overwriting it on re-login would destroy their credential.
    expect(findKimiOAuthProfile([kimi({ apiKey: 'sk-user' })])).toBeUndefined()
  })

  test('a keyless profile on a different host is NOT adopted', () => {
    expect(
      findKimiOAuthProfile([kimi({ baseUrl: 'https://api.moonshot.ai/v1' })]),
    ).toBeUndefined()
  })

  test('a keyless Kimi-hosted profile under another provider tag is NOT adopted', () => {
    expect(
      findKimiOAuthProfile([kimi({ provider: 'anthropic' })]),
    ).toBeUndefined()
  })

  test('does not adopt the xAI OAuth profile', () => {
    expect(
      findKimiOAuthProfile([kimi({ baseUrl: DEFAULT_XAI_BASE_URL })]),
    ).toBeUndefined()
  })
})

describe('findXaiOAuthProfile', () => {
  const xai = (overrides: Partial<ProviderProfile> = {}) =>
    profile({
      id: 'xai-1',
      provider: 'openai',
      baseUrl: DEFAULT_XAI_BASE_URL,
      ...overrides,
    })

  test('the stored id wins over the signature match', () => {
    const byId = profile({ id: 'stored', baseUrl: 'https://elsewhere/v1' })
    const bySignature = xai({ id: 'xai-2' })
    expect(findXaiOAuthProfile([bySignature, byId], 'stored')).toBe(byId)
  })

  test('falls back to the signature when the stored id matches nothing', () => {
    const bySignature = xai({ id: 'xai-2' })
    expect(findXaiOAuthProfile([bySignature], 'gone')).toBe(bySignature)
  })

  test('matches by signature when no id is stored at all', () => {
    const bySignature = xai()
    expect(findXaiOAuthProfile([bySignature])).toBe(bySignature)
  })

  test('an xAI-hosted profile that carries an API key is NOT adopted', () => {
    expect(findXaiOAuthProfile([xai({ apiKey: 'xai-key' })])).toBeUndefined()
  })

  test('a keyless profile on a different host is NOT adopted', () => {
    expect(
      findXaiOAuthProfile([xai({ baseUrl: 'https://api.x.ai/v2' })]),
    ).toBeUndefined()
  })

  test('a keyless xAI-hosted profile under another provider tag is NOT adopted', () => {
    expect(findXaiOAuthProfile([xai({ provider: 'gemini' })])).toBeUndefined()
  })

  test('does not adopt the Kimi OAuth profile', () => {
    expect(
      findXaiOAuthProfile([xai({ baseUrl: KIMI_OAUTH_BASE_URL })]),
    ).toBeUndefined()
  })
})

describe('findAnthropicOAuthProfile', () => {
  const anthropic = (overrides: Partial<ProviderProfile> = {}) =>
    profile({
      id: 'anthropic-1',
      provider: 'anthropic',
      baseUrl: ANTHROPIC_BASE_URL,
      ...overrides,
    })

  test('matches the keyless anthropic profile on the given base URL', () => {
    const target = anthropic()
    expect(findAnthropicOAuthProfile([target], ANTHROPIC_BASE_URL)).toBe(target)
  })

  test('an anthropic profile that carries an API key is NOT adopted', () => {
    expect(
      findAnthropicOAuthProfile(
        [anthropic({ apiKey: 'sk-ant' })],
        ANTHROPIC_BASE_URL,
      ),
    ).toBeUndefined()
  })

  test('a keyless profile on another base URL is NOT adopted', () => {
    expect(
      findAnthropicOAuthProfile(
        [anthropic({ baseUrl: 'https://proxy.internal/anthropic' })],
        ANTHROPIC_BASE_URL,
      ),
    ).toBeUndefined()
  })

  test('a keyless profile under another provider tag is NOT adopted', () => {
    // bedrock/vertex/foundry also run Claude, so matching on anything looser
    // than the exact tag would sweep them in.
    for (const provider of ['bedrock', 'vertex', 'foundry', 'openai'] as const) {
      expect(
        findAnthropicOAuthProfile([anthropic({ provider })], ANTHROPIC_BASE_URL),
      ).toBeUndefined()
    }
  })

  test('returns the first match when several qualify', () => {
    const first = anthropic({ id: 'a' })
    const second = anthropic({ id: 'b' })
    expect(
      findAnthropicOAuthProfile([first, second], ANTHROPIC_BASE_URL),
    ).toBe(first)
  })
})

describe('describeAtomicChatSelectionIssue', () => {
  const BASE_URL = 'http://127.0.0.1:1337/v1'

  test('an unreachable server names the endpoint and how to fix it', () => {
    const message = describeAtomicChatSelectionIssue(
      { state: 'unreachable' },
      BASE_URL,
    )
    expect(message).toBe(
      `Could not reach Atomic Chat at ${BASE_URL}. Start the Atomic Chat app first, or enter the endpoint manually.`,
    )
  })

  test('a reachable server with no models says so instead', () => {
    const message = describeAtomicChatSelectionIssue(
      { state: 'no_models' },
      BASE_URL,
    )
    expect(message).toContain('no models are loaded')
    expect(message).not.toContain('Could not reach')
  })

  test('a ready server has no issue to describe', () => {
    // The caller renders this string unconditionally, so a non-empty return
    // for the healthy case would print a phantom error.
    const readiness: AtomicChatReadiness = { state: 'ready', models: ['m'] }
    expect(describeAtomicChatSelectionIssue(readiness, BASE_URL)).toBe('')
  })

  test('a secret in the base URL is redacted before it reaches the screen', () => {
    const message = describeAtomicChatSelectionIssue(
      { state: 'unreachable' },
      'http://127.0.0.1:1337/v1?api_key=sekret',
    )
    expect(message).not.toContain('sekret')
    expect(message).toContain('redacted')
  })
})

describe('describeOllamaSelectionIssue', () => {
  const BASE_URL = 'http://localhost:11434/v1'
  const readiness = (
    overrides: Partial<OllamaGenerationReadiness>,
  ): OllamaGenerationReadiness => ({
    state: 'ready',
    models: [],
    ...overrides,
  })

  test('an unreachable daemon names the endpoint', () => {
    expect(
      describeOllamaSelectionIssue(readiness({ state: 'unreachable' }), BASE_URL),
    ).toBe(
      `Could not reach Ollama at ${BASE_URL}. Start Ollama first, or enter the endpoint manually.`,
    )
  })

  test('a running daemon with no models suggests pulling one', () => {
    const message = describeOllamaSelectionIssue(
      readiness({ state: 'no_models' }),
      BASE_URL,
    )
    expect(message).toContain('no installed models were found')
    expect(message).not.toContain('Could not reach')
  })

  test('a failed generation probe names the model it probed', () => {
    const message = describeOllamaSelectionIssue(
      readiness({ state: 'generation_failed', probeModel: 'qwen2.5-coder:7b' }),
      BASE_URL,
    )
    expect(message).toContain('a generation probe failed for qwen2.5-coder:7b')
    expect(message).toContain('ollama run qwen2.5-coder:7b')
  })

  test('a failed probe with no model named falls back to a generic phrase', () => {
    const message = describeOllamaSelectionIssue(
      readiness({ state: 'generation_failed' }),
      BASE_URL,
    )
    expect(message).toContain('probe failed for the selected model')
    expect(message).not.toContain('undefined')
  })

  test('the probe detail is appended when present, and nothing when absent', () => {
    expect(
      describeOllamaSelectionIssue(
        readiness({
          state: 'generation_failed',
          probeModel: 'm',
          detail: 'connection reset',
        }),
        BASE_URL,
      ),
    ).toContain('Details: connection reset.')
    expect(
      describeOllamaSelectionIssue(
        readiness({ state: 'generation_failed', probeModel: 'm' }),
        BASE_URL,
      ),
    ).not.toContain('Details:')
  })

  test('a ready daemon has no issue to describe', () => {
    expect(describeOllamaSelectionIssue(readiness({}), BASE_URL)).toBe('')
  })

  test('a secret in the base URL is redacted before it reaches the screen', () => {
    const message = describeOllamaSelectionIssue(
      readiness({ state: 'unreachable' }),
      'http://localhost:11434/v1?token=sekret',
    )
    expect(message).not.toContain('sekret')
    expect(message).toContain('redacted')
  })
})
