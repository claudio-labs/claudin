import { describe, expect, test } from 'bun:test'

import { stringMemberPrefix } from 'src/sessions/indexing/liteRead/promptPrefix.js'
import { leadingMembers, windowEntries } from 'src/sessions/indexing/liteRead/windowEntries.js'
import { newestMessage } from 'src/sessions/indexing/fullLoad/anchor.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'

describe('leadingMembers: the scalar top-level members before a line is cut', () => {
  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['a whole line', '{"type":"user","isSidechain":true,"n":3,"x":null}', { type: 'user', isSidechain: true, n: 3, x: null }],
    ['cut inside a string value', '{"type":"user","cwd":"/sr', { type: 'user' }],
    ['cut inside an object value', '{"type":"user","message":{"content":"lor', { type: 'user' }],
    ['an object value skipped whole', '{"message":{"tag":"inner"},"tag":"outer"', { tag: 'outer' }],
    ['braces inside a string do not end a skipped object', '{"message":{"content":"a}b{"},"tag":"outer","x":', { tag: 'outer' }],
    ['a number the cut may have shortened', '{"type":"pr-link","prNumber":4', { type: 'pr-link' }],
    ['spaces and escaped keys', '{ "ty\\u0070e" : "user" , "isSidechain": true }', { type: 'user', isSidechain: true }],
    ['a literal running to the end of the text, which may be cut', '{"type":"user","isSidechain":tr', { type: 'user' }],
    ['not an object', '[1,2]', undefined],
  ]
  for (const [name, line, expected] of cases) {
    test(name, () => {
      expect(leadingMembers(line)).toEqual(expected as never)
    })
  }
})

describe('windowEntries', () => {
  test('whole lines are parsed, a cut last line keeps its leading members, a cut first line is dropped only mid-file', () => {
    const window = '"tag":"frag"}\n{"type":"tag","tag":"whole"}\n\n{"type":"user","isSidechain":true,"message":{"co'
    expect(windowEntries(window, true)).toEqual([{ type: 'tag', tag: 'whole' }, { type: 'user', isSidechain: true }])
    expect(windowEntries('{"type":"tag","tag":"first"}\n', true)).toEqual([{ type: 'tag', tag: 'first' }])
  })
})

describe('stringMemberPrefix: the raw start of a string member', () => {
  const cases: Array<[string, string, string, number, string]> = [
    ['stops at the closing quote', '{"content":"short one","x":1}', 'content', 200, 'short one'],
    ['turns \\n and \\t into spaces and trims', '{"content":"  a\\nb\\tc  "}', 'content', 200, 'a b c'],
    ['keeps other escapes as written', '{"content":"say \\"hi\\""}', 'content', 200, 'say \\"hi\\"'],
    ['cuts at maxLen when the string never closes', '{"text":"abcdefgh', 'text', 5, 'abcde'],
    ['allows a space after the colon', '{"text": "spaced"}', 'text', 200, 'spaced'],
    ['nothing when the member is missing', '{"other":"x"}', 'content', 200, ''],
  ]
  for (const [name, text, key, maxLen, expected] of cases) {
    test(name, () => {
      expect(stringMemberPrefix(text, key, maxLen)).toBe(expected)
    })
  }
})

describe('newestMessage: the one anchor rule', () => {
  const msg = (uuid: string, timestamp: string, isSidechain = false) => ({ uuid, timestamp, isSidechain }) as unknown as TranscriptMessage
  const cases: Array<[string, TranscriptMessage[], string | undefined]> = [
    ['the newest wins', [msg('a', '2026-01-01T00:00:02Z'), msg('b', '2026-01-01T00:00:01Z')], 'a'],
    ['a tie goes to the later written', [msg('a', '2026-01-01T00:00:01Z'), msg('b', '2026-01-01T00:00:01Z')], 'b'],
    ['a bad timestamp loses to a real one', [msg('a', '2026-01-01T00:00:01Z'), msg('b', 'not a date')], 'a'],
    ['a bad timestamp written first loses too', [msg('a', 'not a date'), msg('b', '2026-01-01T00:00:01Z')], 'b'],
    ['filtered out messages never anchor', [msg('a', '2026-01-01T00:00:01Z'), msg('b', '2026-01-01T00:00:09Z', true)], 'a'],
    ['nothing to choose from', [], undefined],
  ]
  for (const [name, messages, expected] of cases) {
    test(name, () => {
      expect(newestMessage(messages, m => !m.isSidechain)?.uuid).toBe(expected as never)
    })
  }
})
