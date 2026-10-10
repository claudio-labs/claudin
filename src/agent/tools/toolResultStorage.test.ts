import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

import {
  buildLargeToolResultMessage,
  getSessionSpillDir,
  pageForModel,
  processPreMappedToolResultBlock,
  processToolResultBlock,
  unlinkSessionSpillDir,
} from 'src/agent/tools/toolResultStorage.ts'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'

describe('unlinkSessionSpillDir', () => {
  // Isolate filesystem side effects in a hermetic config dir so the test
  // never touches ~/.claudin. CLAUDIN_CONFIG_DIR flows through
  // getClaudinConfigHomeDir → getProjectsDir → getProjectDir.
  const prevConfigDir = process.env.CLAUDIN_CONFIG_DIR
  const testConfigDir = join(
    tmpdir(),
    `claudin-test-spill-${process.pid}-${Date.now()}`,
  )

  beforeAll(() => {
    process.env.CLAUDIN_CONFIG_DIR = testConfigDir
    mkdirSync(testConfigDir, { recursive: true })
  })

  // Track every dir we create so afterAll can remove them even when a leaked
  // getProjectDir stub redirects getSessionSpillDir away from testConfigDir.
  const createdDirs: string[] = []

  afterAll(() => {
    if (prevConfigDir === undefined) {
      delete process.env.CLAUDIN_CONFIG_DIR
    } else {
      process.env.CLAUDIN_CONFIG_DIR = prevConfigDir
    }
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
    rmSync(testConfigDir, { recursive: true, force: true })
  })

  // Build the spill dir through the same getSessionSpillDir() the code under
  // test uses, so this test always targets the exact directory
  // unlinkSessionSpillDir will delete — never an independently-derived path
  // that a sibling's leaked getProjectDir mock could send elsewhere.
  function makeSessionSpillDir(sessionId: string, fileCount: number): string {
    const spillDir = getSessionSpillDir(sessionId)
    mkdirSync(spillDir, { recursive: true })
    createdDirs.push(spillDir)
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(spillDir, `tool_${i}.txt`), 'X'.repeat(1_000))
    }
    return spillDir
  }

  test('removes the tool-results directory for the given session', async () => {
    const sessionId = `sess-remove-${Date.now()}`
    const dir = makeSessionSpillDir(sessionId, 5)
    expect(existsSync(dir)).toBe(true)

    await unlinkSessionSpillDir(sessionId)

    expect(existsSync(dir)).toBe(false)
  })

  test('leaves unrelated sessions untouched', async () => {
    const victim = `sess-victim-${Date.now()}`
    const survivor = `sess-survivor-${Date.now()}`
    const victimDir = makeSessionSpillDir(victim, 3)
    const survivorDir = makeSessionSpillDir(survivor, 3)

    await unlinkSessionSpillDir(victim)

    expect(existsSync(victimDir)).toBe(false)
    expect(existsSync(survivorDir)).toBe(true)
    expect(existsSync(join(survivorDir, 'tool_0.txt'))).toBe(true)
  })

  test('is a no-op when the session directory does not exist', async () => {
    // Force: true swallows ENOENT — this just verifies we don't throw.
    await expect(
      unlinkSessionSpillDir(`sess-nonexistent-${Date.now()}`),
    ).resolves.toBeUndefined()
  })

  test('is a no-op when sessionId is empty', async () => {
    // Guard: empty string must never escalate to "rm -rf projectDir/" via
    // join() treating it as a path segment. The early return protects this.
    const sentinel = `sess-sentinel-${Date.now()}`
    const sentinelDir = makeSessionSpillDir(sentinel, 2)

    await unlinkSessionSpillDir('')

    // Nothing near the projectDir root was touched
    expect(existsSync(sentinelDir)).toBe(true)
  })
})

// Nothing is cut under the line: an agent report ships as it came, blocks and
// all, whatever its middle holds (Explore quotes the lines a caller edits from).
describe('an agent report under its line', () => {
  const report = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n')
  const block = (id: string): ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: id,
    content: [{ type: 'text', text: report }],
  })
  const tool = {
    name: AGENT_TOOL_NAME,
    maxResultSizeChars: 100_000,
    mapToolResultToToolResultBlockParam: (_: unknown, id: string) => block(id),
  }

  test('ships untouched through the pre-mapped path', async () => {
    const out = await processPreMappedToolResultBlock(block('toolu_a'), tool)
    expect(out.content).toEqual([{ type: 'text', text: report }])
  })

  test('ships untouched through processToolResultBlock', async () => {
    const out = await processToolResultBlock(tool, {}, 'toolu_b')
    expect(out.content).toEqual([{ type: 'text', text: report }])
  })
})

