// Characterization of the portable session-storage module (unit
// `sessions/storagePure`): id validation, field reads that never parse a whole
// line, head-and-tail reads, the directory name a project gets, and the
// chunked read that loads a large transcript from its last compact boundary.
// Its names are imported straight from the module, as its callers do. Files
// are real, in a fresh temp directory per test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  extractJsonStringField,
  extractLastJsonStringField,
  getProjectDir,
  getProjectsDir,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  readTranscriptForLoad,
  sanitizePath,
  SKIP_PRECOMPACT_THRESHOLD,
  validateUuid,
} from 'src/sessions/sessionStoragePortable.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const MIB = 1024 * 1024
const READ_SEAM = MIB

let scratch: string
let fileCount = 0

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'storage-pure-portable-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const writeScratch = (contents: string | Buffer): string => {
  const file = join(scratch, `file-${++fileCount}.jsonl`)
  writeFileSync(file, contents)
  return file
}

test('buffer size and thresholds', () => {
  expect(LITE_READ_BUF_SIZE).toBe(64 * 1024)
  expect(SKIP_PRECOMPACT_THRESHOLD).toBe(5 * MIB)
})

describe('validateUuid', () => {
  const good = '5e551a0e-7c3b-4d2a-9f10-2b4c6d8e0a1f'
  const accepted = [good, good.toUpperCase(), '00000000-0000-0000-0000-000000000000']
  const refused: unknown[] = [
    good.slice(0, -1),
    good.replaceAll('-', ''),
    `${good.slice(0, -1)}g`,
    ` ${good}`,
    `${good}\n`,
    `{${good}}`,
    '',
    42,
    null,
    undefined,
    { id: good },
  ]

  test('accepts the 8-4-4-4-12 hex form in any case, and returns the same string', () => {
    const returned: Array<string | null> = accepted.map(value => validateUuid(value))
    expect(returned).toEqual(accepted)
  })

  test('refuses anything else', () => {
    expect(refused.filter(value => validateUuid(value) !== null)).toEqual([])
  })
})

describe('extractJsonStringField', () => {
  const cases: Array<[string, string, string, string | undefined]> = [
    ['compact JSON', '{"type":"user","cwd":"/work/acme"}', 'cwd', '/work/acme'],
    ['a space after the colon', '{"type": "user", "cwd": "/work/acme"}', 'cwd', '/work/acme'],
    ['the first of several lines', '{"title":"first"}\n{"title":"second"}', 'title', 'first'],
    ['a nested member', '{"message":{"model":"opus-9"}}', 'model', 'opus-9'],
    ['decoded escapes', '{"t":"line\\none \\"q\\" \\\\ \\u00e9"}', 't', 'line\none "q" \\ \u00e9'],
    ['an invalid escape, returned raw', '{"t":"bad \\x escape"}', 't', 'bad \\x escape'],
    ['an empty value', '{"t":""}', 't', ''],
    ['a value cut before its closing quote', '{"t":"no end', 't', undefined],
    ['a value cut after a backslash', '{"t":"ends with \\', 't', undefined],
    ['an absent key', '{"a":"b"}', 't', undefined],
    ['a non-string value', '{"t":42,"u":null}', 't', undefined],
    ['a key that only ends like the one asked for', '{"uuid":"u-1"}', 'id', undefined],
  ]
  test.each(cases)('%s', (_label, text, key, expected) => {
    expect(extractJsonStringField(text, key)).toBe(expected)
  })

  test('a compact match cut short falls back to the spaced form', () => {
    expect(extractJsonStringField('{"t": "spaced"} {"t":"cut', 't')).toBe('spaced')
  })
})

describe('extractLastJsonStringField', () => {
  const cases: Array<[string, string, string, string | undefined]> = [
    ['the last of several lines', '{"customTitle":"one"}\n{"customTitle":"two"}\n{"customTitle":"three"}\n', 'customTitle', 'three'],
    ['a single match', '{"tag":"wip"}', 'tag', 'wip'],
    ['a last occurrence cut short, falling back to the one before', '{"tag":"done"}\n{"tag":"unfini', 'tag', 'done'],
    ['decoded escapes', '{"t":"a"}{"t":"tab\\there"}', 't', 'tab\there'],
    ['escaped quotes inside the values', '{"t":"say \\"hi\\""} {"t":"say \\"bye\\""}', 't', 'say "bye"'],
    ['spaced JSON', '{"t": "x"} {"t": "y"}', 't', 'y'],
    ['no occurrence', '{"a":"b"}', 't', undefined],
    ['only an occurrence cut short', '{"t":"cut', 't', undefined],
  ]
  test.each(cases)('%s', (_label, text, key, expected) => {
    expect(extractLastJsonStringField(text, key)).toBe(expected)
  })
})

