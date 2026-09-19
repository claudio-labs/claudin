// Unit coverage for the pure draft/summary helpers behind ProviderManager.
//
// These were private to the 3156-line component until this commit and were
// reachable only through rendered frames, which pin a screen rather than a
// decision. They are covered HERE, against the component file, before the
// extraction commit moves them out — a suite written against the post-move
// modules would only prove the moved code is self-consistent.
//
// `parseCustomHeaders` is deliberately absent: ProviderManager.test.tsx
// already pins it with five cases (first-colon split, blank/keyless/valueless
// lines, trimming, CRLF+LF) and that suite follows it through the move.

import { describe, expect, test } from 'bun:test'
import type { ProviderProfile } from 'src/platform/config/config.js'
import {
  buildExtrasFromDrafts,
  customHeadersToText,
  parseCustomHeaders,
  presetToDraft,
  profileSummary,
  toDraft,
} from 'src/providers/ui/ProviderManager.js'

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    name: 'Work',
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-5',
    ...overrides,
  }
}

describe('toDraft', () => {
  test('carries name, baseUrl, model and apiKey across unchanged', () => {
    expect(
      toDraft(
        profile({
          name: 'Home',
          baseUrl: 'http://localhost:11434/v1',
          model: 'llama3.1:8b',
          apiKey: 'sk-live',
        }),
      ),
    ).toEqual({
      name: 'Home',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1:8b',
      apiKey: 'sk-live',
    })
  })

  test('a keyless profile drafts an empty string, not undefined', () => {
    // The form binds this straight into a TextInput, which renders `undefined`
    // as the literal word. `toEqual` treats a missing key and an undefined one
    // as equal, so assert the value itself.
    const draft = toDraft(profile({ apiKey: undefined }))
    expect(draft.apiKey).toBe('')
  })

  test('drops id and extras — the draft is exactly the four form fields', () => {
    const draft = toDraft(
      profile({ id: 'keep-me', extras: { awsRegion: 'us-east-1' } }),
    )
    expect(Object.keys(draft).sort()).toEqual([
      'apiKey',
      'baseUrl',
      'model',
      'name',
    ])
  })
})

describe('presetToDraft', () => {
  test('seeds the four fields from the preset defaults', () => {
    expect(presetToDraft('ollama')).toEqual({
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1:8b',
      apiKey: '',
    })
  })

  test('reads each field from its own slot on the defaults', () => {
    // A preset whose name, baseUrl and model are all distinct, so a crossed
    // assignment cannot pass by coincidence.
    expect(presetToDraft('groq')).toEqual({
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: '',
    })
  })

  test('never seeds a key — a fresh preset starts unauthenticated', () => {
    // Every preset ships `apiKey: ''`, so the `?? ''` fallback in the source is
    // defensive and unreachable; what is pinned here is the observable: the
    // draft starts blank for a preset that requires a key and for one that
    // does not.
    expect(presetToDraft('openai').apiKey).toBe('')
    expect(presetToDraft('lmstudio').apiKey).toBe('')
  })
})

describe('customHeadersToText', () => {
  test('renders one "Key: value" line per entry, newline separated', () => {
    expect(customHeadersToText({ 'X-A': '1', 'X-B': 'two' })).toBe(
      'X-A: 1\nX-B: two',
    )
  })

  test('undefined headers render as empty text, not "undefined"', () => {
    expect(customHeadersToText(undefined)).toBe('')
  })

  test('an empty header map renders as empty text', () => {
    expect(customHeadersToText({})).toBe('')
  })

  test('round-trips through parseCustomHeaders', () => {
    const headers = { Authorization: 'Bearer abc', 'X-Org': 'acme' }
    expect(parseCustomHeaders(customHeadersToText(headers))).toEqual(headers)
  })
})

