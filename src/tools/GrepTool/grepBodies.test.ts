import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maybeSummarizeToolResult } from 'src/agent/tools/toolResultSummarizer.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import {
  BODIES_BUDGET_CHARS,
  BODIES_HEADER_SUFFIX,
  bodiesSchemaFields,
  GREP_BODIES_ENV,
  isGrepBodiesResult,
  isGrepBodiesEnabled,
  MAX_BODY_LINES,
} from 'src/tools/GrepTool/grepBodies.js'
import { buildSymbolsOutput } from 'src/tools/GrepTool/symbolsOutput.js'

const priorFlag = process.env[GREP_BODIES_ENV]
afterEach(() => {
  if (priorFlag === undefined) delete process.env[GREP_BODIES_ENV]
  else process.env[GREP_BODIES_ENV] = priorFlag
})

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grep-bodies-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A TS file: `small` (lines 1-3), `other` (5-7), and `big`, longer than the body cap. */
function writeSource(name: string): string {
  const path = join(dir, name)
  const big = Array.from({ length: MAX_BODY_LINES + 5 }, (_, i) => `  const v${i} = ${i}`)
  const lines = [
    'export function small(a: number): number {',
    '  return a + 1 // NEEDLE small',
    '}',
    '',
    'export function other(): string {',
    "  return 'NEEDLE other'",
    '}',
    '',
    'export function big(): void {',
    '  // NEEDLE big',
    ...big,
    '}',
    '',
  ]
  writeFileSync(path, lines.join('\n'))
  return path
}

/** The `abs:line:text` lines ripgrep prints in content mode with -n. */
const rgHit = (path: string, line: number): string => `${path}:${line}:NEEDLE`

describe('buildSymbolsOutput with bodies', () => {
  test('without bodies: signatures only, and nothing is registered as read', async () => {
    const path = writeSource('plain.ts')
    const out = await buildSymbolsOutput([rgHit(path, 2)])
    expect(out.content).toContain('1-3  export function small(a: number): number')
    expect(out.content).not.toContain('return a + 1')
  })

  test('each matched symbol comes back whole, numbered, and registered as a Read of its lines', async () => {
    const path = writeSource('bodies.ts')
    const readFileState = createFileStateCacheWithSizeLimit(10)
    const out = await buildSymbolsOutput([rgHit(path, 2), rgHit(path, 6)], undefined, { readFileState })
    expect(out.numMatches).toBe(2)
    expect(out.content).toMatch(/1.export function small\(a: number\): number \{\n\s*2.\s*return a \+ 1 \/\/ NEEDLE small\n\s*3.\}/)
    expect(out.content).toContain("return 'NEEDLE other'")
    const entry = readFileState.get(path)
    expect(entry).toBeDefined()
    // The last region registered is `other`; the earlier one is carried in the entry's seen ranges.
    expect(entry?.offset).toBe(5)
    expect(entry?.limit).toBe(3)
  })

  test(`a symbol over ${MAX_BODY_LINES} lines gets a pointer, not its body`, async () => {
    const path = writeSource('big.ts')
    const readFileState = createFileStateCacheWithSizeLimit(10)
    const out = await buildSymbolsOutput([rgHit(path, 10)], undefined, { readFileState })
    expect(out.content).toContain(`lines — Read symbol='big' for the body`)
    expect(out.content).not.toContain('const v3 = 3')
    expect(readFileState.get(path)).toBeUndefined()
  })

  test('past the budget, a pointer instead of the body — and nothing registered for it', async () => {
    const paths: string[] = []
    // Enough small files that their bodies overrun the budget.
    const bodyLine = `  return '${'x'.repeat(200)}' // NEEDLE`
    const count = Math.ceil(BODIES_BUDGET_CHARS / 200) + 5
    for (let i = 0; i < count; i++) {
      const path = join(dir, `many${String(i).padStart(3, '0')}.ts`)
      writeFileSync(path, [`export function f${i}(): string {`, bodyLine, '}', ''].join('\n'))
      paths.push(path)
    }
    const readFileState = createFileStateCacheWithSizeLimit(200)
    const out = await buildSymbolsOutput(paths.map(p => rgHit(p, 2)), undefined, { readFileState })
    expect(out.content).toContain('body not shown, the budget is spent')
    const registered = paths.filter(p => readFileState.get(p) !== undefined).length
    expect(registered).toBeGreaterThan(0)
    expect(registered).toBeLessThan(paths.length)
  })
})

describe('the flag and the result shape', () => {
  test('CLAUDIN_GREP_BODIES is the switch — the name the session A/B sets', () => {
    delete process.env[GREP_BODIES_ENV]
    expect(isGrepBodiesEnabled()).toBe(false)
    process.env.CLAUDIN_GREP_BODIES = '1'
    expect(isGrepBodiesEnabled()).toBe(true)
    delete process.env.CLAUDIN_GREP_BODIES
  })

  test('the schema field exists only with the flag', () => {
    delete process.env[GREP_BODIES_ENV]
    expect(Object.keys(bodiesSchemaFields())).toEqual([])
    process.env[GREP_BODIES_ENV] = '1'
    expect(bodiesSchemaFields().bodies.safeParse(true).success).toBe(true)
  })

  test('a bodies result is told apart by its header', () => {
    expect(isGrepBodiesResult(`Found 2 matched symbols across 1 file${BODIES_HEADER_SUFFIX}\n\nsrc/a.ts`)).toBe(true)
    expect(isGrepBodiesResult('Found 1 matched symbol across 3 files, with their bodies (pagination = x)')).toBe(true)
    expect(isGrepBodiesResult('Found 2 matched symbols across 1 file\n\nsrc/a.ts')).toBe(false)
  })

  // The summarizer would cut a large Grep result; the bodies in it were
  // registered as read, so it has to reach the model whole.
  test('the tool-result summarizer passes a bodies result through, and still summarizes the same text without the suffix', () => {
    const hits = Array.from({ length: 400 }, (_, i) => `src/file${i % 9}.ts:${i + 1}:const NEEDLE_${i} = ${i}`).join('\n')
    const block = (header: string) => ({ type: 'tool_result' as const, tool_use_id: 'toolu_x', content: `${header}\n\n${hits}` })
    const withBodies = block(`Found 400 matched symbols across 9 files${BODIES_HEADER_SUFFIX}`)
    const withoutBodies = block('Found 400 matched symbols across 9 files')
    expect(maybeSummarizeToolResult(withBodies, 'Grep')).toBe(withBodies)
    expect(maybeSummarizeToolResult(withoutBodies, 'Grep').content).not.toBe(withoutBodies.content)
  })
})
