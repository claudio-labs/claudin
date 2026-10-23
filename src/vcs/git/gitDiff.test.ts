import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildAddedFileHunks,
  chooseDiffStatScope,
  fetchGitDiff,
  fetchGitDiffHunks,
  parseGitDiff,
  parseGitNumstat,
  parseShortstat,
} from 'src/vcs/git/gitDiff.js'

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

  test('empty output is zero files, zero lines', () => {
    expect(parseGitNumstat('')).toEqual({
      stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map(),
    })
  })

  test('keeps per-file details for the first 50 files but totals all of them', () => {
    const out = Array.from({ length: 60 }, (_, i) => `1\t2\tf${i}.ts`).join('\n')
    const { stats, perFileStats } = parseGitNumstat(out)
    expect(stats).toEqual({ filesCount: 60, linesAdded: 60, linesRemoved: 120 })
    expect(perFileStats.size).toBe(50)
    expect(perFileStats.has('f49.ts')).toBe(true)
    expect(perFileStats.has('f50.ts')).toBe(false)
  })

  test('a filename containing a tab is kept whole', () => {
    const { perFileStats } = parseGitNumstat('1\t0\tweird\tname.ts\n')
    expect(perFileStats.has('weird\tname.ts')).toBe(true)
  })

  test('a non-numeric count reads as 0 rather than NaN', () => {
    const { stats } = parseGitNumstat('x\ty\tf.ts\n')
    expect(stats).toEqual({ filesCount: 1, linesAdded: 0, linesRemoved: 0 })
  })

  test('a plain path carries no renamedFrom key', () => {
    const { perFileStats } = parseGitNumstat('1\t1\tsrc/a.ts\n')
    expect(perFileStats.get('src/a.ts')).toEqual({
      added: 1,
      removed: 1,
      isBinary: false,
    })
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

  const fileDiff = (path: string, hunks: string) =>
    `diff --git a/${path} b/${path}\nindex 000..111 100644\n--- a/${path}\n+++ b/${path}\n${hunks}\n`

  test('empty or whitespace-only output is an empty map', () => {
    expect(parseGitDiff('').size).toBe(0)
    expect(parseGitDiff('  \n').size).toBe(0)
  })

  test('reads the hunk header numbers and the +/-/context lines', () => {
    const map = parseGitDiff(fileDiff('src/foo.ts', body))
    expect(map.get('src/foo.ts')).toEqual([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: ['-old', '+new', ' ctx', ''],
      },
    ])
  })

  test('a header without counts defaults both counts to 1', () => {
    const map = parseGitDiff(fileDiff('a.ts', '@@ -3 +4 @@\n-x\n+y'))
    expect(map.get('a.ts')![0]).toMatchObject({
      oldStart: 3,
      oldLines: 1,
      newStart: 4,
      newLines: 1,
    })
  })

  test('splits several hunks of one file, in order', () => {
    const hunks = ['@@ -1,1 +1,1 @@', '-a', '+b', '@@ -10,2 +10,3 @@', ' c', '+d', ' e'].join('\n')
    const parsed = parseGitDiff(fileDiff('m.ts', hunks)).get('m.ts')!
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.lines).toEqual(['-a', '+b'])
    expect(parsed[1]).toMatchObject({ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 })
    expect(parsed[1]!.lines).toEqual([' c', '+d', ' e', ''])
  })

  test('keys each file of a multi-file diff by its b/ path', () => {
    const out = fileDiff('one.ts', body) + fileDiff('two.ts', body)
    expect([...parseGitDiff(out).keys()]).toEqual(['one.ts', 'two.ts'])
  })

  test('a rename keys by the NEW path', () => {
    const out = `diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n${body}\n`
    expect([...parseGitDiff(out).keys()]).toEqual(['new.ts'])
  })

  test('skips the new-file, deleted-file and mode metadata before the hunk', () => {
    const out = [
      'diff --git a/n.ts b/n.ts',
      'old mode 100644',
      'new mode 100755',
      'new file mode 100644',
      'deleted file mode 100644',
      'index 000..111',
      '--- /dev/null',
      '+++ b/n.ts',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n')
    expect(parseGitDiff(out).get('n.ts')![0]!.lines).toEqual(['+hello'])
  })

  test('a binary file with no hunk is left out of the map', () => {
    const out = 'diff --git a/logo.png b/logo.png\nindex 000..111 100644\nBinary files a/logo.png and b/logo.png differ\n'
    expect(parseGitDiff(out).size).toBe(0)
  })

  test('drops the "\\ No newline at end of file" marker', () => {
    const out = fileDiff('e.ts', '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b')
    expect(parseGitDiff(out).get('e.ts')![0]!.lines).toEqual(['-a', '+b', ''])
  })

  test('a chunk whose first line is not a file header is skipped', () => {
    expect(parseGitDiff('not a header\n@@ -1 +1 @@\n-a\n+b\n').size).toBe(0)
  })

  test('caps the lines of one file at 400 across all its hunks', () => {
    const many = Array.from({ length: 450 }, (_, i) => `+l${i}`).join('\n')
    const out = fileDiff('big.ts', `@@ -0,0 +1,450 @@\n${many}\n@@ -500 +500 @@\n+tail`)
    const parsed = parseGitDiff(out).get('big.ts')!
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.lines).toHaveLength(400)
    expect(parsed[1]!.lines).toEqual([])
  })

  test('stops after 50 files', () => {
    const out = Array.from({ length: 55 }, (_, i) => fileDiff(`f${i}.ts`, body)).join('')
    const map = parseGitDiff(out)
    expect(map.size).toBe(50)
    expect(map.has('f49.ts')).toBe(true)
    expect(map.has('f50.ts')).toBe(false)
  })

  test('skips a file diff over 1 MB measured in UTF-8 bytes, not string length', () => {
    // 400k CJK chars are 1.2 MB of UTF-8 but only 400k UTF-16 code units.
    const huge = fileDiff('cjk.ts', `@@ -1 +1 @@\n+${'中'.repeat(400_000)}`)
    expect(huge.length).toBeLessThan(1_000_000)
    const out = huge + fileDiff('small.ts', body)
    expect([...parseGitDiff(out).keys()]).toEqual(['small.ts'])
  })
})

