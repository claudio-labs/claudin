import { describe, expect, test } from 'bun:test'
import type { SymbolEntry } from 'src/tools/shared/codeOutline/scanSymbols.js'
import {
  type CensusCall,
  type FileView,
  type LeverOp,
  type LeverStep,
  leverStepsOf,
  leverVerdict,
  replayLevers,
  rereadsOfThread,
} from './reread-census.ts'

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

function symbol(startLine: number, endLine: number, depth = 0): SymbolEntry {
  return { name: `s${startLine}`, kind: 'function', signature: `function s${startLine}()`, startLine, endLine, depth }
}

/** A file of `lines` ten-char lines (eleven with the newline) and the symbols given. */
function view(lines: number, ...symbols: SymbolEntry[]): FileView {
  return { lines: Array.from({ length: lines }, () => 'x'.repeat(10)), symbols }
}

function slice(from: number, to: number, file = '/repo/a.ts'): LeverOp {
  return { kind: 'read', file, range: [from, to], slice: true, limit: to - from + 1 }
}

function grep(file: string, ...lines: number[]): LeverOp {
  return { kind: 'grep', matches: new Map([[file, lines]]) }
}

const WRITE: LeverOp = { kind: 'write', file: '/repo/a.ts' }
const IDLE: LeverStep = { tools: 0, ops: [] }

/** One API call per argument, each op its only tool; pass a LeverStep to say otherwise. */
function thread(...steps: (LeverOp | LeverStep)[]): LeverStep[] {
  return steps.map(step => ('ops' in step ? step : { tools: 1, ops: [step] }))
}

function lookupOf(files: Record<string, FileView>): (path: string) => FileView | null {
  return path => files[path] ?? null
}

