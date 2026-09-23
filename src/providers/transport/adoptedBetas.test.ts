import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Pin the provider facts isRealFirstPartyEndpoint reads, so this file does not
// pass or fail on the developer's own ~/.claudin profile. Both are read at call
// time, so a test can flip them.
const realProviders = { ...(await import('src/providers/model/providers.js')) }
let provider = 'firstParty'
let profileIsFirstParty = true
const pinProviders = () =>
  mock.module('src/providers/model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => provider,
    isFirstPartyAnthropicBaseUrl: () => profileIsFirstParty,
  }))
pinProviders()

import {
  ADOPTED_BETAS,
  _resetAdoptedBetaRejectionsForTesting,
  adoptedBetaFromRejection,
  decideRealFirstPartyEndpoint,
  isAdoptedBetaEnabled,
  markAdoptedBetaRejected,
  withoutRejectedBetas,
} from 'src/providers/transport/adoptedBetas.js'
import { clearBetasCaches, getAllModelBetas } from 'src/providers/transport/betas.js'
import {
  getIsNonInteractiveSession,
  setIsInteractive,
} from 'src/platform/bootstrap/state.js'
import {
  CACHE_DIAGNOSIS_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  THINKING_TOKEN_COUNT_BETA_HEADER,
} from 'src/shared/constants/betas.js'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDIN_DISABLE_EXPERIMENTAL_BETAS',
  ...Object.values(ADOPTED_BETAS).map(b => b.killswitch),
]
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  pinProviders()
  provider = 'firstParty'
  profileIsFirstParty = true
  for (const k of ENV_KEYS) delete process.env[k]
  // As shipped: cli.tsx defaults the experimental switch on.
  process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = 'true'
  _resetAdoptedBetaRejectionsForTesting()
  clearBetasCaches()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  _resetAdoptedBetaRejectionsForTesting()
  clearBetasCaches()
})

afterAll(() => {
  mock.module('src/providers/model/providers.js', () => realProviders)
})

const facts = (over: Partial<Parameters<typeof decideRealFirstPartyEndpoint>[0]>) => ({
  provider: 'firstParty',
  profileIsFirstParty: true,
  envBaseUrl: undefined,
  assumeFirstParty: false,
  ...over,
})

describe('decideRealFirstPartyEndpoint', () => {
  test('first-party provider, profile on api.anthropic.com, no env base URL', () => {
    expect(decideRealFirstPartyEndpoint(facts({}))).toBe(true)
  })

  test('any other provider is not first-party', () => {
    for (const p of ['bedrock', 'vertex', 'foundry', 'openai']) {
      expect(decideRealFirstPartyEndpoint(facts({ provider: p }))).toBe(false)
    }
  })

  test('a profile pointing elsewhere is not first-party', () => {
    expect(decideRealFirstPartyEndpoint(facts({ profileIsFirstParty: false }))).toBe(false)
  })

  // The case the profile check cannot see: ANTHROPIC_BASE_URL routes the SDK
  // to a proxy while the profile still says api.anthropic.com.
  test('an ANTHROPIC_BASE_URL on another host is not first-party', () => {
    expect(
      decideRealFirstPartyEndpoint(facts({ envBaseUrl: 'https://litellm.corp.example/v1' })),
    ).toBe(false)
    expect(decideRealFirstPartyEndpoint(facts({ envBaseUrl: 'not a url' }))).toBe(false)
  })

  test('an ANTHROPIC_BASE_URL on api.anthropic.com is first-party', () => {
    expect(
      decideRealFirstPartyEndpoint(facts({ envBaseUrl: 'https://api.anthropic.com' })),
    ).toBe(true)
  })

  test('the harness override waives only the env condition', () => {
    expect(
      decideRealFirstPartyEndpoint(
        facts({ envBaseUrl: 'http://localhost:8811', assumeFirstParty: true }),
      ),
    ).toBe(true)
    expect(
      decideRealFirstPartyEndpoint(facts({ provider: 'bedrock', assumeFirstParty: true })),
    ).toBe(false)
  })
})

