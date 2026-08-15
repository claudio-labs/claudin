import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

const realAgentUtil = { ...(await import('src/providers/model/agent.js')) }
const realResolver = { ...(await import('src/tools/AgentTool/agentModelResolver.js')) }
const realAllowlist = { ...(await import('src/providers/model/modelAllowlist.js')) }

let providerIsClaudeNative = true
let availableModelIds: Set<string> | undefined
let allowedAliases: Set<string> | null = null // null = no allowlist (all allowed)

mock.module('src/providers/model/agent.js', () => ({
  ...realAgentUtil,
  checkIsClaudeNativeProvider: () => providerIsClaudeNative,
}))

mock.module('./agentModelResolver.js', () => ({
  ...realResolver,
  getAvailableModelIdsForActiveProfile: () => availableModelIds,
}))

mock.module('src/providers/model/modelAllowlist.js', () => ({
  ...realAllowlist,
  isModelAllowed: (m: string) =>
    allowedAliases === null ? true : allowedAliases.has(m),
}))

const { resolveAgentModelDisplay } = await import('src/tools/AgentTool/agentDisplay.js')

function makeAgent(model: string | undefined): AgentDefinition {
  return {
    agentType: 'TestAgent',
    whenToUse: '',
    tools: [],
    source: 'built-in',
    baseDir: 'built-in',
    model,
    getSystemPrompt: () => '',
  } as unknown as AgentDefinition
}

beforeEach(() => {
  providerIsClaudeNative = true
  availableModelIds = undefined
  allowedAliases = null
})

afterEach(() => {
  providerIsClaudeNative = true
  availableModelIds = undefined
  allowedAliases = null
})

afterAll(() => {
  // Restore the real modules so the mocks don't leak into sibling test files
  // (bun's mock.module is process-global, not per-file).
  mock.module('src/providers/model/agent.js', () => realAgentUtil)
  mock.module('./agentModelResolver.js', () => realResolver)
  mock.module('src/providers/model/modelAllowlist.js', () => realAllowlist)
})

describe('resolveAgentModelDisplay', () => {
  test('returns the raw alias on Claude-native providers', () => {
    providerIsClaudeNative = true
    expect(resolveAgentModelDisplay(makeAgent('haiku'))).toBe('haiku')
    expect(resolveAgentModelDisplay(makeAgent('sonnet'))).toBe('sonnet')
    expect(resolveAgentModelDisplay(makeAgent('opus'))).toBe('opus')
  })

  test('shows haiku/sonnet/opus as "inherit" on non-Claude-native providers', () => {
    // Mirrors runtime resolution in getAgentModel: bare Claude family aliases
    // on a non-Claude-native provider are unreachable and fall back to inherit,
    // so the display should not lie about what will actually run.
    providerIsClaudeNative = false
    expect(resolveAgentModelDisplay(makeAgent('haiku'))).toBe('inherit')
    expect(resolveAgentModelDisplay(makeAgent('sonnet'))).toBe('inherit')
    expect(resolveAgentModelDisplay(makeAgent('opus'))).toBe('inherit')
  })

  test('passes through model ids that are on the active profile', () => {
    providerIsClaudeNative = false
    availableModelIds = new Set(['glm-5.1', 'gpt-5.4'])
    expect(resolveAgentModelDisplay(makeAgent('glm-5.1'))).toBe('glm-5.1')
    expect(resolveAgentModelDisplay(makeAgent('gpt-5.4'))).toBe('gpt-5.4')
  })

  test('collapses orphan model ids to inherit on non-Claude-native providers', () => {
    // User configured agent with claude-opus-4-7 then switched to Opencode Zen.
    // The model id is not on the active profile, so the agent will run via
    // inherit at runtime — display matches.
    providerIsClaudeNative = false
    availableModelIds = new Set(['glm-5.1'])
    expect(resolveAgentModelDisplay(makeAgent('claude-opus-4-7'))).toBe(
      'inherit',
    )
  })

  test('passes through model ids when profile has no enumerated list', () => {
    // Catch-all OpenAI-compatible profiles have no model enum; we can't tell
    // whether the id is reachable, so trust the user's input rather than lie.
    providerIsClaudeNative = false
    availableModelIds = undefined
    expect(resolveAgentModelDisplay(makeAgent('glm-5.1'))).toBe('glm-5.1')
  })

  test('collapses alias to inherit when availableModels excludes it on Claude-native', () => {
    // Claude-native provider has guaranteed haiku/sonnet/opus availability,
    // but the user can still restrict via settings.availableModels (allowlist).
    // If the allowlist forbids the alias, the runtime would 403/400 — display
    // must not promise something the user has explicitly forbidden.
    providerIsClaudeNative = true
    allowedAliases = new Set(['sonnet']) // only sonnet allowed
    expect(resolveAgentModelDisplay(makeAgent('haiku'))).toBe('inherit')
    expect(resolveAgentModelDisplay(makeAgent('opus'))).toBe('inherit')
    expect(resolveAgentModelDisplay(makeAgent('sonnet'))).toBe('sonnet')
  })

  test('preserves "inherit" verbatim', () => {
    providerIsClaudeNative = false
    expect(resolveAgentModelDisplay(makeAgent('inherit'))).toBe('inherit')
  })

  test('defaults missing model to inherit (via getDefaultSubagentModel)', () => {
    providerIsClaudeNative = true
    expect(resolveAgentModelDisplay(makeAgent(undefined))).toBe('inherit')
  })
})
