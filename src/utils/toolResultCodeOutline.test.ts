import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetGlobalConfigForTests } from './config.js'

const realAnalyticsMetadata = { ...(await import('src/services/analytics/metadata.js')) }
const realAnalyticsIndex = { ...(await import('src/services/analytics/index.js')) }

afterAll(() => {
  mock.module('src/services/analytics/metadata.js', () => realAnalyticsMetadata)
  mock.module('src/services/analytics/index.js', () => realAnalyticsIndex)
  resetGlobalConfigForTests()
})

mock.module('src/services/analytics/metadata.js', () => ({
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

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: () => Promise.resolve(),
  stripProtoFields: <T,>(m: T) => m,
}))

const { maybeSummarizeToolResult, isSummarizedContent } = await import(
  './toolResultSummarizer.js'
)
const { processPreMappedToolResultBlock } = await import('./toolResultStorage.js')
const { AGENT_TOOL_NAME } = await import('src/tools/AgentTool/constants.js')

const ENV_KEYS = [
  'CLAUDIN_CODE_OUTLINE',
  'CLAUDIN_TOOL_RESULT_JSON_COMPRESSION',
  'CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
  // Strategy under test on; JSON compression off by default per-test (the
  // feature() folds are stubbed false under bun test — env is the only switch).
  process.env.CLAUDIN_CODE_OUTLINE = '1'
  delete process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]!
  }
})

function makeBlock(
  content: ToolResultBlockParam['content'],
  id = 'toolu_t',
): ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content }
}

function makeArrayBlock(
  blocks: Array<{ type: string; text?: string }>,
  id = 'toolu_t',
): ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content: blocks as ToolResultBlockParam['content'] }
}

function asString(block: ToolResultBlockParam): string {
  const c = block.content
  if (typeof c !== 'string') throw new Error('expected string content')
  return c
}

// A large TS source: import + const + n functions. >> 8KB at n=200.
function bigTsSource(n: number): string {
  const parts = [`import { foo } from './foo'`, `export const VERSION = 1`]
  for (let i = 0; i < n; i++) {
    parts.push(
      `export function fn${i}(x: number): number {`,
      `  const a = x + ${i}`,
      `  const b = a * 2`,
      `  return b - ${i}`,
      `}`,
    )
  }
  return parts.join('\n')
}

const CODE = bigTsSource(200)

function bigProse(n: number): string {
  const sentence =
    'This is an ordinary paragraph of English prose describing the system. '
  return sentence.repeat(n)
}

// Detects as TS (hundreds of import anchors) but yields only 2 symbols — imports
// are anchors for detection yet are NOT scanned as symbols, so this trips the
// CODE_OUTLINE_MIN_SYMBOLS gate. >8KB so the Bash summarizer engages.
function bigCodeFewSymbols(): string {
  const parts: string[] = []
  for (let i = 0; i < 350; i++) parts.push(`import { x${i} } from './m${i}'`)
  parts.push('export function alpha(): void {}')
  parts.push('export function beta(): void {}')
  return parts.join('\n')
}

// Hundreds of one-line top-level consts: many symbols, but each rendered outline
// row (range + indent + signature) is LONGER than its source line, so the body
// is bigger than the source and the CODE_MIN_SAVINGS (15%) gate rejects it.
function bigCodeNoSavings(): string {
  return Array.from({ length: 450 }, (_, i) => `export const A${i} = ${i}`).join('\n')
}

// ============================================================
// Happy path
// ============================================================

describe('code-outline happy path', () => {
  test('large source → code-outline marker, smaller than original', () => {
    const block = makeBlock(CODE)
    const out = maybeSummarizeToolResult(block, 'Bash')
    const s = asString(out)
    expect(isSummarizedContent(s)).toBe(true)
    expect(s).toContain('strategy="code-outline"')
    expect(s).toMatch(/symbols="\d+"/)
    expect(s).toMatch(/lines="\d+"/)
    expect(s.length).toBeLessThan(CODE.length)
    // The outline carries the symbol signatures, not the function bodies.
    expect(s).toContain('export function fn7')
    expect(s).not.toContain('const b = a * 2')
  })
})

// ============================================================
// Reversibility — range alignment (pure) + fs round-trip
// ============================================================