// Past its tool's line a result is paged, never summarized: the pointer, then
// lines 1–K exactly; the saved file holds every line after them.
describe('paging past the persistence line', () => {
  const prevConfigDir = process.env.CLAUDIN_CONFIG_DIR
  const testConfigDir = join(tmpdir(), `claudin-test-page-${process.pid}-${Date.now()}`)
  beforeAll(() => {
    process.env.CLAUDIN_CONFIG_DIR = testConfigDir
    mkdirSync(testConfigDir, { recursive: true })
  })
  afterAll(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = prevConfigDir
    rmSync(testConfigDir, { recursive: true, force: true })
  })

  const lines = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}: ${'p'.repeat(40)}`).join('\n')

  /** The pointer's line count, the page, and the saved file, from a paged message. */
  function readPage(message: string): { shown: number; page: string; file: string } {
    const pointer = /^Lines 1-(\d+) are below; Read the file with offset=(\d+) and limit=(\d+) for the next page\.$/m.exec(message)!
    expect(Number(pointer[2])).toBe(Number(pointer[1]) + 1)
    expect(Number(pointer[3])).toBe(Number(pointer[1]))
    const path = /Full output saved to: (\S+)\n/.exec(message)![1]!
    const page = message.slice(message.indexOf('\n\n') + 2, message.lastIndexOf('\n</persisted-output>'))
    return { shown: Number(pointer[1]), page, file: readFileSync(path, 'utf8') }
  }

  test('pageForModel cuts at a line boundary, or gives the head of a line longer than the page', () => {
    expect(pageForModel('a\nb\nc', 100)).toEqual({ page: 'a\nb\nc', shownLines: 3 })
    expect(pageForModel('aaa\nbbb\nccc', 9)).toEqual({ page: 'aaa\nbbb', shownLines: 2 })
    expect(pageForModel('x'.repeat(50), 10)).toEqual({ page: 'x'.repeat(10), shownLines: 0 })
    // Leading empty lines are lines: they are counted and shown.
    expect(pageForModel(`\n${'x'.repeat(50)}`, 10)).toEqual({ page: '', shownLines: 1 })
    expect(pageForModel(`\n\n${'x'.repeat(50)}`, 10)).toEqual({ page: '\n', shownLines: 2 })
    // Never half of a surrogate pair.
    expect(pageForModel('😀'.repeat(20), 11).page).toBe('😀'.repeat(5))
  })

  test('a head is not the whole: its last line may be cut short and is never shown', () => {
    expect(pageForModel('a\nb\nhalf of c', 100, false)).toEqual({ page: 'a\nb', shownLines: 2 })
    expect(pageForModel('a\nb\n', 100, false)).toEqual({ page: 'a\nb', shownLines: 2 })
    // A byte cap that split a character leaves a replacement char; a head with no
    // line end at all is line 1's start, without it.
    expect(pageForModel('abc\uFFFD', 100, false)).toEqual({ page: 'abc', shownLines: 0 })
  })

  test('the message fits the line, puts the pointer first, and the page is the first lines exactly', () => {
    const text = lines(2_000)
    const message = buildLargeToolResultMessage({ filepath: '/tmp/x.txt', originalSize: text.length }, text, 20_000)
    expect(message.length).toBeLessThanOrEqual(20_000)
    expect(message.split('\n')[1]).toStartWith('Output too large (')
    expect(message.split('\n')[2]).toMatch(/^Lines 1-\d+ are below; Read the file with offset=\d+ and limit=\d+ for the next page\.$/)
    const shown = Number(/Lines 1-(\d+)/.exec(message)![1])
    expect(message).toContain(`\n\n${text.split('\n').slice(0, shown).join('\n')}\n</persisted-output>`)
  })

  test('a first line longer than the page still fits the line, and says how to go on', () => {
    const message = buildLargeToolResultMessage({ filepath: '/tmp/x.txt', originalSize: 40_000 }, 'y'.repeat(40_000), 30_000)
    expect(message.length).toBeLessThanOrEqual(30_000)
    expect(message).toMatch(/^Line 1 alone is longer than this page: its first (\d+) chars are below\. Read cannot split a line; fetch the rest with Bash, from character \d+\.$/m)
  })

  test('a result past its line is saved whole and paged: page + the file from the pointer = the original', async () => {
    const text = lines(3_000)
    const out = await processPreMappedToolResultBlock(
      { type: 'tool_result', tool_use_id: 'toolu_page_string', content: text },
      { name: 'SomeTool', maxResultSizeChars: 10_000 },
    )
    const message = String(out.content)
    expect(message.length).toBeLessThanOrEqual(10_000)
    const { shown, page, file } = readPage(message)
    expect(file).toBe(text)
    const fileLines = file.split('\n')
    expect([...page.split('\n'), ...fileLines.slice(shown)]).toEqual(fileLines)
  })

  test('a text-block result is saved as joined text, so Read offsets are its lines', async () => {
    const blocks = [
      { type: 'text' as const, text: lines(1_500) },
      { type: 'text' as const, text: lines(1_500) },
    ]
    const out = await processPreMappedToolResultBlock(
      { type: 'tool_result', tool_use_id: 'toolu_page_blocks', content: blocks },
      { name: 'SomeTool', maxResultSizeChars: 10_000 },
    )
    const { file } = readPage(String(out.content))
    expect(file).toBe(`${blocks[0]!.text}\n${blocks[1]!.text}`)
  })

  test('an id seen again with other bytes gets its own file, so each page matches its file', async () => {
    const tool = { name: 'SomeTool', maxResultSizeChars: 10_000 }
    const first = lines(3_000)
    const second = first.replaceAll('row', 'ROW')
    const a = readPage(String((await processPreMappedToolResultBlock({ type: 'tool_result', tool_use_id: 'xml_tc_1', content: first }, tool)).content))
    const b = readPage(String((await processPreMappedToolResultBlock({ type: 'tool_result', tool_use_id: 'xml_tc_1', content: second }, tool)).content))
    expect(a.file).toBe(first)
    expect(b.file).toBe(second)
    // And the same bytes again reuse the first file.
    const again = readPage(String((await processPreMappedToolResultBlock({ type: 'tool_result', tool_use_id: 'xml_tc_1', content: first }, tool)).content))
    expect(again.file).toBe(first)
  })

  test('nothing is let through unsized: a result that merely opens like a page is paged too', async () => {
    const block: ToolResultBlockParam = { type: 'tool_result', tool_use_id: 'toolu_lookalike', content: `<persisted-output>\n${lines(3_000)}` }
    const out = await processPreMappedToolResultBlock(block, { name: 'SomeTool', maxResultSizeChars: 10_000 })
    expect(String(out.content).length).toBeLessThanOrEqual(10_000)
  })
})
