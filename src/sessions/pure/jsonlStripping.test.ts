// The stripper works on bytes only. The characterization suite shows it cuts
// a raw result that is not valid JSON; these pin that it never parses at all,
// and that a qualifying line cut inside a later key is left alone.

import { describe, expect, spyOn, test } from 'bun:test'

import { stripPersistedToolUseResultsFromJSONLBuffer } from 'src/sessions/pure/jsonlStripping.js'

const TAG = '<persisted-output>'

describe('stripPersistedToolUseResultsFromJSONLBuffer', () => {
  test('never parses a line, valid JSON included', () => {
    const parse = spyOn(JSON, 'parse')
    try {
      const line = `{"message":{"content":"${TAG}"},"toolUseResult":{"stdout":"[1,{\\"a\\":2}]","n":[1,2]},"uuid":"u-9"}\n`
      const out = stripPersistedToolUseResultsFromJSONLBuffer(Buffer.from(line.repeat(3)))
      expect(out.toString('utf8')).toBe(`{"message":{"content":"${TAG}"},"uuid":"u-9"}\n`.repeat(3))
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  test('a qualifying line that ends inside a later key comes back as it was', () => {
    const buf = Buffer.from(`{"inner":{"toolUseResult":1},"a":"${TAG}","toolUseRes`)
    expect(stripPersistedToolUseResultsFromJSONLBuffer(buf)).toBe(buf)
  })

  test('a raw result inside an array at the top level is not a member of the outermost object', () => {
    const buf = Buffer.from(`[{"toolUseResult":1,"a":"${TAG}"}]\n`)
    expect(stripPersistedToolUseResultsFromJSONLBuffer(buf)).toBe(buf)
  })
})
