import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { resetGlobalConfigForTests } from './config.js'

const realAnalyticsMetadata = { ...(await import('../services/analytics/metadata.js')) }
const realAnalyticsIndex = { ...(await import('../services/analytics/index.js')) }

afterAll(() => {
  mock.module('../services/analytics/metadata.js', () => realAnalyticsMetadata)
  mock.module('../services/analytics/index.js', () => realAnalyticsIndex)
  resetGlobalConfigForTests()
})

// Mock analytics/metadata + index only (narrow surfaces, safe to replace).
// Leave ./config.js as the real module — Bun test runner sets NODE_ENV=test,
// so getGlobalConfig() returns TEST_GLOBAL_CONFIG_FOR_TESTING which starts with
// DEFAULT_GLOBAL_CONFIG.toolResultSummarizerEnabled === true. Tests flip it via
// saveGlobalConfig. This avoids mock.module pollution across test files in the
// same run (config.js has 60+ exports; stubbing them all is fragile).
mock.module('../services/analytics/metadata.js', () => ({
  sanitizeToolNameForAnalytics: (name: string) =>
    name.startsWith('mcp__') ? 'mcp_tool' : name,
  // Stubs for transitive importers (firstPartyEventLoggingExporter etc.)
  // that would otherwise fail to resolve against the mocked module.
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

const loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
mock.module('../services/analytics/index.js', () => ({
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    loggedEvents.push({ name, metadata })
  },
  logEventAsync: () => Promise.resolve(),
  stripProtoFields: <T,>(m: T) => m,
}))

const {
  maybeSummarizeToolResult,
  isSummarizedContent,
  TOOL_RESULT_SUMMARY_TAG,
  TOOL_RESULT_SUMMARY_CLOSING_TAG,
  collapseIdenticalRuns,
  collapseDigitTemplates,
} = await import('./toolResultSummarizer.js')
const { saveGlobalConfig } = await import('./config.js')
const { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } = await import('../tools/AgentTool/constants.js')

const AGENT_SUMMARIZE_THRESHOLD = 8_000
const MCP_SUMMARIZE_THRESHOLD = 8_000

const mockState = {
  get enabled() {
    return true
  },
  set enabled(value: boolean) {
    saveGlobalConfig(c => ({ ...c, toolResultSummarizerEnabled: value }))
  },
}

const originalEnv = process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER

beforeEach(() => {
  mockState.enabled = true
  delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
  loggedEvents.length = 0
})

afterEach(() => {
  mockState.enabled = true
  if (originalEnv === undefined) {
    delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
  } else {
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = originalEnv
  }
  loggedEvents.length = 0
})

function bigText(n: number, filler = 'x'): string {
  return filler.repeat(n)
}

function makeBlock(
  content: ToolResultBlockParam['content'],
  id = 'toolu_t',
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content,
  }
}

function asString(block: ToolResultBlockParam): string {
  const c = block.content
  if (typeof c !== 'string') {
    throw new Error('expected string content')
  }
  return c
}

function makeArrayBlock(
  blocks: Array<{ type: string; text?: string }>,
  id = 'toolu_t',
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: blocks as ToolResultBlockParam['content'],
  }
}

// ============================================================
// Guards
// ============================================================

test('guard: passthrough when env var set truthy', () => {
  process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = '1'
  const block = makeBlock(bigText(20_000, 'abc\n'))
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
  expect(loggedEvents.length).toBe(0)
})

test('guard: passthrough when config flag disabled', () => {
  mockState.enabled = false
  const block = makeBlock(bigText(20_000, 'abc\n'))
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
  expect(loggedEvents.length).toBe(0)
})