describe('adoptedBetaFromRejection', () => {
  // The exact strings the real API returned to beta-acceptance-probe.ts.
  test('an anthropic-beta rejection naming an adopted header', () => {
    expect(
      adoptedBetaFromRejection(
        400,
        `Unexpected value(s) \`${CACHE_DIAGNOSIS_BETA_HEADER}\` for the \`anthropic-beta\` header. Please consult our documentation at platform.claude.com`,
      ),
    ).toBe('cacheDiagnosis')
  })

  test('an anthropic-beta rejection naming anything else is not ours', () => {
    expect(
      adoptedBetaFromRejection(
        400,
        'Unexpected value(s) `claudin-probe-nonexistent-2099-01-01` for the `anthropic-beta` header.',
      ),
    ).toBeNull()
  })

  test('display "updates" rejected on its own', () => {
    expect(
      adoptedBetaFromRejection(
        400,
        "thinking.adaptive.display: Input should be 'summarized', 'omitted'",
      ),
    ).toBe('thinkingDisplayUpdates')
  })

  test('the diagnostics field rejected on its own', () => {
    expect(
      adoptedBetaFromRejection(400, 'diagnostics.previous_message_id: message not found'),
    ).toBe('cacheDiagnosis')
  })

  test('only a 400, and only a message it recognizes', () => {
    expect(
      adoptedBetaFromRejection(500, "thinking.adaptive.display: Input should be 'omitted'"),
    ).toBeNull()
    expect(adoptedBetaFromRejection(400, 'max_tokens: must be at most 128000')).toBeNull()
    expect(adoptedBetaFromRejection(400, undefined)).toBeNull()
  })

  // The field names are ordinary words; only the `<path>:` form is ours.
  test('a message that merely mentions a field name is not a rejection of it', () => {
    expect(
      adoptedBetaFromRejection(400, 'messages.2.content.0.text: tool diagnostics must not be empty'),
    ).toBeNull()
    expect(
      adoptedBetaFromRejection(400, 'the context_management beta is not enabled for this model'),
    ).toBeNull()
    expect(
      adoptedBetaFromRejection(400, 'context_management.edits.0.keep: Input should be "all"'),
    ).toBe('contextManagement')
  })
})

describe('the rejection latch', () => {
  test('a rejected header leaves the list and its beta turns off', () => {
    expect(isAdoptedBetaEnabled('cacheDiagnosis')).toBe(true)
    markAdoptedBetaRejected('cacheDiagnosis')
    expect(isAdoptedBetaEnabled('cacheDiagnosis')).toBe(false)
    expect(
      withoutRejectedBetas(['claude-code-20250219', CACHE_DIAGNOSIS_BETA_HEADER]),
    ).toEqual(['claude-code-20250219'])
  })

  test('with nothing rejected the list comes back unchanged, as a copy', () => {
    const list = [CACHE_DIAGNOSIS_BETA_HEADER]
    const out = withoutRejectedBetas(list)
    expect(out).toEqual(list)
    expect(out).not.toBe(list)
  })
})

describe('isAdoptedBetaEnabled', () => {
  test('on the real endpoint, each beta is on until its own killswitch', () => {
    for (const [name, { killswitch }] of Object.entries(ADOPTED_BETAS)) {
      const beta = name as keyof typeof ADOPTED_BETAS
      expect(isAdoptedBetaEnabled(beta)).toBe(true)
      process.env[killswitch] = '1'
      expect(isAdoptedBetaEnabled(beta)).toBe(false)
      delete process.env[killswitch]
    }
  })

  test('off the real endpoint, none of them', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8811'
    expect(isAdoptedBetaEnabled('thinkingTokenCount')).toBe(false)
    process.env.CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL = '1'
    expect(isAdoptedBetaEnabled('thinkingTokenCount')).toBe(true)
  })
})

// The shipped state is the point: with the experimental switch ON (the cli.tsx
// default), the adopted headers must still go out — a beta gated on the
// switch ships to nobody.
describe('getAllModelBetas with the experimental switch on', () => {
  test('sends the adopted headers on the real endpoint', () => {
    const betas = getAllModelBetas('claude-opus-5-5')
    expect(betas).toContain(THINKING_TOKEN_COUNT_BETA_HEADER)
    expect(betas).toContain(CONTEXT_MANAGEMENT_BETA_HEADER)
    expect(betas).toContain(PROMPT_CACHING_SCOPE_BETA_HEADER)
  })

  test('each killswitch removes its own header only', () => {
    process.env.CLAUDIN_DISABLE_CONTEXT_MANAGEMENT = '1'
    const betas = getAllModelBetas('claude-opus-5-5')
    expect(betas).not.toContain(CONTEXT_MANAGEMENT_BETA_HEADER)
    expect(betas).toContain(THINKING_TOKEN_COUNT_BETA_HEADER)
  })

  test('a proxy base URL gets none of them', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://litellm.corp.example'
    const betas = getAllModelBetas('claude-opus-5-5')
    expect(betas).not.toContain(THINKING_TOKEN_COUNT_BETA_HEADER)
    expect(betas).not.toContain(CONTEXT_MANAGEMENT_BETA_HEADER)
    expect(betas).not.toContain(PROMPT_CACHING_SCOPE_BETA_HEADER)
  })

  // redact-thinking approximates the explicit display the real endpoint now
  // gets; Claude Code never sends the two together, and neither does Claudin.
  // It is interactive-only, so the session is made interactive, and the proxy
  // case is the positive control that keeps the assertion from being vacuous.
  test('never sends redact-thinking on the real endpoint, even with the switch off', () => {
    process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = 'false'
    const wasInteractive = !getIsNonInteractiveSession()
    setIsInteractive(true)
    try {
      clearBetasCaches()
      expect(getAllModelBetas('claude-opus-5-5')).not.toContain(REDACT_THINKING_BETA_HEADER)
      process.env.ANTHROPIC_BASE_URL = 'https://litellm.corp.example'
      clearBetasCaches()
      expect(getAllModelBetas('claude-opus-5-5')).toContain(REDACT_THINKING_BETA_HEADER)
    } finally {
      setIsInteractive(wasInteractive)
    }
  })
})
