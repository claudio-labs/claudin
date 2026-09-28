/**
 * Characterization of the text parsers in src/vcs/git/gitDiff.ts, pinned
 * before the clean-base rewrite so the new module has to pass it unchanged.
 * docs/tech/rewrite/vcs/gitDiff.md is the spec that goes with it.
 *
 * The inputs are git's own output, captured from throwaway repositories into
 * __fixtures__/rewrite/ (git 2.55): `git diff HEAD` with the a/ b/ prefixes the
 * fetchers force, the same with the user settings that change the prefixes
 * (diff.mnemonicPrefix, diff.noprefix), copy detection (diff.renames=copies)
 * and diff.suppressBlankEmpty, plus the matching --numstat and --shortstat.
 * The fetchers that run git themselves are in gitDiff.repo.characterization.
 */
import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildAddedFileHunks, chooseDiffStatScope, parseGitDiff, parseGitNumstat, parseShortstat } from 'src/vcs/git/gitDiff.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

type Hunk = StructuredPatchHunk

/** A hunk literal: header numbers first, then its lines. */
const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[]): Hunk => ({ oldStart, oldLines, newStart, newLines, lines })

/**
 * The old parser ends the last hunk of every file with one empty string: the
 * newline that closes the file's section. The spec drops it (a finding marked
 * "fix"), so the assertions look at each hunk the way its own header counts
 * it. Only surplus empty strings at the very end go: a genuine blank context
 * line (diff.suppressBlankEmpty) is still inside the count and stays.
 */
function asCounted(hunks: readonly Hunk[]): Hunk[] {
  return hunks.map(h => {
    const lines = [...h.lines]
    const oldSide = () => lines.filter(line => line === '' || line.startsWith(' ') || line.startsWith('-')).length
    while (lines.at(-1) === '' && oldSide() > h.oldLines) lines.pop()
    return { ...h, lines }
  })
}

function parsed(text: string): Map<string, Hunk[]> {
  return new Map([...parseGitDiff(text)].map(([path, hunks]) => [path, asCounted(hunks)]))
}

describe('parseGitDiff: `git diff HEAD` with a/ b/ prefixes', () => {
  const files = parsed(fixture('head-vs-worktree.diff'))

  test('only files with a content hunk get an entry, keyed by the new path, in output order', () => {
    expect([...files.keys()]).toEqual([
      'trap.txt b/dir x/trap.txt',
      'docs/guide.md',
      'moved/edited-after.txt',
      'notes/added.txt',
      'old/removed.txt',
      'single.txt',
      'space dir/file name.txt',
      'tail.txt',
      'tool.sh',
    ])
  })

  test('a modified file keeps every hunk; the text after the second @@ is not part of the header', () => {
    expect(files.get('docs/guide.md')).toEqual([
      hunk(1, 6, 1, 6, [' Setup', ' step one', '-step two', '+step 2', ' step three', ' step four', ' step five']),
      hunk(11, 6, 11, 6, [' read the output', ' check the logs', ' repeat as needed', '-stop the tool', '+stop the tool gracefully', ' clean up', ' done']),
    ])
  })

  test('an added file is one hunk starting at old line 0, a deleted file one hunk ending at new line 0', () => {
    expect(files.get('notes/added.txt')).toEqual([hunk(0, 0, 1, 2, ['+first note', '+second note'])])
    expect(files.get('old/removed.txt')).toEqual([hunk(1, 2, 0, 0, ['-stale line one', '-stale line two'])])
  })

  test('a rename with edits is keyed by the new name; a rename without edits has no entry', () => {
    expect(files.get('moved/edited-after.txt')).toEqual([
      hunk(2, 7, 2, 7, [' item 2', ' item 3', ' item 4', '-item 5', '+item five', ' item 6', ' item 7', ' item 8']),
    ])
    for (const path of ['moved/edited-before.txt', 'renamed/after.txt', 'renamed/before.txt', 'k.ts', 'lib/k.ts', 'src/beta/mod.ts', 'src/core/lib.ts', 'src/util.ts']) {
      expect(files.has(path)).toBe(false)
    }
  })

  test('binary files and mode-only changes have no entry; a mode change with edits keeps its hunk', () => {
    expect(files.has('image.bin')).toBe(false)
    expect(files.has('new-image.bin')).toBe(false)
    expect(files.has('run.sh')).toBe(false)
    expect(files.get('tool.sh')).toEqual([hunk(1, 2, 1, 2, [' #!/bin/sh', '-echo tool', '+echo tool v2'])])
  })

  test('a range without a count means one line', () => {
    expect(files.get('single.txt')).toEqual([hunk(1, 1, 1, 1, ['-only line', '+only line, edited'])])
  })

  test('"\\ No newline at end of file" markers are dropped from the hunk', () => {
    expect(files.get('tail.txt')).toEqual([
      hunk(1, 1, 1, 1, ['-last line without newline', '+last line changed, still without newline']),
    ])
  })

  test('a path with spaces is read whole', () => {
    expect(files.get('space dir/file name.txt')).toEqual([hunk(1, 1, 1, 1, ['-spaced', '+spaced out'])])
  })

  test('the two header paths are split at the first " <one character>/", so "dir x/" cuts the header short', () => {
    expect(files.has('dir x/trap.txt')).toBe(false)
    expect(files.get('trap.txt b/dir x/trap.txt')).toEqual([hunk(1, 1, 1, 1, ['-trap', '+trap sprung'])])
  })

  test('a header git had to quote (a non-ASCII name) is skipped without disturbing the others', () => {
    expect([...files.keys()].some(path => path.includes('caf'))).toBe(false)
    expect(files.size).toBe(9)
  })
})