describe('code-outline reversibility', () => {
  test('outline line ranges map onto the raw source line numbers (start AND end)', () => {
    const block = makeBlock(CODE)
    const s = asString(maybeSummarizeToolResult(block, 'Bash'))
    const rawLines = CODE.split('\n')
    // Find the body line for fn7 and parse its "start-end" range.
    const line = s.split('\n').find(l => /\bexport function fn7\b/.test(l))
    expect(line).toBeDefined()
    const m = line!.match(/(\d+)-(\d+)\s+export function fn7\b/)
    expect(m).not.toBeNull()
    const start = Number(m![1])
    const end = Number(m![2])
    // start lands on the signature; end lands on the function's closing brace —
    // an off-by-one in endLine (which multi-line recovery depends on) fails here.
    expect(rawLines[start - 1]).toContain('export function fn7(')
    expect(rawLines[end - 1]!.trim()).toBe('}')
    // bigTsSource emits a 5-line function, so the range must bracket it exactly.
    expect(end).toBe(start + 4)
  })

  describe('fs round-trip (persisted source = raw verbatim)', () => {
    const prevConfigDir = process.env.CLAUDIN_CONFIG_DIR
    const testConfigDir = join(tmpdir(), `claudin-code-outline-${process.pid}-${Date.now()}`)

    beforeAll(() => {
      process.env.CLAUDIN_CONFIG_DIR = testConfigDir
      mkdirSync(testConfigDir, { recursive: true })
    })
    afterAll(() => {
      if (prevConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
      else process.env.CLAUDIN_CONFIG_DIR = prevConfigDir
      if (existsSync(testConfigDir)) rmSync(testConfigDir, { recursive: true, force: true })
    })

    test('marker gains source= and the file equals the raw source', async () => {
      const block = makeBlock(CODE, 'toolu_roundtrip')
      const out = await processPreMappedToolResultBlock(block, 'Bash', 1_000_000)
      const s = asString(out)
      expect(s).toContain('strategy="code-outline"')
      const m = s.match(/source="([^"]+)"/)
      expect(m).not.toBeNull()
      const persisted = readFileSync(m![1], 'utf-8')
      expect(persisted).toBe(CODE)
    })

    test('outline range recovers a DROPPED body from the persisted source', async () => {
      const block = makeBlock(CODE, 'toolu_recover')
      const out = await processPreMappedToolResultBlock(block, 'Bash', 1_000_000)
      const s = asString(out)
      const src = s.match(/source="([^"]+)"/)
      expect(src).not.toBeNull()
      const persistedLines = readFileSync(src![1], 'utf-8').split('\n')
      // Parse fn7's range from the OUTLINE, then recover its body from the
      // PERSISTED source at that range — the end-to-end reversibility contract.
      const bodyLine = s.split('\n').find(l => /\bexport function fn7\b/.test(l))
      const r = bodyLine!.match(/(\d+)-(\d+)\s+export function fn7\b/)
      expect(r).not.toBeNull()
      const start = Number(r![1])
      const end = Number(r![2])
      const recovered = persistedLines.slice(start - 1, end).join('\n')
      expect(recovered).toContain('export function fn7(')
      // `const b = a * 2` is elided from the outline (happy-path asserts that);
      // recovering it through start..end proves the round-trip composes.
      expect(recovered).toContain('const b = a * 2')
    })

    test('JSON off + code on: a non-code head/tail result gains NO source= backing', async () => {
      // With only the code-outline flag on, blind head/tail must stay
      // non-reversible — enabling code-outline must not back unrelated strategies.
      const prose = Array.from(
        { length: 400 },
        (_, i) => `This is line ${i} of an ordinary prose log, not source code at all.`,
      ).join('\n')
      const block = makeBlock(prose, 'toolu_noback')
      const out = await processPreMappedToolResultBlock(block, 'Bash', 1_000_000)
      const s = asString(out)
      expect(s).toContain('strategy="head-tail-errors"')
      expect(s).not.toContain('source=')
    })
  })
})

// ============================================================
// Self-gating — invisible on non-code (ON output == OFF output)
// ============================================================

describe('code-outline is invisible on non-code', () => {
  function bashWith(text: string, codeOutline: boolean): string {
    if (codeOutline) process.env.CLAUDIN_CODE_OUTLINE = '1'
    else process.env.CLAUDIN_CODE_OUTLINE = '0'
    const out = maybeSummarizeToolResult(makeBlock(text), 'Bash')
    return typeof out.content === 'string' ? out.content : JSON.stringify(out.content)
  }

  test('prose ≥ threshold: ON output byte-identical to OFF output', () => {
    const prose = bigProse(400)
    expect(bashWith(prose, true)).toBe(bashWith(prose, false))
  })

  test('unified diff: ON output byte-identical to OFF output', () => {
    const diff =
      `diff --git a/x.ts b/x.ts\nindex 1aa..2bb 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n` +
      Array.from({ length: 400 }, (_, i) => ` export function keep${i}() {}`).join('\n')
    expect(bashWith(diff, true)).toBe(bashWith(diff, false))
  })

  test('short code (below threshold): returns the exact original block', () => {
    const block = makeBlock(bigTsSource(2)) // small, < 8KB
    const out = maybeSummarizeToolResult(block, 'Bash')
    expect(out).toBe(block)
  })
})