describe('readHeadAndTail', () => {
  const freshBuffer = () => Buffer.alloc(LITE_READ_BUF_SIZE)
  const numberedText = (bytes: number) => {
    let text = ''
    for (let n = 0; text.length < bytes; n++) text += `{"line":${n}}\n`
    return text.slice(0, bytes)
  }

  test('a small file: the head is the whole file and the tail is the head', async () => {
    const text = '{"a":1}\n{"b":2}\n'
    const file = writeScratch(text)
    expect(await readHeadAndTail(file, statSync(file).size, freshBuffer())).toEqual({ head: text, tail: text })
  })

  test('a file of exactly one buffer has the same head and tail', async () => {
    const text = numberedText(LITE_READ_BUF_SIZE)
    const file = writeScratch(text)
    const read = await readHeadAndTail(file, LITE_READ_BUF_SIZE, freshBuffer())
    expect(read.head).toBe(text)
    expect(read.tail).toBe(text)
  })

  test('a larger file gives its first and last 64 KiB through one shared buffer', async () => {
    const size = LITE_READ_BUF_SIZE * 2 + 1234
    const text = numberedText(size)
    const file = writeScratch(text)
    const read = await readHeadAndTail(file, size, freshBuffer())
    expect(read.head).toBe(text.slice(0, LITE_READ_BUF_SIZE))
    expect(read.tail).toBe(text.slice(size - LITE_READ_BUF_SIZE))
  })

  test('the tail is placed by the size the caller passes, not by the file', async () => {
    const text = numberedText(200_000)
    const file = writeScratch(text)
    const read = await readHeadAndTail(file, 100_000, freshBuffer())
    expect(read.tail).toBe(text.slice(100_000 - LITE_READ_BUF_SIZE, 100_000))
  })

  test('bytes are decoded as UTF-8, with a replacement where a character is cut', async () => {
    const text = `${'a'.repeat(LITE_READ_BUF_SIZE - 1)}\u00e9${'b'.repeat(10)}`
    const file = writeScratch(text)
    const read = await readHeadAndTail(file, statSync(file).size, freshBuffer())
    expect(read.head).toBe(`${'a'.repeat(LITE_READ_BUF_SIZE - 1)}\uFFFD`)
  })

  test('an empty file, a missing file or a directory give empty strings', async () => {
    const empty = writeScratch('')
    const dir = join(scratch, 'a-directory')
    mkdirSync(dir)
    const reads = await Promise.all([
      readHeadAndTail(empty, 0, freshBuffer()),
      readHeadAndTail(join(scratch, 'missing.jsonl'), 100, freshBuffer()),
      readHeadAndTail(dir, 100, freshBuffer()),
    ])
    expect(reads).toEqual([
      { head: '', tail: '' },
      { head: '', tail: '' },
      { head: '', tail: '' },
    ])
  })

  test('a buffer shorter than 64 KiB is an error, reported as empty strings', async () => {
    const file = writeScratch('{"a":1}\n')
    expect(await readHeadAndTail(file, 8, Buffer.alloc(1024))).toEqual({ head: '', tail: '' })
  })
})