describe('parseGitDiff: other shapes of git output', () => {
  test('diff.renames=copies: a copy is keyed by the copy, and its source keeps its own entry', () => {
    const files = parsed(fixture('copies.diff'))
    expect([...files]).toEqual([
      ['copy.txt', [hunk(6, 5, 6, 5, [' shared row 6', ' shared row 7', ' shared row 8', '-shared row 9', '+copy row nine', ' shared row 10'])]],
      ['origin.txt', [hunk(1, 5, 1, 5, [' shared row 1', '-shared row 2', '+origin row two', ' shared row 3', ' shared row 4', ' shared row 5'])]],
    ])
  })

  test('diff.mnemonicPrefix: c/ w/, i/ w/ and c/ i/ headers parse like a/ b/', () => {
    const files = parsed(fixture('mnemonic-prefix.diff'))
    expect([...files]).toEqual([
      ['vs-head.txt', [hunk(1, 1, 1, 1, ['-head side', '+worktree side'])]],
      ['vs-index.txt', [hunk(1, 1, 1, 1, ['-index side', '+worktree side'])]],
      ['staged.txt', [hunk(1, 1, 1, 1, ['-staged side', '+staged change'])]],
    ])
  })

  test('diff.noprefix: unsupported; only a path whose first directory is one character matches, minus that directory', () => {
    const files = parsed(fixture('no-prefix.diff'))
    expect([...files]).toEqual([['one.txt', [hunk(1, 1, 1, 1, ['-one', '+one edited'])]]])
  })

  test('diff.suppressBlankEmpty: a blank context line arrives empty and stays in place as ""', () => {
    const files = parsed(fixture('suppress-blank-empty.diff'))
    expect(files.get('blank.txt')).toEqual([
      hunk(1, 6, 1, 6, [' header', '', ' body one', '-body two', '+body 2', '', ' footer']),
    ])
  })

  test('hunks with no `diff --git` header (a filtered diff) are not parsed', () => {
    const body = fixture('head-vs-worktree.diff')
    const withoutHeaders = body
      .split('\n')
      .filter(line => !line.startsWith('diff --git ') && !line.startsWith('index '))
      .join('\n')
    expect(parseGitDiff(withoutHeaders).size).toBe(0)
  })

  test('empty or blank output is an empty map', () => {
    expect(parseGitDiff('').size).toBe(0)
    expect(parseGitDiff('\n  \n').size).toBe(0)
  })
})

