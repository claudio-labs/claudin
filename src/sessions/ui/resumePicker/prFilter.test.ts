import { describe, expect, test } from 'bun:test'
import { filterLogsByPr, type PrFilter, parsePrIdentifier } from 'src/sessions/ui/resumePicker/prFilter.js'
import type { LogOption } from 'src/shared/types/logs.js'

describe('parsePrIdentifier', () => {
  const cases: Array<[string, number | null]> = [
    ['17', 17],
    [' 42 ', 42],
    ['https://github.com/acme/app/pull/42', 42],
    ['see github.com/acme/app/pull/7/files', 7],
    ['0', null],
    ['-17', null],
    ['17abc', null],
    ['release notes', null],
    ['https://github.com/acme/app/pull/0', null],
    ['https://gitlab.com/acme/app/pull/3', null],
    ['', null],
  ]
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} -> ${expected}`, () => {
      expect(parsePrIdentifier(text)).toBe(expected)
    })
  }
})

describe('filterLogsByPr', () => {
  const log = (title: string, prNumber?: number) => ({ customTitle: title, prNumber }) as LogOption
  const logs = [log('seventeen', 17), log('forty-two', 42), log('none')]
  const cases: Array<{ filter: PrFilter; kept: string[] }> = [
    { filter: undefined, kept: ['seventeen', 'forty-two', 'none'] },
    { filter: false, kept: ['seventeen', 'forty-two', 'none'] },
    { filter: true, kept: ['seventeen', 'forty-two'] },
    { filter: 42, kept: ['forty-two'] },
    { filter: '17', kept: ['seventeen'] },
    { filter: 'https://github.com/acme/app/pull/42', kept: ['forty-two'] },
    { filter: 99, kept: [] },
    { filter: 'release notes', kept: ['seventeen', 'forty-two', 'none'] },
  ]
  for (const { filter, kept } of cases) {
    test(`${JSON.stringify(filter)} keeps ${kept.join(', ') || 'nothing'}`, () => {
      expect(filterLogsByPr(logs, filter).map(entry => entry.customTitle)).toEqual(kept)
    })
  }
})
