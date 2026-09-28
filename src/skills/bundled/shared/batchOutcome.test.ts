import { describe, expect, test } from 'bun:test'

import { decideBatchOutcome } from 'src/skills/bundled/shared/batchOutcome.js'

describe('decideBatchOutcome', () => {
  test('without an instruction it is the usage, in a repository or not', () => {
    expect(decideBatchOutcome('', true)).toEqual({ kind: 'usage' })
    expect(decideBatchOutcome('', false)).toEqual({ kind: 'usage' })
  })

  test('an instruction outside a repository cannot run', () => {
    expect(decideBatchOutcome('rename the logger', false)).toEqual({ kind: 'needs-repository' })
  })

  test('an instruction inside a repository is orchestrated', () => {
    expect(decideBatchOutcome('rename the logger', true)).toEqual({
      kind: 'orchestrate',
      instruction: 'rename the logger',
    })
  })
})
