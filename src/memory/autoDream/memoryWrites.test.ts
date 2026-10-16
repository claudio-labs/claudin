import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { memoryWritesFromTranscript, readMemoryWrites } from 'src/memory/autoDream/memoryWrites.js'
import { testMemoryDir, testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

const CWD = '/repo'
const PRIVATE = '/repo/.claudin/memory/'
const GLOBAL = '/home/u/.claudin/memory/'
const ROOTS = testMemoryDirs({ private: PRIVATE, team: `${PRIVATE}team/`, global: GLOBAL })

const toolUse = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'X', input }] }, ...extra })

describe('memoryWritesFromTranscript', () => {
  test('Write, Edit and both sides of a Patch move, once each, in order, indexes left out', () => {
    const lines = [
      toolUse({ file_path: `${PRIVATE}feedback-a.md`, content: '---' }),
      toolUse({ file_path: `${PRIVATE}MEMORY.md`, content: '- [a](feedback-a.md)' }),
      toolUse({ file_path: `${PRIVATE}feedback-a.md`, old_string: 'x', new_string: 'y' }),
      toolUse({
        patchText: `*** Begin Patch\n*** Update File: ${PRIVATE}team/x.md\n*** Move to: ${PRIVATE}team/bugs/x.md\n@@\n-a\n+b\n*** End Patch`,
      }),
      toolUse({ file_path: `${GLOBAL}user-lang.md`, content: '---' }),
    ]
    expect(memoryWritesFromTranscript(lines, CWD, ROOTS)).toEqual([
      `${PRIVATE}feedback-a.md`,
      `${PRIVATE}team/x.md`,
      `${PRIVATE}team/bugs/x.md`,
      `${GLOBAL}user-lang.md`,
    ])
  })

  test('a read, a write outside memory, a user line and a broken line are not writes', () => {
    const lines = [
      toolUse({ file_path: `${PRIVATE}feedback-a.md` }),
      toolUse({ file_path: '/repo/src/x.ts', content: `mentions ${PRIVATE}feedback-a.md` }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_use', input: { file_path: `${PRIVATE}b.md`, content: 'x' } }] } }),
      `{"type":"assistant","tool_use" ${PRIVATE} truncated`,
    ]
    expect(memoryWritesFromTranscript(lines, CWD, ROOTS)).toEqual([])
  })

  test("a relative path resolves against the line's own cwd", () => {
    const line = toolUse({ file_path: '.claudin/memory/project-x.md', content: '---' }, { cwd: '/repo' })
    // The prefilter needs a root in the line; the cwd field carries none here.
    expect(memoryWritesFromTranscript([line], '/elsewhere', ROOTS)).toEqual([])
    const withRoot = toolUse({ file_path: '.claudin/memory/project-x.md', content: `see ${PRIVATE}` }, { cwd: '/repo' })
    expect(memoryWritesFromTranscript([withRoot], '/elsewhere', ROOTS)).toEqual([`${PRIVATE}project-x.md`])
  })
})

describe('a root the transcript JSON escapes', () => {
  test('a backslash in the root path is matched as the JSON line spells it', () => {
    // A Windows root is all backslashes; a POSIX dir may hold one too. The
    // line stores it escaped (`\\`), so a raw substring test never matches.
    const root = '/home/u/we\\ird/.claudin/memory/'
    const line = toolUse({ file_path: `${root}feedback-a.md`, content: '---' })
    expect(line).toContain('we\\\\ird')
    expect(memoryWritesFromTranscript([line], CWD, [testMemoryDir('private', root)])).toEqual([`${root}feedback-a.md`])
  })
})

describe('readMemoryWrites', () => {
  test('streams a transcript file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-writes-'))
    try {
      const path = join(dir, 's.jsonl')
      writeFileSync(path, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n${toolUse({ file_path: `${PRIVATE}a.md`, content: '---' })}\n`)
      expect(await readMemoryWrites(path, CWD, ROOTS)).toEqual([`${PRIVATE}a.md`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
