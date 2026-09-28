// The large-transcript loader must give the same result however the file is
// read. The characterization suite pins what the old reader got right around
// its 1 MiB read seam; these tests pin what it got wrong (a compact boundary
// laid out by the transcript writer, straddling the seam, was missed) and
// feed the assembler every chunk size from one byte up.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readTranscriptForLoad } from 'src/sessions/sessionStoragePortable.js'
import {
  type TranscriptForLoad,
  TranscriptLoadAssembler,
} from 'src/sessions/sessionStoragePortable/loadAssembler.js'

const MIB = 1024 * 1024

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'load-assembler-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const lineOf = (entry: object) => `${JSON.stringify(entry)}\n`
const prompt = (text: string) =>
  lineOf({ parentUuid: 'p-0', isSidechain: false, type: 'user', message: { role: 'user', content: text } })
/** A line of exactly `bytes` bytes, LF included. */
const padding = (bytes: number) => {
  const open = '{"type":"assistant","filler":"'
  const close = '"}\n'
  return `${open}${'f'.repeat(bytes - open.length - close.length)}${close}`
}
const snapshot = (n: number, extra = 0) =>
  lineOf({ type: 'attribution-snapshot', messageId: `m-${n}`, surface: 'cli', fileStates: {}, note: 'n'.repeat(extra) })
/** A boundary in the transcript writer's key order: the chain links come first. */
const writerBoundary = (preserved = false) =>
  lineOf({
    parentUuid: null,
    logicalParentUuid: '0d15ea5e-0000-4000-8000-000000000001',
    isSidechain: false,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: '2026-09-21T08:30:00.000Z',
    uuid: '0d15ea5e-0000-4000-8000-000000000002',
    level: 'info',
    compactMetadata: preserved
      ? { trigger: 'manual', preTokens: 9, preservedSegment: { headUuid: 'h', anchorUuid: 'a', tailUuid: 't' } }
      : { trigger: 'auto', preTokens: 9 },
    userType: 'external',
    cwd: '/srv/app',
    sessionId: '0d15ea5e-0000-4000-8000-000000000003',
  })
const bytesOf = (text: string) => Buffer.byteLength(text)

async function loadFile(text: string): Promise<TranscriptForLoad & { text: string }> {
  const file = join(scratch, 'transcript.jsonl')
  writeFileSync(file, text)
  const result = await readTranscriptForLoad(file, bytesOf(text))
  return { ...result, text: result.postBoundaryBuf.toString('utf8') }
}

/** Feeds `bytes` in chunks of `size`, through one buffer that is overwritten between pushes. */
function assembleInChunks(bytes: Buffer, size: number): TranscriptForLoad {
  const assembler = new TranscriptLoadAssembler(bytes.length)
  const reused = Buffer.alloc(size)
  for (let at = 0; at < bytes.length; at += size) {
    const length = bytes.copy(reused, 0, at, Math.min(at + size, bytes.length))
    assembler.push(reused.subarray(0, length))
    reused.fill(0x7e)
  }
  return assembler.finish()
}

describe('a compact boundary across the 1 MiB read seam', () => {
  test('is recognised when laid out by the writer, however many bytes precede the seam', async () => {
    for (const before of [20, 29, 30, 31, 64, 150, 300]) {
      const after = writerBoundary() + prompt('after the cut')
      const result = await loadFile(padding(MIB - before) + after)
      expect(result.text).toBe(after)
      expect(result.boundaryStartOffset).toBe(MIB - before)
      expect(result.hasPreservedSegment).toBe(false)
    }
  })

  test('a preserved boundary laid out by the writer keeps its flag across the seam', async () => {
    for (const before of [30, 100, 300]) {
      const text = prompt('kept') + padding(MIB - before - bytesOf(prompt('kept'))) + writerBoundary(true) + prompt('tail')
      const result = await loadFile(text)
      expect(result.text).toBe(text)
      expect(result.hasPreservedSegment).toBe(true)
      expect(result.boundaryStartOffset).toBe(0)
    }
  })

  test('a system line whose marker starts past the window is never a boundary, across the seam or not', async () => {
    const farMarker = lineOf({ type: 'system', pad: 'q'.repeat(300), subtype: 'compact_boundary', content: 'x', compactMetadata: {} })
    expect(farMarker.indexOf('"compact_boundary"')).toBeGreaterThanOrEqual(256)
    for (const before of [0, 40, 200, 280]) {
      const text = prompt('a') + padding(MIB - before - bytesOf(prompt('a'))) + farMarker + prompt('b')
      const result = await loadFile(text)
      expect(result.text).toBe(text)
      expect(result.boundaryStartOffset).toBe(0)
    }
  })
})

