import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import {
  getDeferredDeltaLegacySession,
  setDeferredDeltaLegacySession,
} from 'src/platform/bootstrap/state.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import type { Tool, ToolPermissionContext, Tools } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'
import {
  extractDiscoveredToolNames,
  getAutoToolSearchCharThreshold,
  getDeferredToolsDelta,
  getToolSearchMode,
  isDeferredToolsDeltaActive,
  isDeferredToolsDiscoveredOnly,
  isToolReferenceBlock,
  isToolSearchEnabled,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  isUnloadedDeferredTool,
  maybeLatchLegacyDeferredAnnouncement,
  modelSupportsToolReference,
} from 'src/agent/tools/toolSearch.js'

// Characterization of toolSearch.ts as it stands, before the client-side tool
// search gate for OpenAI-compatible providers hooks into getToolSearchMode()
// and skips modelSupportsToolReference. Every provider is set through the real
// config (in memory under bun test) — no mock.module.

const ENV_KEYS = [
  'ENABLE_TOOL_SEARCH',
  'CLAUDIN_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDIN_DEFERRED_TOOLS_DISCOVERED_ONLY',
  'CLAUDIN_DEFERRED_TOOLS_DELTA',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const savedLegacyLatch = getDeferredDeltaLegacySession()

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function resetProvider(): void {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

const ANTHROPIC_DIRECT: ProviderProfile = {
  id: 'ts-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
}
const ANTHROPIC_PROXY: ProviderProfile = {
  id: 'ts-anthropic-proxy',
  name: 'Gateway',
  provider: 'anthropic',
  baseUrl: 'https://llm-gateway.example.com',
  model: 'claude-opus-5-5',
}
const OLLAMA: ProviderProfile = {
  id: 'ts-ollama',
  name: 'Ollama',
  provider: 'openai',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3',
}
const BEDROCK: ProviderProfile = {
  id: 'ts-bedrock',
  name: 'Bedrock',
  provider: 'bedrock',
  baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  model: 'claude-opus-5-5',
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  resetProvider()
  setDeferredDeltaLegacySession(false)
})

afterEach(() => {
  restoreEnv()
  resetProvider()
  setDeferredDeltaLegacySession(savedLegacyLatch)
})

afterAll(() => {
  restoreEnv()
  resetProvider()
  setDeferredDeltaLegacySession(savedLegacyLatch)
})

// ── fixtures ────────────────────────────────────────────────────────────────

let uniq = 0
function name(base: string): string {
  // getDeferredToolTokenCount is memoized by the deferred names: keep each
  // test's pool unique so no test reads another's count.
  uniq += 1
  return `${base}_${uniq}`
}

function tool(over: Partial<Tool> & { name: string }): Tool {
  return {
    async prompt() {
      return 'desc'
    },
    ...over,
  } as unknown as Tool
}

const TOOL_SEARCH = tool({ name: 'ToolSearch' })
const READ = tool({ name: 'Read' })
const getCtx = async () => ({}) as ToolPermissionContext
const MODEL = 'claude-sonnet-4-6'

/**
 * A deferred MCP tool whose token count is unavailable: toolToAPISchema
 * (which passes `allowedAgentTypes`) gets a throw, so isToolSearchEnabled
 * falls to the char heuristic, which calls prompt() without that key. No
 * network is reached.
 */
function uncountableMcpTool(description: string, schema: 'json' | 'zod' | 'none'): Tool {
  return tool({
    name: name('mcp__srv__tool'),
    isMcp: true,
    async prompt(opts: object) {
      if ('allowedAgentTypes' in opts) throw new Error('token count unavailable')
      return description
    },
    ...(schema === 'json'
      ? { inputJSONSchema: { type: 'object', properties: {} } }
      : schema === 'zod'
        ? { inputSchema: z.object({ q: z.string() }) }
        : {}),
  } as Partial<Tool> & { name: string })
}

function userWithToolResult(content: unknown[]): Message {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
  } as unknown as Message
}

// ── getToolSearchMode ───────────────────────────────────────────────────────

