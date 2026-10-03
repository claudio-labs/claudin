// Characterization of the two byte walkers the resume loader runs on large
// transcripts (unit `sessions/indexingScan`, the boundary half):
//   - the pre-boundary scan, which recovers session metadata written before a
//     compact boundary without parsing the messages around it;
//   - the chain walk, which drops dead fork branches from a transcript buffer
//     before it is parsed.
// Both are driven with real JSONL laid out the way the transcript writer lays
// it out: `parentUuid` first, then `isSidechain`, the uuid and the timestamp.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  scanPreBoundaryMetadata,
  walkChainBeforeParse,
} from 'src/sessions/indexing/boundaryScan.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const readFixture = (name: string) => readFileSync(join(FIXTURES, name))

const SESSION = '5e551a0e-7c3b-4d2a-9f10-2b4c6d8e0a1f'
const uuidOf = (n: number) => `d00dfeed-1111-4222-8333-${n.toString().padStart(12, '0')}`
const stamp = (n: number) => new Date(Date.UTC(2026, 8, 21, 9, 0, n)).toISOString()

type Turn = {
  n: number
  parent: number | null
  sidechain?: boolean
  /** Leave the isSidechain member out, as transcripts from older builds do. */
  bareSidechain?: boolean
  body?: string
}

/** One message line in the transcript writer's member order. */
function turn({ n, parent, sidechain = false, bareSidechain = false, body = `turn ${n}` }: Turn): string {
  const head: Record<string, unknown> = { parentUuid: parent === null ? null : uuidOf(parent) }
  if (!bareSidechain) head.isSidechain = sidechain
  return JSON.stringify({
    ...head,
    type: n % 2 === 0 ? 'assistant' : 'user',
    message: { role: n % 2 === 0 ? 'assistant' : 'user', content: body },
    uuid: uuidOf(n),
    timestamp: stamp(n),
    sessionId: SESSION,
  })
}

const BULK = 'w'.repeat(6000)
const tagLine = (tag: string) => JSON.stringify({ type: 'tag', tag, sessionId: SESSION })
const jsonl = (lines: string[], finalNewline = true) =>
  Buffer.from(lines.join('\n') + (finalNewline ? '\n' : ''))

