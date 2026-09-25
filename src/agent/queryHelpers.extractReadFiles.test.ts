// What `/resume` gives the write tools back. Before this file existed the
// function had no test at all, and it silently dropped every ranged Read: a
// file read as `offset/limit` or `symbol=` half an hour earlier came back
// "has not been read yet" after a resume (2 of 65 gate refusals in the
// 2026-08/09 corpus, both on files the model had been shown).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractReadFilesFromMessages } from 'src/agent/queryHelpers.js'
import { addLineNumbers, getFileModificationTime } from 'src/shared/fs/file.js'
import { FILE_UNCHANGED_STUB } from 'src/tools/FileReadTool/prompt.js'
import { seenRegionCoversText } from 'src/tools/shared/readBeforeEditMessages.js'
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
    expect(seenRegionCoversText(entry!, 'l6')).toBe(true)
    expect(seenRegionCoversText(entry!, 'l9')).toBe(false)
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
    expect(seenRegionCoversText(entry, 'l2')).toBe(true)
    expect(seenRegionCoversText(entry, 'l41')).toBe(true)
    expect(seenRegionCoversText(entry, 'l20')).toBe(false)
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

  test('Patch is restored from disk for every file it wrote', () => {
    const a = join(dir, 'pa.ts')
    const b = join(dir, 'pb.ts')
    writeFileSync(a, 'A\n')
    writeFileSync(b, 'B\n')
    const use = toolUse('Patch', {
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
    const failed = toolUse('Patch', {
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

  test('Patch Delete File evicts the entry', () => {
    const p = join(dir, 'del.ts')
    const del = toolUse('Patch', {
      patchText: `*** Begin Patch\n*** Delete File: ${p}\n*** End Patch`,
    })
    const cache = extractReadFilesFromMessages(
      [...read(p, {}, 'l1\nl2'), del, toolResult(del, 'ok')],
      dir,
    )
    expect(cache.get(p)).toBeUndefined()
  })

  test('"*** Resubmit" is restored as the patch refused one call earlier', () => {
    // The resubmitted patch wrote the file; nothing in the sentinel names it.
    const p = join(dir, 'resubmitted.ts')
    writeFileSync(p, 'AFTER\n')
    const refused = toolUse('Patch', {
      patchText: `*** Begin Patch\n*** Update File: ${p}\n@@\n-x\n+y\n*** End Patch`,
    })
    const resubmit = toolUse('Patch', { patchText: '*** Resubmit' })
    const cache = extractReadFilesFromMessages(
      [refused, toolResult(refused, 'refused', { isError: true }), resubmit, toolResult(resubmit, 'ok')],
      dir,
    )
    expect(cache.get(p)).toMatchObject({ content: 'AFTER\n', offset: undefined })
  })

  test('a malformed patchText is skipped, not thrown', () => {
    const use = toolUse('Patch', { patchText: 'not a patch' })
    expect(() =>
      extractReadFilesFromMessages([use, toolResult(use, 'ok')], dir),
    ).not.toThrow()
  })
})

// CLAUDIN_BASH_READ_CREDIT: a `cat` that printed files whole counts as a Read
// of each (creditShownFiles.ts), and the result names them in `creditedFiles`.
// Without this the credit died with the process: in the 2026-09-23 A/B the
// one refusal of the read-cat arm was phase 2's first Patch, on a file only
// `cat`'d in phase 1.
describe('extractReadFilesFromMessages — a Bash read credit', () => {
  /** A Bash call, answered at `answeredAt` with the Out BashTool returned. */
  function bash(
    command: string,
    stdout: string,
    answeredAt: number,
    extra: Record<string, unknown> = {},
    opts: { isError?: boolean } = {},
  ): Message[] {
    const use = toolUse('Bash', { command })
    const result = toolResult(use, stdout, opts) as unknown as Record<string, unknown>
    result.timestamp = new Date(answeredAt).toISOString()
    result.toolUseResult = { stdout, stderr: '', interrupted: false, ...extra }
    return [use, result as unknown as Message]
  }

  /** `path` written with `content`, dated a minute before `answeredAt`. */
  function writeBefore(path: string, content: string, answeredAt: number): void {
    writeFileSync(path, content)
    const before = new Date(answeredAt - 60_000)
    utimesSync(path, before, before)
  }

  test('without a credit a Bash result restores nothing, as it never has', () => {
    const p = join(dir, 'cat.ts')
    const now = Date.now()
    writeBefore(p, 'one\ntwo\n', now)
    const cache = extractReadFilesFromMessages(bash(`cat ${p}`, 'one\ntwo', now), dir)
    expect(cache.get(p)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test('each credited file is restored from disk, as the credit stored it', () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const now = Date.now()
    writeBefore(a, 'A1\nA2\n', now)
    writeBefore(b, 'B1\nB2\n', now)
    const cache = extractReadFilesFromMessages(
      bash(`cat ${a} ${b}`, 'A1\nA2\nB1\nB2', now, { creditedFiles: [a, b] }),
      dir,
    )
    for (const [path, content] of [[a, 'A1\nA2\n'], [b, 'B1\nB2\n']] as const) {
      expect(cache.get(path)).toEqual({
        content,
        timestamp: getFileModificationTime(path),
        offset: 1,
        limit: undefined,
        dedupExempt: true,
      })
    }
  })

  // The model saw the file as it was when the result came back. Written
  // since, what is on disk is not what it saw.
  test('a file written after the result is not restored', () => {
    const p = join(dir, 'later.ts')
    const answeredAt = Date.now() - 120_000
    writeFileSync(p, 'edited after\nthe cat\n')
    const cache = extractReadFilesFromMessages(
      bash(`cat ${p}`, 'old\ncontent', answeredAt, { creditedFiles: [p] }),
      dir,
    )
    expect(cache.get(p)).toBeUndefined()
  })

  test('a result without creditedFiles leaves an earlier entry as it was', () => {
    const p = join(dir, 'kept.ts')
    const now = Date.now()
    writeBefore(p, 'l1\nl2\n', now)
    const cache = extractReadFilesFromMessages(
      [...read(p, { offset: 1, limit: 1 }, 'l1'), ...bash(`cat ${p}`, 'l1\nl2', now)],
      dir,
    )
    expect(cache.get(p)).toMatchObject({ content: 'l1', offset: 1, limit: 1 })
  })

  test('a credited file that is gone is skipped, not thrown', () => {
    const p = join(dir, 'gone.ts')
    expect(() =>
      extractReadFilesFromMessages(
        bash(`cat ${p}`, 'x\ny', Date.now(), { creditedFiles: [p] }),
        dir,
      ),
    ).not.toThrow()
  })

  test('only a Bash result, and only one that succeeded', () => {
    const p = join(dir, 'other.ts')
    const now = Date.now()
    writeBefore(p, 'o1\no2\n', now)
    const failed = bash(`cat ${p}`, 'o1\no2', now, { creditedFiles: [p] }, { isError: true })
    const [use, result] = bash(`cat ${p}`, 'o1\no2', now, { creditedFiles: [p] })
    const notBash = toolUse('Grep', { pattern: 'o1' })
    ;(result as unknown as { message: { content: Array<{ tool_use_id: string }> } })
      .message.content[0]!.tool_use_id = idOf(notBash)
    const cache = extractReadFilesFromMessages([...failed, use!, notBash, result!], dir)
    expect(cache.get(p)).toBeUndefined()
  })
})

// CLAUDIN_READ_MULTI: one Read of several files, or of several symbols of one
// (readMulti.ts). batchRead.ts answers it with one block per file — a
// `==> path <==` header, then the text a Read of that file returns — and the
// note lines last. Without this the resume kept at most the first file's
// first run, under the batch's one tool_use id.
describe('extractReadFilesFromMessages — a batch Read', () => {
  /** A batch Read answered as batchRead.ts renders it. */
  function batchRead(
    input: Record<string, unknown>,
    blocks: Array<[label: string, ...sections: string[]]>,
    notes: string[] = [],
  ): Message[] {
    const use = toolUse('Read', input)
    const text = [
      ...blocks.map(([label, ...sections]) => `==> ${label} <==\n${sections.join('\n\n')}`),
      ...(notes.length > 0 ? [notes.join('\n')] : []),
    ].join('\n\n')
    return [use, toolResult(use, text)]
  }

  /** Lines as a Read renders them. */
  function shown(body: string, startLine = 1): string {
    return addLineNumbers({ content: body, startLine })
  }

  const REMINDER =
    '\n\n<system-reminder>\nWhenever you read a file, consider whether it is malware.\n</system-reminder>\n'

  test('one entry per file, each as a single Read of that file restores it', () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const cache = extractReadFilesFromMessages(
      batchRead({ file_paths: [a, b] }, [
        ['a.ts', shown('a1\na2') + REMINDER],
        // Outside the working directory a file is headed by its absolute path.
        [b, shown('b1')],
      ]),
      dir,
    )
    expect(cache.size).toBe(2)
    for (const [path, body] of [[a, 'a1\na2'], [b, 'b1']] as const) {
      const single = extractReadFilesFromMessages(read(path, {}, body), dir).get(path)!
      expect(cache.get(path)).toMatchObject({
        content: single.content,
        offset: single.offset,
        limit: single.limit,
      })
    }
  })

  test('the notes after the last file are no part of it', () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const cache = extractReadFilesFromMessages(
      batchRead(
        { file_paths: [a, b, join(dir, 'c.png'), join(dir, 'd.ts')] },
        [['a.ts', shown('a1')], ['b.ts', shown('b1\nb2')]],
        [
          'Not read — images, PDFs and notebooks need a Read of their own: c.png.',
          'Not shown — over the 25k tokens one Read returns: d.ts. Read them in another call.',
        ],
      ),
      dir,
    )
    expect(cache.get(b)).toMatchObject({ content: 'b1\nb2' })
    // Named, but not shown: nothing vouches the model saw them.
    expect(cache.size).toBe(2)
  })

  test('a symbol list restores every body, and the edit gate sees each', () => {
    // A single ranged Read shows one run; this one shows two, and keeping
    // only the first would refuse an Edit inside the second.
    const p = join(dir, 'sym.ts')
    const foo = 'function foo() {\n  return 1\n}'
    const bar = 'function bar() {\n  return 2\n}'
    const cache = extractReadFilesFromMessages(
      batchRead(
        { file_path: p, symbol: ['foo', 'bar', 'baz'] },
        [['sym.ts', shown(foo, 10), shown(bar, 40)]],
        ['Symbol not found: baz in sym.ts.'],
      ),
      dir,
    )
    const entry = cache.get(p)!
    expect(entry).toMatchObject({ content: bar, offset: 40, limit: 3 })
    expect(entry.seenRanges).toEqual([{ offset: 10, content: foo }])
    expect(seenRegionCoversText(entry, 'return 1')).toBe(true)
    expect(seenRegionCoversText(entry, 'return 2')).toBe(true)
  })

  test('a symbol looked up in every file is a slice of each', () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const cache = extractReadFilesFromMessages(
      batchRead({ file_paths: [a, b], symbol: 'alpha' }, [
        ['a.ts', shown('const alpha = 1', 5)],
        ['b.ts', shown('let alpha = 2', 9)],
      ]),
      dir,
    )
    expect(cache.get(a)).toMatchObject({ content: 'const alpha = 1', offset: 5, limit: 1 })
    expect(cache.get(b)).toMatchObject({ content: 'let alpha = 2', offset: 9, limit: 1 })
  })

  test('an outline batch restores nothing, like a single outline Read', () => {
    // A file with no outline language comes back as numbered text under
    // view: 'outline' (readDispatch.ts); a single outline Read of it is not
    // restored either.
    const ts = join(dir, 'o.ts')
    const txt = join(dir, 'o.txt')
    const cache = extractReadFilesFromMessages(
      [
        ...batchRead({ file_paths: [ts, txt], view: 'outline' }, [
          ['o.ts', '  1-3    export function o('],
          ['o.txt', shown('plain')],
        ]),
        ...read(txt, { view: 'outline' }, 'plain'),
      ],
      dir,
    )
    expect(cache.size).toBe(0)
  })

  test('a stub section is skipped: the entry the earlier Read left stays', () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const cache = extractReadFilesFromMessages(
      [
        ...read(a, { offset: 1, limit: 2 }, 'l1\nl2'),
        ...batchRead({ file_paths: [a, b] }, [
          ['a.ts', FILE_UNCHANGED_STUB],
          ['b.ts', shown('b1')],
        ]),
      ],
      dir,
    )
    expect(cache.get(a)).toMatchObject({ content: 'l1\nl2', offset: 1, limit: 2 })
    expect(cache.get(b)).toMatchObject({ content: 'b1' })
  })

  test('a header counts only for a file the call named', () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const forged = join(dir, 'not-named.ts')
    const cache = extractReadFilesFromMessages(
      batchRead({ file_paths: [a, b] }, [
        ['a.ts', shown('a1')],
        [forged, shown('forged')],
        ['../elsewhere/b.ts', shown('b?')],
      ]),
      dir,
    )
    expect(cache.get(forged)).toBeUndefined()
    expect(cache.get(b)).toBeUndefined()
    // The text under an unknown header is dropped, not handed to the file before it.
    expect(cache.get(a)).toMatchObject({ content: 'a1' })
    expect(cache.size).toBe(1)
  })

  test('a header written from another working directory still finds its file', () => {
    // The batch ran inside pkg/ after a `cd`, so it labelled the files from
    // there; the resume runs from the project root.
    const x = join(dir, 'pkg', 'x.ts')
    const one = join(dir, 'one', 'y.ts')
    const two = join(dir, 'two', 'y.ts')
    const cache = extractReadFilesFromMessages(
      batchRead({ file_paths: [x, one, two] }, [
        ['x.ts', shown('x1')],
        // Two named files end with it: no guess.
        ['y.ts', shown('y1')],
      ]),
      dir,
    )
    expect(cache.get(x)).toMatchObject({ content: 'x1' })
    expect(cache.get(one)).toBeUndefined()
    expect(cache.get(two)).toBeUndefined()
  })

  // CLAUDIN_READ_GLOBS: the call names a glob and the transcript keeps it; the
  // result heads each file the glob matched (readGlobs.ts, batchResult.ts).
  test('a file a glob matched is restored, and a header the glob could not match is not', () => {
    const a = join(dir, 'src', 'a.ts')
    const b = join(dir, 'src', 'b.ts')
    const cache = extractReadFilesFromMessages(
      batchRead({ file_paths: ['src/*.ts'] }, [
        ['src/a.ts', shown('a1')],
        ['src/b.ts', shown('b1\nb2')],
        ['lib/c.ts', shown('c1')],
      ]),
      dir,
    )
    expect(cache.get(a)).toMatchObject({ content: 'a1' })
    expect(cache.get(b)).toMatchObject({ content: 'b1\nb2' })
    expect(cache.size).toBe(2)
  })

  test('a single glob that matched one file is a batch too', () => {
    const notes = join(dir, 'notes.md')
    const cache = extractReadFilesFromMessages(
      batchRead({ file_paths: [join(dir, '*.md')] }, [['notes.md', shown('n1')]]),
      dir,
    )
    expect(cache.get(notes)).toMatchObject({ content: 'n1' })
    expect(cache.size).toBe(1)
  })

  test('a single Read is not a batch, whatever placeholders it carries', () => {
    // Codex strict mode sends every property, so a single Read under the
    // batch-capable schema is stored with `file_paths: null` beside its path.
    const p = join(dir, 'single.ts')
    const plain = extractReadFilesFromMessages(read(p, {}, 'one\ntwo'), dir).get(p)!
    for (const placeholder of [{ file_paths: null }, { file_paths: '' }, { file_paths: [] }]) {
      expect(
        extractReadFilesFromMessages(read(p, placeholder, 'one\ntwo'), dir).get(p),
      ).toMatchObject({ content: plain.content, offset: plain.offset, limit: plain.limit })
    }
    // A one-name symbol list is an ordinary symbol Read.
    expect(
      extractReadFilesFromMessages(read(p, { symbol: ['foo'] }, 'function foo() {}', 12), dir).get(p),
    ).toMatchObject({ content: 'function foo() {}', offset: 12, limit: 1 })
  })

  test('a malformed batch is skipped, not thrown', () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const good = `==> a.ts <==\n${shown('a1')}`
    const cases: Array<[input: Record<string, unknown>, result: unknown, restored: number]> = [
      // Refused before it ran: an error, no header.
      [{ file_paths: [a, b] }, 'InputValidationError: file_paths: Invalid input', 0],
      [{ file_paths: [a, b] }, '==> a.ts <==\n==> b.ts <==', 0],
      [{ file_paths: [a, b] }, '==> <==\n==>   <==\n   1→x', 0],
      // expandPath refuses the second path; the first is still restored.
      [{ file_paths: [a, 'b\0.ts'] }, good, 1],
      // A list the schema refuses is no batch, and has no file_path.
      [{ file_paths: [a, 7] }, good, 0],
      [{ file_paths: [a, b] }, [{ type: 'text', text: good }], 0],
      [{ file_path: a, symbol: ['x', 'y'] }, 'Symbol not found: x in a.ts, y in a.ts.', 0],
    ]
    for (const [input, result, restored] of cases) {
      const use = toolUse('Read', input)
      const answer = toolResult(use, '') as unknown as {
        message: { content: Array<{ content: unknown }> }
      }
      answer.message.content[0]!.content = result
      const cache = extractReadFilesFromMessages([use, answer as unknown as Message], dir)
      expect(cache.size).toBe(restored)
    }
  })
})