describe('getToolSearchMode: ENABLE_TOOL_SEARCH forms (no kill switch)', () => {
  test.each([
    [undefined, 'tst'],
    ['', 'tst'],
    ['true', 'tst'],
    ['1', 'tst'],
    ['false', 'standard'],
    ['0', 'standard'],
    ['auto', 'tst-auto'],
    ['auto:0', 'tst'],
    ['auto:1', 'tst-auto'],
    ['auto:50', 'tst-auto'],
    ['auto:99', 'tst-auto'],
    ['auto:100', 'standard'],
    // Clamped to 0..100 before the edge checks.
    ['auto:-5', 'tst'],
    ['auto:250', 'standard'],
    // Not a number: still auto mode, at the default percentage.
    ['auto:abc', 'tst-auto'],
    // Neither truthy nor defined-falsy: the default.
    ['bogus', 'tst'],
  ] as const)('ENABLE_TOOL_SEARCH=%p → %s', (value, expected) => {
    if (value !== undefined) process.env.ENABLE_TOOL_SEARCH = value
    expect(getToolSearchMode()).toBe(expected)
  })
})

describe('getToolSearchMode: CLAUDIN_DISABLE_EXPERIMENTAL_BETAS kill switch', () => {
  beforeEach(() => {
    process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = '1'
  })

  test('no profile counts as genuine first-party: not forced off', () => {
    expect(getToolSearchMode()).toBe('tst')
  })

  test('genuine first-party Anthropic: not forced off', () => {
    useProfile(ANTHROPIC_DIRECT)
    expect(getToolSearchMode()).toBe('tst')
  })

  test('genuine first-party still honors ENABLE_TOOL_SEARCH=false', () => {
    useProfile(ANTHROPIC_DIRECT)
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(getToolSearchMode()).toBe('standard')
  })

  test.each([
    ['anthropic proxy', ANTHROPIC_PROXY],
    ['bedrock', BEDROCK],
  ] as const)('%s with ENABLE_TOOL_SEARCH unset → standard', (_, profile) => {
    useProfile(profile)
    expect(getToolSearchMode()).toBe('standard')
  })

  test('openai-compatible (Ollama) is not forced off: the shim defers tools itself', () => {
    useProfile(OLLAMA)
    expect(getToolSearchMode()).toBe('tst')
  })

  test.each([
    ['true', 'tst'],
    ['auto', 'tst-auto'],
    ['auto:0', 'tst'],
    ['auto:40', 'tst-auto'],
    // auto:N is "explicit", so even auto:100 passes the switch — and then
    // lands on standard by its own edge rule.
    ['auto:100', 'standard'],
  ] as const)('non-first-party with explicit ENABLE_TOOL_SEARCH=%s → %s', (value, expected) => {
    useProfile(OLLAMA)
    process.env.ENABLE_TOOL_SEARCH = value
    expect(getToolSearchMode()).toBe(expected)
  })

  test('a falsy kill switch is no kill switch', () => {
    process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = '0'
    useProfile(OLLAMA)
    expect(getToolSearchMode()).toBe('tst')
  })
})

// ── modelSupportsToolReference ──────────────────────────────────────────────

describe('modelSupportsToolReference', () => {
  test.each([
    ['claude-3-haiku-20240307', false],
    ['claude-3-5-haiku-20241022', false],
    ['claude-haiku-4-5-20251001', false],
    ['us.anthropic.CLAUDE-HAIKU-4-5', false],
    ['claude-haiku-5-5', true],
    ['claude-sonnet-4-6', true],
    ['claude-opus-5-5', true],
    // Non-Claude models are assumed to support it (negative test).
    ['qwen3', true],
    ['gpt-5', true],
  ] as const)('%s → %p', (model, expected) => {
    expect(modelSupportsToolReference(model)).toBe(expected)
  })
})

// ── isToolSearchEnabledOptimistic ───────────────────────────────────────────

