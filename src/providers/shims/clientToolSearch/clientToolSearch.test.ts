import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import {
  CALL_TOOL,
  CALL_TOOL_NAME,
  gatewayInput,
  unwrapGatewayCall,
} from 'src/providers/shims/clientToolSearch/callTool.js'
import { clientDefersTools } from 'src/providers/shims/clientToolSearch/capability.js'
import { planToolDeferral } from 'src/providers/shims/clientToolSearch/deferral.js'
import { clientToolSearchDisabled } from 'src/providers/shims/clientToolSearch/gate.js'
import { renderLoadedTools } from 'src/providers/shims/clientToolSearch/renderToolReference.js'

const savedKillswitch = process.env.CLAUDIN_SHIM_TOOL_SEARCH

function useProfile(profile: ProviderProfile | null): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: profile ? [profile] : [],
    activeProviderProfileId: profile?.id,
  }))
  invalidateActiveProviderCache()
}

beforeEach(() => {
  delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterEach(() => {
  if (savedKillswitch === undefined) delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
  else process.env.CLAUDIN_SHIM_TOOL_SEARCH = savedKillswitch
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

describe('clientDefersTools', () => {
  const base = { name: 'p', model: 'm' }

  test('openai-compatible and Mistral profiles', () => {
    useProfile({ ...base, id: 'o', provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' })
    expect(clientDefersTools()).toBe(true)
    useProfile({ ...base, id: 'mi', provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' })
    expect(clientDefersTools()).toBe(true)
  })

  test('Copilot on chat completions and on /responses, but not Copilot running Claude natively', () => {
    const copilot: ProviderProfile = {
      ...base,
      id: 'gh',
      provider: 'openai',
      baseUrl: 'https://api.githubcopilot.com',
      model: 'gpt-4o',
      extras: { githubToken: 't' },
    }
    useProfile(copilot)
    expect(clientDefersTools('gpt-4o')).toBe(true)
    expect(clientDefersTools('gpt-5.4')).toBe(true)
    expect(clientDefersTools('claude-sonnet-4-6')).toBe(false)
  })

  test('Gemini and Codex: yes', () => {
    useProfile({ ...base, id: 'g', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3-pro' })
    expect(clientDefersTools()).toBe(true)
    useProfile({ ...base, id: 'c', provider: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5.5' })
    expect(clientDefersTools()).toBe(true)
  })

  test('no profile, Anthropic: no', () => {
    useProfile(null)
    expect(clientDefersTools()).toBe(false)
    useProfile({ ...base, id: 'a', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' })
    expect(clientDefersTools()).toBe(false)
  })
})

describe('clientToolSearchDisabled', () => {
  test('only an explicit falsy value turns it off', () => {
    expect(clientToolSearchDisabled()).toBe(false)
    process.env.CLAUDIN_SHIM_TOOL_SEARCH = '1'
    expect(clientToolSearchDisabled()).toBe(false)
    process.env.CLAUDIN_SHIM_TOOL_SEARCH = '0'
    expect(clientToolSearchDisabled()).toBe(true)
    process.env.CLAUDIN_SHIM_TOOL_SEARCH = 'false'
    expect(clientToolSearchDisabled()).toBe(true)
  })
})

describe('planToolDeferral', () => {
  const tools = [
    { name: 'Bash' },
    { name: 'mcp__a', defer_loading: true, description: 'A' },
    { name: 'mcp__b', defer_loading: true },
  ]

  test('flagged tools stay behind the gateway, in order', () => {
    const plan = planToolDeferral(tools)
    expect(plan.sent.map(t => t.name)).toEqual(['Bash'])
    expect([...plan.deferred.keys()]).toEqual(['mcp__a', 'mcp__b'])
  })

  test('a tool forced by tool_choice is sent whole', () => {
    const plan = planToolDeferral(tools, 'mcp__b')
    expect(plan.sent.map(t => t.name)).toEqual(['Bash', 'mcp__b'])
    expect([...plan.deferred.keys()]).toEqual(['mcp__a'])
  })

  test('the killswitch sends everything', () => {
    process.env.CLAUDIN_SHIM_TOOL_SEARCH = '0'
    const plan = planToolDeferral(tools)
    expect(plan.sent).toHaveLength(3)
    expect(plan.deferred.size).toBe(0)
  })
})

describe('the gateway call', () => {
  test('CALL_TOOL takes a name and free-form arguments', () => {
    expect(CALL_TOOL.name).toBe(CALL_TOOL_NAME)
    expect(CALL_TOOL.input_schema).toMatchObject({
      required: ['name', 'arguments'],
      properties: { name: { type: 'string' }, arguments: { type: 'object' } },
    })
  })

  test('round trip: a deferred tool_use goes out as gateway arguments and comes back', () => {
    const args = JSON.stringify(gatewayInput('mcp__a', { select: 'x' }))
    expect(args).toBe('{"name":"mcp__a","arguments":{"select":"x"}}')
    expect(unwrapGatewayCall(args)).toEqual({ name: 'mcp__a', input: { select: 'x' } })
    expect(JSON.stringify(gatewayInput('mcp__a', undefined))).toBe('{"name":"mcp__a","arguments":{}}')
  })

  test('arguments encoded twice are decoded; undecodable ones become {}', () => {
    expect(unwrapGatewayCall('{"name":"mcp__a","arguments":"{\\"x\\":1}"}')).toEqual({ name: 'mcp__a', input: { x: 1 } })
    expect(unwrapGatewayCall('{"name":"mcp__a","arguments":"not json"}')).toEqual({ name: 'mcp__a', input: {} })
    expect(unwrapGatewayCall('{"name":"mcp__a"}')).toEqual({ name: 'mcp__a', input: {} })
    expect(unwrapGatewayCall('{"name":"mcp__a","arguments":[1]}')).toEqual({ name: 'mcp__a', input: [1] })
  })

  test('no name, or not JSON: not a gateway call', () => {
    expect(unwrapGatewayCall('{"arguments":{}}')).toBeNull()
    expect(unwrapGatewayCall('{"name":""}')).toBeNull()
    expect(unwrapGatewayCall('{"name":')).toBeNull()
    expect(unwrapGatewayCall('null')).toBeNull()
    expect(unwrapGatewayCall(undefined)).toBeNull()
  })
})

describe('renderLoadedTools', () => {
  const deferred = new Map([
    ['mcp__a', { name: 'mcp__a', description: 'Alpha.', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    ['mcp__b', { name: 'mcp__b' }],
  ])

  test('each loaded tool as a <function>, with how to call it', () => {
    expect(renderLoadedTools(['mcp__a', 'mcp__b'], deferred)).toBe(
      `Loaded. Call these through ${CALL_TOOL_NAME} with {"name": <tool>, "arguments": {...}}:\n` +
        '<functions>' +
        '<function>{"description":"Alpha.","name":"mcp__a","parameters":{"properties":{"q":{"type":"string"}},"type":"object"}}</function>' +
        '<function>{"description":"","name":"mcp__b","parameters":{"properties":{},"type":"object"}}</function>' +
        '</functions>',
    )
  })

  test('a tool that left the pool says so', () => {
    expect(renderLoadedTools(['mcp__gone'], deferred)).toBe('Tool mcp__gone is no longer available.')
    expect(renderLoadedTools(['mcp__a', 'mcp__gone'], deferred).endsWith('\nTool mcp__gone is no longer available.')).toBe(true)
  })
})
