import { describe, expect, test } from 'bun:test'

import {
  type IntervalUnit,
  type LoopRequest,
  formatInterval,
  parseLoopRequest,
} from 'src/skills/bundled/shared/loopRequest.js'

function fixed(count: number, unit: IntervalUnit, prompt?: string): LoopRequest {
  const interval = { count, unit }
  return prompt === undefined ? { kind: 'fixed', interval } : { kind: 'fixed', interval, prompt }
}

describe('parseLoopRequest', () => {
  test('no arguments, or only whitespace, is a self-paced maintenance loop', () => {
    expect(parseLoopRequest('')).toEqual({ kind: 'self-paced' })
    expect(parseLoopRequest(' \n\t ')).toEqual({ kind: 'self-paced' })
  })

  const SPELLINGS: ReadonlyArray<readonly [string, IntervalUnit]> = [
    ['s', 's'], ['sec', 's'], ['secs', 's'], ['second', 's'], ['seconds', 's'],
    ['m', 'm'], ['min', 'm'], ['mins', 'm'], ['minute', 'm'], ['minutes', 'm'],
    ['h', 'h'], ['hr', 'h'], ['hrs', 'h'], ['hour', 'h'], ['hours', 'h'],
    ['d', 'd'], ['day', 'd'], ['days', 'd'],
  ]
  for (const [spelling, unit] of SPELLINGS) {
    test(`"${spelling}" is the unit ${unit}, attached or after a space, in any case`, () => {
      expect(parseLoopRequest(`4${spelling}`)).toEqual(fixed(4, unit))
      expect(parseLoopRequest(`4 ${spelling.toUpperCase()}`)).toEqual(fixed(4, unit))
    })
  }

  test('a count drops its leading zeros', () => {
    expect(parseLoopRequest('007m')).toEqual(fixed(7, 'm'))
  })

  test('an interval as the first token schedules the rest as the prompt, spacing kept', () => {
    expect(parseLoopRequest('5m check the deploy')).toEqual(fixed(5, 'm', 'check the deploy'))
    expect(parseLoopRequest('  2h   watch  the build\n  and report \n')).toEqual(
      fixed(2, 'h', 'watch  the build\n  and report'),
    )
  })

  test('a trailing "every" clause is taken off the prompt', () => {
    expect(parseLoopRequest('check the deploy every 20m')).toEqual(fixed(20, 'm', 'check the deploy'))
    expect(parseLoopRequest('run tests every 5 minutes')).toEqual(fixed(5, 'm', 'run tests'))
    expect(parseLoopRequest('poll the queue EVERY 3 hrs')).toEqual(fixed(3, 'h', 'poll the queue'))
    expect(parseLoopRequest('watch the build\nand report every 1 day')).toEqual(
      fixed(1, 'd', 'watch the build\nand report'),
    )
  })

  test('an "every" clause on its own is a fixed maintenance loop', () => {
    expect(parseLoopRequest('every 5m')).toEqual(fixed(5, 'm'))
    expect(parseLoopRequest('Every 2 hours')).toEqual(fixed(2, 'h'))
  })

  test('a leading interval wins over a trailing clause', () => {
    expect(parseLoopRequest('5m ping every 10m')).toEqual(fixed(5, 'm', 'ping every 10m'))
  })

  const SELF_PACED = [
    'check the deploy',
    'check every PR',
    'check every 5 PRs',
    '5 minutes check the deploy',
    'watch  the build\nand report',
  ]
  for (const prompt of SELF_PACED) {
    test(`${JSON.stringify(prompt)} is self-paced, with the whole text as its prompt`, () => {
      expect(parseLoopRequest(` ${prompt}\n`)).toEqual({ kind: 'self-paced', prompt })
    })
  }

  const NOT_INTERVALS = ['0m', '0 minutes', '5w', '5ms', '1.5h', '-5m', '5m,', '99999999999999999999m']
  for (const text of NOT_INTERVALS) {
    test(`${JSON.stringify(text)} is not an interval`, () => {
      expect(parseLoopRequest(text)).toEqual({ kind: 'self-paced', prompt: text })
    })
  }
})

describe('formatInterval', () => {
  test('writes the count and the one-letter unit', () => {
    expect(formatInterval({ count: 90, unit: 's' })).toBe('90s')
    expect(formatInterval({ count: 1, unit: 'd' })).toBe('1d')
  })
})