describe('isToolSearchEnabledOptimistic', () => {
  test('standard mode → false', () => {
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(isToolSearchEnabledOptimistic()).toBe(false)
  })

  test('no profile, default mode → true', () => {
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })

  test('genuine first-party → true', () => {
    useProfile(ANTHROPIC_DIRECT)
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })

  test('firstParty transport on a proxy base URL, ENABLE_TOOL_SEARCH unset → false', () => {
    useProfile(ANTHROPIC_PROXY)
    expect(isToolSearchEnabledOptimistic()).toBe(false)
  })

  test.each(['true', 'auto', 'auto:5'])('proxy base URL with explicit ENABLE_TOOL_SEARCH=%s → true', value => {
    useProfile(ANTHROPIC_PROXY)
    process.env.ENABLE_TOOL_SEARCH = value
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })

  test('openai-compatible without the kill switch → true (the proxy gate is firstParty-only)', () => {
    useProfile(OLLAMA)
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })

  test('bedrock with the kill switch → false (standard)', () => {
    process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = '1'
    useProfile(BEDROCK)
    expect(isToolSearchEnabledOptimistic()).toBe(false)
  })

  test('repeated calls keep answering after the one-shot log', () => {
    useProfile(ANTHROPIC_PROXY)
    expect(isToolSearchEnabledOptimistic()).toBe(false)
    expect(isToolSearchEnabledOptimistic()).toBe(false)
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(isToolSearchEnabledOptimistic()).toBe(false)
    resetProvider()
    delete process.env.ENABLE_TOOL_SEARCH
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })
})

// ── isToolSearchToolAvailable ───────────────────────────────────────────────

describe('isToolSearchToolAvailable', () => {
  test('true when ToolSearch is in the pool', () => {
    expect(isToolSearchToolAvailable([READ, TOOL_SEARCH])).toBe(true)
  })

  test('false when it is missing (e.g. disallowedTools)', () => {
    expect(isToolSearchToolAvailable([READ])).toBe(false)
    expect(isToolSearchToolAvailable([])).toBe(false)
  })

  test('the old name ToolSearchTool does not match', () => {
    expect(isToolSearchToolAvailable([{ name: 'ToolSearchTool' }])).toBe(false)
  })
})

// ── isToolSearchEnabled ─────────────────────────────────────────────────────

describe('isToolSearchEnabled', () => {
  test('a model without tool_reference → false, whatever the mode', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(await isToolSearchEnabled('claude-haiku-4-5-20251001', [TOOL_SEARCH], getCtx, [])).toBe(false)
  })

  test('ToolSearch missing from the pool → false', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(await isToolSearchEnabled(MODEL, [READ], getCtx, [])).toBe(false)
  })

  test('tst → true', async () => {
    expect(await isToolSearchEnabled(MODEL, [READ, TOOL_SEARCH], getCtx, [])).toBe(true)
  })

  test('standard → false', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(await isToolSearchEnabled(MODEL, [READ, TOOL_SEARCH], getCtx, [])).toBe(false)
  })

  test('non-first-party under the kill switch → false (bedrock)', async () => {
    process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = '1'
    useProfile(BEDROCK)
    expect(await isToolSearchEnabled(MODEL, [READ, TOOL_SEARCH], getCtx, [])).toBe(false)
  })

  test('tst-auto with no deferred tools → 0 tokens, below threshold → false', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'auto'
    expect(await isToolSearchEnabled(MODEL, [READ, TOOL_SEARCH], getCtx, [], 'test')).toBe(false)
  })

  test('tst-auto char fallback: deferred descriptions at the threshold → true', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'auto:1'
    const threshold = getAutoToolSearchCharThreshold(MODEL)
    expect(threshold).toBeGreaterThan(0)
    const tools: Tools = [
      READ,
      TOOL_SEARCH,
      uncountableMcpTool('x'.repeat(threshold), 'json'),
      uncountableMcpTool('y', 'zod'),
      uncountableMcpTool('z', 'none'),
    ]
    expect(await isToolSearchEnabled(MODEL, tools, getCtx, [], 'test')).toBe(true)
  })

  test('tst-auto char fallback: small deferred descriptions → false', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'auto:1'
    const tools: Tools = [READ, TOOL_SEARCH, uncountableMcpTool('tiny', 'json')]
    expect(await isToolSearchEnabled(MODEL, tools, getCtx, [])).toBe(false)
  })

  test('the threshold scales with ENABLE_TOOL_SEARCH=auto:N', () => {
    process.env.ENABLE_TOOL_SEARCH = 'auto:1'
    const one = getAutoToolSearchCharThreshold(MODEL)
    process.env.ENABLE_TOOL_SEARCH = 'auto:20'
    const twenty = getAutoToolSearchCharThreshold(MODEL)
    process.env.ENABLE_TOOL_SEARCH = 'auto'
    const dflt = getAutoToolSearchCharThreshold(MODEL)
    delete process.env.ENABLE_TOOL_SEARCH
    const unset = getAutoToolSearchCharThreshold(MODEL)
    process.env.ENABLE_TOOL_SEARCH = 'auto:abc'
    const invalid = getAutoToolSearchCharThreshold(MODEL)
    process.env.ENABLE_TOOL_SEARCH = 'true'
    const notAuto = getAutoToolSearchCharThreshold(MODEL)
    expect(twenty).toBeGreaterThan(one)
    // Default is 10%; every non-auto:N form falls back to it.
    expect(dflt).toBe(unset)
    expect(invalid).toBe(dflt)
    expect(notAuto).toBe(dflt)
    expect(Math.abs(dflt - one * 10)).toBeLessThanOrEqual(10)
  })
})

