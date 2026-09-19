// encoding — the other half of Grep's `encoding`. A search that can reach a
// Shift-JIS or UTF-16 file is only half an answer if the follow-up read of
// that same file comes back as mojibake.
//
// Split out of the 2177-line FileReadTool.test.ts; the fixtures and the
// process-global env pair live in __testutils__/fileReadHarness.ts.

import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import {
  fixtureDir,
  makeContext,
  useFileReadEnv,
  writeFixture,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'

useFileReadEnv()

// ---------------------------------------------------------------------------
// encoding — the other half of Grep's `encoding`. A search that can reach a
// Shift-JIS or UTF-16 file is only half an answer if the follow-up read of
// that same file comes back as mojibake.
// ---------------------------------------------------------------------------

describe('FileReadTool — encoding', () => {
  const SOURCE = `export function wideHelper(id: string) {
  return 'ZQENCODED' + id
}

export class WideFactory {
  buildWidget() {
    return 'ZQENCODED'
  }
}
`

  function writeBufferFixture(name: string, buf: Buffer): string {
    const p = join(fixtureDir(), name)
    writeFileSync(p, buf)
    return p
  }

  async function readWith(
    filePath: string,
    input: Record<string, unknown>,
    context: ToolUseContext = makeContext(),
  ) {
    return FileReadTool.call(
      { file_path: filePath, ...input } as never,
      context,
      undefined as never,
      undefined as never,
    )
  }

  function textOf(data: unknown): string {
    const file = (data as { file?: { content?: string } }).file
    return file?.content ?? ''
  }

  test('a full read decodes UTF-16LE', async () => {
    const p = writeBufferFixture('enc-full.ts', Buffer.from(SOURCE, 'utf16le'))

    const plain = await readWith(p, {})
    expect(textOf(plain.data)).toContain('\u0000')

    const decoded = await readWith(p, { encoding: 'utf-16le' })
    expect(textOf(decoded.data)).toContain('export function wideHelper')
    expect(textOf(decoded.data)).not.toContain('\u0000')
  })

  test('symbol= finds and returns the symbol body', async () => {
    // The round trip Grep's symbols mode sets up: it names wideHelper, this is
    // the call that has to be able to open it.
    const p = writeBufferFixture('enc-symbol.ts', Buffer.from(SOURCE, 'utf16le'))

    const r = await readWith(p, { symbol: 'wideHelper', encoding: 'utf-16le' })
    const text = textOf(r.data)
    expect(text).toContain("return 'ZQENCODED' + id")
    expect(text).not.toContain('WideFactory')
  })

  test('symbol= without the label cannot find the symbol', async () => {
    const p = writeBufferFixture('enc-nosym.ts', Buffer.from(SOURCE, 'utf16le'))

    // The scan reads mojibake, finds no symbols, and the tool degrades to a
    // normal read rather than erroring — so the failure is silent content,
    // which is exactly what the label is for.
    const r = await readWith(p, { symbol: 'wideHelper' })
    expect(textOf(r.data)).not.toContain("return 'ZQENCODED' + id")
  })

  test('view=outline lists the symbols', async () => {
    const p = writeBufferFixture(
      'enc-outline.ts',
      Buffer.from(SOURCE, 'utf16le'),
    )

    const r = await readWith(p, { view: 'outline', encoding: 'utf-16le' })
    const text = JSON.stringify(r.data)
    expect(text).toContain('wideHelper')
    expect(text).toContain('WideFactory')
  })

  test('offset and limit select lines of the decoded text', async () => {
    const p = writeBufferFixture(
      'enc-range.ts',
      Buffer.from('l1\nl2\nl3\nl4\n', 'utf16le'),
    )

    const r = await readWith(p, { offset: 2, limit: 2, encoding: 'utf-16le' })
    const text = textOf(r.data)
    expect(text).toContain('l2')
    expect(text).toContain('l3')
    expect(text).not.toContain('l4')
  })

  test('a legacy single-byte encoding decodes', async () => {
    const p = writeBufferFixture(
      'enc-cp1252.txt',
      Buffer.from([0x80, 0x0a, 0x41, 0x0a]),
    )

    const r = await readWith(p, { encoding: 'windows-1252' })
    expect(textOf(r.data)).toContain('€')
  })

  test('an unknown label is an error naming valid ones', async () => {
    const p = writeBufferFixture('enc-bad.ts', Buffer.from(SOURCE, 'utf16le'))

    await expect(readWith(p, { encoding: 'utf16' })).rejects.toThrow(
      /Unknown encoding "utf16"/,
    )
  })

  test('the label is rejected before the file is even opened', async () => {
    await expect(
      readWith(join(fixtureDir(), 'does-not-exist-at-all.ts'), { encoding: 'utf16' }),
    ).rejects.toThrow(/Unknown encoding/)
  })

  test('an encoding read is never answered with the UTF-8 read dedup stub', async () => {
    // Both reads share path, offset and limit, which is exactly what the dedup
    // arm matches on. Without the encoding exclusion the second one comes back
    // as a file_unchanged stub pointing at the mojibake body.
    const p = writeBufferFixture('enc-dedup.ts', Buffer.from(SOURCE, 'utf16le'))
    const ctx = makeContext()

    const first = await readWith(p, {}, ctx)
    expect(textOf(first.data)).toContain('\u0000')

    const second = await readWith(p, { encoding: 'utf-16le' }, ctx)
    expect(textOf(second.data)).toContain('export function wideHelper')
    expect(JSON.stringify(second.data)).not.toContain('file_unchanged')
  })

  test('an explicit utf-8 label reads exactly like no label', async () => {
    const p = writeFixture('enc-plain.ts', SOURCE)

    const bare = await readWith(p, {})
    const labelled = await readWith(p, { encoding: 'utf-8' })
    expect(textOf(labelled.data)).toBe(textOf(bare.data))
  })
})
