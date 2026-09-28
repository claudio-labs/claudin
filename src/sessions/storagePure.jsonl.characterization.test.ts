// Characterization of the byte-level JSONL helpers of session storage (unit
// `sessions/storagePure`). On resume, a transcript line whose tool result was
// replaced by a `<persisted-output>` preview still carries the raw result in a
// top-level `toolUseResult` member, which can be megabytes long. The stripper
// cuts that member out of the bytes; everything else must come back byte for
// byte, because transcripts are files users keep across versions.
//
// The stripper is imported through the session-storage barrel; the line
// visitor is not re-exported there, so it comes from its own module.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { forEachParsedJSONLBufferEntry } from 'src/sessions/pure/jsonlStripping.js'
import { stripPersistedToolUseResultsFromJSONLBuffer } from 'src/sessions/sessionStorage.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const TAG = '<persisted-output>'

const stripText = (text: string) =>
  stripPersistedToolUseResultsFromJSONLBuffer(Buffer.from(text)).toString('utf8')

describe('the persisted-output fixture', () => {
  const input = readFileSync(join(FIXTURES, 'persisted-output.input.jsonl'))
  const expected = readFileSync(join(FIXTURES, 'persisted-output.stripped.jsonl'))

  test('a real transcript comes out byte for byte as the stripped fixture', () => {
    const out = stripPersistedToolUseResultsFromJSONLBuffer(input)
    expect(out.toString('utf8')).toBe(expected.toString('utf8'))
    expect(out.equals(expected)).toBe(true)
  })

  test('only lines with a preview tag and a top-level raw result change', () => {
    const before = input.toString('utf8').split('\n')
    const after = stripPersistedToolUseResultsFromJSONLBuffer(input).toString('utf8').split('\n')
    expect(after).toHaveLength(before.length)
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index + 1]))
    expect(changed).toEqual([3, 6, 8])

    const entries = after.filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    const withRawResult = entries.flatMap((entry, index) => ('toolUseResult' in entry ? [index + 1] : []))
    // Line 5 has no preview; line 7 carries its raw result one level down.
    expect(withRawResult).toEqual([5])
    const nested = entries[6] as { data: { message: Record<string, unknown> } }
    expect(nested.data.message.toolUseResult).toEqual({ stdout: 'nested raw output' })
  })

  test('the input buffer is left untouched', () => {
    const copy = Buffer.from(input)
    stripPersistedToolUseResultsFromJSONLBuffer(input)
    expect(input.equals(copy)).toBe(true)
  })
})

