import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import {
  activeSessionOnCodexBackend,
  activeSessionReplaysCodexItems,
  codexReplayActive,
  codexBackendBodyFields,
  codexStateToKeep,
  isCodexBackendRequest,
  isCodexReasoningReplayEnabled,
  isCodexReplayRejected,
} from 'src/providers/shims/codex/backend.js'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const originalSwitch = process.env.CLAUDIN_CODEX_REASONING_REPLAY

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

afterEach(() => {
  if (originalSwitch === undefined) delete process.env.CLAUDIN_CODEX_REASONING_REPLAY
  else process.env.CLAUDIN_CODEX_REASONING_REPLAY = originalSwitch
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

describe('the killswitch', () => {
  test.each([
    [undefined, true],
    ['1', true],
    ['', true],
    ['0', false],
    ['false', false],
    ['off', false],
  ])('CLAUDIN_CODEX_REASONING_REPLAY=%p → replay %p', (value, enabled) => {
    if (value === undefined) delete process.env.CLAUDIN_CODEX_REASONING_REPLAY
    else process.env.CLAUDIN_CODEX_REASONING_REPLAY = value
    expect(isCodexReasoningReplayEnabled()).toBe(enabled)
  })
})

describe('which requests go to the Codex backend', () => {
  test.each([
    ['codex_responses', CODEX_BASE_URL, true],
    ['codex_responses', `${CODEX_BASE_URL}/`, true],
    ['codex_responses', 'https://api.githubcopilot.com', false],
    ['codex_responses', 'http://localhost:8000/v1', false],
    ['chat_completions', CODEX_BASE_URL, false],
  ] as const)('%s to %s → %p', (transport, baseUrl, active) => {
    expect(codexReplayActive({ transport, baseUrl })).toBe(active)
    expect(isCodexBackendRequest({ transport, baseUrl })).toBe(active)
  })

  test('the killswitch turns the replay off, not the backend', () => {
    process.env.CLAUDIN_CODEX_REASONING_REPLAY = '0'
    expect(codexReplayActive({ transport: 'codex_responses', baseUrl: CODEX_BASE_URL })).toBe(false)
    expect(isCodexBackendRequest({ transport: 'codex_responses', baseUrl: CODEX_BASE_URL })).toBe(true)
  })
})

describe('which sessions go to the Codex backend', () => {
  test.each([
    [{ id: 'b-codex', name: 'Codex OAuth', provider: 'openai', baseUrl: CODEX_BASE_URL, model: 'codexplan' }, true],
    [{ id: 'b-codex-model', name: 'Codex', provider: 'openai', baseUrl: CODEX_BASE_URL, model: 'gpt-5.6-terra' }, true],
    [
      {
        id: 'b-copilot',
        name: 'Copilot',
        provider: 'openai',
        baseUrl: 'https://api.githubcopilot.com',
        model: 'gpt-5.5',
        extras: { githubToken: 'gh' },
      },
      false,
    ],
    [{ id: 'b-openai', name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' }, false],
    [{ id: 'b-local', name: 'Local', provider: 'openai', baseUrl: 'http://localhost:8000/v1', model: 'codexplan' }, false],
    [{ id: 'b-anthropic', name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' }, false],
  ] as Array<[ProviderProfile, boolean]>)('$1: %o', (profile, expected) => {
    useProfile(profile)
    expect(activeSessionReplaysCodexItems()).toBe(expected)
    expect(activeSessionOnCodexBackend()).toBe(expected)
  })

  test('no profile is no Codex session', () => {
    expect(activeSessionReplaysCodexItems()).toBe(false)
    expect(activeSessionOnCodexBackend()).toBe(false)
  })

  test('a Codex session with the killswitch off stays on the backend but replays nothing', () => {
    useProfile({ id: 'b-codex', name: 'Codex OAuth', provider: 'openai', baseUrl: CODEX_BASE_URL, model: 'codexplan' })
    process.env.CLAUDIN_CODEX_REASONING_REPLAY = '0'
    expect(activeSessionReplaysCodexItems()).toBe(false)
    expect(activeSessionOnCodexBackend()).toBe(true)
  })
})

describe('the item state a rebuilt block keeps', () => {
  const CODEX = { id: 'b-codex', name: 'Codex OAuth', provider: 'openai', baseUrl: CODEX_BASE_URL, model: 'codexplan' } as ProviderProfile
  const CALL = { type: 'tool_use', id: 'call_1', codex: { id: 'fc_real' } }

  test('a session that replays keeps it', () => {
    useProfile(CODEX)
    expect(codexStateToKeep(CALL)).toEqual({ codex: { id: 'fc_real' } })
  })

  test('a block without state, or no block, keeps nothing', () => {
    useProfile(CODEX)
    expect(codexStateToKeep({ type: 'tool_use', id: 'call_1' })).toEqual({})
    expect(codexStateToKeep(null)).toEqual({})
  })

  test('another provider, or the killswitch off, keeps nothing', () => {
    useProfile({ id: 'b-anthropic', name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' })
    expect(codexStateToKeep(CALL)).toEqual({})
    useProfile(CODEX)
    process.env.CLAUDIN_CODEX_REASONING_REPLAY = '0'
    expect(codexStateToKeep(CALL)).toEqual({})
  })
})

describe('the body fields the Codex CLI adds', () => {
  test('with an effort, the context joins it', () => {
    expect(codexBackendBodyFields({ effort: 'medium' })).toEqual({
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium', context: 'all_turns' },
      text: { verbosity: 'low' },
    })
  })

  test('without one, no reasoning field is invented', () => {
    expect(codexBackendBodyFields(undefined)).toEqual({
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'low' },
    })
  })
})

describe('a replayed reasoning item the backend refuses', () => {
  const refusal = 'The encrypted content for item rs_1 could not be verified.'
  test.each([
    [400, { error: { message: refusal, code: 'invalid_encrypted_content' } }, true],
    [500, { error: { message: refusal, code: 'invalid_encrypted_content' } }, false],
    [400, { error: { message: 'Unsupported parameter: x', code: 'unsupported_parameter' } }, false],
  ])('%d %o → %p', (status, body, expected) => {
    expect(isCodexReplayRejected(APIError.generate(status, body, refusal, new Headers()))).toBe(expected)
  })

  test('only an SDK error counts', () => {
    expect(isCodexReplayRejected(new Error('invalid_encrypted_content'))).toBe(false)
    expect(isCodexReplayRejected('invalid_encrypted_content')).toBe(false)
  })
})