describe('parseGitDiff: a file section above 1,000,000 bytes is left out', () => {
  // One real single-line section, with its added line stretched so the whole
  // section (from after `diff --git ` through its final newline) weighs
  // exactly `bytes`, measured as UTF-8.
  function sectionOfSize(path: string, bytes: number, fill: string): string {
    const head = `${path} ${path.replace('a/', 'b/')}\nindex 1111111..2222222 100644\n--- ${path}\n+++ ${path.replace('a/', 'b/')}\n@@ -1 +1 @@\n-x\n+`
    const room = bytes - Buffer.byteLength(head + '\n', 'utf8')
    const unit = Buffer.byteLength(fill, 'utf8')
    return `diff --git ${head}${fill.repeat(Math.floor(room / unit))}${'y'.repeat(room % unit)}\n`
  }
  const small = 'diff --git a/small.txt b/small.txt\nindex 3333333..4444444 100644\n--- a/small.txt\n+++ b/small.txt\n@@ -1 +1 @@\n-before\n+after\n'

  test('exactly 1,000,000 bytes is kept; one byte more is not, and the next file still parses', () => {
    const atLimit = parseGitDiff(sectionOfSize('a/big.txt', 1_000_000, 'z') + small)
    expect([...atLimit.keys()]).toEqual(['big.txt', 'small.txt'])
    const overLimit = parseGitDiff(sectionOfSize('a/big.txt', 1_000_001, 'z') + small)
    expect([...overLimit.keys()]).toEqual(['small.txt'])
  })

  test('the size is counted in UTF-8 bytes, not in string length', () => {
    const wide = sectionOfSize('a/wide.txt', 1_200_000, 'é')
    expect(wide.length).toBeLessThan(1_000_000)
    expect([...parseGitDiff(wide + small).keys()]).toEqual(['small.txt'])
  })
})

describe('parseGitNumstat', () => {
  test('`git diff HEAD --numstat`: totals over every line, one entry per file keyed by its new path', () => {
    const { stats, perFileStats } = parseGitNumstat(fixture('head-vs-worktree.numstat'))
    expect(stats).toStrictEqual({ filesCount: 18, linesAdded: 11, linesRemoved: 11 })
    const same = (added: number, removed: number) => ({ added, removed, isBinary: false })
    const binary = { added: 0, removed: 0, isBinary: true }
    const moved = (from: string, added = 0, removed = 0) => ({ added, removed, isBinary: false, renamedFrom: from })
    expect([...perFileStats]).toStrictEqual([
      ['"caf\\303\\251.txt"', same(1, 1)],
      ['dir x/trap.txt', same(1, 1)],
      ['docs/guide.md', same(2, 2)],
      ['image.bin', binary],
      ['k.ts', moved('lib/k.ts')],
      ['moved/edited-after.txt', moved('moved/edited-before.txt', 1, 1)],
      ['new-image.bin', binary],
      ['notes/added.txt', same(2, 0)],
      ['old/removed.txt', same(0, 2)],
      ['renamed/after.txt', moved('renamed/before.txt')],
      ['run.sh', same(0, 0)],
      ['single.txt', same(1, 1)],
      ['space dir/file name.txt', same(1, 1)],
      ['src/beta/mod.ts', moved('src/alpha/mod.ts')],
      ['src/core/lib.ts', moved('src/lib.ts')],
      ['src/util.ts', moved('src/deep/util.ts')],
      ['tail.txt', same(1, 1)],
      ['tool.sh', same(1, 1)],
    ])
  })

  test('a copy (diff.renames=copies) is reported the way a rename is', () => {
    const { stats, perFileStats } = parseGitNumstat(fixture('copies.numstat'))
    expect(stats).toStrictEqual({ filesCount: 2, linesAdded: 2, linesRemoved: 2 })
    expect(perFileStats.get('copy.txt')).toStrictEqual({ added: 1, removed: 1, isBinary: false, renamedFrom: 'origin.txt' })
    expect(perFileStats.get('origin.txt')).toStrictEqual({ added: 1, removed: 1, isBinary: false })
  })

  test('blank lines around the output and lines with fewer than three fields are ignored', () => {
    const noisy = `\n\n${fixture('copies.numstat')}not numstat\n12\tonly-two-fields\n\n`
    const { stats, perFileStats } = parseGitNumstat(noisy)
    expect(stats).toStrictEqual({ filesCount: 2, linesAdded: 2, linesRemoved: 2 })
    expect([...perFileStats.keys()]).toEqual(['copy.txt', 'origin.txt'])
  })

  test('at most 50 entries are kept, the first 50 in order, while the totals count every file', () => {
    const lines = Array.from({ length: 64 }, (_, i) => `${i + 1}\t1\tfile-${String(i).padStart(2, '0')}.txt`)
    const { stats, perFileStats } = parseGitNumstat(lines.join('\n') + '\n')
    expect(stats).toStrictEqual({ filesCount: 64, linesAdded: (64 * 65) / 2, linesRemoved: 64 })
    expect(perFileStats.size).toBe(50)
    expect([...perFileStats.keys()].at(0)).toBe('file-00.txt')
    expect([...perFileStats.keys()].at(-1)).toBe('file-49.txt')
    expect(perFileStats.get('file-49.txt')).toStrictEqual({ added: 50, removed: 1, isBinary: false })
  })

  test('no output is zero of everything', () => {
    const { stats, perFileStats } = parseGitNumstat('')
    expect(stats).toStrictEqual({ filesCount: 0, linesAdded: 0, linesRemoved: 0 })
    expect(perFileStats.size).toBe(0)
  })
})