describe('sanitizePath', () => {
  test('a short name has every UTF-16 unit outside A-Z, a-z and 0-9 turned into a dash', () => {
    const inputs = ['/Users/dev/my-project', 'plugin:name:server', 'C:\\Users\\dev\\acme', '~/a b/c.d_e', 'caf\u00e9', '\u{1F600}', 'AZaz09', '']
    expect(inputs.map(name => sanitizePath(name))).toEqual([
      '-Users-dev-my-project',
      'plugin-name-server',
      'C--Users-dev-acme',
      '--a-b-c-d-e',
      'caf-',
      '--',
      'AZaz09',
      '',
    ])
  })

  test('200 characters is the longest name kept whole', () => {
    expect(sanitizePath('a'.repeat(200))).toBe('a'.repeat(200))
    const longer = sanitizePath('a'.repeat(201))
    expect(longer.startsWith(`${'a'.repeat(200)}-`)).toBe(true)
    expect(longer.length).toBeGreaterThan(201)
  })

  test('a long name keeps a 200-character prefix and gains a base-36 hash of the original', () => {
    const cwd = `/work/${'nested/'.repeat(40)}app`
    const name = sanitizePath(cwd)
    expect(name.slice(0, 201)).toBe(`-work-${'nested-'.repeat(40)}`.slice(0, 200) + '-')
    expect(name.slice(201)).toMatch(/^[0-9a-z]+$/)
    expect(sanitizePath(cwd)).toBe(name)
    // Same sanitized text, different original: the hash tells them apart.
    const twin = cwd.replace(/\/app$/, ':app')
    expect(sanitizePath(twin).slice(0, 201)).toBe(name.slice(0, 201))
    expect(sanitizePath(twin)).not.toBe(name)
  })

  // The native binary installed from npm runs on Bun, and the Node bundle is
  // its fallback, so users' long-cwd directories carry either suffix. Both
  // are pinned: changing one orphans the sessions stored under it.
  test('under Bun, which the native binary runs on, the hash suffix is exact', () => {
    expect(sanitizePath(`/${'a'.repeat(250)}`)).toBe(`-${'a'.repeat(199)}-lni537xdrusg`)
    expect(sanitizePath(`/work/${'nested/'.repeat(40)}app`)).toBe(
      `${`-work-${'nested-'.repeat(40)}`.slice(0, 200)}-3dh8vz4brrq16`,
    )
  })

  test('under Node, the fallback bundle and the dev launcher, the hash suffix is exact', async () => {
    const node = Bun.which('node')
    expect(node).not.toBeNull()
    const outdir = mkdtempSync(join(tmpdir(), 'storage-pure-node-'))
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, 'sessionStoragePortable.ts')],
        target: 'node',
        format: 'esm',
        outdir,
      })
      expect(build.success).toBe(true)
      const moduleUrl = pathToFileURL(build.outputs[0]!.path).href
      const inputs = [`/${'a'.repeat(250)}`, `/work/${'nested/'.repeat(40)}app`, '/work/acme/api']
      const script = `const m = await import(${JSON.stringify(moduleUrl)});
        process.stdout.write(JSON.stringify(${JSON.stringify(inputs)}.map(p => m.sanitizePath(p))))`
      const run = Bun.spawnSync([node!, '--input-type=module', '-e', script])
      expect(run.stderr.toString()).toBe('')
      expect(run.exitCode).toBe(0)
      expect(JSON.parse(run.stdout.toString())).toEqual([
        `-${'a'.repeat(199)}-feo44x`,
        `${`-work-${'nested-'.repeat(40)}`.slice(0, 200)}-4trpsi`,
        '-work-acme-api',
      ])
    } finally {
      rmSync(outdir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('portable project directories', () => {
  let savedConfigDir: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  })

  test('follow the config home at every call, with nothing cached', () => {
    const first = join(scratch, 'home-a')
    const second = join(scratch, 'home-b')
    process.env.CLAUDIN_CONFIG_DIR = first
    expect(getProjectsDir()).toBe(join(first, 'projects'))
    expect(getProjectDir('/work/acme/api')).toBe(join(first, 'projects', '-work-acme-api'))
    process.env.CLAUDIN_CONFIG_DIR = second
    expect(getProjectsDir()).toBe(join(second, 'projects'))
    expect(getProjectDir('/work/acme/api')).toBe(join(second, 'projects', '-work-acme-api'))
  })
})