describe('stripPersistedToolUseResultsFromJSONLBuffer', () => {
  test('a buffer with nothing to strip is handed back as the same instance', () => {
    const untouched = [
      Buffer.alloc(0),
      Buffer.from('{"type":"user","message":{"content":"plain"}}\n'),
      Buffer.from('{"type":"user","toolUseResult":{"stdout":"no preview here"}}\n'),
      Buffer.from(`{"type":"user","message":{"content":"${TAG}"}}\n`),
      Buffer.from(`{"note":"${TAG}"}\n{"toolUseResult":{"a":1}}\n`),
      Buffer.from(`{"message":{"content":"${TAG}","toolUseResult":{"a":1}}}\n`),
      Buffer.from(`{"a":"${TAG}","toolUseResult" :{"a":1}}\n`),
    ]
    const replaced = untouched.filter(buf => stripPersistedToolUseResultsFromJSONLBuffer(buf) !== buf)
    expect(replaced).toEqual([])
  })

  test('stripping yields a new buffer and leaves the input as it was', () => {
    const text = `{"a":"${TAG}","toolUseResult":{"big":"${'x'.repeat(64)}"},"b":2}\n`
    const buf = Buffer.from(text)
    const out = stripPersistedToolUseResultsFromJSONLBuffer(buf)
    expect(out).not.toBe(buf)
    expect(out.toString('utf8')).toBe(`{"a":"${TAG}","b":2}\n`)
    expect(buf.toString('utf8')).toBe(text)
  })

  const placements: Array<[string, string, string]> = [
    ['a middle member takes the comma after it', `{"a":1,"toolUseResult":{"x":[1,2]},"b":"${TAG}"}`, `{"a":1,"b":"${TAG}"}`],
    ['a first member takes the comma after it', `{"toolUseResult":"raw","a":"${TAG}"}`, `{"a":"${TAG}"}`],
    ['a last member takes the comma before it', `{"a":"${TAG}","toolUseResult":{"x":1}}`, `{"a":"${TAG}"}`],
    ['a last primitive member takes the comma before it', `{"a":"${TAG}","toolUseResult":42}`, `{"a":"${TAG}"}`],
    ['a lone member leaves an empty object', `{"toolUseResult":"${TAG} only"}`, '{}'],
    ['whitespace around a middle member stays', `{"c":"${TAG}","a":1, "toolUseResult": {"x":1} , "b":2}`, `{"c":"${TAG}","a":1,  "b":2}`],
    ['whitespace before a last member goes with its comma', `{"c":"${TAG}","a":1 ,  "toolUseResult":[1,2] }`, `{"c":"${TAG}","a":1  }`],
  ]
  test.each(placements)('%s', (_label, line, stripped) => {
    expect(stripText(line)).toBe(stripped)
  })

  test('removes a raw result of any JSON kind, strings and brackets inside it included', () => {
    const raws = [
      '"he said \\"}{\\" and left"',
      '"C:\\\\temp\\\\"',
      '"a \\" b"',
      '-12.5e3',
      'true',
      'false',
      'null',
      '[{"a":[1,{"b":"]}"}]},[],{}]',
      '{"out":"[[[{{{","err":"]]]}}}"}',
      '{"out":"\\"{"}',
    ]
    const leftovers = raws.map(raw => stripText(`{"before":"${TAG}","toolUseResult":${raw},"after":true}`))
    expect(leftovers).toEqual(raws.map(() => `{"before":"${TAG}","after":true}`))
  })

  test('a raw result nested inside another member stays; a later top-level one goes', () => {
    const line = `{"data":{"toolUseResult":{"inner":1},"text":"${TAG}"},"toolUseResult":{"outer":2},"z":0}`
    expect(stripText(line)).toBe(`{"data":{"toolUseResult":{"inner":1},"text":"${TAG}"},"z":0}`)
  })

  test('brackets and an escaped quote inside an earlier string do not upset the depth count', () => {
    const line = `{"note":"a \\" quote {[{[ ${TAG}","toolUseResult":{"k":"v"},"z":0}`
    expect(stripText(line)).toBe(`{"note":"a \\" quote {[{[ ${TAG}","z":0}`)
  })

  test('the preview tag may sit anywhere on the line, even inside the raw result', () => {
    const line = `{"message":{"content":"inline output"},"toolUseResult":{"stdout":"a file that mentions ${TAG}"},"uuid":"u-1"}`
    expect(stripText(line)).toBe('{"message":{"content":"inline output"},"uuid":"u-1"}')
  })

  test('a raw result cut short by a crash takes the rest of its line with it', () => {
    const cutString = `{"a":"${TAG}","toolUseResult":"half a val`
    const cutObject = `{"a":"${TAG}","toolUseResult":{"stdout":"half","list":[1,2`
    expect(stripText(`${cutString}\n${cutObject}\n`)).toBe(`{"a":"${TAG}"\n{"a":"${TAG}"\n`)
  })

  test('each line is judged on its own', () => {
    const lines = [`{"a":"${TAG}","toolUseResult":1,"b":2}`, '{"toolUseResult":{"kept":true},"b":3}']
    expect(stripText(`${lines.join('\n')}\n`)).toBe(`{"a":"${TAG}","b":2}\n{"toolUseResult":{"kept":true},"b":3}\n`)
  })

  test('line endings survive: CRLF, empty lines and a last line without a newline', () => {
    const line = `{"a":"${TAG}","toolUseResult":1,"b":2}`
    const kept = `{"a":"${TAG}","b":2}`
    expect(stripText(`${line}\r\n\n${line}`)).toBe(`${kept}\r\n\n${kept}`)
  })

  test('a multi-megabyte raw result is cut out without the line having to be valid JSON', () => {
    // Balanced brackets but not JSON: a whole-line parse would reject it. The
    // stripper walks the bytes, so the rest of the line comes back exactly.
    const raw = `{"stdout":"${'x'.repeat(6 * 1024 * 1024)}","note": this is not json, [neither] {is this} }`
    const head = `{"parentUuid":"p-1","type":"user","message":{"content":"${TAG}\\npreview\\n</persisted-output>"}`
    const tail = '"uuid":"u-1","cwd":"/work/acme"}'
    const line = `${head},"toolUseResult":${raw},${tail}\n`
    expect(() => JSON.parse(line)).toThrow()

    const out = stripText(line)
    expect(out).toBe(`${head},${tail}\n`)
    expect((JSON.parse(out) as { uuid: string }).uuid).toBe('u-1')
  })
})

describe('forEachParsedJSONLBufferEntry', () => {
  const visitAll = (input: string | Buffer): unknown[] => {
    const seen: unknown[] = []
    forEachParsedJSONLBufferEntry(typeof input === 'string' ? Buffer.from(input) : input, entry => {
      seen.push(entry)
    })
    return seen
  }

  test('visits the lines in order, skipping blank ones, with or without a final newline', () => {
    expect(visitAll('{"n":1}\n\n   \n{"n":2}\n{"n":3}')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  test('reads CRLF lines and ignores the whitespace around a line', () => {
    expect(visitAll('{"n":1}\r\n  {"n":2}\t \r\n')).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('a byte-order mark at the start of the buffer or of a line is ignored', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const buf = Buffer.concat([bom, Buffer.from('{"n":1}\n'), bom, Buffer.from('{"n":2}\n')])
    expect(visitAll(buf)).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('malformed lines are skipped and the lines after them are still visited', () => {
    expect(visitAll('{"n":1}\n{"n":\nnot json at all\n{"n":4}\n')).toEqual([{ n: 1 }, { n: 4 }])
  })

  test('any JSON value is handed to the visitor, not only objects', () => {
    expect(visitAll('42\n"text"\nnull\n[1,2]\ntrue\n')).toEqual([42, 'text', null, [1, 2], true])
  })

  test('a visitor that throws loses that entry and the walk goes on', () => {
    const numbers: number[] = []
    forEachParsedJSONLBufferEntry<{ n: number } | null>(Buffer.from('{"n":1}\nnull\n{"n":3}\n'), entry => {
      numbers.push(entry!.n)
    })
    expect(numbers).toEqual([1, 3])
  })

  test('text is decoded as UTF-8', () => {
    expect(visitAll('{"t":"caf\u00e9 \u2713 \u{1F600}"}\n')).toEqual([{ t: 'caf\u00e9 \u2713 \u{1F600}' }])
  })

  test('an empty buffer visits nothing', () => {
    expect(visitAll('')).toEqual([])
  })

  test('the loaded fixture parses into its entries', () => {
    const kinds: string[] = []
    forEachParsedJSONLBufferEntry<{ type: string }>(readFileSync(join(FIXTURES, 'compacted.loaded.jsonl')), entry => {
      kinds.push(entry.type)
    })
    expect(kinds).toEqual(['system', 'user', 'user', 'assistant', 'custom-title', 'attribution-snapshot'])
  })
})