describe('parseShortstat', () => {
  const cases: Array<[string, string, { filesCount: number; linesAdded: number; linesRemoved: number } | null]> = [
    ['the fixture repository', fixture('head-vs-worktree.shortstat'), { filesCount: 18, linesAdded: 11, linesRemoved: 11 }],
    ['insertions only, singular', ' 1 file changed, 1 insertion(+)\n', { filesCount: 1, linesAdded: 1, linesRemoved: 0 }],
    ['deletions only, singular', ' 1 file changed, 1 deletion(-)\n', { filesCount: 1, linesAdded: 0, linesRemoved: 1 }],
    ['a mode or rename change', ' 4 files changed, 0 insertions(+), 0 deletions(-)\n', { filesCount: 4, linesAdded: 0, linesRemoved: 0 }],
    ['plural counts', ' 1648 files changed, 52341 insertions(+), 8123 deletions(-)\n', { filesCount: 1648, linesAdded: 52341, linesRemoved: 8123 }],
    ['no changes (git prints nothing)', '', null],
    ['anything else', 'fatal: bad revision HEAD\n', null],
  ]
  test.each(cases)('%s', (_label, output, expected) => {
    expect(parseShortstat(output)).toStrictEqual(expected)
  })
})

describe('buildAddedFileHunks: an untracked file shown as all-added', () => {
  test('one hunk from old line 0 to new line 1, every line prefixed with +', () => {
    expect(buildAddedFileHunks('first\nsecond\n')).toStrictEqual([hunk(0, 0, 1, 2, ['+first', '+second'])])
  })

  test('only the final newline is dropped; blank lines inside stay, and a missing final newline changes nothing', () => {
    expect(buildAddedFileHunks('a\n\n\nb')[0]!.lines).toEqual(['+a', '+', '+', '+b'])
    expect(buildAddedFileHunks('a\n\n')[0]!.lines).toEqual(['+a', '+'])
    expect(buildAddedFileHunks('\n')).toStrictEqual([hunk(0, 0, 1, 1, ['+'])])
  })

  test('carriage returns are kept', () => {
    expect(buildAddedFileHunks('x\r\ny\r\n')[0]!.lines).toEqual(['+x\r', '+y\r'])
  })

  test('empty content has no hunk', () => {
    expect(buildAddedFileHunks('')).toEqual([])
  })

  test('the first 400 lines are shown and the header counts only those', () => {
    const content = Array.from({ length: 450 }, (_, i) => `row ${i}`).join('\n') + '\n'
    const [only, ...rest] = buildAddedFileHunks(content)
    expect(rest).toEqual([])
    expect(only!.newLines).toBe(400)
    expect(only!.lines).toHaveLength(400)
    expect(only!.lines.at(-1)).toBe('+row 399')
  })
})

describe('chooseDiffStatScope', () => {
  const HEAD_SHA = 'a'.repeat(40)
  const BASE_SHA = 'b'.repeat(40)
  test('a branch that has left its base is measured from the merge-base, labelled with the base', () => {
    expect(chooseDiffStatScope(HEAD_SHA, BASE_SHA, 'origin/release')).toStrictEqual({ kind: 'branch', against: BASE_SHA, base: 'origin/release' })
  })
  test.each([
    ['HEAD is the merge-base', HEAD_SHA, HEAD_SHA],
    ['no merge-base', HEAD_SHA, null],
    ['an empty merge-base', HEAD_SHA, ''],
    ['no HEAD', '', BASE_SHA],
  ] as const)('%s: only the uncommitted changes', (_label, head, mergeBase) => {
    expect(chooseDiffStatScope(head, mergeBase, 'main')).toStrictEqual({ kind: 'uncommitted' })
  })
})
