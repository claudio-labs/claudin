import { describe, expect, test } from 'bun:test'
import type { PrStatus } from 'src/vcs/git/ghPrStatus.js'
import { emptyPill, pillAfterAnswer } from 'src/vcs/hooks/prStatus/pillState.js'
import type { PrStatusState } from 'src/vcs/hooks/usePrStatus.js'

const OPEN: PrStatus = { number: 42, url: 'https://forge.example/pull/42', reviewState: 'pending', label: 'PR' }
const SHOWN: PrStatusState = { ...OPEN, lastUpdated: 1_000 }
const NOW = 5_000

describe('pillAfterAnswer', () => {
  const kept: Array<{ name: string; current: PrStatusState; answer: PrStatus | null }> = [
    { name: 'no pull request, still none', current: emptyPill(), answer: null },
    { name: 'the same pull request again', current: SHOWN, answer: { ...OPEN } },
  ]
  for (const row of kept) {
    test(`keeps the very same object: ${row.name}`, () => {
      expect(pillAfterAnswer(row.current, row.answer, NOW)).toBe(row.current)
    })
  }

  const replaced: Array<{ name: string; current: PrStatusState; answer: PrStatus | null; next: PrStatusState }> = [
    { name: 'a first answer', current: emptyPill(), answer: OPEN, next: { ...OPEN, lastUpdated: NOW } },
    {
      name: 'only the URL changed (finding 7)',
      current: SHOWN,
      answer: { ...OPEN, url: 'https://forge.example/pull/42-moved' },
      next: { ...OPEN, url: 'https://forge.example/pull/42-moved', lastUpdated: NOW },
    },
    { name: 'another number', current: SHOWN, answer: { ...OPEN, number: 43 }, next: { ...OPEN, number: 43, lastUpdated: NOW } },
    {
      name: 'another review state',
      current: SHOWN,
      answer: { ...OPEN, reviewState: 'approved' },
      next: { ...OPEN, reviewState: 'approved', lastUpdated: NOW },
    },
    { name: 'another label', current: SHOWN, answer: { ...OPEN, label: 'MR' }, next: { ...OPEN, label: 'MR', lastUpdated: NOW } },
    { name: 'the pull request went away', current: SHOWN, answer: null, next: emptyPill(NOW) },
  ]
  for (const row of replaced) {
    test(`replaces and stamps the state: ${row.name}`, () => {
      expect(pillAfterAnswer(row.current, row.answer, NOW)).toEqual(row.next)
    })
  }
})
