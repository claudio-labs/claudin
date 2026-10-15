import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'

import { classifierFallback } from 'src/permissions/permissions/denial.js'

describe('classifierFallback', () => {
  test('a real block is not a fallback', () => {
    expect(classifierFallback({})).toBeNull()
  })

  test('a refusal asks the user, and headless keeps the denial', () => {
    expect(classifierFallback({ refused: true })).toEqual({
      cause: 'declined to assess this transcript',
      abortsHeadless: false,
    })
  })

  test('the permanent causes abort headless', () => {
    expect(classifierFallback({ transcriptTooLong: true })).toEqual({
      cause: 'transcript exceeded context window',
      abortsHeadless: true,
    })
    expect(classifierFallback({ deterministic: true })).toEqual({
      cause: 'request failed with a deterministic error',
      abortsHeadless: true,
    })
  })

  test('a timeout asks the user, and headless keeps its retry guidance', () => {
    expect(classifierFallback({ timedOut: true })).toEqual({
      cause: 'exceeded its time budget',
      abortsHeadless: false,
    })
  })

  test('the auto-mode branch asks it (source-pinned: that branch needs a live classifier)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'permissions.ts'), 'utf8')
    expect(src).toContain('const fallback = classifierFallback(classifierResult)')
    expect(src).toContain('if (fallback.abortsHeadless) {')
  })
})
