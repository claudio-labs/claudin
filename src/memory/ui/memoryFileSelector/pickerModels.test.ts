import { describe, expect, test } from 'bun:test'

import { TIDY_VALUE } from 'src/memory/ui/memoryDirRows.js'
import { createChoiceMemory } from 'src/memory/ui/memoryFileSelector/choiceMemory.js'
import { describeDreamStatus, type DreamStatusInput } from 'src/memory/ui/memoryFileSelector/dreamStatus.js'
import { type PickerFocus, stepFocus, type SwitchKey } from 'src/memory/ui/memoryFileSelector/focus.js'
import { overrideNote } from 'src/memory/ui/memoryFileSelector/switchNote.js'

describe('describeDreamStatus', () => {
  const ago = (at: number) => `${at}ms ago`
  const cases: Array<[DreamStatusInput, string]> = [
    [{ enabled: false, running: false, lastRunAt: null }, ''],
    [{ enabled: true, running: false, lastRunAt: null }, ' · /dream to run'],
    [{ enabled: false, running: false, lastRunAt: 0 }, ' · never'],
    [{ enabled: true, running: false, lastRunAt: 0 }, ' · never · /dream to run'],
    [{ enabled: true, running: false, lastRunAt: 42 }, ' · last ran 42ms ago · /dream to run'],
    [{ enabled: false, running: false, lastRunAt: 42 }, ' · last ran 42ms ago'],
    [{ enabled: true, running: true, lastRunAt: 42 }, ' · running'],
    [{ enabled: false, running: true, lastRunAt: null }, ' · running'],
  ]
  for (const [given, expected] of cases) {
    test(JSON.stringify(given), () => {
      expect(describeDreamStatus(given, ago)).toBe(expected)
    })
  }
})

describe('stepFocus', () => {
  const both: SwitchKey[] = ['autoMemory', 'autoDream']
  const one: SwitchKey[] = ['autoMemory']
  const cases: Array<[PickerFocus, 'up' | 'down', SwitchKey[], PickerFocus]> = [
    ['list', 'up', both, 'autoDream'],
    ['list', 'up', one, 'autoMemory'],
    ['autoDream', 'up', both, 'autoMemory'],
    ['autoMemory', 'up', both, 'autoMemory'],
    ['autoMemory', 'down', both, 'autoDream'],
    ['autoDream', 'down', both, 'list'],
    ['autoMemory', 'down', one, 'list'],
    ['list', 'down', both, 'list'],
  ]
  for (const [from, direction, switches, to] of cases) {
    test(`${direction} from ${from} with ${switches.length} switch(es): ${to}`, () => {
      expect(stepFocus(from, direction, switches)).toBe(to)
    })
  }
})

describe('createChoiceMemory', () => {
  test('nothing chosen yet: the first row', () => {
    expect(createChoiceMemory().focusAmong(['a', 'b'])).toBe('a')
  })

  test('the last choice while it is offered, the first row once it is gone', () => {
    const memory = createChoiceMemory()
    memory.remember('b')
    expect(memory.focusAmong(['a', 'b'])).toBe('b')
    expect(memory.focusAmong(['a', 'c'])).toBe('a')
  })

  test('tidy is never remembered', () => {
    const memory = createChoiceMemory()
    memory.remember('b')
    memory.remember(TIDY_VALUE)
    expect(memory.focusAmong(['a', 'b', TIDY_VALUE])).toBe('b')
  })

  test('an empty list has nothing to focus', () => {
    expect(createChoiceMemory().focusAmong([])).toBeUndefined()
  })
})

describe('overrideNote', () => {
  const cases: Array<[boolean | undefined, boolean, boolean]> = [
    [undefined, false, false],
    [undefined, true, false],
    [true, true, false],
    [false, false, false],
    [true, false, true],
    [false, true, true],
  ]
  for (const [requested, effective, noted] of cases) {
    test(`asked ${String(requested)}, in effect ${effective}: ${noted ? 'says so' : 'silent'}`, () => {
      expect(overrideNote(requested, effective) !== '').toBe(noted)
    })
  }
})
