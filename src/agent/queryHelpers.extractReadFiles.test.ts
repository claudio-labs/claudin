// What `/resume` gives the write tools back. Before this file existed the
// function had no test at all, and it silently dropped every ranged Read: a
// file read as `offset/limit` or `symbol=` half an hour earlier came back
// "has not been read yet" after a resume (2 of 65 gate refusals in the
// 2026-08/09 corpus, both on files the model had been shown).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractReadFilesFromMessages } from 'src/agent/queryHelpers.js'
import { addLineNumbers } from 'src/shared/fs/file.js'
import { FILE_UNCHANGED_STUB } from 'src/tools/FileReadTool/prompt.js'
import { seenRegionCovers } from 'src/tools/shared/readBeforeEditMessages.js'
import type { Message } from 'src/shared/types/message.js'

let dir: string
let n = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'extract-read-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A file of `count` lines named l1..lN, so a slice is recognisable. */
function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `l${i + 1}`).join('\n') + '\n'
}

function toolUse(name: string, input: Record<string, unknown>): Message {
  const id = `toolu_${++n}`
  return {
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  } as unknown as Message
}

function idOf(message: Message): string {
  return (message as unknown as { message: { content: Array<{ id: string }> } })
    .message.content[0]!.id
}

function toolResult(
  use: Message,
  content: string,
  opts: { isError?: boolean } = {},
): Message {
  n++
  return {
    type: 'user',
    uuid: `u-${n}`,
    timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: idOf(use),
          content,
          ...(opts.isError ? { is_error: true } : {}),
        },
      ],
    },
  } as unknown as Message
}

/** A Read of `path`, answered as FileReadTool renders it. */
function read(
  path: string,
  input: Record<string, unknown>,
  body: string,
  startLine = 1,
): Message[] {
  const use = toolUse('Read', { file_path: path, ...input })
  return [use, toolResult(use, addLineNumbers({ content: body, startLine }))]
}

describe('extractReadFilesFromMessages — Read', () => {
  test('a whole-file Read is restored as a whole-file entry', () => {
    const p = join(dir, 'a.ts')
    const cache = extractReadFilesFromMessages(
      read(p, {}, 'one\ntwo\nthree'),
      dir,
    )
    expect(cache.get(p)).toMatchObject({
      content: 'one\ntwo\nthree',
      offset: undefined,
      limit: undefined,
    })
  })

  test('a range Read is restored as the slice it showed', () => {
    const p = join(dir, 'b.ts')
    const cache = extractReadFilesFromMessages(
      read(p, { offset: 5, limit: 3 }, 'l5\nl6\nl7', 5),
      dir,
    )
    const entry = cache.get(p)
    expect(entry).toMatchObject({ content: 'l5\nl6\nl7', offset: 5, limit: 3 })
    expect(seenRegionCovers(entry!, ['l6'])).toBe(true)
    expect(seenRegionCovers(entry!, ['l9'])).toBe(false)
  })

  test('a leading blank line in a slice keeps its line number', () => {
    // Trimming the slice, as the whole-file path does, would drop the blank
    // and shift every line after it by one.
    const p = join(dir, 'blank.ts')
    const cache = extractReadFilesFromMessages(
      read(p, { offset: 10, limit: 3 }, '\nl11\nl12', 10),
      dir,
    )
    expect(cache.get(p)).toMatchObject({
      content: '\nl11\nl12',
      offset: 10,
      limit: 3,
    })
  })

  test('a symbol Read is a range read at the lines it rendered', () => {
    const p = join(dir, 'sym.ts')
    const cache = extractReadFilesFromMessages(
      read(p, { symbol: 'foo' }, 'function foo() {\n  return 1\n}', 42),
      dir,
    )
    expect(cache.get(p)).toMatchObject({ offset: 42, limit: 3 })
  })

  test('an outline restores nothing, whether asked for or pivoted to', () => {
    const p = join(dir, 'big.ts')
    const asked = toolUse('Read', { file_path: p, view: 'outline' })
    const pivoted = toolUse('Read', { file_path: p })
    const outline =
      "<system-reminder>File is large — showing a structural outline instead.</system-reminder>\n\n  31-37    export type Foo\n  38-42    export function bar("
    const cache = extractReadFilesFromMessages(
      [asked, toolResult(asked, outline), pivoted, toolResult(pivoted, outline)],
      dir,
    )
    // The old path cached the outline TEXT as the file's content.
    expect(cache.get(p)).toBeUndefined()
  })

  test('a dedup stub does not overwrite the real entry', () => {
    const p = join(dir, 'dedup.ts')
    const cache = extractReadFilesFromMessages(
      [
        ...read(p, { offset: 1, limit: 2 }, 'l1\nl2'),
        ...(() => {
          const use = toolUse('Read', { file_path: p, offset: 1, limit: 2 })
          return [use, toolResult(use, FILE_UNCHANGED_STUB)]
        })(),
      ],
      dir,
    )
    expect(cache.get(p)).toMatchObject({ content: 'l1\nl2', offset: 1 })
  })
})

