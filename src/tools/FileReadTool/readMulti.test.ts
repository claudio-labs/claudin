// recordedReadTargets: a Read input as a transcript stores it — the model's
// own arguments, never parsed — read the way the flag-on schema reads them.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  isBatchReadInput,
  readMultiEnabledAtLoad,
  readPathsOf,
  recordedReadTargets,
} from 'src/tools/FileReadTool/readMulti.js'

describe('recordedReadTargets', () => {
  test('a Codex single Read stays single: its placeholders are absent', () => {
    // Strict mode sends every property, so under the batch-capable schema a
    // single Read is stored with the batch fields filled by placeholders.
    for (const placeholder of [null, '', []]) {
      const targets = recordedReadTargets({
        file_path: '/r/a.ts',
        file_paths: placeholder,
        symbol: placeholder,
        view: null,
      })
      expect(targets).toEqual({ file_path: '/r/a.ts' })
      expect(isBatchReadInput(targets)).toBe(false)
      expect(readPathsOf(targets)).toEqual(['/r/a.ts'])
    }
  })

  test('a batch keeps its paths and its symbols', () => {
    const batch = recordedReadTargets({
      file_path: null,
      file_paths: ['/r/a.ts', '/r/b.ts'],
      symbol: ['x', 'y'],
    })
    expect(batch).toEqual({ file_paths: ['/r/a.ts', '/r/b.ts'], symbol: ['x', 'y'] })
    expect(isBatchReadInput(batch)).toBe(true)
    expect(recordedReadTargets({ file_path: '/r/a.ts', symbol: 'x' })).toEqual({
      file_path: '/r/a.ts',
      symbol: 'x',
    })
  })

  test('a value of a type the schema refuses is absent', () => {
    expect(
      recordedReadTargets({ file_path: 7, file_paths: ['/r/a.ts', 3], symbol: [1] }),
    ).toEqual({})
    expect(recordedReadTargets({ file_paths: '/r/a.ts' })).toEqual({})
    for (const input of [undefined, null, 'Read', 42]) {
      expect(recordedReadTargets(input)).toEqual({})
    }
  })
})

describe('readMultiEnabledAtLoad', () => {
  // The batch Read is on by default; only an explicit falsy value is the
  // killswitch. A value that is neither — a typo — leaves it on, as unset does.
  const ENV = 'CLAUDIN_READ_MULTI'
  let prior: string | undefined

  beforeEach(() => {
    prior = process.env[ENV]
  })
  afterEach(() => {
    if (prior === undefined) delete process.env[ENV]
    else process.env[ENV] = prior
  })

  test('unset, or any value that is not falsy, is on', () => {
    delete process.env[ENV]
    expect(readMultiEnabledAtLoad()).toBe(true)
    for (const value of ['1', 'true', 'yes', 'on', '', 'maybe']) {
      process.env[ENV] = value
      expect({ value, on: readMultiEnabledAtLoad() }).toEqual({ value, on: true })
    }
  })

  test('0, false, no and off are the killswitch', () => {
    for (const value of ['0', 'false', 'no', 'off', ' OFF ']) {
      process.env[ENV] = value
      expect({ value, on: readMultiEnabledAtLoad() }).toEqual({ value, on: false })
    }
  })
})
