import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import {
  satisfiesReadGate,
  isWholeFileView,
} from 'src/tools/shared/readBeforeEditMessages.js'
import {
  createPlanAttachmentIfNeeded,
  seedPlanFileState,
} from 'src/agent/compact/postCompactAttachments.js'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'post-compact-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createPlanAttachmentIfNeeded', () => {
  test('seeds the plan into the cache it was given, as a whole-file entry', () => {
    // Both compaction paths clear readFileState and then re-inject the plan
    // verbatim; without this seed the model's next Edit of a plan it is
    // holding in full was refused with "has not been read yet".
    const p = join(dir, 'plan.md')
    const plan = '# Plan\n\n- [ ] step\n'
    writeFileSync(p, plan)
    const cache = new FileStateCache(10, 1024 * 1024)

    const attachment = createPlanAttachmentIfNeeded(undefined, cache, {
      getPlan: () => plan,
      getPlanFilePath: () => p,
    })

    expect(attachment?.attachment).toMatchObject({
      type: 'plan_file_reference',
      planFilePath: p,
      planContent: plan,
    })
    const entry = cache.get(p)!
    expect(satisfiesReadGate(entry)).toBe(true)
    expect(isWholeFileView(entry)).toBe(true)
    expect(entry.content).toBe(plan)
    expect(entry.timestamp).toBe(getFileModificationTime(p))
  })

  test('without a cache it only builds the attachment', () => {
    const p = join(dir, 'plan-no-cache.md')
    writeFileSync(p, '# Plan\n')
    const attachment = createPlanAttachmentIfNeeded(undefined, undefined, {
      getPlan: () => '# Plan\n',
      getPlanFilePath: () => p,
    })
    expect(attachment?.attachment).toMatchObject({ type: 'plan_file_reference' })
  })

  test('no plan, no attachment, no entry', () => {
    const cache = new FileStateCache(10, 1024 * 1024)
    expect(
      createPlanAttachmentIfNeeded(undefined, cache, {
        getPlan: () => null,
        getPlanFilePath: () => join(dir, 'absent.md'),
      }),
    ).toBeNull()
    expect(cache.size).toBe(0)
  })
})

describe('seedPlanFileState', () => {
  test('a plan that cannot be stat-ed leaves the cache alone', () => {
    const cache = new FileStateCache(10, 1024 * 1024)
    seedPlanFileState(cache, join(dir, 'never-written.md'), '# Plan\n')
    expect(cache.size).toBe(0)
  })
})
