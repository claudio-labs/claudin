import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// eager_input_streaming is set only for first-party requests; pin that fact so
// the developer's own ~/.claudin profile cannot decide the outcome.
const realProviders = { ...(await import('src/providers/model/providers.js')) }
const pinFirstParty = () =>
  mock.module('src/providers/model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'firstParty',
    isFirstPartyAnthropicBaseUrl: () => true,
  }))
pinFirstParty()

import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type Tools } from 'src/tools/Tool.js'
import { toolToAPISchema } from 'src/providers/transport/api.js'

const KEYS = [
  'CLAUDIN_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDIN_ENABLE_FINE_GRAINED_TOOL_STREAMING',
  'CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL',
  'ANTHROPIC_BASE_URL',
] as const
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  pinFirstParty()
  // As shipped: both are cli.tsx defaults.
  process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = 'true'
  process.env.CLAUDIN_ENABLE_FINE_GRAINED_TOOL_STREAMING = '1'
  delete process.env.CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

afterAll(() => {
  mock.module('src/providers/model/providers.js', () => realProviders)
})

// A fresh name per call: the base schema is cached per session by tool.
let seq = 0
const schemaFor = async (): Promise<Record<string, unknown>> =>
  (await toolToAPISchema(
    {
      name: `EagerProbe${seq++}`,
      inputSchema: z.strictObject({}),
      inputJSONSchema: { type: 'object', properties: {} },
      prompt: async () => 'probe',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )) as unknown as Record<string, unknown>

// The experimental switch used to strip it along with every other non-base
// field, which cancelled the fine-grained tool streaming cli.tsx turns on.
test('keeps eager_input_streaming under the experimental switch on the real endpoint', async () => {
  expect((await schemaFor()).eager_input_streaming).toBe(true)
})

test('still strips it for a proxy reached through ANTHROPIC_BASE_URL', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://litellm.corp.example'
  expect('eager_input_streaming' in (await schemaFor())).toBe(false)
})
