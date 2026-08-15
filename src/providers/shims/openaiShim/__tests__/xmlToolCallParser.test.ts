/**
 * Unit tests for the XML tool-call parser (dialects A/B/C/D).
 *
 * Pure module — no ink/analytics imports — so it loads directly under bun test.
 * Streaming integration (hold-back, false-positive flush, finish_reason rewrite)
 * is covered end-to-end in streamParser.test.ts.
 */

import { describe, expect, test } from 'bun:test'

import {
  coerceXmlToolValue,
  extractBalancedJson,
  findXmlToolCallOpener,
  isHy3Model,
  parseXmlToolCalls,
  recoverXmlToolCallsFromText,
  stripRanges,
  trailingXmlOpenerPrefixLen,
} from 'src/providers/shims/openaiShim/xmlToolCallParser.js'

describe('coerceXmlToolValue', () => {
  test('round-trips JSON scalars and objects', () => {
    expect(coerceXmlToolValue('42')).toBe(42)
    expect(coerceXmlToolValue('true')).toBe(true)
    expect(coerceXmlToolValue('  {"a":1} ')).toEqual({ a: 1 })
    expect(coerceXmlToolValue('[1,2]')).toEqual([1, 2])
  })

  test('falls back to the raw string for non-JSON', () => {
    expect(coerceXmlToolValue('src/foo.ts')).toBe('src/foo.ts')
    expect(coerceXmlToolValue('')).toBe('')
  })
})

describe('extractBalancedJson', () => {
  test('extracts a balanced object, honoring braces inside strings', () => {
    const text = 'x {"a":"}{","b":2} y'
    const start = text.indexOf('{')
    expect(extractBalancedJson(text, start)).toBe('{"a":"}{","b":2}')
  })

  test('returns null on a truncated (unbalanced) object', () => {
    const text = '{"a":1'
    expect(extractBalancedJson(text, 0)).toBeNull()
  })
})

describe('stripRanges', () => {
  test('removes ranges and keeps surrounding text (unsorted input)', () => {
    const text = 'ABCDEFGHIJ'
    // Remove [2,4) then [6,8) — provided out of order.
    expect(stripRanges(text, [[6, 8], [2, 4]])).toBe('ABEFIJ')
  })
})

describe('parseXmlToolCalls — dialect A (<function=…>)', () => {
  test('parses name + parameters with typed coercion', () => {
    const text =
      'here <tool_call><function=Read><parameter=file_path>/tmp/x</parameter>' +
      '<parameter=limit>10</parameter></function></tool_call> done'
    const { calls, toolCallRanges } = parseXmlToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('Read')
    expect(calls[0]!.arguments).toEqual({ file_path: '/tmp/x', limit: 10 })
    // The stripped remainder keeps only the surrounding prose.
    expect(stripRanges(text, toolCallRanges)).toBe('here  done')
  })

  test('coerces a nested-JSON parameter value', () => {
    const text =
      '<tool_call><function=Edit><parameter=opts>{"replace_all":true}</parameter>' +
      '</function></tool_call>'
    const { calls } = parseXmlToolCalls(text)
    expect(calls[0]!.arguments).toEqual({ opts: { replace_all: true } })
  })
})

describe('parseXmlToolCalls — dialect B (GLM arg_key/arg_value)', () => {
  test('leading token is the name, then key/value pairs', () => {
    const text =
      '<tool_call>Grep<arg_key>pattern</arg_key><arg_value>foo</arg_value>' +
      '<arg_key>n</arg_key><arg_value>true</arg_value></tool_call>'
    const { calls } = parseXmlToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('Grep')
    expect(calls[0]!.arguments).toEqual({ pattern: 'foo', n: true })
  })
})

describe('parseXmlToolCalls — dialect C (Hermes JSON)', () => {
  test('parses arguments given as an object', () => {
    const text = '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>'
    const { calls } = parseXmlToolCalls(text)
    expect(calls[0]!.name).toBe('Bash')
    expect(calls[0]!.arguments).toEqual({ command: 'ls' })
  })

  test('parses arguments given as a stringified JSON blob', () => {
    const text = '<tool_call>{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>'
    const { calls } = parseXmlToolCalls(text)
    expect(calls[0]!.name).toBe('Bash')
    expect(calls[0]!.arguments).toEqual({ command: 'ls' })
  })

  test('tolerates a truncated JSON block (no close tag, unbalanced)', () => {
    const text = '<tool_call>{"name":"Bash","arguments":{"command":"ls"'
    const { calls } = parseXmlToolCalls(text)
    // Unbalanced JSON → no name extracted → no call, but no throw.
    expect(calls).toHaveLength(0)
  })
})