// ── isToolReferenceBlock ────────────────────────────────────────────────────

describe('isToolReferenceBlock', () => {
  test.each([
    [{ type: 'tool_reference', tool_name: 'X' }, true],
    [{ type: 'tool_reference' }, true],
    [{ type: 'text', text: 'x' }, false],
    [{ tool_name: 'X' }, false],
    [null, false],
    ['tool_reference', false],
    [undefined, false],
  ] as const)('%p → %p', (obj, expected) => {
    expect(isToolReferenceBlock(obj)).toBe(expected)
  })
})

// ── extractDiscoveredToolNames ──────────────────────────────────────────────

describe('extractDiscoveredToolNames', () => {
  test('reads tool_reference blocks inside user tool_result content', () => {
    const messages = [
      userWithToolResult([
        { type: 'tool_reference', tool_name: 'mcp__a__one' },
        { type: 'tool_reference', tool_name: 'WebFetch' },
        { type: 'text', text: 'Tool loaded.' },
      ]),
      userWithToolResult([{ type: 'tool_reference', tool_name: 'mcp__a__one' }]),
    ]
    expect([...extractDiscoveredToolNames(messages)].sort()).toEqual(['WebFetch', 'mcp__a__one'])
  })

  test('ignores references outside a user tool_result, unnamed ones and string content', () => {
    const messages = [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_result', content: [{ type: 'tool_reference', tool_name: 'A' }] }] },
      },
      { type: 'user', message: { content: 'plain text' } },
      { type: 'user', message: { content: [{ type: 'tool_reference', tool_name: 'B' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'string body' }] } },
      userWithToolResult([{ type: 'tool_reference' }, { type: 'tool_reference', tool_name: 7 }]),
    ] as unknown as Message[]
    expect(extractDiscoveredToolNames(messages).size).toBe(0)
  })

  test('carries compactMetadata.preCompactDiscoveredTools from the boundary', () => {
    const messages = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { preCompactDiscoveredTools: ['mcp__a__one', 'mcp__a__two'] },
      },
      { type: 'system', subtype: 'compact_boundary', compactMetadata: {} },
      { type: 'system', subtype: 'informational' },
      userWithToolResult([{ type: 'tool_reference', tool_name: 'mcp__b__three' }]),
    ] as unknown as Message[]
    expect([...extractDiscoveredToolNames(messages)].sort()).toEqual([
      'mcp__a__one',
      'mcp__a__two',
      'mcp__b__three',
    ])
  })

  test('empty history → empty set', () => {
    expect(extractDiscoveredToolNames([]).size).toBe(0)
  })
})

// ── isUnloadedDeferredTool ──────────────────────────────────────────────────