describe('walkChainBeforeParse', () => {
  test('a forked transcript keeps the live branch and every metadata line, in file order', () => {
    const input = readFixture('forked.input.jsonl')
    const walked = walkChainBeforeParse(input)
    expect(walked.equals(readFixture('forked.walked.jsonl'))).toBe(true)
  })

  test('the input buffer is left as it was', () => {
    const input = readFixture('forked.input.jsonl')
    const copy = Buffer.from(input)
    walkChainBeforeParse(input)
    expect(input.equals(copy)).toBe(true)
  })

  // Each case lists its lines and the indexes of the lines that must survive.
  // `all` means the buffer comes back with the same bytes.
  const progressWithNestedMessage = JSON.stringify({
    parentUuid: uuidOf(1),
    isSidechain: false,
    type: 'progress',
    data: {
      type: 'agent_progress',
      message: { type: 'assistant', uuid: uuidOf(70), timestamp: stamp(70), message: { content: [] } },
    },
    toolUseID: 'toolu_9',
    uuid: uuidOf(3),
    timestamp: stamp(3),
  })
  const resultWithNestedRecord = JSON.stringify({
    parentUuid: uuidOf(1),
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }] },
    uuid: uuidOf(3),
    timestamp: stamp(3),
    toolUseResult: { uuid: uuidOf(71), timestamp: stamp(71), rows: 2 },
  })
  const trickyStrings = JSON.stringify({
    parentUuid: uuidOf(1),
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: ['a "{" quoted brace', 'two {{ opens', 'a path ending C:\\', '}} closes'],
    },
    uuid: uuidOf(3),
    timestamp: stamp(3),
    toolUseResult: { uuid: uuidOf(72), timestamp: stamp(72) },
  })
  const uuidLast = JSON.stringify({
    parentUuid: uuidOf(1),
    isSidechain: false,
    type: 'progress',
    data: { type: 'hook_progress' },
    timestamp: stamp(3),
    uuid: uuidOf(3),
  })
  const parentWithoutUuid = JSON.stringify({ parentUuid: null, type: 'mystery', note: 'no id here' })

  const cases: Array<{ name: string; lines: string[]; keep: number[] | 'all'; finalNewline?: boolean }> = [
    {
      name: 'a straight chain loses nothing',
      lines: [turn({ n: 1, parent: null }), turn({ n: 2, parent: 1 }), turn({ n: 3, parent: 2 })],
      keep: 'all',
    },
    {
      name: 'a dead branch goes and a tag between its lines stays',
      lines: [turn({ n: 1, parent: null }), tagLine('kept'), turn({ n: 2, parent: 1, body: BULK }), turn({ n: 3, parent: 1 })],
      keep: [0, 1, 3],
    },
    {
      name: 'the leaf is the last main-thread message, so a later sidechain line goes',
      lines: [
        turn({ n: 1, parent: null }),
        turn({ n: 2, parent: 1, body: BULK }),
        turn({ n: 3, parent: 1 }),
        turn({ n: 5, parent: 3, sidechain: true, body: BULK }),
      ],
      keep: [0, 2],
    },
    {
      name: 'a line without isSidechain is a leaf even when the next line is a sidechain',
      lines: [
        turn({ n: 1, parent: null, bareSidechain: true }),
        turn({ n: 2, parent: 1, bareSidechain: true, body: BULK }),
        turn({ n: 3, parent: 1, bareSidechain: true }),
        turn({ n: 5, parent: 3, sidechain: true }),
      ],
      keep: [0, 2],
    },
    {
      name: 'only sidechain messages: nothing to anchor on, nothing goes',
      lines: [turn({ n: 1, parent: null, sidechain: true }), turn({ n: 2, parent: null, sidechain: true, body: BULK })],
      keep: 'all',
    },
    {
      name: 'only metadata: nothing goes',
      lines: [tagLine('one'), JSON.stringify({ type: 'summary', summary: BULK, leafUuid: uuidOf(1) })],
      keep: 'all',
    },
    {
      name: 'a parent missing from the file ends the chain',
      lines: [turn({ n: 1, parent: null, body: BULK }), turn({ n: 3, parent: 99 })],
      keep: [1],
    },
    {
      name: 'a parent cycle ends the walk',
      lines: [turn({ n: 9, parent: null, body: BULK }), turn({ n: 1, parent: 2 }), turn({ n: 2, parent: 1 })],
      keep: [1, 2],
    },
    {
      name: 'a nested message before the top-level uuid is not taken for it',
      lines: [turn({ n: 1, parent: null }), turn({ n: 2, parent: 1, body: BULK }), progressWithNestedMessage, turn({ n: 4, parent: 3 })],
      keep: [0, 2, 3],
    },
    {
      name: 'a nested record after the top-level uuid is not taken for it',
      lines: [turn({ n: 1, parent: null }), turn({ n: 2, parent: 1, body: BULK }), resultWithNestedRecord, turn({ n: 4, parent: 3 })],
      keep: [0, 2, 3],
    },
    {
      name: 'braces, escaped quotes and a trailing backslash inside strings do not count as nesting',
      lines: [turn({ n: 1, parent: null }), turn({ n: 2, parent: 1, body: BULK }), trickyStrings, turn({ n: 4, parent: 3 })],
      keep: [0, 2, 3],
    },
    {
      name: 'a message whose uuid is its last member is still linked',
      lines: [turn({ n: 1, parent: null }), turn({ n: 2, parent: 1, body: BULK }), uuidLast, turn({ n: 4, parent: 3 })],
      keep: [0, 2, 3],
    },
    {
      name: 'a parentUuid line without a uuid is kept like metadata',
      lines: [turn({ n: 1, parent: null }), parentWithoutUuid, turn({ n: 2, parent: 1, body: BULK }), turn({ n: 3, parent: 1 })],
      keep: [0, 1, 3],
    },
  ]

  for (const { name, lines, keep, finalNewline = true } of cases) {
    test(name, () => {
      const input = jsonl(lines, finalNewline)
      const expected = keep === 'all' ? input : jsonl(keep.map(i => lines[i]!), finalNewline)
      expect(walkChainBeforeParse(input).toString()).toBe(expected.toString())
    })
  }

  test('a last line without a newline comes out without one', () => {
    const lines = [turn({ n: 1, parent: null }), turn({ n: 2, parent: 1, body: BULK }), turn({ n: 3, parent: 1 }), tagLine('end')]
    const out = walkChainBeforeParse(jsonl(lines, false)).toString()
    expect(out).toBe([lines[0], lines[2], lines[3]].join('\n'))
  })

  test('an empty buffer comes back empty', () => {
    expect(walkChainBeforeParse(Buffer.alloc(0)).length).toBe(0)
  })

  // The cut happens only when the lines off the chain are at least half the
  // buffer, rounded down. Two roots: the first is dead, the second is the leaf.
  test.each([
    { deadShorterBy: 1, cut: true },
    { deadShorterBy: 0, cut: true },
    { deadShorterBy: 2, cut: false },
    { deadShorterBy: 3, cut: false },
  ])('dead bytes $deadShorterBy short of the live bytes: cut = $cut', ({ deadShorterBy, cut }) => {
    const live = turn({ n: 1, parent: null, body: 'x'.repeat(400) })
    const dead = turn({ n: 3, parent: null, body: 'x'.repeat(400 - deadShorterBy) })
    expect(Buffer.byteLength(dead)).toBe(Buffer.byteLength(live) - deadShorterBy)
    const input = jsonl([dead, live])
    const out = walkChainBeforeParse(input).toString()
    expect(out).toBe(cut ? `${live}\n` : input.toString())
  })

  test('metadata bytes count with the dead ones when deciding to cut', () => {
    // The dead message alone is far from half the buffer; with the summary it is over.
    const summary = JSON.stringify({ type: 'summary', summary: BULK, leafUuid: uuidOf(3) })
    const lines = [summary, turn({ n: 1, parent: null }), turn({ n: 2, parent: 1 }), turn({ n: 3, parent: 1 })]
    expect(walkChainBeforeParse(jsonl(lines)).toString()).toBe(jsonl([summary, lines[1]!, lines[3]!]).toString())
  })
})

