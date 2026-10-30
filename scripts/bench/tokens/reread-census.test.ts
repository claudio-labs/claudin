import { describe, expect, test } from 'bun:test'
import { type CensusCall, rereadsOfThread } from './reread-census.ts'

const T0 = Date.parse('2026-10-28T12:00:00Z')

function call(tool: string, input: Record<string, unknown>, text: string, extra: Partial<CensusCall> = {}): CensusCall {
  return { tool, input, text, isError: false, result: null, ts: T0, cwd: '/repo', refreshed: [], ...extra }
}

/** A Read result as a sub-agent transcript holds it: numbered lines, no toolUseResult. */
function numbered(from: number, to: number): string {
  return Array.from({ length: to - from + 1 }, (_, i) => `${from + i}→line`).join('\n')
}

const OUTLINE = "File '/repo/a.md' (185 lines) is large — showing a structural outline instead of the full contents.\n## A\n## B"

describe('rereadsOfThread', () => {
  test('an auto outline followed by a body read counts as auto outline → body', () => {
    const counts = rereadsOfThread([
      call('Read', { file_path: '/repo/a.md' }, OUTLINE),
      call('Read', { file_path: '/repo/a.md', offset: 1, limit: 185 }, numbered(1, 185)),
    ])
    expect(counts['reread: auto outline → body']).toBe(1)
    expect(counts.reads).toBe(2)
  })

  test("an outline the model asked for is counted apart from Read's own pivot", () => {
    const counts = rereadsOfThread([
      call('Read', { file_path: '/repo/a.ts', view: 'outline' }, 'Structural outline of /repo/a.ts (900 lines).\n  1-40  function a'),
      call('Read', { file_path: '/repo/a.ts', offset: 1, limit: 40 }, numbered(1, 40)),
    ])
    expect(counts['reread: asked outline → body']).toBe(1)
    expect(counts['reread: auto outline → body']).toBeUndefined()
  })

  test('paging forward is new lines; asking again for lines already shown is a duplicate', () => {
    const counts = rereadsOfThread([
      call('Read', { file_path: '/repo/b.ts', offset: 1, limit: 50 }, numbered(1, 50)),
      call('Read', { file_path: '/repo/b.ts', offset: 51, limit: 50 }, numbered(51, 100)),
      call('Read', { file_path: '/repo/b.ts', offset: 20, limit: 10 }, numbered(20, 29)),
    ])
    expect(counts['reread: new lines']).toBe(1)
    expect(counts['reread: duplicate within 3 calls']).toBe(1)
  })

  test('a duplicate after an hour idle is told apart from one the model just saw', () => {
    const counts = rereadsOfThread([
      call('Read', { file_path: '/repo/b.ts' }, numbered(1, 30)),
      call('Read', { file_path: '/repo/b.ts' }, numbered(1, 30), { ts: T0 + 2 * 3_600_000 }),
    ])
    expect(counts['reread: duplicate after >1h idle']).toBe(1)
  })

  test('a write in between makes the next read a first read', () => {
    const counts = rereadsOfThread([
      call('Read', { file_path: '/repo/c.ts' }, numbered(1, 10)),
      call('Edit', { file_path: '/repo/c.ts', old_string: 'a', new_string: 'b' }, 'ok'),
      call('Read', { file_path: '/repo/c.ts' }, numbered(1, 10)),
      call('Patch', { patchText: '*** Begin Patch\n*** Update File: c.ts\n@@\n-a\n+b\n*** End Patch' }, 'ok'),
      call('Read', { file_path: '/repo/c.ts' }, numbered(1, 10)),
    ])
    expect(Object.keys(counts).filter(k => k.startsWith('reread'))).toEqual([])
  })

  test('a Bash print the filter cut, then the same file read, counts as after a Bash cut', () => {
    const counts = rereadsOfThread([
      call('Bash', { command: 'cd src && cat a.ts b.ts' }, '<bash-output-filtered original="" lines="30/200" reduction="80%">…</bash-output-filtered>'),
      call('Read', { file_path: '/repo/src/b.ts' }, numbered(1, 120)),
    ])
    expect(counts['reread: after a Bash cut']).toBe(1)
  })

  test('a whole Bash print followed by a Read of part of it is a duplicate', () => {
    const counts = rereadsOfThread([
      call('Bash', { command: 'cat src/a.ts' }, 'whole file'),
      call('Read', { file_path: '/repo/src/a.ts', offset: 10, limit: 5 }, numbered(10, 14)),
    ])
    expect(counts['reread: duplicate within 3 calls']).toBe(1)
  })

  test('a batch entry the harness answered unchanged counts as the unchanged stub', () => {
    const counts = rereadsOfThread([
      call('Read', { file_paths: ['/repo/a.ts', '/repo/b.ts'] }, `==> a.ts <==\n${numbered(1, 3)}\n\n==> b.ts <==\n${numbered(1, 3)}`),
      call('Read', { file_paths: ['/repo/a.ts', '/repo/c.ts'] }, `==> a.ts <==\nFile unchanged since last read.\n\n==> c.ts <==\n${numbered(1, 3)}`),
    ])
    expect(counts['reread: unchanged stub']).toBe(1)
    expect(counts.reads).toBe(4)
  })
})