describe('readTranscriptForLoad', () => {
  const load = async (contents: string | Buffer, size?: number) => {
    const file = writeScratch(contents)
    const result = await readTranscriptForLoad(file, size ?? statSync(file).size)
    return { ...result, text: result.postBoundaryBuf.toString('utf8') }
  }
  const lineOf = (entry: object) => `${JSON.stringify(entry)}\n`
  const said = (text: string) =>
    lineOf({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text } })
  /** A line of exactly `bytes` bytes, newline included. */
  const filler = (bytes: number) => {
    const open = '{"type":"assistant","pad":"'
    const close = '"}\n'
    return `${open}${'x'.repeat(bytes - open.length - close.length)}${close}`
  }
  const snapshot = (n: number, padding = 0) =>
    lineOf({ type: 'attribution-snapshot', messageId: `m-${n}`, surface: 'cli', fileStates: {}, promptCount: n, pad: 'p'.repeat(padding) })
  const metadata = (preserved: boolean) =>
    preserved
      ? { trigger: 'auto', preTokens: 1, preservedSegment: { headUuid: 'h-1', anchorUuid: 'a-1', tailUuid: 't-1' } }
      : { trigger: 'auto', preTokens: 1 }
  /** A boundary with `type` as its first member. */
  const leadingTypeBoundary = (preserved = false) =>
    lineOf({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: metadata(preserved), uuid: 'b-lead' })
  /** A boundary laid out the way the transcript writer lays one out. */
  const writtenBoundary = (preserved = false) =>
    lineOf({
      parentUuid: null,
      logicalParentUuid: 'c0ffee00-0000-4000-8000-000000000012',
      isSidechain: false,
      type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
      isMeta: false,
      timestamp: '2026-09-20T10:00:13.000Z',
      uuid: 'c0ffee00-0000-4000-8000-000000000013',
      level: 'info',
      compactMetadata: metadata(preserved),
      userType: 'external',
      cwd: '/work/acme',
      sessionId: '5e551a0e-7c3b-4d2a-9f10-2b4c6d8e0a1f',
    })
  const bytesOf = (text: string) => Buffer.byteLength(text)

  describe('fixtures', () => {
    test('a compacted transcript loads from its boundary, with the latest snapshot at the end', async () => {
      const inputPath = join(FIXTURES, 'compacted.input.jsonl')
      const expected = readFileSync(join(FIXTURES, 'compacted.loaded.jsonl'))
      const result = await readTranscriptForLoad(inputPath, statSync(inputPath).size)
      expect(result.postBoundaryBuf.toString('utf8')).toBe(expected.toString('utf8'))
      expect(result.postBoundaryBuf.equals(expected)).toBe(true)
      const boundaryLine = expected.subarray(0, expected.indexOf(0x0a) + 1)
      expect(result.boundaryStartOffset).toBe(readFileSync(inputPath).indexOf(boundaryLine))
      expect(result.boundaryStartOffset).toBe(1971)
      expect(result.hasPreservedSegment).toBe(false)
    })

    test('a preserved-segment boundary cuts nothing, and a newline goes in before the moved snapshot', async () => {
      const inputPath = join(FIXTURES, 'preserved.input.jsonl')
      const expected = readFileSync(join(FIXTURES, 'preserved.loaded.jsonl'))
      const result = await readTranscriptForLoad(inputPath, statSync(inputPath).size)
      expect(result.postBoundaryBuf.toString('utf8')).toBe(expected.toString('utf8'))
      expect(result.boundaryStartOffset).toBe(0)
      expect(result.hasPreservedSegment).toBe(true)
    })
  })

  describe('plain reads', () => {
    test('a transcript without snapshots or boundaries comes back byte for byte', async () => {
      const text = said('one') + filler(300) + said('caf\u00e9 \u2713') + said('three')
      const result = await load(text)
      expect(result.text).toBe(text)
      expect(result.boundaryStartOffset).toBe(0)
      expect(result.hasPreservedSegment).toBe(false)
    })

    test('an empty file gives an empty buffer', async () => {
      const result = await load('')
      expect(result.postBoundaryBuf.length).toBe(0)
      expect(result.boundaryStartOffset).toBe(0)
    })

    test('a missing file rejects', async () => {
      await expect(readTranscriptForLoad(join(scratch, 'missing.jsonl'), 10)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    test('only as many bytes as the size given are read', async () => {
      const text = said('one') + said('two') + said('three')
      const cut = bytesOf(said('one') + said('two')) + 5
      expect((await load(text, cut)).text).toBe(text.slice(0, cut))
    })

    test('a size beyond the end of the file reads to the end', async () => {
      const text = said('one') + said('two')
      expect((await load(text, bytesOf(text) + 1000)).text).toBe(text)
    })

    test('lines longer than a read pass through unparsed', async () => {
      const notJson = `{"type":"user","message":${'garbage '.repeat(400_000)}\n`
      const text = said('a') + notJson + snapshot(1) + said('b')
      expect((await load(text)).text).toBe(said('a') + notJson + said('b') + snapshot(1))
    })

    test('an output beyond 8 MiB keeps every byte', async () => {
      const text = said('start') + filler(3 * MIB) + filler(3 * MIB) + filler(3 * MIB) + said('end')
      const result = await load(text)
      expect(result.postBoundaryBuf.equals(Buffer.from(text))).toBe(true)
    })
  })

  describe('attribution snapshots', () => {
    test('only the last one survives, moved to the end', async () => {
      const text = snapshot(1) + said('a') + snapshot(2) + said('b') + snapshot(3) + said('c')
      expect((await load(text)).text).toBe(said('a') + said('b') + said('c') + snapshot(3))
    })

    test('a snapshot is recognised only by its exact opening bytes', async () => {
      const reordered = lineOf({ messageId: 'm-1', type: 'attribution-snapshot' })
      const spaced = '{ "type":"attribution-snapshot","messageId":"m-2"}\n'
      const text = reordered + said('a') + spaced
      expect((await load(text)).text).toBe(text)
    })

    test('an unterminated snapshot at the end is the last one and gets no newline', async () => {
      const last = snapshot(2).trimEnd()
      expect((await load(snapshot(1) + said('a') + last)).text).toBe(said('a') + last)
    })

    test('when the file does not end in a newline, one goes in before the moved snapshot', async () => {
      const unterminated = said('b').trimEnd()
      const text = said('a') + snapshot(1) + unterminated
      const result = await load(text)
      expect(result.text).toBe(`${said('a')}${unterminated}\n${snapshot(1)}`)
      expect(result.postBoundaryBuf.length).toBe(bytesOf(text) + 1)
    })
  })

  describe('compact boundaries', () => {
    test('a boundary drops everything before it, snapshots included', async () => {
      const before = said('old') + snapshot(1) + filler(500)
      const after = writtenBoundary() + said('new')
      const result = await load(before + after)
      expect(result.text).toBe(after)
      expect(result.boundaryStartOffset).toBe(bytesOf(before))
      expect(result.hasPreservedSegment).toBe(false)
    })

    test('the last of several boundaries wins', async () => {
      const first = said('a') + writtenBoundary() + said('b')
      const rest = writtenBoundary() + said('c') + snapshot(2)
      const result = await load(first + rest)
      expect(result.text).toBe(rest.replace(snapshot(2), '') + snapshot(2))
      expect(result.boundaryStartOffset).toBe(bytesOf(first))
    })

    test('a preserved-segment boundary sets the flag and cuts nothing', async () => {
      const text = said('a') + writtenBoundary(true) + said('b')
      const result = await load(text)
      expect(result.text).toBe(text)
      expect(result.boundaryStartOffset).toBe(0)
      expect(result.hasPreservedSegment).toBe(true)
    })

    test('an ordinary boundary after a preserved one cuts and clears the flag', async () => {
      const before = said('a') + writtenBoundary(true) + said('b')
      const after = writtenBoundary() + said('c')
      const result = await load(before + after)
      expect(result.text).toBe(after)
      expect(result.boundaryStartOffset).toBe(bytesOf(before))
      expect(result.hasPreservedSegment).toBe(false)
    })

    test('a preserved boundary after an ordinary one keeps the cut and sets the flag', async () => {
      const before = said('a')
      const after = writtenBoundary() + said('b') + writtenBoundary(true) + said('c')
      const result = await load(before + after)
      expect(result.text).toBe(after)
      expect(result.boundaryStartOffset).toBe(bytesOf(before))
      expect(result.hasPreservedSegment).toBe(true)
    })

    test('the marker counts only on a system compact_boundary line that parses', async () => {
      const lookalikes = [
        said('compact_boundary'),
        lineOf({ type: 'system', subtype: 'informational', content: 'x', note: 'compact_boundary' }),
        lineOf({ type: 'user', subtype: 'compact_boundary', message: { role: 'user', content: 'not a system line' } }),
        '{"type":"system","subtype":"compact_boundary","content":"cut short\n',
      ]
      const text = said('first') + lookalikes.join('') + said('last')
      const result = await load(text)
      expect(result.text).toBe(text)
      expect(result.boundaryStartOffset).toBe(0)
    })

    test('the marker has to start within the first 256 bytes of its line', async () => {
      const boundaryWithMarkerAt = (offset: number) => {
        const open = '{"parentUuid":null,"pad":"'
        const close = '","isSidechain":false,"type":"system","subtype":'
        const pad = 'p'.repeat(offset - open.length - close.length)
        const line = `${open}${pad}${close}"compact_boundary","content":"Conversation compacted","compactMetadata":{"trigger":"auto","preTokens":1},"uuid":"b-far"}\n`
        expect(line.indexOf('"compact_boundary"')).toBe(offset)
        return line
      }
      const within = boundaryWithMarkerAt(255)
      const reached = await load(said('a') + within + said('b'))
      expect(reached.text).toBe(within + said('b'))
      expect(reached.boundaryStartOffset).toBe(bytesOf(said('a')))

      const beyond = said('a') + boundaryWithMarkerAt(256) + said('b')
      const missed = await load(beyond)
      expect(missed.text).toBe(beyond)
      expect(missed.boundaryStartOffset).toBe(0)
    })
  })

  describe('lines across the 1 MiB read seam', () => {
    /** Places `line` so that it starts `before` bytes ahead of the seam. */
    const straddling = (before: number, line: string) => filler(READ_SEAM - before) + line + said('tail')

    test('an ordinary line across the seam comes back unchanged', async () => {
      const text = straddling(100, said('x'.repeat(400)))
      expect((await load(text)).text).toBe(text)
    })

    test('a line several MiB long spans many reads unchanged', async () => {
      const text = said('a') + filler(2 * MIB + 12_345) + said('b')
      expect((await load(text)).text).toBe(text)
    })

    test('a snapshot across the seam is moved to the end, however it is split', async () => {
      for (const before of [100, 10]) {
        const snap = snapshot(1, 300)
        const result = await load(straddling(before, snap))
        expect(result.text).toBe(filler(READ_SEAM - before) + said('tail') + snap)
      }
    })

    test('a snapshot longer than a read is moved to the end', async () => {
      const snap = snapshot(1, 2 * MIB + 777)
      const result = await load(straddling(100, snap))
      expect(result.text).toBe(filler(READ_SEAM - 100) + said('tail') + snap)
    })

    test('a later snapshot inside the next read wins over one across the seam', async () => {
      const early = snapshot(1, 300)
      const late = snapshot(2)
      const text = filler(READ_SEAM - 100) + early + said('mid') + late + said('tail')
      expect((await load(text)).text).toBe(filler(READ_SEAM - 100) + said('mid') + said('tail') + late)
    })

    test('a boundary right after a snapshot across the seam drops that snapshot', async () => {
      const snap = snapshot(1, 300)
      const text = filler(READ_SEAM - 100) + snap + leadingTypeBoundary() + said('after')
      const result = await load(text)
      expect(result.text).toBe(leadingTypeBoundary() + said('after'))
      expect(result.boundaryStartOffset).toBe(READ_SEAM - 100 + bytesOf(snap))
    })

    test('a boundary across the seam cuts at its first byte, even with the marker split', async () => {
      for (const before of [60, 35]) {
        const text = filler(READ_SEAM - before) + leadingTypeBoundary() + said('new')
        const result = await load(text)
        expect(result.text).toBe(leadingTypeBoundary() + said('new'))
        expect(result.boundaryStartOffset).toBe(READ_SEAM - before)
      }
    })

    test('a boundary as the writer lays it out, under 30 bytes before the seam, cuts too', async () => {
      const text = filler(READ_SEAM - 20) + writtenBoundary() + said('new')
      const result = await load(text)
      expect(result.text).toBe(writtenBoundary() + said('new'))
      expect(result.boundaryStartOffset).toBe(READ_SEAM - 20)
    })

    test('a preserved boundary across the seam sets the flag and cuts nothing', async () => {
      const text = straddling(60, leadingTypeBoundary(true))
      const result = await load(text)
      expect(result.text).toBe(text)
      expect(result.hasPreservedSegment).toBe(true)
      expect(result.boundaryStartOffset).toBe(0)
    })

    test('a system line across the seam that is not a boundary stays in place', async () => {
      const note = lineOf({ type: 'system', subtype: 'informational', content: 'n'.repeat(200) })
      const broken = '{"type":"system","subtype":"compact_boundary","content":"cut short\n'
      for (const line of [note, broken]) {
        const text = straddling(100, line)
        const result = await load(text)
        expect(result.text).toBe(text)
        expect(result.boundaryStartOffset).toBe(0)
      }
    })

    test('an unterminated last line across the seam, ending in a short read, is kept whole', async () => {
      const last = `{"type":"user","message":{"content":"${'z'.repeat(500)}"}}`
      const text = filler(READ_SEAM - 40) + last
      expect((await load(text)).text).toBe(text)
    })
  })
})
