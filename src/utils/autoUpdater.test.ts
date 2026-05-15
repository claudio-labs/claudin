import { describe, expect, test } from 'bun:test'
import {
  getLatestVersionFromGcs,
  getGcsDistTags,
  getMaxVersion,
  getMaxVersionMessage,
  assertMinVersion,
} from 'src/utils/autoUpdater.js'

describe('autoUpdater — neutralized GCS + kill-switch', () => {
  test('getLatestVersionFromGcs returns null (GCS path neutralized)', async () => {
    const result = await getLatestVersionFromGcs()
    expect(result).toBeNull()
  })

  test('getGcsDistTags returns empty tags (GCS path neutralized)', async () => {
    const result = await getGcsDistTags()
    expect(result).toEqual({ latest: null, stable: null })
  })

  test('getMaxVersion returns undefined (kill-switch neutralized)', async () => {
    expect(await getMaxVersion()).toBeUndefined()
  })

  test('getMaxVersionMessage returns undefined', async () => {
    expect(await getMaxVersionMessage()).toBeUndefined()
  })

  test('assertMinVersion is a no-op (does not throw)', async () => {
    await expect(assertMinVersion()).resolves.toBeUndefined()
  })
})
