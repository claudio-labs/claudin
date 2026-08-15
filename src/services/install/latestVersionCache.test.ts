import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readLatestVersion,
  subscribeLatestVersion,
  writeLatestVersion,
  type LatestVersionCache,
} from 'src/services/install/latestVersionCache.ts'

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

describe('subscribeLatestVersion', () => {
  test('notifies subscriber exactly once per write with cache payload', async () => {
    const received: LatestVersionCache[] = []
    const unsub = subscribeLatestVersion(c => received.push(c))
    try {
      const cache = { latest: '1.2.3', checkedAt: 1, current: '1.0.0' }
      await writeLatestVersion(cache)
      expect(received).toEqual([cache])
    } finally {
      unsub()
    }
  })

  test('unsubscribe stops further notifications', async () => {
    let count = 0
    const unsub = subscribeLatestVersion(() => {
      count += 1
    })
    await writeLatestVersion({ latest: '1.0.0', checkedAt: 1, current: '0.9.0' })
    unsub()
    await writeLatestVersion({ latest: '2.0.0', checkedAt: 2, current: '0.9.0' })
    expect(count).toBe(1)
  })

  test('a throwing listener does not block subsequent listeners', async () => {
    let secondCalled = false
    const u1 = subscribeLatestVersion(() => {
      throw new Error('boom')
    })
    const u2 = subscribeLatestVersion(() => {
      secondCalled = true
    })
    try {
      await writeLatestVersion({ latest: '1.0.0', checkedAt: 1, current: '0.9.0' })
      expect(secondCalled).toBe(true)
    } finally {
      u1()
      u2()
    }
  })

  test('notifies even on the ENOENT/mkdir recovery branch', async () => {
    process.env.CLAUDIN_CONFIG_DIR = join(tmp, 'fresh', 'subdir')
    let calls = 0
    const unsub = subscribeLatestVersion(() => {
      calls += 1
    })
    try {
      await writeLatestVersion({ latest: '1.0.0', checkedAt: 1, current: '0.9.0' })
      expect(calls).toBe(1)
    } finally {
      unsub()
    }
  })
})
