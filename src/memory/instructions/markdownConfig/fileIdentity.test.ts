import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  fileIdentityOf,
  type IdentifiedFile,
  identityFromStats,
  keepFirstOfEachFile,
} from 'src/memory/instructions/markdownConfig/fileIdentity.js'

/** Loaded entries from `[path, identity]` rows; an undefined identity is one that could not be read. */
function entriesOf(rows: ReadonlyArray<readonly [string, string | undefined]>): IdentifiedFile[] {
  return rows.map(([filePath, identity]) => ({ filePath, identity }))
}

describe('identityFromStats', () => {
  test('tells apart inodes that a double would round to the same number', () => {
    const large = 2n ** 63n
    expect(Number(large + 1n)).toBe(Number(large + 2n))
    expect(identityFromStats({ dev: 7n, ino: large + 1n })).not.toBe(identityFromStats({ dev: 7n, ino: large + 2n }))
  })

  test('tells apart one inode number on two devices', () => {
    expect(identityFromStats({ dev: 1n, ino: 42n })).not.toBe(identityFromStats({ dev: 2n, ino: 42n }))
  })

  test('an inode of 0, as some file systems report for every file, identifies nothing', () => {
    expect(identityFromStats({ dev: 0n, ino: 0n })).toBeUndefined()
  })
})

describe('keepFirstOfEachFile', () => {
  test('keeps the first entry of each file, in order', () => {
    const entries = entriesOf([
      ['managed/deploy.md', '1:10'],
      ['user/review.md', '1:11'],
      ['project/deploy-hardlink.md', '1:10'],
    ])
    expect(keepFirstOfEachFile(entries).map(entry => entry.filePath)).toEqual(['managed/deploy.md', 'user/review.md'])
  })

  test('never folds entries whose identity is unknown', () => {
    const entries = entriesOf([
      ['a.md', undefined],
      ['b.md', undefined],
    ])
    expect(keepFirstOfEachFile(entries)).toEqual(entries)
  })
})

describe('fileIdentityOf', () => {
  test('an entry whose identity cannot be read has none, so it is kept', async () => {
    expect(await fileIdentityOf(join(tmpdir(), 'md-identity-missing', 'gone.md'))).toBeUndefined()
  })
})
