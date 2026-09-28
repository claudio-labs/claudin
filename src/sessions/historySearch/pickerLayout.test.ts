import { describe, expect, test } from 'bun:test'
import { pickerWidths, previewLines, promptRow } from 'src/sessions/historySearch/pickerLayout.js'

const MINUTE = 60_000
const NOW = new Date('2026-09-28T12:00:00Z')
const ago = (ms: number) => NOW.getTime() - ms

describe('pickerWidths', () => {
  test.each([
    [120, { previewBeside: true, rowText: 48, preview: 51 }],
    [100, { previewBeside: true, rowText: 38, preview: 41 }],
    [99, { previewBeside: false, rowText: 84, preview: 89 }],
    [80, { previewBeside: false, rowText: 65, preview: 70 }],
  ])('at %i columns', (columns, widths) => {
    expect(pickerWidths(columns)).toEqual(widths)
  })

  test('neither the row text nor the preview goes below 20 columns', () => {
    expect(pickerWidths(24)).toEqual({ previewBeside: false, rowText: 20, preview: 20 })
  })
})

describe('promptRow', () => {
  test('the age padded to eight columns, then the first line', () => {
    expect(promptRow({ display: 'first\nsecond', timestamp: ago(5.5 * MINUTE) }, 40, NOW)).toEqual({ age: '5m ago  ', text: 'first' })
  })

  test('a Windows line break ends the first line too', () => {
    expect(promptRow({ display: 'first\r\nsecond', timestamp: ago(MINUTE) }, 40, NOW).text).toBe('first')
  })

  test('the first line is cut to the width with an ellipsis', () => {
    expect(promptRow({ display: 'x'.repeat(30), timestamp: ago(MINUTE) }, 20, NOW).text).toBe(`${'x'.repeat(19)}…`)
  })

  test('a timestamp in the future reads as one', () => {
    expect(promptRow({ display: 'later', timestamp: NOW.getTime() + 5.5 * MINUTE }, 40, NOW).age).toBe('in 5m   ')
  })
})

describe('previewLines', () => {
  test('wraps the whole prompt hard to the width', () => {
    expect(previewLines(`${'z'.repeat(25)}\nshort`, 10)).toEqual(['z'.repeat(10), 'z'.repeat(10), 'z'.repeat(5), 'short'])
  })

  test('drops lines that are empty or only spaces', () => {
    expect(previewLines('one\n\n   \ntwo\n', 20)).toEqual(['one', 'two'])
  })

  test('shows six lines as they are, and past six the first five and a count of the rest', () => {
    const six = ['1', '2', '3', '4', '5', '6']
    expect(previewLines(six.join('\n'), 20)).toEqual(six)
    expect(previewLines([...six, '7', '8'].join('\n'), 20)).toEqual(['1', '2', '3', '4', '5', '… +3 more lines'])
  })
})