describe('extractReadFilesFromMessages — several Reads of one file', () => {
  test('slices accumulate, as they do in a live session', () => {
    const p = join(dir, 'walk.ts')
    const cache = extractReadFilesFromMessages(
      [
        ...read(p, { offset: 1, limit: 3 }, 'l1\nl2\nl3', 1),
        ...read(p, { offset: 40, limit: 2 }, 'l40\nl41', 40),
      ],
      dir,
    )
    const entry = cache.get(p)!
    expect(entry).toMatchObject({ offset: 40, limit: 2 })
    expect(entry.seenRanges).toEqual([{ offset: 1, content: 'l1\nl2\nl3' }])
    expect(seenRegionCovers(entry, ['l2'])).toBe(true)
    expect(seenRegionCovers(entry, ['l41'])).toBe(true)
    expect(seenRegionCovers(entry, ['l20'])).toBe(false)
  })

  test('a slice read after an Edit does not inherit the pre-edit file', () => {
    // The Edit entry stands for the whole post-write file; the earlier slice
    // described bytes that may no longer exist. Only Read-authored entries
    // have their timestamp equalized for the carry.
    const p = join(dir, 'edited.ts')
    writeFileSync(p, numbered(10))
    const edit = toolUse('Edit', { file_path: p, old_string: 'l1', new_string: 'L1' })
    const cache = extractReadFilesFromMessages(
      [
        ...read(p, { offset: 1, limit: 3 }, 'l1\nl2\nl3', 1),
        edit,
        toolResult(edit, 'ok'),
        ...read(p, { offset: 8, limit: 2 }, 'l8\nl9', 8),
      ],
      dir,
    )
    const entry = cache.get(p)!
    expect(entry).toMatchObject({ offset: 8, limit: 2 })
    expect(entry.seenRanges).toBeUndefined()
  })
})

describe('extractReadFilesFromMessages — write tools', () => {
  test('Write is restored from its own input', () => {
    const p = join(dir, 'w.ts')
    const use = toolUse('Write', { file_path: p, content: 'written' })
    const cache = extractReadFilesFromMessages([use, toolResult(use, 'ok')], dir)
    expect(cache.get(p)).toMatchObject({ content: 'written', offset: undefined })
  })

  test('Edit is restored from disk', () => {
    const p = join(dir, 'e.ts')
    writeFileSync(p, 'on disk\n')
    const use = toolUse('Edit', { file_path: p, old_string: 'a', new_string: 'b' })
    const cache = extractReadFilesFromMessages([use, toolResult(use, 'ok')], dir)
    expect(cache.get(p)).toMatchObject({ content: 'on disk\n', offset: undefined })
  })

  test('apply_patch is restored from disk for every file it wrote', () => {
    const a = join(dir, 'pa.ts')
    const b = join(dir, 'pb.ts')
    writeFileSync(a, 'A\n')
    writeFileSync(b, 'B\n')
    const use = toolUse('apply_patch', {
      patchText:
        `*** Begin Patch\n*** Update File: ${a}\n@@\n-x\n+y\n` +
        `*** Add File: ${b}\n+B\n*** End Patch`,
    })
    const cache = extractReadFilesFromMessages([use, toolResult(use, 'ok')], dir)
    expect(cache.get(a)).toMatchObject({ content: 'A\n', offset: undefined })
    expect(cache.get(b)).toMatchObject({ content: 'B\n', offset: undefined })
  })

  test('a failed patch changes nothing', () => {
    const p = join(dir, 'failed.ts')
    writeFileSync(p, 'DISK\n')
    const failed = toolUse('apply_patch', {
      patchText: `*** Begin Patch\n*** Update File: ${p}\n@@\n-x\n+y\n*** End Patch`,
    })
    const cache = extractReadFilesFromMessages(
      [
        ...read(p, {}, 'l1\nl2'),
        failed,
        toolResult(failed, 'refused', { isError: true }),
      ],
      dir,
    )
    expect(cache.get(p)).toMatchObject({ content: 'l1\nl2' })
  })

  test('apply_patch Delete File evicts the entry', () => {
    const p = join(dir, 'del.ts')
    const del = toolUse('apply_patch', {
      patchText: `*** Begin Patch\n*** Delete File: ${p}\n*** End Patch`,
    })
    const cache = extractReadFilesFromMessages(
      [...read(p, {}, 'l1\nl2'), del, toolResult(del, 'ok')],
      dir,
    )
    expect(cache.get(p)).toBeUndefined()
  })

  test('a malformed patchText is skipped, not thrown', () => {
    const use = toolUse('apply_patch', { patchText: 'not a patch' })
    expect(() =>
      extractReadFilesFromMessages([use, toolResult(use, 'ok')], dir),
    ).not.toThrow()
  })
})