// ============================================================
// Savings / symbol gates → fall through to head/tail
// ============================================================

describe('code-outline gates fall through to head/tail', () => {
  test('detects as code but < CODE_OUTLINE_MIN_SYMBOLS → not outlined', () => {
    const src = bigCodeFewSymbols()
    expect(src.length).toBeGreaterThan(8_000) // above the Bash summarize bar
    const s = asString(maybeSummarizeToolResult(makeBlock(src), 'Bash'))
    expect(s).not.toContain('strategy="code-outline"')
    expect(s).toContain('strategy="head-tail-errors"')
  })

  test('many symbols but outline not 15% smaller (CODE_MIN_SAVINGS) → not outlined', () => {
    const src = bigCodeNoSavings()
    expect(src.length).toBeGreaterThan(8_000)
    const s = asString(maybeSummarizeToolResult(makeBlock(src), 'Bash'))
    expect(s).not.toContain('strategy="code-outline"')
    expect(s).toContain('strategy="head-tail-errors"')
  })
})

// ============================================================
// JSON still wins over code-outline
// ============================================================

test('JSON array → json-structural, not code-outline', () => {
  process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION = '1'
  const arr = JSON.stringify(
    Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item-${i}`, ok: true })),
  )
  const s = asString(maybeSummarizeToolResult(makeBlock(arr), 'Bash'))
  expect(s).toContain('strategy="json-structural"')
  expect(s).not.toContain('strategy="code-outline"')
})

// ============================================================
// 4-path parity
// ============================================================

describe('code-outline fires on all wired paths', () => {
  test('Bash (string)', () => {
    const s = asString(maybeSummarizeToolResult(makeBlock(CODE), 'Bash'))
    expect(s).toContain('strategy="code-outline"')
  })

  test('WebFetch (string)', () => {
    const s = asString(maybeSummarizeToolResult(makeBlock(CODE), 'WebFetch'))
    expect(s).toContain('strategy="code-outline"')
  })

  test('MCP (string)', () => {
    const s = asString(maybeSummarizeToolResult(makeBlock(CODE), 'mcp__srv__readFile'))
    expect(s).toContain('strategy="code-outline"')
  })

  test('Agent (array content)', () => {
    const out = maybeSummarizeToolResult(
      makeArrayBlock([{ type: 'text', text: CODE }]),
      AGENT_TOOL_NAME,
    )
    expect(asString(out)).toContain('strategy="code-outline"')
  })

  test('Agent: code-outline preserves the agentId/<usage> trailer block', () => {
    const trailer = 'agentId: abc123\n<usage>input=10 output=20</usage>'
    const out = maybeSummarizeToolResult(
      makeArrayBlock([
        { type: 'text', text: CODE },
        { type: 'text', text: trailer },
      ]),
      AGENT_TOOL_NAME,
    )
    const s = asString(out)
    expect(s).toContain('strategy="code-outline"')
    // The trailer must survive the outline (it is not part of the scanned code).
    expect(s).toContain('agentId: abc123')
    expect(s).toContain('<usage>input=10 output=20</usage>')
  })

  test('MCP (array content)', () => {
    const out = maybeSummarizeToolResult(
      makeArrayBlock([{ type: 'text', text: CODE }]),
      'mcp__srv__readFile',
    )
    expect(asString(out)).toContain('strategy="code-outline"')
  })
})

// ============================================================
// Flag off → passthrough to head/tail (no code-outline marker)
// ============================================================

test('flag off: code is head/tail-d, not outlined', () => {
  process.env.CLAUDIN_CODE_OUTLINE = '0'
  const s = asString(maybeSummarizeToolResult(makeBlock(CODE), 'Bash'))
  expect(s).not.toContain('strategy="code-outline"')
  expect(s).toContain('strategy="head-tail-errors"')
})

// ============================================================
// Determinism (cache-safety: no per-turn drift)
// ============================================================

test('deterministic: same input → byte-identical marker across calls', () => {
  const a = asString(maybeSummarizeToolResult(makeBlock(CODE), 'Bash'))
  const b = asString(maybeSummarizeToolResult(makeBlock(CODE), 'Bash'))
  expect(a).toBe(b)
})