describe('parseShortstat', () => {
  test('reads files, insertions and deletions', () => {
    expect(
      parseShortstat(' 1648 files changed, 52341 insertions(+), 8123 deletions(-)\n'),
    ).toEqual({ filesCount: 1648, linesAdded: 52341, linesRemoved: 8123 })
  })

  test('handles the singular forms and a missing half', () => {
    expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({
      filesCount: 1,
      linesAdded: 1,
      linesRemoved: 0,
    })
    expect(parseShortstat(' 2 files changed, 3 deletions(-)')).toEqual({
      filesCount: 2,
      linesAdded: 0,
      linesRemoved: 3,
    })
  })

  test('answers null for output it does not recognize', () => {
    expect(parseShortstat('')).toBeNull()
    expect(parseShortstat('fatal: not a git repository')).toBeNull()
  })
})

describe('chooseDiffStatScope', () => {
  test('a branch that diverged diffs against its merge-base', () => {
    expect(chooseDiffStatScope('aaa', 'bbb', 'main')).toEqual({
      kind: 'branch',
      against: 'bbb',
      base: 'main',
    })
  })

  test('collapses to uncommitted when merge-base failed, is HEAD, or HEAD is unknown', () => {
    expect(chooseDiffStatScope('aaa', null, 'main')).toEqual({ kind: 'uncommitted' })
    expect(chooseDiffStatScope('aaa', 'aaa', 'main')).toEqual({ kind: 'uncommitted' })
    expect(chooseDiffStatScope('', 'bbb', 'main')).toEqual({ kind: 'uncommitted' })
  })
})

// ---------------------------------------------------------------------------
// fetchGitDiff / fetchGitDiffHunks against a real temp repo. Both are called
// with an explicit repo root, which skips the memoized ambient getIsGit and
// keeps this repo's own git state out of it.
// ---------------------------------------------------------------------------
const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

function makeRepo(files: Record<string, string>): {
  root: string
  git: (...args: string[]) => string
} {
  const root = mkdtempSync(join(tmpdir(), 'claudin-gitdiff-'))
  tempDirs.push(root)
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(root, path), content)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { root, git }
}