describe('buildExtrasFromDrafts', () => {
  test('no cloud fields and no headers produce undefined, not an empty object', () => {
    // The profile writer stores `extras` verbatim, so an empty object would
    // persist a meaningless key on every non-cloud profile.
    expect(buildExtrasFromDrafts({}, '')).toBeUndefined()
  })

  test('each cloud field lands on its own extras key', () => {
    expect(
      buildExtrasFromDrafts(
        {
          awsRegion: 'us-east-1',
          gcpProject: 'my-project',
          gcpRegion: 'us-central1',
          azureResource: 'my-foundry',
        },
        '',
      ),
    ).toEqual({
      awsRegion: 'us-east-1',
      gcpProject: 'my-project',
      gcpRegion: 'us-central1',
      azureResource: 'my-foundry',
    })
  })

  test('trims each cloud field', () => {
    expect(buildExtrasFromDrafts({ awsRegion: '  us-east-1  ' }, '')).toEqual({
      awsRegion: 'us-east-1',
    })
    expect(buildExtrasFromDrafts({ gcpProject: '  proj  ' }, '')).toEqual({
      gcpProject: 'proj',
    })
    expect(buildExtrasFromDrafts({ gcpRegion: '  us-central1  ' }, '')).toEqual({
      gcpRegion: 'us-central1',
    })
    expect(buildExtrasFromDrafts({ azureResource: '  res  ' }, '')).toEqual({
      azureResource: 'res',
    })
  })

  test('a whitespace-only cloud field is dropped entirely', () => {
    expect(buildExtrasFromDrafts({ awsRegion: '   ' }, '')).toBeUndefined()
    expect(buildExtrasFromDrafts({ gcpProject: '   ' }, '')).toBeUndefined()
    expect(buildExtrasFromDrafts({ gcpRegion: '   ' }, '')).toBeUndefined()
    expect(buildExtrasFromDrafts({ azureResource: '   ' }, '')).toBeUndefined()
  })

  test('parsed custom headers land under customHeaders', () => {
    expect(buildExtrasFromDrafts({}, 'X-Org: acme')).toEqual({
      customHeaders: { 'X-Org': 'acme' },
    })
  })

  test('header text that parses to nothing adds no customHeaders key', () => {
    expect(buildExtrasFromDrafts({ awsRegion: 'us-east-1' }, 'garbage')).toEqual(
      { awsRegion: 'us-east-1' },
    )
  })

  test('headers alone are enough to produce extras', () => {
    expect(buildExtrasFromDrafts({}, 'A: b')).not.toBeUndefined()
  })
})

describe('profileSummary', () => {
  test('composes kind, base URL, model and key state for a keyless profile', () => {
    expect(profileSummary(profile(), false)).toBe(
      'openai-compatible · https://api.example.com/v1 · gpt-5 · no key',
    )
  })

  test('a profile with a key reads "key set"', () => {
    expect(profileSummary(profile({ apiKey: 'sk-live' }), false)).toBe(
      'openai-compatible · https://api.example.com/v1 · gpt-5 · key set',
    )
  })

  test('an empty-string key still reads "no key"', () => {
    expect(profileSummary(profile({ apiKey: '' }), false)).toContain('no key')
  })

  test('the active profile gets an " (active)" suffix and only it', () => {
    expect(profileSummary(profile(), true)).toBe(
      'openai-compatible · https://api.example.com/v1 · gpt-5 · no key (active)',
    )
    expect(profileSummary(profile(), false)).not.toContain('(active)')
  })

  test('only the anthropic tag reads "anthropic"', () => {
    expect(
      profileSummary(profile({ provider: 'anthropic' }), false),
    ).toStartWith('anthropic · ')
  })

  test('the cloud tags are openai-compatible, not anthropic', () => {
    // bedrock/vertex/foundry run Claude, so `provider !== 'anthropic'` reads
    // wrong here — the summary deliberately calls them openai-compatible.
    for (const provider of ['bedrock', 'vertex', 'foundry'] as const) {
      expect(profileSummary(profile({ provider }), false)).toStartWith(
        'openai-compatible · ',
      )
    }
  })

  test('up to three models are listed in full', () => {
    expect(profileSummary(profile({ model: 'a; b; c' }), false)).toContain(
      '· a, b, c ·',
    )
  })

  test('a fourth model collapses the tail into a "+ N more" count', () => {
    expect(profileSummary(profile({ model: 'a; b; c; d' }), false)).toContain(
      '· a, b + 2 more ·',
    )
  })

  test('the "more" count grows with the list', () => {
    expect(
      profileSummary(profile({ model: 'a, b, c, d, e, f' }), false),
    ).toContain('· a, b + 4 more ·')
  })
})
