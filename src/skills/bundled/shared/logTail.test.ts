import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { lastLines, readLogTail } from 'src/skills/bundled/shared/logTail.js'

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`)

describe('lastLines', () => {
  test('a trailing newline ends the last line rather than starting an empty one', () => {
    const text = `${numbered(1, 30).join('\n')}\n`
    expect(lastLines(text, 20, false)).toEqual(numbered(11, 30))
  })

  test('a last line without a newline still counts', () => {
    expect(lastLines(numbered(1, 30).join('\n'), 20, false)).toEqual(numbered(11, 30))
  })

  test('returns every line when there are fewer than asked for', () => {
    expect(lastLines('a\nb\n', 20, false)).toEqual(['a', 'b'])
    expect(lastLines('', 20, false)).toEqual([])
    expect(lastLines('a\nb\n', 0, false)).toEqual([])
  })

  test('drops a leading fragment when the text starts mid-line, unless it is all there is', () => {
    expect(lastLines('agment\nwhole\n', 20, true)).toEqual(['whole'])
    expect(lastLines('only a fragment', 20, true)).toEqual(['only a fragment'])
  })
})

describe('readLogTail', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-tail-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('reports a missing file as missing, not as a failure', async () => {
    expect(await readLogTail(join(dir, 'absent.log'), { maxBytes: 1024, maxLines: 5 })).toEqual({
      kind: 'missing',
    })
  })

  test('gives the size of the whole file and its last lines', async () => {
    const path = join(dir, 'small.log')
    const content = `${numbered(1, 8).join('\n')}\n`
    writeFileSync(path, content)
    expect(await readLogTail(path, { maxBytes: 1024, maxLines: 5 })).toEqual({
      kind: 'read',
      sizeBytes: Buffer.byteLength(content),
      lines: numbered(4, 8),
    })
  })

  test('reads no more than the byte limit, and drops the line it cuts', async () => {
    const path = join(dir, 'large.log')
    // Ten lines of 100 bytes each; the last 250 bytes start halfway into line 8.
    const lines = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2, '0')}:${'x'.repeat(96)}`)
    writeFileSync(path, `${lines.join('\n')}\n`)
    const tail = await readLogTail(path, { maxBytes: 250, maxLines: 20 })
    expect(tail).toEqual({ kind: 'read', sizeBytes: 1000, lines: lines.slice(8) })
  })

  test.skipIf(process.platform === 'win32')('reports a path it cannot read with the reason', async () => {
    const path = join(dir, 'a-directory.log')
    mkdirSync(path)
    const tail = await readLogTail(path, { maxBytes: 1024, maxLines: 5 })
    expect(tail.kind).toBe('unreadable')
    expect(tail.kind === 'unreadable' ? tail.reason : '').toMatch(/\bEISDIR\b/)
  })
})
