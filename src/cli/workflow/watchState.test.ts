import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runWithCwdOverride } from 'src/utils/fs/cwd.js'

import { loadProcessed, saveProcessed } from 'src/cli/workflow/watchState.js'

describe('watchState', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-watch-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('loadProcessed returns an empty set before any run', async () => {
    await runWithCwdOverride(dir, async () => {
      const set = await loadProcessed()
      expect(set.size).toBe(0)
    })
  })

  test('save then load round-trips the processed ids', async () => {
    await runWithCwdOverride(dir, async () => {
      await saveProcessed(new Set(['#1', '#2', '#7']))
      const set = await loadProcessed()
      expect([...set].sort()).toEqual(['#1', '#2', '#7'])
      expect(set.has('#2')).toBe(true)
      expect(set.has('#3')).toBe(false)
    })
  })

  test('a persisted id is treated as already-processed (dedup)', async () => {
    await runWithCwdOverride(dir, async () => {
      const processed = await loadProcessed()
      processed.add('#42')
      await saveProcessed(processed)
    })
    await runWithCwdOverride(dir, async () => {
      const reloaded = await loadProcessed()
      expect(reloaded.has('#42')).toBe(true)
    })
  })
})