describe('scanPreBoundaryMetadata', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'indexing-scan-boundary-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writeTranscript = (text: string) => {
    const path = join(dir, `${SESSION}.jsonl`)
    writeFileSync(path, text)
    return path
  }

  test('returns the ten session-metadata kinds written before the boundary, in order, without newlines', async () => {
    const path = join(FIXTURES, 'pre-boundary.jsonl')
    const text = readFileSync(path, 'utf8')
    const boundaryAt = Buffer.byteLength(text.slice(0, text.indexOf('"subtype":"compact_boundary"')).replace(/[^\n]*$/, ''))
    const lines = await scanPreBoundaryMetadata(path, boundaryAt)
    const expected = readFileSync(join(FIXTURES, 'pre-boundary.metadata.jsonl'), 'utf8').trimEnd().split('\n')
    expect(lines).toEqual(expected)
    expect(lines.map(l => JSON.parse(l).type)).toEqual([
      'summary',
      'custom-title',
      'tag',
      'agent-name',
      'agent-color',
      'agent-setting',
      'mode',
      'worktree-state',
      'cost-state',
      'pr-link',
    ])
  })

  test('reading to the end of the file also returns metadata written after the boundary', async () => {
    const path = join(FIXTURES, 'pre-boundary.jsonl')
    const size = readFileSync(path).length
    const all = await scanPreBoundaryMetadata(path, size)
    // Reading to the end picks up the tag written after the boundary too.
    expect(all.at(-1)).toContain('"tag":"after-boundary"')
    expect(all).toHaveLength(11)
  })

  test('the byte at the end offset is not read', async () => {
    // `{"type":"tag"` is 13 bytes: cut one byte short of it, the marker is incomplete.
    const message = turn({ n: 1, parent: null })
    const text = `${message}\n${tagLine('cut')}\n`
    const path = writeTranscript(text)
    const tagStart = Buffer.byteLength(message) + 1
    expect(await scanPreBoundaryMetadata(path, tagStart + 12)).toEqual([])
    expect(await scanPreBoundaryMetadata(path, tagStart + 13)).toEqual(['{"type":"tag"'])
  })

  test('a transcript of messages only gives nothing', async () => {
    const text = [turn({ n: 1, parent: null }), turn({ n: 2, parent: 1 })].join('\n') + '\n'
    expect(await scanPreBoundaryMetadata(writeTranscript(text), text.length)).toEqual([])
  })

  test('the last line needs no newline', async () => {
    const tag = tagLine('closing')
    const text = `${turn({ n: 1, parent: null })}\n${tag}`
    expect(await scanPreBoundaryMetadata(writeTranscript(text), text.length)).toEqual([tag])
  })

  test('an end past the file reads the whole file', async () => {
    const tag = tagLine('whole')
    const text = `${tag}\n${turn({ n: 1, parent: null })}\n`
    expect(await scanPreBoundaryMetadata(writeTranscript(text), text.length + 4096)).toEqual([tag])
  })

  test('a missing file rejects', async () => {
    await expect(scanPreBoundaryMetadata(join(dir, 'gone.jsonl'), 10)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // A file is read in pieces, so a metadata line may start anywhere relative
  // to a piece. Shift one across the first and second 64 KiB marks, with and
  // without other metadata earlier in the piece.
  const MARK = 64 * 1024
  const title = JSON.stringify({ type: 'custom-title', customTitle: 'crossing', sessionId: SESSION })
  const shifts = [-400, -200, -26, -25, -24, -23, -10, -2, -1, 0, 1, 2]
  for (const mark of [MARK, 2 * MARK]) {
    for (const earlyTag of [false, true]) {
      test(`a title starting at ${mark} + offset is found (offsets ${shifts.join(', ')}; early tag ${earlyTag})`, async () => {
        for (const shift of shifts) {
          const before = earlyTag ? `${tagLine('early')}\n` : ''
          const startAt = mark + shift
          // A filler message line ends exactly where the title begins.
          const fillerBody = 'f'.repeat(startAt - before.length - Buffer.byteLength(turn({ n: 1, parent: null, body: '' })) - 1)
          const filler = turn({ n: 1, parent: null, body: fillerBody })
          const text = `${before}${filler}\n${title}\n${turn({ n: 2, parent: 1 })}\n`
          expect(Buffer.byteLength(`${before}${filler}\n`)).toBe(startAt)
          const found = await scanPreBoundaryMetadata(writeTranscript(text), Buffer.byteLength(text))
          expect({ shift, found }).toEqual({ shift, found: earlyTag ? [tagLine('early'), title] : [title] })
        }
      })
    }
  }

  test('a title after a message line several pieces long is found', async () => {
    const huge = turn({ n: 1, parent: null, body: 'h'.repeat(300 * 1024) })
    const text = `${tagLine('first')}\n${huge}\n${title}\n`
    const found = await scanPreBoundaryMetadata(writeTranscript(text), Buffer.byteLength(text))
    expect(found).toEqual([tagLine('first'), title])
  })

  test('a metadata line of a few KiB crossing a piece boundary comes back whole', async () => {
    const long = JSON.stringify({ type: 'summary', summary: 's'.repeat(5000), leafUuid: uuidOf(1) })
    const filler = turn({ n: 1, parent: null, body: 'f'.repeat(MARK - 2000) })
    const text = `${filler}\n${long}\n`
    const found = await scanPreBoundaryMetadata(writeTranscript(text), Buffer.byteLength(text))
    expect(found).toEqual([long])
  })
})
