import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readOutputBytes } from 'src/agent/tasks/LocalShellTask/readOutputBytes.js'

const dir = mkdtempSync(join(tmpdir(), 'output-bytes-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readOutputBytes', () => {
  test('returns the raw bytes from the offset, capped, invalid UTF-8 untouched', async () => {
    const path = join(dir, 'task.output')
    writeFileSync(path, Buffer.from([0x61, 0xe9, 0x0a, 0x62, 0x63]))
    expect(await readOutputBytes(path, 1, 1024)).toEqual(Buffer.from([0xe9, 0x0a, 0x62, 0x63]))
    expect(await readOutputBytes(path, 1, 2)).toEqual(Buffer.from([0xe9, 0x0a]))
    expect(await readOutputBytes(path, 5, 1024)).toEqual(Buffer.alloc(0))
    expect(await readOutputBytes(path, 9, 1024)).toEqual(Buffer.alloc(0))
  })

  test('a file not written yet reads as nothing; any other failure is thrown', async () => {
    expect(await readOutputBytes(join(dir, 'missing.output'), 0, 1024)).toEqual(Buffer.alloc(0))
    const asDir = join(dir, 'a-directory')
    mkdirSync(asDir)
    await expect(readOutputBytes(asDir, 0, 1024)).rejects.toThrow()
  })
})
