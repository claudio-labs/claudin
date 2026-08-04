import { describe, expect, test } from 'bun:test'
import {
  createOneShotMemo,
  createOutputTrimTailStripper,
  DEFAULT_OUTPUT_TRIM_FILTERS,
  hasShellComposition,
} from './redirect.js'

const strip = createOutputTrimTailStripper()
const stripWithWc = createOutputTrimTailStripper([
  ...DEFAULT_OUTPUT_TRIM_FILTERS,
  'wc',
])

describe('output trim tail', () => {
  test('removes a trailing output reducer', () => {
    expect(strip('git diff | head -50')).toBe('git diff')
    expect(strip('bun run typecheck 2>&1 | tail -40')).toBe('bun run typecheck')
    expect(strip('cargo check 2>&1')).toBe('cargo check')
  })

  test('keeps a pipe into a filter that holds its own pipe in quotes', () => {
    expect(strip('bun test | grep -E "^test |test result"')).toBe('bun test')
  })

  test('leaves a non-reducer pipe alone', () => {
    // `tee` persists the output somewhere else, so it is composition, not a trim.
    expect(strip('git diff | tee out.txt')).toBe('git diff | tee out.txt')
  })

  test('wc is opt-in', () => {
    expect(strip('git diff | wc -l')).toBe('git diff | wc -l')
    expect(stripWithWc('tsc --noEmit | wc -l')).toBe('tsc --noEmit')
  })

  /**
   * The guard that matters: a redirect suggests the STRIPPED command back to
   * the model, so over-stripping is silent data loss, not a cosmetic bug.
   */
  test('does not swallow a command chained after the filter', () => {
    const chained = 'git show --stat X | head -30; echo ---; git log --oneline -8'
    expect(strip(chained)).toBe(chained)
    expect(strip('bun test | tail -5 && echo done')).toBe(
      'bun test | tail -5 && echo done',
    )
  })

  test('does not swallow a redirection after the filter', () => {
    const redirected = 'git diff | head -40 > /tmp/out.txt'
    expect(strip(redirected)).toBe(redirected)
  })

  test('an over-stripped command still fails the composition check', () => {
    // Belt and braces: even if the stripper let one through, the pipes it
    // leaves behind keep the command in Bash.
    expect(hasShellComposition('git show X | head -30; git log')).toBe(true)
  })
})

describe('one-shot memo', () => {
  test('refuses once, then lets the identical re-send through', () => {
    const memo = createOneShotMemo()
    expect(memo.shouldRefuse('git diff')).toBe(true)
    expect(memo.shouldRefuse('git diff')).toBe(false)
  })

  test('instances do not share state', () => {
    const a = createOneShotMemo()
    const b = createOneShotMemo()
    expect(a.shouldRefuse('git diff')).toBe(true)
    expect(b.shouldRefuse('git diff')).toBe(true)
  })

  test('evicts the oldest entry rather than growing without bound', () => {
    const memo = createOneShotMemo(2)
    memo.shouldRefuse('first')
    memo.shouldRefuse('second')
    memo.shouldRefuse('third') // evicts `first`
    expect(memo.shouldRefuse('second')).toBe(false)
    expect(memo.shouldRefuse('first')).toBe(true)
  })
})