describe('fetchGitDiff', () => {
  test('reports tracked edits from numstat plus untracked files by name', async () => {
    const { root } = makeRepo({ 'a.ts': 'one\ntwo\n', 'b.ts': 'keep\n' })
    writeFileSync(join(root, 'a.ts'), 'one\nTWO\nthree\n')
    writeFileSync(join(root, 'new.ts'), 'brand new\n')

    const result = await fetchGitDiff(root)
    expect(result).not.toBeNull()
    expect(result!.stats).toEqual({ filesCount: 2, linesAdded: 2, linesRemoved: 1 })
    expect(result!.perFileStats.get('a.ts')).toEqual({
      added: 2,
      removed: 1,
      isBinary: false,
    })
    expect(result!.perFileStats.get('new.ts')).toEqual({
      added: 0,
      removed: 0,
      isBinary: false,
      isUntracked: true,
    })
    expect(result!.perFileStats.has('b.ts')).toBe(false)
    // Hunks are fetched on demand, never by the poll.
    expect(result!.hunks.size).toBe(0)
  })

  test('a clean tree is zero files', async () => {
    const { root } = makeRepo({ 'a.ts': 'x\n' })
    const result = await fetchGitDiff(root)
    expect(result!.stats).toEqual({ filesCount: 0, linesAdded: 0, linesRemoved: 0 })
    expect(result!.perFileStats.size).toBe(0)
  })

  test('answers null mid-merge, mid-rebase, mid-cherry-pick and mid-revert', async () => {
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const { root } = makeRepo({ 'a.ts': 'x\n' })
      writeFileSync(join(root, 'a.ts'), 'y\n')
      writeFileSync(join(root, '.git', marker), '0000000000000000000000000000000000000000\n')
      expect(await fetchGitDiff(root)).toBeNull()
    }
  })

  test('answers null outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudin-gitdiff-nogit-'))
    tempDirs.push(dir)
    expect(await fetchGitDiff(dir)).toBeNull()
  })

  test('over 500 changed files returns shortstat totals and no per-file details', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 501; i++) files[`f${i}.txt`] = 'a\n'
    const { root } = makeRepo(files)
    for (let i = 0; i < 501; i++) writeFileSync(join(root, `f${i}.txt`), 'b\n')
    writeFileSync(join(root, 'untracked.txt'), 'u\n')

    const result = await fetchGitDiff(root)
    expect(result!.stats).toEqual({ filesCount: 501, linesAdded: 501, linesRemoved: 501 })
    expect(result!.perFileStats.size).toBe(0)
    expect(result!.hunks.size).toBe(0)
  })

  test('lists at most 50 files in total, untracked ones filling the remaining slots', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 45; i++) files[`t${i}.txt`] = 'a\n'
    const { root } = makeRepo(files)
    for (let i = 0; i < 45; i++) writeFileSync(join(root, `t${i}.txt`), 'b\n')
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `u${i}.txt`), 'u\n')

    const result = await fetchGitDiff(root)
    expect(result!.perFileStats.size).toBe(50)
    expect(result!.stats.filesCount).toBe(50)
    const untracked = [...result!.perFileStats.values()].filter(s => s.isUntracked)
    expect(untracked).toHaveLength(5)
  })
})

describe('fetchGitDiffHunks', () => {
  test('returns the working tree hunks vs HEAD keyed by path', async () => {
    const { root } = makeRepo({ 'a.ts': 'one\ntwo\nthree\n' })
    writeFileSync(join(root, 'a.ts'), 'one\n2\nthree\n')
    const hunks = await fetchGitDiffHunks(root)
    expect([...hunks.keys()]).toEqual(['a.ts'])
    const lines = hunks.get('a.ts')![0]!.lines
    expect(lines).toContain('-two')
    expect(lines).toContain('+2')
  })

  test('forces a/ b/ prefixes so a repo with diff.noprefix still parses', async () => {
    const { root, git } = makeRepo({ 'a.ts': 'x\n' })
    git('config', 'diff.noprefix', 'true')
    writeFileSync(join(root, 'a.ts'), 'y\n')
    expect([...(await fetchGitDiffHunks(root)).keys()]).toEqual(['a.ts'])
  })

  test('is empty mid-merge', async () => {
    const { root } = makeRepo({ 'a.ts': 'x\n' })
    writeFileSync(join(root, 'a.ts'), 'y\n')
    writeFileSync(join(root, '.git', 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n')
    expect((await fetchGitDiffHunks(root)).size).toBe(0)
  })

  test('is empty outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudin-gitdiff-nogit-'))
    tempDirs.push(dir)
    expect((await fetchGitDiffHunks(dir)).size).toBe(0)
  })
})
