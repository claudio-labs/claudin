import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readLatestVersion,
  writeLatestVersion,
} from './latestVersionCache.ts'

let tmp: string
let originalEnv: string | undefined

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'claudin-latest-version-'))
  originalEnv = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = tmp
})

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = originalEnv
  await rm(tmp, { recursive: true, force: true })
})

describe('latestVersionCache', () => {
  test('returns null when file does not exist', () => {
    expect(readLatestVersion()).toBeNull()
  })

  test('round-trips a valid cache', async () => {
    const cache = { latest: '0.4.0', checkedAt: 1700000000000, current: '0.3.8' }
    await writeLatestVersion(cache)
    expect(readLatestVersion()).toEqual(cache)
  })

  test('returns null on malformed JSON', async () => {
    await writeFile(join(tmp, 'latest-version.json'), '{ not json', 'utf8')
    expect(readLatestVersion()).toBeNull()
  })

  test('returns null when shape is invalid', async () => {
    await writeFile(
      join(tmp, 'latest-version.json'),
      JSON.stringify({ latest: 42, checkedAt: 'now' }),
      'utf8',
    )
    expect(readLatestVersion()).toBeNull()
  })

  test('writeLatestVersion creates the config directory if missing', async () => {
    const nested = join(tmp, 'does', 'not', 'exist')
    process.env.CLAUDIN_CONFIG_DIR = nested
    const cache = { latest: '1.0.0', checkedAt: 1, current: '0.9.0' }
    await writeLatestVersion(cache)
    expect(readLatestVersion()).toEqual(cache)
  })
})
