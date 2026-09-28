import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative } from 'path'

import {
  findMarkdownFiles,
  MarkdownSearchTimeoutError,
  type SearchClock,
} from 'src/memory/instructions/markdownConfig/markdownSearch.js'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'md-search-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(path: string): string {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, 'text\n')
  return full
}

async function found(dir: string, clock?: SearchClock): Promise<string[]> {
  return (await findMarkdownFiles(join(root, dir), clock)).map(path => relative(root, path)).sort()
}

/**
 * A clock that reads 0 for its first `readings` readings, and the whole budget
 * after that. The search reads it once to start and once before each directory.
 */
function clockExpiringAfter(readings: number): SearchClock {
  let read = 0
  return { budgetMs: 60_000, now: () => (read++ < readings ? 0 : 60_000) }
}

describe('findMarkdownFiles: the time budget', () => {
  test('with time to spare, every file is found', async () => {
    write('src/a.md')
    write('src/b/deep.md')
    expect(await found('src')).toEqual(['src/a.md', 'src/b/deep.md'])
  })

  test('once the budget is spent, the files found so far are the answer', async () => {
    write('src/a.md')
    write('src/b/deep.md')
    expect(await found('src', clockExpiringAfter(2))).toEqual(['src/a.md'])
  })

  test('finding nothing before the budget is spent is a failure, not an empty directory', async () => {
    write('src/a.md')
    await expect(findMarkdownFiles(join(root, 'src'), clockExpiringAfter(1))).rejects.toBeInstanceOf(
      MarkdownSearchTimeoutError,
    )
  })
})

describe('findMarkdownFiles: what is searched', () => {
  test('a link back up the tree is entered once, so no file is found twice', async () => {
    write('src/inner/only.md')
    symlinkSync(join(root, 'src'), join(root, 'src', 'inner', 'back-to-top'))
    expect(await found('src')).toEqual(['src/inner/only.md'])
  })

  test('a directory reached through two paths is searched once', async () => {
    write('src/real/one.md')
    symlinkSync(join(root, 'src', 'real'), join(root, 'src', 'alias'))
    expect(await found('src')).toHaveLength(1)
  })

  test('a source that is a file, not a directory, gives nothing', async () => {
    write('agents.md')
    expect(await found('agents.md')).toEqual([])
  })

  test('a source that does not exist gives nothing', async () => {
    expect(await found('missing')).toEqual([])
  })
})
