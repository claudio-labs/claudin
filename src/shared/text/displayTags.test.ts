import { describe, expect, test } from 'bun:test'
import { wrapPastedText } from 'src/agent/input/pastedContent.js'
import {
  stripDisplayTags,
  stripDisplayTagsAllowEmpty,
  stripIdeContextTags,
  unwrapPastedContent,
} from 'src/shared/text/displayTags.js'

const PASTED = wrapPastedText('the pasted log', 'a1b2')

describe('stripDisplayTags', () => {
  test('drops injected blocks and keeps the prose', () => {
    expect(stripDisplayTags('<ide_selection>x</ide_selection>\nfix the <Button> layout')).toBe(
      'fix the <Button> layout',
    )
  })

  test('falls back to the original when only tags remain', () => {
    expect(stripDisplayTags('<task-notification>done</task-notification>')).toBe(
      '<task-notification>done</task-notification>',
    )
  })

  test('a paste stays in the title as the text the user pasted', () => {
    expect(stripDisplayTags(`explain ${PASTED} please`)).toBe('explain the pasted log please')
    expect(stripDisplayTags(PASTED)).toBe('the pasted log')
  })
})

describe('stripDisplayTagsAllowEmpty', () => {
  test('returns empty when only injected tags remain', () => {
    expect(stripDisplayTagsAllowEmpty('<command-name>/clear</command-name>')).toBe('')
  })

  test('a paste-only prompt is not empty', () => {
    expect(stripDisplayTagsAllowEmpty(PASTED)).toBe('the pasted log')
  })
})

describe('stripIdeContextTags', () => {
  test('drops IDE context and keeps lowercase HTML the user typed', () => {
    expect(stripIdeContextTags('<ide_opened_file>a.ts</ide_opened_file>\nuse <code>x</code>')).toBe(
      'use <code>x</code>',
    )
  })
})

describe('unwrapPastedContent', () => {
  test('keeps the text around the block', () => {
    expect(unwrapPastedContent(`a ${PASTED} b`)).toBe('a the pasted log b')
  })
})
