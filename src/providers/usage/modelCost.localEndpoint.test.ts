import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { calculateUSDCost } from 'src/providers/usage/modelCost.js'

const usage = { input_tokens: 1_000_000, output_tokens: 100_000 } as Usage

let savedProfiles: ReturnType<typeof getGlobalConfig>['providerProfiles']
let savedActiveProfileId: string | undefined

beforeAll(() => {
  const global = getGlobalConfig()
  savedProfiles = global.providerProfiles
  savedActiveProfileId = global.activeProviderProfileId
})

function activate(baseUrl: string, model: string): void {
  saveGlobalConfig(c => ({
    ...c,
    providerProfiles: [{ id: 'p-cost', name: 'Cost probe', provider: 'openai', baseUrl, model }],
    activeProviderProfileId: 'p-cost',
  }))
  invalidateActiveProviderCache()
}

function restore(): void {
  saveGlobalConfig(c => ({
    ...c,
    providerProfiles: savedProfiles,
    activeProviderProfileId: savedActiveProfileId,
  }))
  invalidateActiveProviderCache()
}

afterEach(restore)
afterAll(restore)

describe('calculateUSDCost — a model served from the user\'s own machine is free', () => {
  test('Ollama on localhost costs nothing, whatever the model is named', () => {
    activate('http://localhost:11434/v1', 'mgraffam/qwen3.8-35B-A3B-empero:latest')
    expect(calculateUSDCost('mgraffam/qwen3.8-35B-A3B-empero:latest', usage)).toBe(0)
    // A local model named like a priced one is still local.
    expect(calculateUSDCost('deepseek-chat', usage)).toBe(0)
  })

  test('a server on the LAN counts as local too', () => {
    activate('http://192.168.1.20:8000/v1', 'qwen3-coder')
    expect(calculateUSDCost('qwen3-coder', usage)).toBe(0)
  })

  test('a hosted endpoint keeps its price', () => {
    activate('https://api.deepseek.com/v1', 'deepseek-chat')
    expect(calculateUSDCost('deepseek-chat', usage)).toBeGreaterThan(0)
  })
})