describe('parseXmlToolCalls — dialect D (Tencent HY3)', () => {
  test('only fires when allowHy3 is set', () => {
    const text =
      '<tool_calls:abc><tool_call:abc>Read<parameter name="file_path">/tmp/x</parameter>' +
      '</tool_call:abc></tool_calls:abc>'
    expect(parseXmlToolCalls(text, false).calls).toHaveLength(0)
    const { calls } = parseXmlToolCalls(text, true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('Read')
    expect(calls[0]!.arguments).toEqual({ file_path: '/tmp/x' })
  })

  test('parses the name: value line form', () => {
    const text = '<tool_call:z>Grep\npattern: hello</tool_call:z>'
    const { calls } = parseXmlToolCalls(text, true)
    expect(calls[0]!.name).toBe('Grep')
    expect(calls[0]!.arguments).toEqual({ pattern: 'hello' })
  })
})

describe('parseXmlToolCalls — dedup & multiplicity', () => {
  test('deduplicates identical name+args', () => {
    const block = '<tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call>'
    const { calls } = parseXmlToolCalls(block + block)
    expect(calls).toHaveLength(1)
  })

  test('keeps two distinct calls and strips exactly the tool XML', () => {
    const text =
      'a<tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call>' +
      'b<tool_call><function=Read><parameter=file_path>/b</parameter></function></tool_call>c'
    const { calls, toolCallRanges } = parseXmlToolCalls(text)
    expect(calls.map(c => c.arguments)).toEqual([{ file_path: '/a' }, { file_path: '/b' }])
    expect(stripRanges(text, toolCallRanges)).toBe('abc')
  })

  test('truncated final block (no close tag) still parses', () => {
    const text = '<tool_call><function=Read><parameter=file_path>/a</parameter></function>'
    const { calls } = parseXmlToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.arguments).toEqual({ file_path: '/a' })
  })
})

describe('parseXmlToolCalls — false positives', () => {
  test('prose mentioning <tool_call> with no valid name yields nothing', () => {
    const text = 'You emit a <tool_call> block to call a tool.'
    expect(parseXmlToolCalls(text).calls).toHaveLength(0)
  })
})

describe('streaming hold-back helpers', () => {
  test('findXmlToolCallOpener returns the earliest opener', () => {
    expect(findXmlToolCallOpener('abc<tool_call>x', false)).toBe(3)
    expect(findXmlToolCallOpener('no opener here', false)).toBe(-1)
  })

  test('findXmlToolCallOpener sees HY3 openers only when allowed', () => {
    expect(findXmlToolCallOpener('a<tool_call:z>', false)).toBe(-1)
    expect(findXmlToolCallOpener('a<tool_call:z>', true)).toBe(1)
  })

  test('trailingXmlOpenerPrefixLen holds back a split opener', () => {
    // "<tool_" is a proper prefix of "<tool_call>" → hold back all 6 chars.
    expect(trailingXmlOpenerPrefixLen('hello <tool_', false)).toBe(6)
    // No partial opener at the tail.
    expect(trailingXmlOpenerPrefixLen('hello world', false)).toBe(0)
  })
})

describe('recoverXmlToolCallsFromText (non-streaming path)', () => {
  const text =
    'sure <tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call> ok'

  test('returns residual prose + valid calls', () => {
    const r = recoverXmlToolCallsFromText(text, { toolNames: new Set(['Read']) })
    expect(r).not.toBeNull()
    expect(r!.visibleText).toBe('sure  ok')
    expect(r!.calls).toHaveLength(1)
    expect(r!.calls[0]!.name).toBe('Read')
    expect(r!.calls[0]!.arguments).toEqual({ file_path: '/a' })
  })

  test('returns null when the parsed name is not an advertised tool', () => {
    expect(recoverXmlToolCallsFromText(text, { toolNames: new Set(['Grep']) })).toBeNull()
  })

  test('returns null when there is no tool XML at all', () => {
    expect(
      recoverXmlToolCallsFromText('just prose', { toolNames: new Set(['Read']) }),
    ).toBeNull()
  })

  test('strips <think> from the residual prose', () => {
    const withThink =
      '<think>reason</think><tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call>'
    const r = recoverXmlToolCallsFromText(withThink, { toolNames: new Set(['Read']) })
    expect(r!.visibleText).toBe('')
  })

  test('HY3 requires allowHy3', () => {
    const hy3 = '<tool_call:z>Read<parameter name="file_path">/h</parameter></tool_call:z>'
    expect(recoverXmlToolCallsFromText(hy3, { toolNames: new Set(['Read']) })).toBeNull()
    const r = recoverXmlToolCallsFromText(hy3, { allowHy3: true, toolNames: new Set(['Read']) })
    expect(r!.calls[0]!.arguments).toEqual({ file_path: '/h' })
  })
})

describe('isHy3Model', () => {
  test('matches tencent/hy3 case-insensitively and ignores query params', () => {
    expect(isHy3Model('tencent/hy3')).toBe(true)
    expect(isHy3Model('Tencent/HY3?foo=1')).toBe(true)
    expect(isHy3Model('glm-4.5')).toBe(false)
  })
})
