import { describe, expect, test } from 'bun:test'
import { createMemorySavedMessage } from 'src/agent/messages/messages.js'
import { memorySavedParts } from 'src/agent/ui/messages/memorySaved.js'
import type { SystemMemorySavedMessage } from 'src/shared/types/message.js'

const paths = (n: number) => Array.from({ length: n }, (_, i) => `/m/${i}.md`)

function saved(n: number, extra: Partial<SystemMemorySavedMessage> = {}): SystemMemorySavedMessage {
  return { ...createMemorySavedMessage(paths(n)), ...extra }
}

describe('memorySavedParts — the "Saved …" line, per memory directory', () => {
  test('one part per directory, global, private, team, each pluralized', () => {
    expect(memorySavedParts(saved(4, { memoryCounts: { team: 1, global: 2, private: 1 } }))).toEqual([
      '2 global memories',
      '1 private memory',
      '1 team memory',
    ])
  })

  test('a directory with nothing saved has no part', () => {
    expect(memorySavedParts(saved(3, { memoryCounts: { global: 3, private: 0 } }))).toEqual(['3 global memories'])
  })

  test('paths the counts leave out are still said, unscoped', () => {
    expect(memorySavedParts(saved(3, { memoryCounts: { private: 1 } }))).toEqual(['1 private memory', '2 memories'])
  })

  describe('a transcript saved before memoryCounts', () => {
    test('with the old teamCount: the team share, the rest unscoped', () => {
      expect(memorySavedParts(saved(3, { teamCount: 1 }))).toEqual(['2 memories', '1 team memory'])
      expect(memorySavedParts(saved(2, { teamCount: 2 }))).toEqual(['2 team memories'])
      expect(memorySavedParts(saved(1, { teamCount: 0 }))).toEqual(['1 memory'])
    })

    test('with neither: how many', () => {
      expect(memorySavedParts(saved(1))).toEqual(['1 memory'])
      expect(memorySavedParts(saved(3))).toEqual(['3 memories'])
    })

    test('memoryCounts wins over a teamCount beside it', () => {
      expect(memorySavedParts(saved(2, { teamCount: 2, memoryCounts: { global: 2 } }))).toEqual(['2 global memories'])
    })
  })
})