describe('isUnloadedDeferredTool', () => {
  const mcp = tool({ name: 'mcp__srv__x', isMcp: true })

  test('a deferred tool not yet referenced → true', () => {
    expect(isUnloadedDeferredTool(mcp, [READ, TOOL_SEARCH], [])).toBe(true)
  })

  test('once referenced → false', () => {
    const messages = [userWithToolResult([{ type: 'tool_reference', tool_name: 'mcp__srv__x' }])]
    expect(isUnloadedDeferredTool(mcp, [READ, TOOL_SEARCH], messages)).toBe(false)
  })

  test('a tool that is not deferred → false', () => {
    expect(isUnloadedDeferredTool(READ, [READ, TOOL_SEARCH], [])).toBe(false)
  })

  test('no ToolSearch in the pool → false', () => {
    expect(isUnloadedDeferredTool(mcp, [READ], [])).toBe(false)
  })

  test('tool search off → false', () => {
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(isUnloadedDeferredTool(mcp, [READ, TOOL_SEARCH], [])).toBe(false)
  })
})

// ── deferred-tools delta and the legacy latch ───────────────────────────────

function deltaAttachment(addedNames: string[], removedNames: string[] = []): Message {
  return {
    type: 'attachment',
    attachment: { type: 'deferred_tools_delta', addedNames, addedLines: addedNames, removedNames },
  } as unknown as Message
}

describe('getDeferredToolsDelta', () => {
  const a = tool({ name: 'mcp__s__a', isMcp: true })
  const b = tool({ name: 'mcp__s__b', isMcp: true })

  test('announces every deferred tool on an empty history, sorted', () => {
    expect(getDeferredToolsDelta([b, READ, a], [])).toEqual({
      addedNames: ['mcp__s__a', 'mcp__s__b'],
      addedLines: ['mcp__s__a', 'mcp__s__b'],
      removedNames: [],
    })
  })

  test('nothing new → null', () => {
    expect(getDeferredToolsDelta([a, b], [deltaAttachment(['mcp__s__a', 'mcp__s__b'])])).toBeNull()
  })

  test('an announced tool gone from the pool is removed; one now loaded directly is silent', () => {
    const history = [
      { type: 'attachment', attachment: { type: 'other' } } as unknown as Message,
      { type: 'user', message: { content: 'hi' } } as unknown as Message,
      deltaAttachment(['mcp__s__a', 'mcp__s__gone', 'Read', 'mcp__s__dropped']),
      deltaAttachment([], ['mcp__s__dropped']),
    ]
    expect(getDeferredToolsDelta([a, READ], history)).toEqual({
      addedNames: [],
      addedLines: [],
      removedNames: ['mcp__s__gone'],
    })
  })
})

describe('maybeLatchLegacyDeferredAnnouncement / isDeferredToolsDeltaActive', () => {
  const EPOCH = Date.parse('2026-10-31T12:00:00Z')
  const assistantAt = (iso: string | undefined): Message =>
    ({ type: 'assistant', timestamp: iso, message: { content: [] } }) as unknown as Message

  test('delta is active by default and inactive when the flag is off', () => {
    expect(isDeferredToolsDeltaActive()).toBe(true)
    process.env.CLAUDIN_DEFERRED_TOOLS_DELTA = '0'
    expect(isDeferredToolsDeltaActive()).toBe(false)
  })

  test('a warm pre-epoch assistant with no delta attachments latches legacy', () => {
    maybeLatchLegacyDeferredAnnouncement([assistantAt('2026-10-31T11:30:00Z')], { epochMs: EPOCH })
    expect(getDeferredDeltaLegacySession()).toBe(true)
    expect(isDeferredToolsDeltaActive()).toBe(false)
  })

  test('a history that already carries a delta attachment stays on delta', () => {
    maybeLatchLegacyDeferredAnnouncement([deltaAttachment(['x']), assistantAt('2026-10-31T11:30:00Z')], {
      epochMs: EPOCH,
    })
    expect(getDeferredDeltaLegacySession()).toBe(false)
  })

  test('a cold (over 1h) resume point does not latch', () => {
    maybeLatchLegacyDeferredAnnouncement([assistantAt('2026-10-31T10:00:00Z')], { epochMs: EPOCH })
    expect(getDeferredDeltaLegacySession()).toBe(false)
  })

  test('live (post-epoch) and undated assistants are skipped to reach the resume point', () => {
    maybeLatchLegacyDeferredAnnouncement(
      [
        assistantAt('2026-10-31T11:50:00Z'),
        { type: 'user', message: { content: 'x' } } as unknown as Message,
        assistantAt(undefined),
        assistantAt('2026-10-31T12:05:00Z'),
      ],
      { epochMs: EPOCH },
    )
    expect(getDeferredDeltaLegacySession()).toBe(true)
  })

  test('a subagent history, an already-set latch or the flag off never latch', () => {
    const warm = [assistantAt('2026-10-31T11:30:00Z')]
    maybeLatchLegacyDeferredAnnouncement(warm, { epochMs: EPOCH, subagent: true })
    expect(getDeferredDeltaLegacySession()).toBe(false)

    process.env.CLAUDIN_DEFERRED_TOOLS_DELTA = '0'
    maybeLatchLegacyDeferredAnnouncement(warm, { epochMs: EPOCH })
    expect(getDeferredDeltaLegacySession()).toBe(false)
    delete process.env.CLAUDIN_DEFERRED_TOOLS_DELTA

    setDeferredDeltaLegacySession(true)
    maybeLatchLegacyDeferredAnnouncement([], { epochMs: EPOCH })
    expect(getDeferredDeltaLegacySession()).toBe(true)
  })

  test('defaults to the session epoch when none is given', () => {
    // An assistant from the far future is never before the epoch.
    maybeLatchLegacyDeferredAnnouncement([assistantAt('2999-01-01T00:00:00Z')])
    expect(getDeferredDeltaLegacySession()).toBe(false)
  })
})