test('guard: passthrough when content is null', () => {
  const block = makeBlock(undefined)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('guard: passthrough when content is empty string', () => {
  const block = makeBlock('')
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('guard: passthrough when content is whitespace-only', () => {
  const block = makeBlock('   \n\n  \t')
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('guard: passthrough when content is array (non-string)', () => {
  const block = makeBlock([{ type: 'text', text: 'hello' }])
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('guard: passthrough below per-tool threshold', () => {
  const block = makeBlock('line\n'.repeat(100))
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('guard: passthrough for unknown tool', () => {
  const block = makeBlock(bigText(50_000, 'abc\n'))
  const out = maybeSummarizeToolResult(block, 'UnknownTool')
  expect(out).toBe(block)
})

test('guard: passthrough when already summarized (idempotency)', () => {
  const summarized = `${TOOL_RESULT_SUMMARY_TAG} tool="Bash" original="10KB" kept="1KB" strategy="head-tail-errors">\nfoo\n${TOOL_RESULT_SUMMARY_CLOSING_TAG}`
  const block = makeBlock(summarized)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('guard: passthrough when already persisted', () => {
  const persisted = '<persisted-output>\nPath: /tmp/foo.txt\n</persisted-output>'
  const block = makeBlock(persisted)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

// ============================================================
// Bash strategy
// ============================================================

test('bash: JSON object passthrough', () => {
  const json = `{"items":[${Array.from({ length: 1000 }, (_, i) => `"item-${i}-xyz"`).join(',')}]}`
  expect(json.length).toBeGreaterThan(8_000)
  const block = makeBlock(json)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('bash: JSON array passthrough', () => {
  const json = `[${Array.from({ length: 2000 }, (_, i) => `"x-${i}"`).join(',')}]`
  expect(json.length).toBeGreaterThan(8_000)
  const block = makeBlock(json)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('bash: error window preserves Python Traceback', () => {
  const pad = ' filler content that pads the line meaningfully'
  const filler = Array.from({ length: 300 }, (_, i) => `normal line ${i}${pad}`).join('\n')
  const traceback = [
    'Traceback (most recent call last):',
    '  File "app.py", line 42, in <module>',
    '    main()',
    '  File "app.py", line 17, in main',
    '    raise ValueError("boom")',
    'ValueError: boom',
  ].join('\n')
  const tail = Array.from({ length: 100 }, (_, i) => `later line ${i}${pad}`).join('\n')
  const content = `${filler}\n${traceback}\n${tail}`
  expect(content.length).toBeGreaterThan(8_000)

  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body.startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(body).toContain('Traceback (most recent call last):')
  expect(body).toContain('ValueError: boom')

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt).toBeDefined()
  expect(evt?.metadata.errorWindowPreserved).toBe(true)
  expect(evt?.metadata.strategyId).toBe(1)
})

test('bash: Node Error preserved', () => {
  const pad = ' padding words for length'
  const head = Array.from({ length: 200 }, (_, i) => `info ${i}${pad}`).join('\n')
  const mid = Array.from({ length: 200 }, (_, i) => `chatter ${i}${pad}`).join('\n')
  const err = [
    'Error: something went wrong',
    '    at Object.<anonymous> (/path/to/file.js:12:15)',
    '    at Module._compile (node:internal/modules/cjs/loader:1254:14)',
  ].join('\n')
  const tail = Array.from({ length: 100 }, (_, i) => `later ${i}${pad}`).join('\n')
  const content = `${head}\n${mid}\n${err}\n${tail}`
  expect(content.length).toBeGreaterThan(8_000)

  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toContain('Error: something went wrong')
})

test('bash: Exit code preserved', () => {
  const pad = ' padding words for length'
  const head = Array.from({ length: 100 }, (_, i) => `hello ${i}${pad}`).join('\n')
  const mid = Array.from({ length: 300 }, (_, i) => `chatter ${i}${pad}`).join('\n')
  const tail = Array.from({ length: 100 }, (_, i) => `later ${i}${pad}`).join('\n')
  const content = `${head}\n${mid}\nExit code: 42\n${tail}`
  expect(content.length).toBeGreaterThan(8_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toContain('Exit code: 42')
})

test('bash: progress bar CR dedupe (\\r-last-segment)', () => {
  const prog = Array.from({ length: 200 }, (_, i) => `progress\rstep ${i}: ok`).join('\n')
  const filler = Array.from({ length: 500 }, () => 'filler line').join('\n')
  const content = `${prog}\n${filler}`
  expect(content.length).toBeGreaterThan(8_000)

  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  // CR collapse happened: no "progress\rstep" substring.
  expect(body).not.toContain('progress\rstep')
  // At least one collapsed progress marker survives via head capture.
  expect(body).toMatch(/step \d+: ok/)
})

test('bash: identical run dedupe (×N marker)', () => {
  const dup = Array.from({ length: 300 }, () => 'same line with some repeating text content here').join('\n')
  const tail = Array.from({ length: 100 }, (_, i) => `final entry number ${i} with padding content`).join('\n')
  const content = `start\n${dup}\n${tail}`
  expect(content.length).toBeGreaterThan(8_000)

  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toContain('same line with some repeating text content here (×')
})

test('bash: digit-template dedupe (N updates)', () => {
  const mid = Array.from({ length: 200 }, (_, i) => `processing file ${i} of many items`).join('\n')
  const head = Array.from({ length: 5 }, (_, i) => `head ${i} of stuff`).join('\n')
  const tail = Array.from({ length: 100 }, (_, i) => `tail entry ${i} padding content`).join('\n')
  const content = `${head}\n${mid}\n${tail}`
  expect(content.length).toBeGreaterThan(8_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toMatch(/processing file \d+ of many items \(\d+ updates\)/)
})

test('bash: cargo error[E0308] in middle preserved (case-insensitive `error:` + bracketed code)', () => {
  // Simulate ~150 lines of cargo "Compiling …" progress, an error block in
  // the middle, then more progress. Vary the line shape so digit-template
  // dedupe does NOT collapse it (we want the error to land outside head/tail).
  const crates = ['serde', 'tokio', 'anyhow', 'reqwest', 'clap', 'tracing']
  const pad = ' '.repeat(40)
  const head = Array.from(
    { length: 120 },
    (_, i) =>
      `   Compiling ${crates[i % crates.length]}-${i} v${i}.${i + 1}.${i + 2}${pad}feature=${i}`,
  )
  const errorBlock = [
    'error[E0308]: mismatched types',
    '   --> src/main.rs:42:9',
    '    |',
    '42  |     let x: u32 = "hello";',
    '    |            ---   ^^^^^^^ expected `u32`, found `&str`',
    '    |            |',
    '    |            expected due to this',
  ]
  const tail = Array.from(
    { length: 120 },
    (_, i) =>
      `   Compiling ${crates[i % crates.length]}-tail-${i} v${i}.${i + 1}${pad}feature=${i}`,
  )
  const content = [...head, ...errorBlock, ...tail].join('\n')
  expect(content.length).toBeGreaterThan(8_000)

  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toContain('error[E0308]: mismatched types')

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.errorWindowPreserved).toBe(true)
})

test('bash: Rust runtime panic preserved (`panicked at`)', () => {
  const pad = ' filler ' + 'x'.repeat(40)
  const head = Array.from({ length: 80 }, (_, i) => `info line ${i}${pad}`)
  const panicLine = `thread 'main' panicked at 'assertion failed: x == y', src/lib.rs:17:5`
  const tail = Array.from({ length: 80 }, (_, i) => `later ${i}${pad}`)
  const content = [...head, panicLine, ...tail].join('\n')
  expect(content.length).toBeGreaterThan(8_000)

  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toContain("panicked at 'assertion failed: x == y'")

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.errorWindowPreserved).toBe(true)
})

test('bash: Java FATAL level marker preserved (no colon, mixed levels)', () => {
  // Simulate log4j-style output: INFO/WARN noise around a single FATAL line.
  const levels = ['INFO', 'WARN', 'INFO', 'INFO', 'WARN']
  const head = Array.from(
    { length: 100 },
    (_, i) => `2026-04-24 12:34:${String(i).padStart(2, '0')} ${levels[i % levels.length]} com.foo.Bar - normal noise ${i}`,
  )
  const fatalLine =
    '2026-04-24 12:35:00 FATAL com.foo.Bar - JVM heap exhausted, terminating'
  const tail = Array.from(
    { length: 100 },
    (_, i) => `2026-04-24 12:36:${String(i).padStart(2, '0')} INFO com.foo.Baz - shutting down ${i}`,
  )
  const content = [...head, fatalLine, ...tail].join('\n')
  expect(content.length).toBeGreaterThan(8_000)

  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toContain('FATAL com.foo.Bar - JVM heap exhausted')

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.errorWindowPreserved).toBe(true)
})

test('bash: nginx-style ERROR (uppercase) preserved among 200-response noise', () => {
  // 500 access-log-ish lines + one ERROR upstream line buried in the middle.
  const head = Array.from(
    { length: 250 },
    (_, i) =>
      `127.0.0.1 - - [24/Apr/2026:12:00:${String(i % 60).padStart(2, '0')}] "GET /api/${i} HTTP/1.1" 200 ${1024 + i}`,
  )
  const errLine = `2026/04/24 12:00:30 [error] 1234#1234: ERROR: upstream timed out (connecting to backend)`
  const tail = Array.from(
    { length: 250 },
    (_, i) =>
      `127.0.0.1 - - [24/Apr/2026:12:01:${String(i % 60).padStart(2, '0')}] "GET /api/late/${i} HTTP/1.1" 200 ${2048 + i}`,
  )
  const content = [...head, errLine, ...tail].join('\n')
  expect(content.length).toBeGreaterThan(8_000)

  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toContain('ERROR: upstream timed out')

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.errorWindowPreserved).toBe(true)
})

test('bash: negative — `error`/`errors` without colon does NOT trigger window (FP guard)', () => {
  // 300 distinct lines all containing `error`/`errors` but never `error:`.
  // Vary shape so digit-template dedupe doesn't collapse them and they
  // genuinely fall outside head (40) + tail (60).
  const phrases = [
    'no errors found in the build',
    'errors reported: 0',
    'previous errors have been resolved',
    'audit: errors detected last week',
    'the errors module exports helpers',
  ]
  const lines = Array.from(
    { length: 300 },
    (_, i) => `${phrases[i % phrases.length]} (entry ${i} ${'x'.repeat(20)})`,
  )
  const content = lines.join('\n')
  expect(content.length).toBeGreaterThan(8_000)

  maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt).toBeDefined()
  // Critical: NO error window should fire on these innocuous strings.
  expect(evt?.metadata.errorWindowPreserved).toBe(false)
})

test('bash: head+tail without error emits omitted marker', () => {
  // Vary shape per line so digit-template dedupe does NOT collapse the input —
  // we want to exercise head+tail omission of mid-stream lines.
  const words = ['apple', 'banana', 'cherry', 'donut', 'eggplant', 'fig', 'grape']
  const lines = Array.from(
    { length: 500 },
    (_, i) => `${words[i % words.length]} row ${i} payload ${'x'.repeat(30)}`,
  ).join('\n')
  expect(lines.length).toBeGreaterThan(8_000)
  const out = maybeSummarizeToolResult(makeBlock(lines), 'Bash')
  const body = asString(out)
  // New metadata-shaped marker (was: "[…bash output omitted: N lines, X…]").
  // Anti-regression: the old prose marker must not reappear.
  expect(body).toMatch(/<omitted lines="\d+" bytes="[^"]+"\/>/)
  expect(body).not.toContain('bash output omitted')
  // Head captured (first line).
  expect(body).toContain('apple row 0 payload')
  // Tail captured (last line — 499 % 7 = 2 → cherry).
  expect(body).toContain('cherry row 499 payload')
  // Middle is NOT in head/tail and no error — should be omitted.
  expect(body).not.toContain('row 250 payload')

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.errorWindowPreserved).toBe(false)
})

// ============================================================
// Grep strategy
// ============================================================

test('grep: count-mode passthrough', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `path/to/file${i}.ts:${i + 1}`)
  const content = lines.join('\n')
  expect(content.length).toBeGreaterThan(6_000)
  const block = makeBlock(content)
  const out = maybeSummarizeToolResult(block, 'Grep')
  expect(out).toBe(block)
})

test('grep: grouped by file with per-file cap', () => {
  const pad = ' xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const aLines = Array.from({ length: 40 }, (_, i) => `src/a.ts:${i + 1}:match line ${i}${pad}`)
  const bLines = Array.from({ length: 20 }, (_, i) => `src/b.ts:${i + 1}:match line ${i}${pad}`)
  const cLines = Array.from({ length: 5 }, (_, i) => `src/c.ts:${i + 1}:match line ${i}${pad}`)
  const content = [...aLines, ...bLines, ...cLines].join('\n')
  expect(content.length).toBeGreaterThan(6_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Grep')
  const body = asString(out)
  expect(body.startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(body).toContain('Grep summary:')
  expect(body).toContain('files=3')
  expect(body).toContain('src/a.ts (40 matches)')
  expect(body).toContain('src/b.ts (20 matches)')
  // Per-file cap of 10 → +30 more matches for a.ts. The counter sits inside
  // the file's block, so it names no path — same reason the lines don't.
  expect(body).toContain('+30 more')
  expect(body).toContain('+10 more')
  // c.ts has 5 so no "+X more" line.
  expect(body).toContain('src/c.ts (5 matches)')
  // Exactly two counters in the whole body: a.ts and b.ts, not c.ts.
  expect([...body.matchAll(/\+\d+ more match/g)]).toHaveLength(2)

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(2)
})

test('grep: preserves exact totals in header (no silent cut)', () => {
  const lines = Array.from({ length: 600 }, (_, i) => `file${i % 3}.ts:${i + 1}:content ${i}`).join('\n')
  expect(lines.length).toBeGreaterThan(6_000)
  const out = maybeSummarizeToolResult(makeBlock(lines), 'Grep')
  const body = asString(out)
  expect(body).toContain('matches=600')
})

test('grep: other bucket preserves non-matching lines literally', () => {
  const parsable = Array.from({ length: 200 }, (_, i) => `src/a.ts:${i + 1}:hit ${i}`).join('\n')
  const binary = 'Binary file matches'
  const rgErr = 'rg: /opt/x: Permission denied'
  const content = `${parsable}\n${binary}\n${rgErr}\n${'xx '.repeat(2000)}`
  expect(content.length).toBeGreaterThan(6_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Grep')
  const body = asString(out)
  expect(body).toContain('other (preserved literally)')
  expect(body).toContain('Binary file matches')
  expect(body).toContain('rg: /opt/x: Permission denied')
})

test('grep: global cap with omitted-files marker', () => {
  // 60 distinct files, each with 3 matches → exceeds GREP_MAX_FILES=50.
  // Pad line text so the whole payload clears 6K threshold.
  const lines: string[] = []
  for (let f = 0; f < 60; f++) {
    for (let m = 1; m <= 3; m++) {
      lines.push(
        `src/file${f}.ts:${m}:match text ${f}-${m} ${'padding '.repeat(6)}`,
      )
    }
  }
  const content = lines.join('\n')
  expect(content.length).toBeGreaterThan(6_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Grep')
  const body = asString(out)
  expect(body).toContain('files=60')
  expect(body).toContain('matches=180')
  expect(body).toMatch(/<omitted>: 10 files, 30 matches not shown/)
})

// ============================================================
// WebFetch strategy
// ============================================================

test('webfetch: strips script/style for HTML-dense content', () => {
  const scripts = Array.from(
    { length: 30 },
    (_, i) => `<script>var x${i} = ${'a'.repeat(400)};</script>`,
  ).join('\n')
  const styles = Array.from(
    { length: 10 },
    (_, i) => `<style>.c${i} { color: red; ${'b'.repeat(200)} }</style>`,
  ).join('\n')
  const body = 'actual content\n' + Array.from({ length: 200 }, (_, i) => `paragraph ${i}`).join('\n')
  const content = `<!DOCTYPE html>\n${scripts}\n${styles}\n${body}`
  expect(content.length).toBeGreaterThan(12_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'WebFetch')
  const outStr = asString(out)
  expect(outStr).not.toContain('<script>')
  expect(outStr).not.toContain('</script>')
  expect(outStr).not.toContain('<style>')
  expect(outStr).toContain('actual content')
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(3)
})

test('webfetch: markdown passthrough to head+tail strategy', () => {
  // Pure markdown (no HTML markers) above threshold.
  const lines = Array.from({ length: 500 }, (_, i) => `paragraph with some content ${i} and extra text ${'y'.repeat(20)}`).join('\n')
  expect(lines.length).toBeGreaterThan(12_000)
  const out = maybeSummarizeToolResult(makeBlock(lines), 'WebFetch')
  const body = asString(out)
  // New metadata-shaped marker (was: "[…webfetch content omitted: …]").
  expect(body).toMatch(/<omitted lines="\d+" bytes="[^"]+"\/>/)
  expect(body).not.toContain('webfetch content omitted')
  expect(body).toContain('paragraph with some content 0')
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(4)
})

test('webfetch: preserves markdown-style title in first 3 lines', () => {
  const title = '# Important Title'
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${'z'.repeat(20)}`).join('\n')
  const content = `${title}\n${lines}`
  expect(content.length).toBeGreaterThan(12_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'WebFetch')
  const body = asString(out)
  expect(body).toContain('# Important Title')
})

test('webfetch: preserves Title: prefix', () => {
  const title = 'Title: My Page'
  const lines = Array.from({ length: 500 }, (_, i) => `filler ${i} ${'z'.repeat(20)}`).join('\n')
  const content = `${title}\n${lines}`
  expect(content.length).toBeGreaterThan(12_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'WebFetch')
  expect(asString(out)).toContain('Title: My Page')
})

// ============================================================
// Read strategy
// ============================================================

// Read summarization is disabled: head/tail elision induced a thrashing loop
// where the subagent re-Reads the same file in 50-line slices following the
// elision hint (~127× in one observed Rust session). FileReadTool already
// caps body size on its own; this strategy was redundant and harmful.
test('read: passthrough at all sizes (summarizer disabled)', () => {
  const small = makeBlock(
    Array.from({ length: 100 }, (_, i) => `${i + 1}→line content ${i}`).join('\n'),
  )
  expect(maybeSummarizeToolResult(small, 'Read')).toBe(small)

  const large = makeBlock(
    Array.from({ length: 500 }, (_, i) => `${i + 1}→${'x'.repeat(30)} line ${i}`).join('\n'),
  )
  expect(maybeSummarizeToolResult(large, 'Read')).toBe(large)
})

// ============================================================
// Glob strategy
// ============================================================

test('glob: below threshold passthrough', () => {
  // Under GLOB_SUMMARIZE_THRESHOLD of 3000 chars
  const content = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`).join('\n')
  expect(content.length).toBeLessThan(3_000)
  const block = makeBlock(content)
  const out = maybeSummarizeToolResult(block, 'Glob')
  expect(out).toBe(block)
})

test('glob: oversized (120 paths) → summarized with header + omission + strategyId=6', () => {
  const content = Array.from(
    { length: 120 },
    (_, i) => `src/components/module${i}/index.ts`,
  ).join('\n')
  expect(content.length).toBeGreaterThan(3_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const body = asString(out)
  expect(body.startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(body).toContain('Glob summary: 120 paths found, showing first 50')
  // New metadata-shaped marker (was: "[…70 paths omitted…]").
  expect(body).toMatch(/<omitted paths="\d+"\/>/)
  expect(body).not.toContain('paths omitted…')
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(6)
})

test('glob: preserves (Results are truncated...) notice', () => {
  const paths = Array.from(
    { length: 120 },
    (_, i) => `src/deep/path/module${i}/component.tsx`,
  ).join('\n')
  const content = `${paths}\n(Results are truncated to 120 matches)`
  expect(content.length).toBeGreaterThan(3_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const body = asString(out)
  expect(body).toContain('Results are truncated')
})

// ============================================================
// JSON structural strategy (TOOL_RESULT_JSON_COMPRESSION)
// ============================================================

function bigJsonArray(rows = 200): string {
  const arr = Array.from({ length: rows }, (_, i) => ({
    number: i + 1,
    title: `Pull request number ${i + 1} with a reasonably long descriptive title`,
    state: i % 2 === 0 ? 'OPEN' : 'MERGED',
    author: 'dev',
  }))
  return JSON.stringify(arr)
}

afterEach(() => {
  delete process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION
})

test('json: gate off → bash JSON passes through untouched', () => {
  delete process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION
  const content = bigJsonArray()
  expect(content.length).toBeGreaterThan(8_000)
  const block = makeBlock(content)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block) // unchanged: bash arm passes JSON through when gate off
})

test('json: gate on → bash JSON compressed with strategyId=9 + source-less marker', () => {
  process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION = '1'
  const out = maybeSummarizeToolResult(makeBlock(bigJsonArray()), 'Bash')
  const body = asString(out)
  expect(body.startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(body).toContain('strategy="json-structural"')
  // author is constant across all rows → hoisted to const= and dropped from the grid (#7)
  expect(body).toContain('const={"author":"dev"}')
  expect(body).toContain('keys=[number,title,state]')
  expect(body).toContain('<omitted rows=')
  expect(body.length).toBeLessThan(bigJsonArray().length)
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(9)
  expect(evt?.metadata.salientPinned).toBe(0) // benign fixture → nothing pinned
})

test('json: a rare value buried in the dropped middle → salientPinned flows into analytics', () => {
  process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION = '1'
  // benign 200-row PR list with a single rare DRAFT state at #101 (the dropped middle)
  const arr = Array.from({ length: 200 }, (_, i) => ({
    number: i + 1,
    title: `Pull request number ${i + 1} with a reasonably long descriptive title`,
    state: i === 100 ? 'DRAFT' : i % 2 === 0 ? 'OPEN' : 'MERGED',
    author: 'dev',
  }))
  const out = maybeSummarizeToolResult(makeBlock(JSON.stringify(arr)), 'Bash')
  const body = asString(out)
  expect(body).toContain('#101\t') // the rare row is pinned back into the grid
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.salientPinned).toBe(1)
})

test('json: gate on → MCP array-text JSON compressed', () => {
  process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION = '1'
  const block = makeArrayBlock([{ type: 'text', text: bigJsonArray() }])
  const out = maybeSummarizeToolResult(block, 'mcp__server__list')
  const body = asString(out)
  expect(body).toContain('strategy="json-structural"')
})

test('json: gate on but non-JSON bash output → falls back to bash summarizer', () => {
  process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION = '1'
  const content = Array.from({ length: 400 }, (_, i) => `log line ${i} doing work`).join('\n')
  expect(content.length).toBeGreaterThan(8_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toContain('strategy="head-tail-errors"')
})

test('glob: no omission when total ≤ 50 paths (even if above threshold)', () => {
  // 40 paths. The summarizer processes them all (omitted=0) and emits no omission marker.
  // If the no-win guard fires (wrapped ≥ original), the block passes through unchanged —
  // either way, no "paths omitted" text appears.
  const content = Array.from(
    { length: 40 },
    (_, i) => `src/${'nested/'.repeat(10)}component${i}/index.tsx`,
  ).join('\n')
  expect(content.length).toBeGreaterThan(3_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const body = asString(out)
  expect(body).not.toContain('paths omitted')
})

test('glob: boundary — exactly 50 paths → no omission', () => {
  // Same reasoning: 50 paths, all kept, no omission marker in any output path.
  const content = Array.from(
    { length: 50 },
    (_, i) => `src/${'nested/'.repeat(10)}component${i}/index.tsx`,
  ).join('\n')
  expect(content.length).toBeGreaterThan(3_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const body = asString(out)
  expect(body).not.toContain('paths omitted')
})

test('glob: boundary — exactly 51 paths → 1 path omitted', () => {
  // Paths must be long enough (>200 chars each) so omitting 1 path saves more than
  // the wrapper + header + omission-marker overhead, clearing the no-win guard.
  const content = Array.from(
    { length: 51 },
    (_, i) => `src/${'deeply/nested/feature/module/'.repeat(7)}component${i}/index.tsx`,
  ).join('\n')
  expect(content.length).toBeGreaterThan(3_000)
  const out = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const body = asString(out)
  expect(body.startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(body).toContain('<omitted paths="1"/>')
})

test('glob: pathological — all lines are truncation notice → passthrough (bail)', () => {
  // Only truncation notice lines, no actual paths after filter
  const content = Array.from(
    { length: 100 },
    () => '(Results are truncated to 100 matches, use a more specific pattern)',
  ).join('\n')
  expect(content.length).toBeGreaterThan(3_000)
  const block = makeBlock(content)
  const out = maybeSummarizeToolResult(block, 'Glob')
  expect(out).toBe(block)
})

test('glob: the INCOMPLETE notice is metadata, not a path', () => {
  // The notice survives the 50-path cap and is not counted as a path: it is
  // the line saying the listing is a prefix, so losing it to the cap would
  // turn a partial walk back into an answer that reads as complete.
  const paths = Array.from(
    { length: 60 },
    (_, i) => `src/${'deeply/nested/feature/module/'.repeat(7)}component${i}/index.tsx`,
  )
  const notice =
    '(INCOMPLETE: ripgrep was stopped before it finished walking the tree. Any paths above are real but they are not all of them — search a narrower path.)'
  const out = maybeSummarizeToolResult(
    makeBlock([...paths, notice].join('\n')),
    'Glob',
  )
  const body = asString(out)
  expect(body).toContain('Glob summary: 60 paths found')
  expect(body).toContain('INCOMPLETE:')
})

test('glob: snapshot — marker shape and strategy attribute', () => {
  const content = Array.from(
    { length: 120 },
    (_, i) => `src/components/module${i}/index.ts`,
  ).join('\n')
  const out = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const body = asString(out)
  expect(body).toMatch(
    /^<tool-result-summary tool="Glob" original="\d+(\.\d)?(KB|MB|bytes)" kept="\d+(\.\d)?(KB|MB|bytes)" strategy="glob-top-n">\n/,
  )
  expect(body).toContain('strategy="glob-top-n"')
})

test('glob: analytics — strategyId=6 and errorWindowPreserved is undefined', () => {
  const content = Array.from(
    { length: 120 },
    (_, i) => `src/components/module${i}/index.ts`,
  ).join('\n')
  maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt).toBeDefined()
  expect(evt?.metadata.strategyId).toBe(6)
  // Glob has no error window concept — field must be absent, not a boolean
  expect(evt?.metadata.errorWindowPreserved).toBeUndefined()
})

test('glob: idempotent (summarize∘summarize = summarize)', () => {
  const content = Array.from(
    { length: 120 },
    (_, i) => `src/components/module${i}/index.ts`,
  ).join('\n')
  const first = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const second = maybeSummarizeToolResult(first, 'Glob')
  expect(second).toBe(first)
})

test('glob: deterministic (byte-identical output)', () => {
  const content = Array.from(
    { length: 120 },
    (_, i) => `src/components/module${i}/index.ts`,
  ).join('\n')
  const a = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  const b = maybeSummarizeToolResult(makeBlock(content), 'Glob')
  expect(asString(a)).toBe(asString(b))
})

// ============================================================
// Marker format snapshots
// ============================================================

test('snapshot: Bash marker shape', () => {
  const content = Array.from({ length: 500 }, (_, i) => `${['alpha', 'beta', 'gamma', 'delta'][i % 4]} row ${i} ${'x'.repeat(20)}`).join('\n')
  const out = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const body = asString(out)
  expect(body).toMatch(
    /^<tool-result-summary tool="Bash" original="\d+(\.\d)?(KB|MB|bytes)" kept="\d+(\.\d)?(KB|MB|bytes)" strategy="head-tail-errors">\n/,
  )
  expect(body.endsWith('</tool-result-summary>')).toBe(true)
})

test('snapshot: Grep marker shape', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `src/f${i % 5}.ts:${i + 1}:hit ${i} ${'p'.repeat(10)}`).join('\n')
  const out = maybeSummarizeToolResult(makeBlock(lines), 'Grep')
  const body = asString(out)
  expect(body).toMatch(
    /^<tool-result-summary tool="Grep" original="\d+(\.\d)?(KB|MB|bytes)" kept="\d+(\.\d)?(KB|MB|bytes)" strategy="grep-grouped">\n/,
  )
})

test('snapshot: WebFetch stripped marker shape', () => {
  const scripts = Array.from({ length: 30 }, (_, i) => `<script>${'a'.repeat(400)}; // ${i}</script>`).join('\n')
  const body0 = Array.from({ length: 200 }, (_, i) => `p ${i}`).join('\n')
  const content = `<!DOCTYPE html>\n${scripts}\n${body0}`
  const out = maybeSummarizeToolResult(makeBlock(content), 'WebFetch')
  const body = asString(out)
  expect(body).toMatch(/strategy="webfetch-stripped"/)
})

test('snapshot: WebFetch head-tail marker shape', () => {
  const content = Array.from({ length: 500 }, (_, i) => `markdown paragraph ${i} ${'z'.repeat(30)}`).join('\n')
  const out = maybeSummarizeToolResult(makeBlock(content), 'WebFetch')
  const body = asString(out)
  expect(body).toMatch(/strategy="webfetch-head-tail"/)
})

// ============================================================
// Property: idempotency
// ============================================================

test('property: idempotent (summarize∘summarize = summarize)', () => {
  const content = Array.from({ length: 500 }, (_, i) => `${['alpha', 'beta', 'gamma', 'delta'][i % 4]} row ${i} ${'x'.repeat(20)}`).join('\n')
  const first = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const second = maybeSummarizeToolResult(first, 'Bash')
  expect(second).toBe(first) // same reference — guard hits
  expect(asString(second)).toBe(asString(first))
})

test('property: idempotent for Grep', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `src/f${i % 4}.ts:${i + 1}:match ${i}`).join('\n')
  const first = maybeSummarizeToolResult(makeBlock(lines), 'Grep')
  const second = maybeSummarizeToolResult(first, 'Grep')
  expect(second).toBe(first)
})

test('property: idempotent for WebFetch', () => {
  const content = Array.from({ length: 500 }, (_, i) => `p ${i} ${'q'.repeat(30)}`).join('\n')
  const first = maybeSummarizeToolResult(makeBlock(content), 'WebFetch')
  const second = maybeSummarizeToolResult(first, 'WebFetch')
  expect(second).toBe(first)
})

// ============================================================
// Property: determinism (byte-identical across runs)
// ============================================================

test('property: deterministic (byte-identical output, Bash)', () => {
  const content = Array.from({ length: 500 }, (_, i) => `${['alpha', 'beta', 'gamma', 'delta'][i % 4]} row ${i} ${'x'.repeat(20)}`).join('\n')
  const a = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const b = maybeSummarizeToolResult(makeBlock(content), 'Bash')
  expect(asString(a)).toBe(asString(b))
})

test('property: deterministic (byte-identical output, Grep)', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `src/f${i % 5}.ts:${i + 1}:match ${i}`).join('\n')
  const a = maybeSummarizeToolResult(makeBlock(lines), 'Grep')
  const b = maybeSummarizeToolResult(makeBlock(lines), 'Grep')
  expect(asString(a)).toBe(asString(b))
})

test('property: deterministic (byte-identical output, WebFetch)', () => {
  const content = Array.from({ length: 500 }, (_, i) => `para ${i} ${'w'.repeat(30)}`).join('\n')
  const a = maybeSummarizeToolResult(makeBlock(content), 'WebFetch')
  const b = maybeSummarizeToolResult(makeBlock(content), 'WebFetch')
  expect(asString(a)).toBe(asString(b))
})

// ============================================================
// Error handling: try/catch global
// ============================================================

test('never throws: pathological input returns original block', () => {
  // Crafted to be huge but survive — we mostly just verify no throws.
  const content = '\x00'.repeat(30_000)
  const block = makeBlock(content)
  const out = maybeSummarizeToolResult(block, 'Bash')
  // Either summarized or passthrough — but must not throw. And must be a
  // valid ToolResultBlockParam either way.
  expect(out.type).toBe('tool_result')
})

test('never throws: pathological input for Read returns original block', () => {
  const block = makeBlock('\x00'.repeat(30_000))
  const out = maybeSummarizeToolResult(block, 'Read')
  expect(out.type).toBe('tool_result')
})

test('never throws: pathological input for Glob returns original block', () => {
  const block = makeBlock('\x00'.repeat(10_000))
  const out = maybeSummarizeToolResult(block, 'Glob')
  expect(out.type).toBe('tool_result')
})

// ============================================================
// isSummarizedContent
// ============================================================

test('isSummarizedContent: true for summarized string', () => {
  const s = `${TOOL_RESULT_SUMMARY_TAG} tool="Bash" original="10KB" kept="1KB" strategy="head-tail-errors">\nx\n${TOOL_RESULT_SUMMARY_CLOSING_TAG}`
  expect(isSummarizedContent(s)).toBe(true)
})

test('isSummarizedContent: false for plain string', () => {
  expect(isSummarizedContent('hello')).toBe(false)
  expect(isSummarizedContent('')).toBe(false)
})

test('isSummarizedContent: false for non-string', () => {
  expect(isSummarizedContent(null)).toBe(false)
  expect(isSummarizedContent(undefined)).toBe(false)
  expect(isSummarizedContent(42)).toBe(false)
  expect(isSummarizedContent([])).toBe(false)
  expect(isSummarizedContent({})).toBe(false)
})

// ============================================================
// Analytics event schema
// ============================================================

test('analytics: event schema matches plan', () => {
  const content = Array.from({ length: 500 }, (_, i) => `${['alpha', 'beta', 'gamma', 'delta'][i % 4]} row ${i} ${'x'.repeat(20)}`).join('\n')
  maybeSummarizeToolResult(makeBlock(content), 'Bash')
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt).toBeDefined()
  const m = evt!.metadata
  expect(typeof m.toolName).toBe('string')
  expect(typeof m.originalSizeBytes).toBe('number')
  expect(typeof m.summarizedSizeBytes).toBe('number')
  expect(typeof m.estimatedOriginalTokens).toBe('number')
  expect(typeof m.estimatedSummarizedTokens).toBe('number')
  expect([1, 2, 3, 4, 5, 6, 7, 8]).toContain(m.strategyId as number)
  expect(typeof m.reductionPct).toBe('number')
  // errorWindowPreserved must be boolean for Bash.
  expect(typeof m.errorWindowPreserved).toBe('boolean')
})

test('analytics: not emitted on passthrough (below threshold)', () => {
  const block = makeBlock('small\n'.repeat(10))
  maybeSummarizeToolResult(block, 'Bash')
  expect(
    loggedEvents.some(e => e.name === 'claudin_tool_result_summarized'),
  ).toBe(false)
})

test('analytics: not emitted when flag off', () => {
  mockState.enabled = false
  const block = makeBlock(bigText(20_000, 'abc\n'))
  maybeSummarizeToolResult(block, 'Bash')
  expect(
    loggedEvents.some(e => e.name === 'claudin_tool_result_summarized'),
  ).toBe(false)
})

// ============================================================
// AgentTool — main flow
// ============================================================

test('agentTool: array below threshold → passthrough', () => {
  const block = makeArrayBlock([{ type: 'text', text: 'short output' }])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  expect(out).toBe(block)
  expect(loggedEvents.length).toBe(0)
})

test('agentTool: array above threshold → summarized, content becomes string', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n')
  expect(text.length).toBeGreaterThan(AGENT_SUMMARIZE_THRESHOLD)

  const block = makeArrayBlock([{ type: 'text', text }])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  expect(typeof out.content).toBe('string')
  expect((out.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
})

test('agentTool: trailer with <usage> preserved verbatim at end', () => {
  const mainText = Array.from({ length: 300 }, (_, i) => `Result line ${i}: ${'y'.repeat(30)}`).join('\n')
  const trailerText = '<usage><total_tokens>4200</total_tokens></usage>'
  const block = makeArrayBlock([
    { type: 'text', text: mainText },
    { type: 'text', text: trailerText },
  ])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  const body = asString(out)
  expect(body).toContain(trailerText)
  expect(body).toMatch(/<omitted lines="\d+"\/>/)
})

test('agentTool: LEGACY_AGENT_TOOL_NAME also triggers', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n')
  expect(text.length).toBeGreaterThan(AGENT_SUMMARIZE_THRESHOLD)

  const block = makeArrayBlock([{ type: 'text', text }])
  const out = maybeSummarizeToolResult(block, LEGACY_AGENT_TOOL_NAME)
  expect(typeof out.content).toBe('string')
  expect((out.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
})

test('agentTool: already summarized → passthrough (idempotency)', () => {
  const summarized = `${TOOL_RESULT_SUMMARY_TAG} tool="${AGENT_TOOL_NAME}" original="20KB" kept="3KB" strategy="agent-head-tail">\nfoo\n${TOOL_RESULT_SUMMARY_CLOSING_TAG}`
  const block = makeBlock(summarized)
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  expect(out).toBe(block)
})

test('agentTool: strategyId = 7', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n')
  const block = makeArrayBlock([{ type: 'text', text }])
  maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(7)
})

test('agentTool: errorWindowPreserved absent (undefined)', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n')
  const block = makeArrayBlock([{ type: 'text', text }])
  maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.errorWindowPreserved).toBeUndefined()
})

// ============================================================
// AgentTool — edge cases
// ============================================================

test('agentTool: empty array → passthrough', () => {
  const block = makeArrayBlock([])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  expect(out).toBe(block)
})

test('agentTool: only trailer block, no main content → passthrough', () => {
  const trailerText = 'agentId: abc123\n<usage><total_tokens>100</total_tokens></usage>'
  const block = makeArrayBlock([{ type: 'text', text: trailerText }])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  expect(out).toBe(block)
})

test('agentTool: only image blocks → passthrough (joined = empty)', () => {
  const block = makeArrayBlock([{ type: 'image' }, { type: 'image' }])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  expect(out).toBe(block)
})

test('agentTool: no trailer → summary without trailer, full body', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'z'.repeat(40)}`).join('\n')
  const block = makeArrayBlock([{ type: 'text', text }])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  const body = asString(out)
  expect(body.startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  expect(body).not.toContain('<usage>')
  expect(body).not.toContain('agentId:')
})

test('agentTool: false-positive trailer — only last block is candidate', () => {
  // First block starts with agentId: but should NOT be treated as trailer.
  const firstText = 'agentId: fakestart\n' + Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'a'.repeat(30)}`).join('\n')
  const lastText = Array.from({ length: 50 }, (_, i) => `tail ${i}: ${'b'.repeat(30)}`).join('\n')
  const block = makeArrayBlock([
    { type: 'text', text: firstText },
    { type: 'text', text: lastText },
  ])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  // lastText doesn't contain <usage> or start with agentId: → no trailer detected
  const body = asString(out)
  expect(body).toMatch(/<omitted lines="\d+"\/>/)
  // The "fake trailer" block (first block) is main content — its text must appear in the output body
  expect(body).toContain(firstText.slice(0, 20))
})

test('agentTool: trailer null-safety (text block without text field)', () => {
  const mainText = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n')
  // Last block has type 'text' but no text property — must not crash.
  const block = makeArrayBlock([
    { type: 'text', text: mainText },
    { type: 'text' },
  ])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  expect(out.type).toBe('tool_result')
})

test('agentTool: short async_launched content → below threshold → passthrough', () => {
  const block = makeArrayBlock([{ type: 'text', text: 'async_launched: true\nagentId: abc' }])
  const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  expect(out).toBe(block)
})

// ============================================================
// MCPTool — array
// ============================================================

test('mcpTool: array above threshold → summarized, strategyId = 8', () => {
  const text = Array.from({ length: 300 }, (_, i) => `mcp line ${i}: ${'a'.repeat(40)}`).join('\n')
  expect(text.length).toBeGreaterThan(MCP_SUMMARIZE_THRESHOLD)

  const block = makeArrayBlock([{ type: 'text', text }])
  const out = maybeSummarizeToolResult(block, 'mcp__files__read')
  expect(typeof out.content).toBe('string')
  expect((out.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(8)
})

test('mcpTool: mixed image+text blocks → passthrough (images preserved)', () => {
  const text = Array.from({ length: 300 }, (_, i) => `mcp line ${i}: ${'b'.repeat(40)}`).join('\n')
  const block = makeArrayBlock([
    { type: 'image' },
    { type: 'text', text },
  ])
  const out = maybeSummarizeToolResult(block, 'mcp__files__read')
  // Non-text blocks present → no summarization, original block returned as-is
  expect(out).toBe(block)
})

test('mcpTool: all-text blocks above threshold → summarized', () => {
  const text = Array.from({ length: 300 }, (_, i) => `mcp line ${i}: ${'b'.repeat(40)}`).join('\n')
  expect(text.length).toBeGreaterThan(MCP_SUMMARIZE_THRESHOLD)
  const block = makeArrayBlock([{ type: 'text', text }])
  const out = maybeSummarizeToolResult(block, 'mcp__files__read')
  expect(typeof out.content).toBe('string')
  expect((out.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
})

test('mcpTool: array with only image blocks → passthrough', () => {
  const block = makeArrayBlock([{ type: 'image' }, { type: 'image' }])
  const out = maybeSummarizeToolResult(block, 'mcp__vision__analyze')
  expect(out).toBe(block)
})

test('mcpTool: bare mcp__ prefix (no server/tool) → startsWith still routes', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i}: ${'c'.repeat(40)}`).join('\n')
  const block = makeArrayBlock([{ type: 'text', text }])
  const out = maybeSummarizeToolResult(block, 'mcp__')
  expect(typeof out.content).toBe('string')
  expect((out.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
})

// ============================================================
// MCPTool — string content
// ============================================================

test('mcpTool: string above threshold → summarized via dispatch', () => {
  const text = Array.from({ length: 300 }, (_, i) => `item ${i}: ${'d'.repeat(40)}`).join('\n')
  expect(text.length).toBeGreaterThan(MCP_SUMMARIZE_THRESHOLD)

  const block = makeBlock(text)
  const out = maybeSummarizeToolResult(block, 'mcp__search__query')
  expect(typeof out.content).toBe('string')
  expect((out.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(8)
})

test('mcpTool: string below threshold → passthrough', () => {
  const block = makeBlock('short mcp result')
  const out = maybeSummarizeToolResult(block, 'mcp__search__query')
  expect(out).toBe(block)
})

// ============================================================
// Savings estimation — numeric assertions
// ============================================================

test('AgentTool savings: 20KB report → >50% reduction and correct omission marker', () => {
  const lineCount = 400
  const text = Array.from({ length: lineCount }, (_, i) => `Line ${i}: ${'x'.repeat(45)}`).join('\n')
  expect(text.length).toBeGreaterThan(AGENT_SUMMARIZE_THRESHOLD)

  const block = makeArrayBlock([{ type: 'text', text }])
  const result = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  const body = asString(result)

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.originalSizeBytes).toBe(text.length)
  expect(evt?.metadata.summarizedSizeBytes).toBeLessThan(text.length)
  expect(evt?.metadata.summarizedSizeBytes).toBe(body.length)
  expect(evt?.metadata.reductionPct).toBeGreaterThan(50)
  expect(evt?.metadata.estimatedOriginalTokens).toBeGreaterThan(1_000)
  expect((evt?.metadata.estimatedSummarizedTokens as number)).toBeLessThan(
    evt?.metadata.estimatedOriginalTokens as number,
  )
  // Metadata-shaped marker (was: "[…300 lines omitted…]").
  expect(body).toContain('<omitted lines="300"/>')
  expect(body).not.toMatch(/lines omitted…\]/)
})

test('AgentTool savings: trailer preserved and size reflects all content', () => {
  const mainText = Array.from({ length: 300 }, (_, i) => `Result line ${i}: ${'z'.repeat(30)}`).join('\n')
  const trailerText = 'agentId: abc123\n<usage><total_tokens>4200</total_tokens></usage>'
  expect(mainText.length).toBeGreaterThan(AGENT_SUMMARIZE_THRESHOLD)
  const blocks = [
    { type: 'text', text: mainText },
    { type: 'text', text: trailerText },
  ]
  const block = makeArrayBlock(blocks)
  const result = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
  const body = asString(result)

  expect(body).toContain(trailerText)
  expect(body).toMatch(/<omitted lines="\d+"\/>/)
  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  // originalSizeBytes = joinTextBlocks(all blocks) = mainText + '\n' + trailerText
  expect(evt?.metadata.originalSizeBytes).toBe(mainText.length + trailerText.length + 1)
  expect(evt?.metadata.reductionPct).toBeGreaterThan(0)
})

test('MCPTool savings: 15KB array → bytes and tokens reduced', () => {
  const text = Array.from({ length: 300 }, (_, i) => `mcp result line ${i}: ${'a'.repeat(40)}`).join('\n')
  expect(text.length).toBeGreaterThan(MCP_SUMMARIZE_THRESHOLD)

  const block = makeArrayBlock([{ type: 'text', text }], 'mcp__files__read')
  const result = maybeSummarizeToolResult(block, 'mcp__files__read')

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(8)
  expect(evt?.metadata.originalSizeBytes).toBe(text.length)
  expect(evt?.metadata.summarizedSizeBytes).toBeLessThan(text.length)
  expect(evt?.metadata.reductionPct).toBeGreaterThan(0)
})

test('MCPTool savings: 15KB string → reduced via dispatch', () => {
  const text = Array.from({ length: 300 }, (_, i) => `item ${i}: ${'b'.repeat(40)}`).join('\n')
  expect(text.length).toBeGreaterThan(MCP_SUMMARIZE_THRESHOLD)

  const block = makeBlock(text)
  const result = maybeSummarizeToolResult(block, 'mcp__search__query')

  const evt = loggedEvents.find(e => e.name === 'claudin_tool_result_summarized')
  expect(evt?.metadata.strategyId).toBe(8)
  expect(evt?.metadata.originalSizeBytes).toBe(text.length)
  expect(evt?.metadata.summarizedSizeBytes).toBeLessThan(text.length)
  expect(evt?.metadata.reductionPct).toBeGreaterThan(0)
})

// ============================================================
// bash-output-filter markers (Phase 0 plumbing — roadmap 6.1.0)
// ============================================================

test('bash-output: <bash-output-rewritten> marker is not re-summarized', () => {
  const rewritten = `<bash-output-rewritten filter="git-log" original="500" actual="40">\n${bigText(20_000)}`
  const block = makeBlock(rewritten)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('bash-output: <bash-output-filtered> marker is not re-summarized', () => {
  const filtered = `<bash-output-filtered name="ps-aux" reduction="93%">\n${bigText(20_000)}`
  const block = makeBlock(filtered)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('bash-output: marker with error-like content inside is not re-summarized', () => {
  const filtered = `<bash-output-filtered name="pytest" reduction="95%">\nerror: test failed\nFAILED test_foo.py::test_bar\n${bigText(20_000)}`
  const block = makeBlock(filtered)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('bash-output: markers with complex attributes are recognized', () => {
  const rewritten = `<bash-output-rewritten filter="git-log --oneline -20" original="git log -10" actual="git log --oneline -10">\n${bigText(20_000)}`
  const block = makeBlock(rewritten)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('bash-output: guard works for all tool types (Grep, WebFetch, Read, Glob)', () => {
  const marker = `<bash-output-filtered name="ps-aux" reduction="93%">\n${bigText(20_000)}`
  for (const toolName of ['Grep', 'WebFetch', 'Read', 'Glob']) {
    const block = makeBlock(marker)
    const out = maybeSummarizeToolResult(block, toolName)
    expect(out).toBe(block)
  }
})

test('bash-output: idempotent (summarize∘filter-output = filter-output)', () => {
  const filtered = `<bash-output-filtered name="ps-aux" reduction="93%">\n${bigText(20_000)}`
  const first = maybeSummarizeToolResult(makeBlock(filtered), 'Bash')
  const second = maybeSummarizeToolResult(first, 'Bash')
  expect(second).toBe(first)
})

test('bash-output: isSummarizedContent returns false for bash-output markers', () => {
  expect(isSummarizedContent('<bash-output-rewritten filter="x" original="git log" actual="git log --oneline">')).toBe(false)
  expect(isSummarizedContent('<bash-output-filtered name="y" reduction="72%">')).toBe(false)
})

test('bash-output: small output with marker is also passthrough', () => {
  const small = `<bash-output-rewritten filter="git-status" original="git status" actual="git status --porcelain">\nM src/foo.ts`
  const block = makeBlock(small)
  const out = maybeSummarizeToolResult(block, 'Bash')
  expect(out).toBe(block)
})

test('bash-output: collapseIdenticalRuns is importable and works', () => {
  expect(collapseIdenticalRuns(['a', 'a', 'a'])).toEqual(['a (×3)'])
  expect(collapseIdenticalRuns(['a', 'b', 'b', 'c'])).toEqual(['a', 'b (×2)', 'c'])
  expect(collapseIdenticalRuns([])).toEqual([])
})

test('bash-output: a run of blank/whitespace lines collapses to a single blank, never ` (×N)`', () => {
  // A ` (×N)` marker on a blank run is non-blank, so it would survive a
  // `/^\s*$/` strip rule and defeat onEmpty in the Bash output-filter pipeline.
  expect(collapseIdenticalRuns(['a', '', '', 'b'])).toEqual(['a', '', 'b'])
  expect(collapseIdenticalRuns(['', '', ''])).toEqual([''])
  expect(collapseIdenticalRuns(['  ', '  '])).toEqual(['  '])
  // Non-blank runs are still annotated.
  expect(collapseIdenticalRuns(['x', '', '', 'x', 'x'])).toEqual(['x', '', 'x (×2)'])
})

test('bash-output: collapseDigitTemplates is importable and works', () => {
  const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`)
  expect(collapseDigitTemplates(lines)).toEqual(['line 1 (5 updates)'])
  expect(collapseDigitTemplates([])).toEqual([])
  // Below DIGIT_TEMPLATE_MIN_RUN (5) — preserve as-is
  expect(collapseDigitTemplates(['line 1', 'line 2'])).toEqual(['line 1', 'line 2'])
})
