/**
 * End-to-end pipeline tests: map → summarize → persist.
 *
 * Verifies the summarizer plugs into processToolResultBlock correctly:
 *   - Below 50K after summarize → no disk write (result starts with our tag).
 *   - Unknown tools still flow through to persist when oversized.
 *   - Flag off (via env) → neither summarize nor persist kicks in.
 *
 * Mock strategy: narrow local mocks of `./config.js` (only `getGlobalConfig`,
 * driven by `harnessState`) plus analytics stubs. Bun's `mock.module` is
 * process-global, so OTHER tests running before this file can replace
 * `./config.js` with their own stubs that lack `toolResultSummarizerEnabled`.
 * Re-mocking it here guarantees the summarizer always sees the flag we set.
 *
 * `../bootstrap/state.js`, `./sessionStorage.js`, and analytics/growthbook
 * are left REAL so that `setOriginalCwd` in beforeAll reaches the same
 * state instance that the storage module reads from — otherwise persisted
 * files land in the real project dir instead of tempRoot.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  test,
} from 'bun:test'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const realAnalyticsMetadata = { ...(await import('../services/analytics/metadata.js')) }
const realAnalyticsIndex = { ...(await import('../services/analytics/index.js')) }

mock.module('../services/analytics/metadata.js', () => ({
  sanitizeToolNameForAnalytics: (n: string) => n,
  // Stubs for transitive importers (firstPartyEventLoggingExporter etc.)
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

mock.module('../services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: () => Promise.resolve(),
  stripProtoFields: <T,>(m: T) => m,
  attachAnalyticsSink: () => {},
}))

const { processToolResultBlock, processPreMappedToolResultBlock } =
  await import('./toolResultStorage.js')
const summarizer = await import('./toolResultSummarizer.js')
const { setOriginalCwd, getOriginalCwd, getSessionId } = await import('../bootstrap/state.js')
const { getProjectDir } = await import('./sessionStorage.js')
const { saveGlobalConfig } = await import('./config.js')

let tempRoot = ''
const createdProjectDirs = new Set<string>()
const originalEnv = process.env.CLAUDIO_DISABLE_TOOL_RESULT_SUMMARIZER
const originalCwd = getOriginalCwd()

afterAll(async () => {
  // Restore the original CWD so subsequent test files see a clean state.
  setOriginalCwd(originalCwd)
  // Restore mocked modules.
  mock.module('../services/analytics/metadata.js', () => realAnalyticsMetadata)
  mock.module('src/services/analytics/metadata.js', () => realAnalyticsMetadata)
  mock.module('../services/analytics/index.js', () => realAnalyticsIndex)
  mock.module('src/services/analytics/index.js', () => realAnalyticsIndex)
  // Clean up every project dir we touched (one per test).
  for (const dir of createdProjectDirs) {
    await rm(dir, { recursive: true, force: true })
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  // Unique tempRoot per test — memoization of getProjectDir maps to a
  // distinct project dir per input, so isolation is per-test rather than
  // per-file. Other test files in the full suite may mutate state/session
  // between our tests, but our files always land in a fresh dir.
  tempRoot = await mkdtemp(join(tmpdir(), 'claudio-summarizer-int-'))
  setOriginalCwd(tempRoot)
  createdProjectDirs.add(getProjectDir(tempRoot))
  try {
    saveGlobalConfig(c => ({ ...c, toolResultSummarizerEnabled: true }))
  } catch {
    // config module may be mocked by a sibling test file without
    // saveGlobalConfig; env-var path + default still cover the flag.
  }
  delete process.env.CLAUDIO_DISABLE_TOOL_RESULT_SUMMARIZER
})

afterEach(() => {
  try {
    saveGlobalConfig(c => ({ ...c, toolResultSummarizerEnabled: true }))
  } catch {
    // See beforeEach: saveGlobalConfig may be absent under sibling-file mocks.
  }
  if (originalEnv === undefined) {
    delete process.env.CLAUDIO_DISABLE_TOOL_RESULT_SUMMARIZER
  } else {
    process.env.CLAUDIO_DISABLE_TOOL_RESULT_SUMMARIZER = originalEnv
  }
})

async function persistedFileCount(): Promise<number> {
  try {
    const dir = join(
      getProjectDir(tempRoot),
      getSessionId(),
      'tool-results',
    )
    const entries = await readdir(dir)
    return entries.length
  } catch {
    return 0
  }
}


type FakeTool<T> = {
  name: string
  maxResultSizeChars: number
  mapToolResultToToolResultBlockParam: (
    result: T,
    toolUseID: string,
  ) => ToolResultBlockParam
}

const bashTool: FakeTool<string> = {
  name: 'Bash',
  maxResultSizeChars: 50_000,
  mapToolResultToToolResultBlockParam: (text, id) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: text,
  }),
}

const grepTool: FakeTool<string> = {
  name: 'Grep',
  maxResultSizeChars: 50_000,
  mapToolResultToToolResultBlockParam: (text, id) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: text,
  }),
}

const readTool: FakeTool<string> = {
  name: 'Read',
  maxResultSizeChars: 50_000,
  mapToolResultToToolResultBlockParam: (text, id) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: text,
  }),
}

const globTool: FakeTool<string> = {
  name: 'Glob',
  maxResultSizeChars: 50_000,
  mapToolResultToToolResultBlockParam: (text, id) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: text,
  }),
}

test('integration: oversized Bash is summarized, no disk write when <50K after', async () => {

  const words = ['apple', 'banana', 'cherry', 'donut', 'eggplant']
  const content = Array.from(
    { length: 1000 },
    (_, i) => `${words[i % words.length]} row ${i} payload ${'x'.repeat(25)}`,
  ).join('\n')
  expect(content.length).toBeGreaterThan(30_000)
  expect(content.length).toBeLessThan(50_000)

  const out = await processToolResultBlock(
    bashTool,
    content,
    'toolu_bash_1',
  )
  const outContent = out.content
  expect(typeof outContent).toBe('string')
  expect(
    (outContent as string).startsWith(summarizer.TOOL_RESULT_SUMMARY_TAG),
  ).toBe(true)
  expect(await persistedFileCount()).toBe(0)
})

test('integration: below summarizer threshold, no summarize, no persist', async () => {

  const content = 'hello\n'.repeat(100)
  const out = await processToolResultBlock(
    bashTool,
    content,
    'toolu_bash_small',
  )
  expect(out.content).toBe(content)
  expect(await persistedFileCount()).toBe(0)
})

test('integration: Grep path summarizes and skips persist', async () => {

  const pad = ' xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const lines = Array.from(
    { length: 400 },
    (_, i) => `src/f${i % 6}.ts:${i + 1}:match ${i}${pad}`,
  ).join('\n')
  expect(lines.length).toBeGreaterThan(6_000)
  const out = await processToolResultBlock(
    grepTool,
    lines,
    'toolu_grep_1',
  )
  expect(
    (out.content as string).startsWith(summarizer.TOOL_RESULT_SUMMARY_TAG),
  ).toBe(true)
  expect(await persistedFileCount()).toBe(0)
})

test('integration: oversized Read is summarized, no disk write when <50K after', async () => {

  // 500 lines in N→content format: >10k chars (above summarizer threshold), <50k (no persist)
  const content = Array.from(
    { length: 500 },
    (_, i) => `${i + 1}→file content line with enough padding to exceed threshold ${i}`,
  ).join('\n')
  expect(content.length).toBeGreaterThan(10_000)
  expect(content.length).toBeLessThan(50_000)

  const out = await processToolResultBlock(
    readTool,
    content,
    'toolu_read_1',
  )
  expect((out.content as string).startsWith(summarizer.TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(await persistedFileCount()).toBe(0)
})

test('integration: oversized Glob is summarized, no disk write when <50K after', async () => {

  // 120 paths ~50 chars each: >3k chars (above summarizer threshold), well under 50k
  const content = Array.from(
    { length: 120 },
    (_, i) => `src/components/deeply/nested/module${i}/index.ts`,
  ).join('\n')
  expect(content.length).toBeGreaterThan(3_000)
  expect(content.length).toBeLessThan(50_000)

  const out = await processToolResultBlock(
    globTool,
    content,
    'toolu_glob_1',
  )
  expect((out.content as string).startsWith(summarizer.TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(await persistedFileCount()).toBe(0)
})

test('integration: env-var kill switch restores pre-summarizer behavior', async () => {
  process.env.CLAUDIO_DISABLE_TOOL_RESULT_SUMMARIZER = '1'
  const words = ['alpha', 'beta', 'gamma', 'delta']
  const content = Array.from(
    { length: 800 },
    (_, i) => `${words[i % words.length]} row ${i} payload ${'x'.repeat(25)}`,
  ).join('\n')
  expect(content.length).toBeLessThan(50_000)
  const out = await processToolResultBlock(
    bashTool,
    content,
    'toolu_bash_disabled',
  )
  expect(out.content).toBe(content)
  expect(await persistedFileCount()).toBe(0)
})

test('integration: processPreMappedToolResultBlock also summarizes', async () => {

  const words = ['one', 'two', 'three', 'four']
  const content = Array.from(
    { length: 1000 },
    (_, i) => `${words[i % words.length]} row ${i} payload ${'x'.repeat(25)}`,
  ).join('\n')
  const block: ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: 'toolu_pre',
    content,
  }
  const out = await processPreMappedToolResultBlock(block, 'Bash', 50_000)
  expect(
    (out.content as string).startsWith(summarizer.TOOL_RESULT_SUMMARY_TAG),
  ).toBe(true)
  expect(await persistedFileCount()).toBe(0)
})

type ArrayBlocks = Array<{ type: string; text?: string }>

const agentTool: FakeTool<ArrayBlocks> = {
  name: 'Agent',
  maxResultSizeChars: 50_000,
  mapToolResultToToolResultBlockParam: (blocks, id) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: blocks as ToolResultBlockParam['content'],
  }),
}

const mcpTool: FakeTool<ArrayBlocks> = {
  name: 'mcp__files__read',
  maxResultSizeChars: 50_000,
  mapToolResultToToolResultBlockParam: (blocks, id) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: blocks as ToolResultBlockParam['content'],
  }),
}

test('integration: AgentTool array 30k chars → summarized, no disk write', async () => {
  const text = Array.from(
    { length: 600 },
    (_, i) => `agent output line ${i} ${'x'.repeat(40)}`,
  ).join('\n')
  expect(text.length).toBeGreaterThan(30_000)
  expect(text.length).toBeLessThan(50_000)

  const out = await processToolResultBlock(
    agentTool,
    [{ type: 'text', text }],
    'toolu_agent_1',
  )
  expect(typeof out.content).toBe('string')
  expect(
    (out.content as string).startsWith(summarizer.TOOL_RESULT_SUMMARY_TAG),
  ).toBe(true)
  expect(await persistedFileCount()).toBe(0)
})

test('integration: MCPTool array 20k chars → summarized, no disk write', async () => {
  const text = Array.from(
    { length: 400 },
    (_, i) => `mcp result line ${i} ${'y'.repeat(40)}`,
  ).join('\n')
  expect(text.length).toBeGreaterThan(20_000)
  expect(text.length).toBeLessThan(50_000)

  const out = await processToolResultBlock(
    mcpTool,
    [{ type: 'text', text }],
    'toolu_mcp_1',
  )
  expect(typeof out.content).toBe('string')
  expect(
    (out.content as string).startsWith(summarizer.TOOL_RESULT_SUMMARY_TAG),
  ).toBe(true)
  expect(await persistedFileCount()).toBe(0)
})

test('integration: env-var kill switch → AgentTool array passes through unchanged', async () => {
  process.env.CLAUDIO_DISABLE_TOOL_RESULT_SUMMARIZER = '1'
  const text = Array.from(
    { length: 600 },
    (_, i) => `agent output line ${i} ${'z'.repeat(40)}`,
  ).join('\n')
  const blocks: ArrayBlocks = [{ type: 'text', text }]
  const out = await processToolResultBlock(
    agentTool,
    blocks,
    'toolu_agent_disabled',
  )
  // Content must still be an array (not summarized to string)
  expect(Array.isArray(out.content)).toBe(true)
  expect(await persistedFileCount()).toBe(0)
})
