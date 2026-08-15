import { describe, expect, test } from 'bun:test'
import {
  buildAddedFileHunks,
  parseGitDiff,
  parseGitNumstat,
} from 'src/services/git/gitDiff.js'

describe('buildAddedFileHunks', () => {
  test('renders every line as a + addition numbered from 1', () => {
    const hunks = buildAddedFileHunks('const a = 1\nconst b = 2\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      lines: ['+const a = 1', '+const b = 2'],
    })
  })

  test('drops only the single trailing newline (keeps interior blanks)', () => {
    const hunks = buildAddedFileHunks('a\n\nb\n')
    expect(hunks[0]!.lines).toEqual(['+a', '+', '+b'])
  })

  test('keeps a file with no trailing newline intact', () => {
    expect(buildAddedFileHunks('only').at(0)!.lines).toEqual(['+only'])
  })

  test('returns no hunk for empty content', () => {
    expect(buildAddedFileHunks('')).toEqual([])
  })

  test('caps at the 400-line per-file limit', () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const hunks = buildAddedFileHunks(content)
    expect(hunks[0]!.lines).toHaveLength(400)
    expect(hunks[0]!.newLines).toBe(400)
  })
})

describe('parseGitNumstat', () => {
  test('parses added/removed and totals', () => {
    const { stats, perFileStats } = parseGitNumstat(
      '12\t3\tsrc/foo.ts\n4\t4\tREADME.md\n',
    )
    expect(stats).toEqual({ filesCount: 2, linesAdded: 16, linesRemoved: 7 })
    expect(perFileStats.get('src/foo.ts')).toMatchObject({
      added: 12,
      removed: 3,
      isBinary: false,
    })
  })

  test('flags binary files (dash counts) as 0/0 binary', () => {
    const { perFileStats } = parseGitNumstat('-\t-\tlogo.png\n')
    expect(perFileStats.get('logo.png')).toMatchObject({
      added: 0,
      removed: 0,
      isBinary: true,
    })
  })

  test('deletions appear as removed-only entries keyed by path', () => {
    const { perFileStats } = parseGitNumstat('0\t40\tsrc/gone.ts\n')
    expect(perFileStats.get('src/gone.ts')).toMatchObject({
      added: 0,
      removed: 40,
    })
  })

  test('resolves "old => new" rename to the new path + renamedFrom', () => {
    const { perFileStats } = parseGitNumstat('2\t1\tsrc/old.ts => src/new.ts\n')
    expect(perFileStats.has('src/old.ts => src/new.ts')).toBe(false)
    expect(perFileStats.get('src/new.ts')).toMatchObject({
      added: 2,
      removed: 1,
      renamedFrom: 'src/old.ts',
    })
  })

  test('resolves brace rename "src/{old => new}/f.ts"', () => {
    const { perFileStats } = parseGitNumstat(
      '0\t0\tsrc/{old => new}/f.ts\n',
    )
    expect(perFileStats.get('src/new/f.ts')).toMatchObject({
      renamedFrom: 'src/old/f.ts',
    })
  })

  test('ignores malformed lines (fewer than 3 columns)', () => {
    const { stats } = parseGitNumstat('garbage\n12\t3\tok.ts\n')
    expect(stats.filesCount).toBe(1)
  })
})

describe('parseGitDiff', () => {
  const body = [
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' ctx',
  ].join('\n')

  test('parses standard a/ b/ prefixes', () => {
    const out = `diff --git a/src/foo.ts b/src/foo.ts\nindex 000..111 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n${body}\n`
    const map = parseGitDiff(out)
    expect(map.has('src/foo.ts')).toBe(true)
    expect(map.get('src/foo.ts')).toHaveLength(1)
  })

  test('parses mnemonic c/ w/ prefixes (diff.mnemonicPrefix)', () => {
    const out = `diff --git c/src/foo.ts w/src/foo.ts\nindex 000..111 100644\n--- c/src/foo.ts\n+++ w/src/foo.ts\n${body}\n`
    const map = parseGitDiff(out)
    expect(map.has('src/foo.ts')).toBe(true)
    expect(map.get('src/foo.ts')).toHaveLength(1)
  })
})
