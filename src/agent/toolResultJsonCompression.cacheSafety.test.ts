/**
 * Cache-safety invariants for TOOL_RESULT_JSON_COMPRESSION.
 *
 * The prompt cache stays intact only if the compressed marker is produced ONCE
 * at result creation and is byte-stable thereafter. These tests pin:
 *   1. flag OFF → output byte-identical to today (zero regression when disabled),
 *   2. flag ON  → the same input yields a byte-identical marker (determinism →
 *      the cached prefix can never shift from this feature),
 *   3. the marker (incl. a spliced `source="…"` attribute) still satisfies the
 *      `startsWith(TOOL_RESULT_SUMMARY_TAG)` check that `isContentAlreadyCompacted`
 *      (toolResultStorage.ts) uses, so the budget/stub layer won't re-mutate it.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

const realAnalyticsMetadata = { ...(await import('src/platform/analytics/metadata.js')) }
const realAnalyticsIndex = { ...(await import('src/platform/analytics/index.js')) }
const realConfig = { ...(await import('src/platform/config/config.js')) }

// Guard 2 of maybeSummarizeToolResult reads
// getGlobalConfig().toolResultSummarizerEnabled (default true). The test-config
// singleton is process-global and Bun's mock.module is suite-wide, so an
// earlier file that flips the toggle off (or clobbers NODE_ENV so
// resetGlobalConfigForTests no-ops) would make every strategy here return the
// raw block. Bind the summarizer to a config whose toggle is forced on,
// regardless of ambient singleton/NODE_ENV state. Registered BEFORE the
// summarizer import below so it resolves through this override.
const forceSummarizerOn = () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    ...realConfig.getGlobalConfig(),
    toolResultSummarizerEnabled: true,
  }),
})
mock.module('src/platform/config/config.js', forceSummarizerOn)
mock.module('src/platform/config/config.js', forceSummarizerOn)

mock.module('src/platform/analytics/metadata.js', () => ({
  sanitizeToolNameForAnalytics: (name: string) =>
    name.startsWith('mcp__') ? 'mcp_tool' : name,
  isToolDetailsLoggingEnabled: () => false,
  isAnalyticsToolDetailsLoggingEnabled: () => false,
  mcpToolDetailsForAnalytics: () => ({}),
  extractMcpToolDetails: () => ({}),
  extractSkillName: () => undefined,
  extractToolInputForTelemetry: () => ({}),
  getFileExtensionForAnalytics: () => '',
  getFileExtensionsFromBashCommand: () => [],
  getEventMetadata: async () => ({}),
  to1PEventFormat: () => ({}),
}))
mock.module('src/platform/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: () => Promise.resolve(),
  stripProtoFields: <T,>(m: T) => m,
}))

const { maybeSummarizeToolResult, isSummarizedContent, TOOL_RESULT_SUMMARY_TAG } =
  await import('src/agent/tools/toolResultSummarizer.js')
const { injectEnvelopeAttr } = await import('src/agent/tools/toolResultStorage.js')

afterAll(() => {
  mock.module('src/platform/analytics/metadata.js', () => realAnalyticsMetadata)
  mock.module('src/platform/analytics/index.js', () => realAnalyticsIndex)
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/platform/config/config.js', () => realConfig)
})

beforeEach(() => {
  delete process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION
  delete process.env.CLAUDIN_CODE_OUTLINE
})
afterEach(() => {
  delete process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION
  delete process.env.CLAUDIN_CODE_OUTLINE
})

function bigJsonArray(rows = 200): string {
  return JSON.stringify(
    Array.from({ length: rows }, (_, i) => ({
      number: i + 1,
      title: `row ${i + 1} with some descriptive text padding it out a bit`,
      state: i % 2 === 0 ? 'OPEN' : 'MERGED',
    })),
  )
}

function block(content: string): ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: 'toolu_x', content }
}

test('flag OFF → JSON bash output is byte-identical (returns the same block)', () => {
  const b = block(bigJsonArray())
  expect(maybeSummarizeToolResult(b, 'Bash')).toBe(b)
})

test('flag ON → identical input yields a byte-identical marker (determinism)', () => {
  process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION = '1'
  const content = bigJsonArray()
  const a = maybeSummarizeToolResult(block(content), 'Bash').content as string
  const b = maybeSummarizeToolResult(block(content), 'Bash').content as string
  expect(a).toBe(b)
  expect(a).toContain('strategy="json-structural"')
})

test('marker with a spliced source= attribute still starts with the summary tag', () => {
  process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION = '1'
  const marker = maybeSummarizeToolResult(block(bigJsonArray()), 'Bash')
    .content as string
  // Exercise the REAL storage-layer injector, not a re-implementation, so a
  // regression in injectEnvelopeAttr is caught by this dedicated guard.
  const withSource = injectEnvelopeAttr(
    marker,
    'source',
    '/tmp/tool-results/toolu_x.txt',
  )

  expect(withSource.startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  // Same predicate isContentAlreadyCompacted (toolResultStorage) keys off.
  expect(isSummarizedContent(withSource)).toBe(true)
  // The attribute lands inside the opening tag (before the first '>').
  expect(withSource).toContain('source="/tmp/tool-results/toolu_x.txt"')
})

// --- Same invariants for the code-outline strategy ---

function bigTsSource(n = 200): string {
  const parts = [`import { foo } from '../utils/foo'`, `export const VERSION = 1`]
  for (let i = 0; i < n; i++) {
    parts.push(`export function fn${i}(x: number): number {`, `  return x + ${i}`, `}`)
  }
  return parts.join('\n')
}

test('code-outline flag ON → identical input yields a byte-identical marker', () => {
  process.env.CLAUDIN_CODE_OUTLINE = '1'
  const content = bigTsSource()
  const a = maybeSummarizeToolResult(block(content), 'Bash').content as string
  const b = maybeSummarizeToolResult(block(content), 'Bash').content as string
  expect(a).toBe(b)
  expect(a).toContain('strategy="code-outline"')
})

test('code-outline marker with a spliced source= still starts with the summary tag', () => {
  process.env.CLAUDIN_CODE_OUTLINE = '1'
  const marker = maybeSummarizeToolResult(block(bigTsSource()), 'Bash').content as string
  const withSource = injectEnvelopeAttr(marker, 'source', '/tmp/tool-results/toolu_x.txt')
  expect(withSource.startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(isSummarizedContent(withSource)).toBe(true)
  expect(withSource).toContain('source="/tmp/tool-results/toolu_x.txt"')
})
