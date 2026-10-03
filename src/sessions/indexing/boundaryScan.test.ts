// Unit tests for the byte walkers beyond the characterization suite: the fix
// decisions of the spec (an empty range, a nested isSidechain) and the seams
// between the pieces the pre-boundary scan reads.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  scanPreBoundaryMetadata,
  walkChainBeforeParse,
} from 'src/sessions/indexing/boundaryScan.js'

const uuidOf = (n: number) => `0b5e55ed-2222-4333-8444-${n.toString().padStart(12, '0')}`
const PIECE = 256 * 1024

function message(n: number, parent: number | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: parent === null ? null : uuidOf(parent),
    isSidechain: false,
    type: n % 2 === 0 ? 'assistant' : 'user',
    message: { content: `turn ${n}` },
    uuid: uuidOf(n),
    timestamp: '2026-10-03T10:00:00.000Z',
    ...extra,
  })
}
const tag = (name: string) => JSON.stringify({ type: 'tag', tag: name })
const jsonl = (lines: string[]) => Buffer.from(`${lines.join('\n')}\n`)

describe('walkChainBeforeParse: only the top-level isSidechain makes a sidechain line', () => {
  const bulk = 'b'.repeat(4000)
  // Turn 2 is a fat dead branch when turn 3 is the leaf.
  const deadBranch = message(2, 1, { message: { content: bulk } })
  const cases = [
    {
      name: 'a nested "isSidechain":true in a tool result keeps the line a leaf',
      lines: [message(1, null), deadBranch, message(3, 1, { toolUseResult: { isSidechain: true, rows: 1 } })],
      keep: [0, 2],
    },
    {
      name: 'the bytes inside a string do not count either',
      lines: [message(1, null), deadBranch, message(3, 1, { message: { content: 'log "isSidechain":true seen' } })],
      keep: [0, 2],
    },
    {
      name: 'a top-level "isSidechain":true still does',
      lines: [
        message(1, null),
        message(2, 1),
        JSON.stringify({ parentUuid: uuidOf(1), isSidechain: true, note: bulk, uuid: uuidOf(3), timestamp: 't' }),
      ],
      keep: [0, 1],
    },
  ]
  for (const { name, lines, keep } of cases) {
    test(name, () => {
      expect(walkChainBeforeParse(jsonl(lines)).toString()).toBe(jsonl(keep.map(i => lines[i]!)).toString())
    })
  }

  test('a uuid member of the wrong length leaves the line as metadata', () => {
    // Members after it leave 36 bytes to read, so only the closing quote rules it out.
    const odd = JSON.stringify({ parentUuid: uuidOf(1), isSidechain: false, uuid: 'short', timestamp: 't'.repeat(60) })
    const lines = [message(1, null), message(2, 1, { message: { content: bulk } }), odd]
    // The leaf is turn 2, so nothing is off the chain and the bytes come back as given.
    const input = jsonl(lines)
    expect(walkChainBeforeParse(input)).toBe(input)
  })
})

describe('scanPreBoundaryMetadata', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boundary-scan-unit-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const write = (text: string) => {
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, text)
    return path
  }

  test.each([0, -1])('an end offset of %p is an empty range', async endOffset => {
    expect(await scanPreBoundaryMetadata(write(`${tag('t')}\n`), endOffset)).toEqual([])
  })

  test('an empty range on a missing file still rejects', async () => {
    await expect(scanPreBoundaryMetadata(join(dir, 'gone.jsonl'), 0)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('the byte at the end offset is not read past the first piece either', async () => {
    const head = `${message(1, null, { message: { content: 'q'.repeat(PIECE + 1000) } })}\n`
    const text = `${head}${tag('cut')}\n`
    const tagStart = Buffer.byteLength(head)
    // `{"type":"tag"` is 13 bytes: one short of it, the marker is incomplete.
    expect(await scanPreBoundaryMetadata(write(text), tagStart + 12)).toEqual([])
    expect(await scanPreBoundaryMetadata(write(text), tagStart + 13)).toEqual(['{"type":"tag"'])
  })

  // A marker is up to 23 bytes, so every placement of one across a piece seam is covered.
  test('a marker split by a piece seam at any byte is found', async () => {
    const title = JSON.stringify({ type: 'custom-title', customTitle: 'seam' })
    for (const seam of [PIECE, 2 * PIECE]) {
      for (let shift = -26; shift <= 2; shift++) {
        const filler = message(1, null, { message: { content: '' } })
        const pad = 'p'.repeat(seam + shift - Buffer.byteLength(filler) - 1)
        const head = `${message(1, null, { message: { content: pad } })}\n`
        expect(Buffer.byteLength(head)).toBe(seam + shift)
        const text = `${head}${title}\n`
        const found = await scanPreBoundaryMetadata(write(text), Buffer.byteLength(text))
        expect({ seam, shift, found }).toEqual({ seam, shift, found: [title] })
      }
    }
  })

  test('a metadata line spanning several pieces comes back whole', async () => {
    const long = JSON.stringify({ type: 'summary', summary: 's'.repeat(3 * PIECE) })
    const text = `${message(1, null)}\n${long}\n${tag('after')}`
    expect(await scanPreBoundaryMetadata(write(text), Buffer.byteLength(text))).toEqual([long, tag('after')])
  })

  test('a message line spanning several pieces without a marker is dropped', async () => {
    const huge = message(1, null, { message: { content: 'h'.repeat(3 * PIECE) } })
    const text = `${huge}\n${tag('kept')}\n`
    expect(await scanPreBoundaryMetadata(write(text), Buffer.byteLength(text))).toEqual([tag('kept')])
  })
})
