import { describe, expect, test } from 'bun:test'
import { getSnippetForTwoFileDiff } from 'src/tools/FileEditTool/utils.js'

const LINE_NUMBER_RE = /^\s*(\d+)/

function numberOf(snippet: string, marker: string): number | undefined {
  const line = snippet.split('\n').find(l => l.includes(marker))
  const match = line?.match(LINE_NUMBER_RE)
  return match ? Number(match[1]) : undefined
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)

describe('getSnippetForTwoFileDiff', () => {
  test('numbers a single change by its line in the new file', () => {
    const before = lines(30)
    const after = [...before]
    after[19] = 'CHANGED'
    expect(numberOf(getSnippetForTwoFileDiff(before.join('\n'), after.join('\n')), 'CHANGED')).toBe(20)
  })

  test('offsets the numbering by firstLine', () => {
    const before = lines(30)
    const after = [...before]
    after[19] = 'CHANGED'
    expect(numberOf(getSnippetForTwoFileDiff(before.join('\n'), after.join('\n'), 101), 'CHANGED')).toBe(120)
  })

  test('returns an empty string when nothing changed', () => {
    expect(getSnippetForTwoFileDiff('a\nb', 'a\nb')).toBe('')
  })

  test('a later hunk is numbered in the new file after an insertion above it', () => {
    const before = lines(60)
    const after = [...before]
    after.splice(1, 0, 'INSERTED')
    after[50] = 'CHANGED'
    const snippet = getSnippetForTwoFileDiff(before.join('\n'), after.join('\n'))
    expect(numberOf(snippet, 'INSERTED')).toBe(2)
    expect(numberOf(snippet, 'CHANGED')).toBe(51)
  })
})