describe('leverStepsOf', () => {
  test('one step per API call, with its tool count and what each tool read, searched or wrote', () => {
    const steps = leverStepsOf([
      [
        call('Read', { file_path: '/repo/a.ts', offset: 10, limit: 5 }, numbered(10, 14)),
        call('Grep', { pattern: 'x', output_mode: 'content' }, 'src/b.ts:7:x\nsrc/b.ts-8-y\nsrc/c.ts:3:x'),
      ],
      [],
      [call('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 'ok')],
      [call('Read', { file_path: '/repo/a.ts' }, numbered(1, 30))],
    ])
    expect(steps.map(s => s.tools)).toEqual([2, 0, 1, 1])
    expect(steps[0]!.ops).toEqual([
      { kind: 'read', file: '/repo/a.ts', range: [10, 14], slice: true, limit: 5 },
      { kind: 'grep', matches: new Map([['/repo/src/b.ts', [7]], ['/repo/src/c.ts', [3]]]) },
    ])
    expect(steps[2]!.ops).toEqual([{ kind: 'write', file: '/repo/a.ts' }])
    expect(steps[3]!.ops).toEqual([{ kind: 'read', file: '/repo/a.ts', range: [1, 30], slice: false, limit: null }])
  })

  test('a Grep reads its matches off the structured result, a regrouped text or a one-file search', () => {
    const matchesOf = (input: Record<string, unknown>, text: string, extra: Partial<CensusCall> = {}) =>
      leverStepsOf([[call('Grep', { pattern: 'x', output_mode: 'content', ...input }, text, extra)]])[0]!.ops
    expect(matchesOf({}, 'regrouped', { result: { mode: 'content', content: 'src/b.ts:7:x' } })).toEqual([grep('/repo/src/b.ts', 7)])
    expect(matchesOf({}, '--- src/b.ts ---\n7:x\n8-y\n12:x')).toEqual([grep('/repo/src/b.ts', 7, 12)])
    expect(matchesOf({ path: 'src/b.ts' }, '7:x\n9:x')).toEqual([grep('/repo/src/b.ts', 7, 9)])
    // Another mode, or a content search the tool answered as a symbol map, offers no match lines.
    expect(matchesOf({ output_mode: 'files_with_matches' }, 'src/b.ts')).toEqual([])
    expect(matchesOf({}, 'src/b.ts\n  1-9  function a', { result: { mode: 'symbols', content: 'src/b.ts:7:x' } })).toEqual([])
  })
})

describe('replayLevers: grep bodies', () => {
  const files = lookupOf({ '/repo/a.ts': view(300, symbol(10, 30), symbol(40, 200)) })

  test('a range Read inside a matched body within three calls is served, and saved when alone', () => {
    const { grep: tally, rangeReads } = replayLevers(thread(grep('/repo/a.ts', 12), IDLE, IDLE, slice(15, 25)), files)
    expect(tally).toEqual({ triggers: 1, served: 1, saved: 1, repeats: 0, returnedChars: 21 * 11, servedChars: 11 * 11 })
    expect(rangeReads).toBe(1)
  })

  test('a served Read that shared its API call removes no call', () => {
    const steps = thread(grep('/repo/a.ts', 12), { tools: 2, ops: [slice(15, 25)] })
    expect(replayLevers(steps, files).grep).toMatchObject({ served: 1, saved: 0 })
  })

  test('not served: outside the body, a fourth call later, in the same call, or after a write', () => {
    const served = (...steps: (LeverOp | LeverStep)[]) => replayLevers(thread(...steps), files).grep.served
    expect(served(grep('/repo/a.ts', 12), slice(25, 35))).toBe(0)
    expect(served(grep('/repo/a.ts', 12), IDLE, IDLE, IDLE, slice(15, 25))).toBe(0)
    expect(served({ tools: 2, ops: [grep('/repo/a.ts', 12), slice(15, 25)] })).toBe(0)
    expect(served(grep('/repo/a.ts', 12), WRITE, slice(15, 25))).toBe(0)
  })

  test('no bodies when a matched symbol is over the line cap, the symbols are over five, or the budget is spent', () => {
    const triggers = (lookup: (path: string) => FileView | null, ...lines: number[]) =>
      replayLevers(thread(grep('/repo/a.ts', ...lines)), lookup).grep.triggers
    expect(triggers(files, 12)).toBe(1)
    expect(triggers(files, 12, 50)).toBe(0)
    const six = lookupOf({ '/repo/a.ts': view(300, ...[1, 11, 21, 31, 41, 51].map(n => symbol(n, n + 5))) })
    expect(triggers(six, 1, 11, 21, 31, 41)).toBe(1)
    expect(triggers(six, 1, 11, 21, 31, 41, 51)).toBe(0)
    const wide: FileView = { lines: Array.from({ length: 100 }, () => 'x'.repeat(200)), symbols: [symbol(1, 60)] }
    expect(triggers(lookupOf({ '/repo/a.ts': wide }), 5)).toBe(0)
    // A match outside every symbol has no body to carry.
    expect(triggers(files, 35)).toBe(0)
  })

  test('a Read the thread had already been shown is a repeat, not a served read', () => {
    const steps = thread(slice(15, 25), grep('/repo/a.ts', 12), slice(15, 25))
    expect(replayLevers(steps, files).grep).toMatchObject({ served: 0, saved: 0, repeats: 1 })
  })
})

describe('replayLevers: a small range snaps to its symbol', () => {
  const files = lookupOf({ '/repo/a.ts': view(400, symbol(10, 60), symbol(100, 399), symbol(120, 140, 1)), '/repo/notes.txt': view(400) })

  test('a later range Read inside the snapped symbol is served', () => {
    const { snap } = replayLevers(thread(slice(20, 24), slice(40, 55)), files)
    // The symbol is 51 lines and 5 were asked for; the second Read is 16 lines.
    expect(snap).toEqual({ triggers: 1, served: 1, saved: 1, repeats: 0, returnedChars: 46 * 11, servedChars: 16 * 11 })
  })

  test('a served Read that shared its API call removes no call, and snaps nothing itself', () => {
    const steps = thread(slice(20, 24), { tools: 3, ops: [slice(40, 55)] })
    expect(replayLevers(steps, files).snap).toMatchObject({ triggers: 1, served: 1, saved: 0 })
  })

  test('not served: a limit over 80, a range past the symbol, a write in between, a file with no symbols', () => {
    const tally = (...steps: (LeverOp | LeverStep)[]) => replayLevers(thread(...steps), files).snap
    const wide: LeverOp = { kind: 'read', file: '/repo/a.ts', range: [20, 24], slice: true, limit: 81 }
    // The 81-line ask snaps nothing, so the second Read is made, and is the one that snaps.
    expect(tally(wide, slice(40, 55))).toMatchObject({ triggers: 1, served: 0 })
    expect(tally(wide)).toMatchObject({ triggers: 0 })
    expect(tally(slice(20, 24), slice(55, 70))).toMatchObject({ triggers: 2, served: 0 })
    expect(tally(slice(20, 24), WRITE, slice(40, 55))).toMatchObject({ triggers: 2, served: 0 })
    expect(tally(slice(20, 24, '/repo/notes.txt'), slice(40, 55, '/repo/notes.txt'))).toMatchObject({ triggers: 0, served: 0 })
  })

  test('a symbol that would add over 150 lines is left out, and the one inside it is kept', () => {
    // 300 lines around the range: nothing is added, so nothing is served.
    expect(replayLevers(thread(slice(200, 204), slice(210, 220)), files).snap).toMatchObject({ triggers: 0, served: 0 })
    // Lines 125-129 sit in the 21-line method and in the 300-line class: only the method comes back.
    expect(replayLevers(thread(slice(125, 129), slice(120, 124), slice(150, 160)), files).snap).toMatchObject({
      triggers: 1, served: 1, returnedChars: 16 * 11,
    })
  })

  test('a Read the real reads had covered is a repeat: made anyway, and it snaps like any other', () => {
    const { snap } = replayLevers(thread(slice(20, 24), slice(20, 24), slice(40, 55)), files)
    expect(snap).toMatchObject({ triggers: 2, served: 1, repeats: 1 })
  })
})

describe('replayLevers: the whole file on the third slice', () => {
  const files = lookupOf({ '/repo/a.ts': view(300), '/repo/long.ts': view(601), '/repo/wide.ts': { lines: Array.from({ length: 300 }, () => 'x'.repeat(100)), symbols: [] } })
  const paging = (file: string, ...extra: (LeverOp | LeverStep)[]) => thread(slice(1, 50, file), slice(51, 100, file), slice(101, 150, file), ...extra)

  test('every range Read after the third distinct one is served', () => {
    const { whole } = replayLevers(paging('/repo/a.ts', slice(151, 200), { tools: 2, ops: [slice(201, 250)] }), files)
    // The file less the third slice comes back; two 50-line Reads are not made, one of them alone.
    expect(whole).toEqual({ triggers: 1, served: 2, saved: 1, repeats: 0, returnedChars: 250 * 11, servedChars: 100 * 11 })
  })

  test('the same range asked three times is one slice', () => {
    const steps = thread(slice(1, 50), slice(1, 50), slice(1, 50), slice(51, 100))
    expect(replayLevers(steps, files).whole).toMatchObject({ triggers: 0, served: 0 })
  })

  test('not served: a file over 600 lines or over 25,000 chars, or a write before the next Read', () => {
    const tally = (steps: LeverStep[]) => replayLevers(steps, files).whole
    expect(tally(paging('/repo/long.ts', slice(151, 200, '/repo/long.ts')))).toMatchObject({ triggers: 0, served: 0 })
    expect(tally(paging('/repo/wide.ts', slice(151, 200, '/repo/wide.ts')))).toMatchObject({ triggers: 0, served: 0 })
    expect(tally(paging('/repo/a.ts', WRITE, slice(151, 200)))).toMatchObject({ triggers: 1, served: 0 })
  })

  test('a later Read of lines the thread had read itself is a repeat', () => {
    expect(replayLevers(paging('/repo/a.ts', slice(60, 90)), files).whole).toMatchObject({ served: 0, repeats: 1 })
  })
})

describe('replayLevers: files that cannot be replayed', () => {
  test('a range Read of a file that is gone or shorter than the range is unresolvable and counts nowhere', () => {
    const files = lookupOf({ '/repo/a.ts': view(40, symbol(10, 40)) })
    const counts = replayLevers(thread(slice(20, 24), slice(30, 60), slice(1, 5, '/repo/gone.ts'), grep('/repo/gone.ts', 3), grep('/repo/a.ts', 90)), files)
    expect(counts.unresolvable).toBe(2)
    expect(counts.unresolvableGreps).toBe(2)
    expect(counts.rangeReads).toBe(1)
    expect(counts.aloneRangeReads).toBe(1)
    expect(counts.snap).toMatchObject({ triggers: 1, served: 0 })
    expect(counts.grep.triggers).toBe(0)
  })
})

describe('leverVerdict', () => {
  const tally = { triggers: 10, served: 4, saved: 2, repeats: 0, returnedChars: 48_000, servedChars: 8_000 }

  test('passes with saved calls at 2% of the main calls and a positive net', () => {
    // 10,000 tokens added at $8/M is $0.08 against two calls at $0.105.
    const verdict = leverVerdict(tally, 100, 0.105, 8)
    expect(verdict).toMatchObject({ addedChars: 40_000, addedTokens: 10_000, pass: true, why: '' })
    expect(verdict.netUsd).toBeCloseTo(0.13, 5)
  })

  test('fails naming the half that failed', () => {
    expect(leverVerdict(tally, 101, 0.105, 8)).toMatchObject({ pass: false, why: 'saved calls 2.0% of main API calls, under 2%' })
    expect(leverVerdict(tally, 100, 0.105, 30).why).toBe('net $-0.09, not above 0')
    expect(leverVerdict(tally, 1000, 0.01, 8).why).toBe('saved calls 0.2% of main API calls, under 2%; net $-0.06, not above 0')
  })
})