describe('isDeferredToolsDiscoveredOnly', () => {
  test('off by default, on with CLAUDIN_DEFERRED_TOOLS_DISCOVERED_ONLY=1', () => {
    expect(isDeferredToolsDiscoveredOnly()).toBe(false)
    process.env.CLAUDIN_DEFERRED_TOOLS_DISCOVERED_ONLY = '1'
    expect(isDeferredToolsDiscoveredOnly()).toBe(true)
  })
})

// ── client-side tool search on the openai shim ──────────────────────────────

const OPENROUTER: ProviderProfile = {
  id: 'ts-openrouter',
  name: 'OpenRouter',
  provider: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'anthropic/claude-3-5-haiku',
}
const GEMINI: ProviderProfile = {
  id: 'ts-gemini',
  name: 'Gemini',
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-3-pro',
}
const CODEX: ProviderProfile = {
  id: 'ts-codex',
  name: 'Codex',
  provider: 'openai',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'gpt-5.5',
}

describe('client-side tool search: the openai shim defers tools itself', () => {
  beforeEach(() => {
    process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = '1'
  })

  afterEach(() => {
    delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
  })

  test('an openai-compatible profile keeps tool search under the kill switch', () => {
    useProfile(OLLAMA)
    expect(getToolSearchMode()).toBe('tst')
    expect(isToolSearchEnabledOptimistic()).toBe(true)
  })

  test('a hosted openai-compatible profile gets it too', async () => {
    useProfile(OPENROUTER)
    expect(await isToolSearchEnabled('qwen/qwen3-coder', [READ, TOOL_SEARCH], getCtx, [])).toBe(true)
  })

  test('a model listed as lacking tool_reference keeps every tool inline, as the delta attachment does', async () => {
    useProfile(OPENROUTER)
    expect(await isToolSearchEnabled('anthropic/claude-3-5-haiku', [READ, TOOL_SEARCH], getCtx, [])).toBe(false)
  })

  test('CLAUDIN_SHIM_TOOL_SEARCH=0 puts the old behavior back', async () => {
    process.env.CLAUDIN_SHIM_TOOL_SEARCH = '0'
    useProfile(OLLAMA)
    expect(getToolSearchMode()).toBe('standard')
    expect(await isToolSearchEnabled('qwen3', [READ, TOOL_SEARCH], getCtx, [])).toBe(false)
  })

  test.each([
    ['gemini', GEMINI],
    ['codex', CODEX],
    ['bedrock', BEDROCK],
    ['anthropic proxy', ANTHROPIC_PROXY],
  ] as const)('%s is not the openai chat-completions path: unchanged', (_, profile) => {
    useProfile(profile)
    expect(getToolSearchMode()).toBe('standard')
  })
})
