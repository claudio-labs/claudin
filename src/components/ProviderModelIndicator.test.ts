import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'

import { renderModelName } from 'src/utils/model/model.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import type { ProviderProfile } from 'src/platform/config/config.js'
import { readSnapshot } from 'src/components/ProviderModelIndicator.js'

const realModel = { ...(await import('src/utils/model/model.js')) }
const realProfiles = { ...(await import('src/services/api/providerProfiles.js')) }

function setActiveModel(name: string): void {
  mock.module('src/utils/model/model.js', () => ({
    ...realModel,
    getMainLoopModel: () => name,
  }))
}

function setProfile(profile: Partial<ProviderProfile> | undefined): void {
  mock.module('src/services/api/providerProfiles.js', () => ({
    ...realProfiles,
    getActiveProviderProfile: () => profile,
  }))
}

afterEach(() => {
  mock.module('src/utils/model/model.js', () => realModel)
  mock.module('src/services/api/providerProfiles.js', () => realProfiles)
})

afterAll(() => {
  mock.module('src/utils/model/model.js', () => realModel)
  mock.module('src/services/api/providerProfiles.js', () => realProfiles)
})

describe('ProviderModelIndicator readSnapshot', () => {
  it('renders the friendly model name instead of the raw model id', () => {
    setProfile({ provider: 'anthropic', name: 'Anthropic', model: '' })
    const raw = getModelStrings().opus48
    setActiveModel(raw)

    const snapshot = readSnapshot()

    // The raw id maps to a friendly label and must not leak through.
    expect(snapshot?.model).toBe(renderModelName(raw))
    expect(snapshot?.model).not.toBe(raw)
  })

  it('never leaks the [1m] context suffix into the pill', () => {
    // Regression: the bottom pill used to print the raw `<id>[1m]` string
    // because it bypassed renderModelName (see ProviderModelIndicator fix).
    setProfile({ provider: 'anthropic', name: 'Anthropic', model: '' })
    const raw = getModelStrings().opus48 + '[1m]'
    setActiveModel(raw)

    const snapshot = readSnapshot()

    expect(snapshot?.model).toBe(renderModelName(raw))
    expect(snapshot?.model).not.toContain('[1m]')
  })

  it('falls back to the profile model when no main-loop model resolves', () => {
    const raw = getModelStrings().opus48
    setProfile({ provider: 'anthropic', name: 'Anthropic', model: raw })
    mock.module('src/utils/model/model.js', () => ({
      ...realModel,
      getMainLoopModel: () => '',
    }))

    const snapshot = readSnapshot()

    expect(snapshot?.model).toBe(renderModelName(raw))
  })

  it('returns null when no provider profile is active', () => {
    setProfile(undefined)

    expect(readSnapshot()).toBeNull()
  })
})