describe('the size limit', () => {
  test('only the first fileSize bytes are read when they span several reads', async () => {
    const text = prompt('start') + padding(2 * MIB) + prompt('end')
    const file = join(scratch, 'longer.jsonl')
    writeFileSync(file, text)
    const limit = MIB + MIB / 2 + 7
    const result = await readTranscriptForLoad(file, limit)
    expect(result.postBoundaryBuf.equals(Buffer.from(text).subarray(0, limit))).toBe(true)
  })
})

describe('independence from the read size', () => {
  const cut = prompt('before') + snapshot(1)
  const broken = '{"type":"system","subtype":"compact_boundary","content":"cut short\n'
  const lastPrompt = prompt('d').trimEnd()
  // Lines on either side of the prefix that settles a line's kind.
  const around = padding(272) + padding(273) + padding(274)
  const transcript =
    cut +
    writerBoundary() +
    prompt('b') +
    around +
    snapshot(2, 400) +
    broken +
    writerBoundary(true) +
    prompt('c') +
    snapshot(3) +
    lastPrompt
  const bytes = Buffer.from(transcript)
  const expected: TranscriptForLoad = {
    boundaryStartOffset: bytesOf(cut),
    postBoundaryBuf: Buffer.from(
      `${writerBoundary()}${prompt('b')}${around}${broken}${writerBoundary(true)}${prompt('c')}${lastPrompt}\n${snapshot(3)}`,
    ),
    hasPreservedSegment: true,
  }

  test('one push of the whole transcript gives the expected load', () => {
    expect(assembleInChunks(bytes, bytes.length)).toEqual(expected)
  })

  test('every chunk size gives the same load, byte for byte', () => {
    const sizes = [1, 2, 3, 5, 7, 17, 29, 30, 31, 64, 255, 256, 257, 272, 273, 274, 500, 1024]
    const differing = sizes.filter(size => {
      const result = assembleInChunks(bytes, size)
      return !result.postBoundaryBuf.equals(expected.postBoundaryBuf) ||
        result.boundaryStartOffset !== expected.boundaryStartOffset ||
        result.hasPreservedSegment !== expected.hasPreservedSegment
    })
    expect(differing).toEqual([])
  })

  test('an empty stream loads as nothing', () => {
    const empty = new TranscriptLoadAssembler(0).finish()
    expect(empty.postBoundaryBuf.length).toBe(0)
    expect(empty.boundaryStartOffset).toBe(0)
    expect(empty.hasPreservedSegment).toBe(false)
  })
})

describe('what gets parsed', () => {
  test('only the lines that carry the marker in their window are parsed', async () => {
    const parse = spyOn(JSON, 'parse')
    try {
      const text = prompt('one') + snapshot(1) + padding(3000) + prompt('compact_boundary') + writerBoundary() + prompt('two')
      const result = await loadFile(text)
      expect(result.text).toBe(writerBoundary() + prompt('two'))
      // The prompt that quotes the marker and the boundary itself.
      expect(parse).toHaveBeenCalledTimes(2)
    } finally {
      parse.mockRestore()
    }
  })
})
