// revertHunk against a real git repository: the hunks come from `git diff
// HEAD` through parseGitDiff, exactly as /diff's working-tree source gets them.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StructuredPatchHunk } from 'diff'
import { parseGitDiff } from 'src/vcs/git/gitDiff.js'
import {
  parseRawHunks,
  planHunkRevert,
  type RevertableFile,
  type RunGit,
  revertBlocker,
  revertHunk,
  singleHunkPatch,
} from 'src/vcs/diff/revertHunk.js'

const roots: string[] = []
let repo: string

function git(...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

function write(name: string, lines: string[], eol = true): void {
  writeFileSync(join(repo, name), lines.join('\n') + (eol ? '\n' : ''))
}

function hunksOf(name: string): StructuredPatchHunk[] {
  return parseGitDiff(git('diff', 'HEAD', '--src-prefix=a/', '--dst-prefix=b/')).get(name) ?? []
}

const tracked = (path: string): RevertableFile => ({
  path,
  isBinary: false,
  isLargeFile: false,
  isTruncated: false,
})

const HUNK = { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-a', '+b'] }
const DIFF_OF_HUNK = 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -2,1 +2,1 @@\n-a\n+b\n'

type Reply = { code: number; stdout?: string; stderr?: string }

/** A git that answers call N (0: staged check, 1: diff, 2: apply --check, 3: apply) from `replies`. */
function fakeGit(replies: Record<number, Reply> = {}): { run: RunGit; calls: { args: string[]; input?: string }[] } {
  const calls: { args: string[]; input?: string }[] = []
  const run: RunGit = async (args, _cwd, input) => {
    const n = calls.length
    calls.push({ args, input })
    const reply = replies[n] ?? { code: 0, stdout: n === 1 ? DIFF_OF_HUNK : '' }
    return { stdout: '', stderr: '', ...reply }
  }
  return { run, calls }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'revert-hunk-'))
  roots.push(repo)
  git('init', '-q')
  write('a.txt', LINES)
  git('add', '.')
  git('commit', '-qm', 'base')
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('revertHunk', () => {
  test('takes back only the chosen hunk', async () => {
    const changed = [...LINES]
    changed[1] = 'line 2 edited'
    changed[25] = 'line 26 edited'
    write('a.txt', changed)
    const hunks = hunksOf('a.txt')
    expect(hunks).toHaveLength(2)

    expect(await revertHunk(repo, tracked('a.txt'), hunks[1]!)).toEqual({ ok: true })

    const expected = [...LINES]
    expected[1] = 'line 2 edited'
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(expected.join('\n') + '\n')
    expect(hunksOf('a.txt')).toHaveLength(1)
  })

  test('reverts a hunk that touches a file with no trailing newline', async () => {
    write('a.txt', [...LINES.slice(0, 29), 'line 30 edited'], false)
    const [hunk] = hunksOf('a.txt')
    // The parsed hunk has lost the marker git needs; the fresh diff has it.
    expect(hunk!.lines.some(l => l.startsWith('\\'))).toBe(false)
    expect(await revertHunk(repo, tracked('a.txt'), hunk!)).toEqual({ ok: true })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(LINES.join('\n') + '\n')
  })

  test('refuses a file with staged changes and leaves it as it is', async () => {
    const changed = [...LINES]
    changed[1] = 'line 2 edited'
    write('a.txt', changed)
    git('add', 'a.txt')
    const [hunk] = hunksOf('a.txt')
    expect(await revertHunk(repo, tracked('a.txt'), hunk!)).toEqual({
      ok: false,
      reason: 'a.txt has staged changes — unstage it first',
    })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(changed.join('\n') + '\n')
  })

  test('refuses a hunk the file moved away from since the diff, and writes nothing', async () => {
    const changed = [...LINES]
    changed[1] = 'line 2 edited'
    write('a.txt', changed)
    const [hunk] = hunksOf('a.txt')
    changed[1] = 'line 2 edited again'
    write('a.txt', changed)

    const r = await revertHunk(repo, tracked('a.txt'), hunk!)
    expect(r).toEqual({ ok: false, reason: 'the file changed since the diff was taken' })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(changed.join('\n') + '\n')
  })

  test('a blocked hunk never reaches git', async () => {
    const { run, calls } = fakeGit()
    expect(await revertHunk(repo, { ...tracked('a.bin'), isBinary: true }, HUNK, run)).toEqual({
      ok: false,
      reason: 'binary files cannot be reverted hunk by hunk',
    })
    expect(calls).toEqual([])
  })

  test('the fresh diff, then the check, then the apply, both reading the patch from stdin', async () => {
    const { run, calls } = fakeGit()
    expect(await revertHunk('/repo', tracked('x.ts'), HUNK, run)).toEqual({ ok: true })
    expect(calls.map(c => c.args)).toEqual([
      ['diff', '--cached', '--quiet', '--', 'x.ts'],
      ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--', 'x.ts'],
      ['apply', '-R', '--check', '--recount', '-'],
      ['apply', '-R', '--recount', '-'],
    ])
    expect(calls[2]!.input).toBe(singleHunkPatch('x.ts', HUNK))
    expect(calls[3]!.input).toBe(singleHunkPatch('x.ts', HUNK))
  })

  test('a hunk missing from the fresh diff is never applied', async () => {
    const { run, calls } = fakeGit({ 1: { code: 0, stdout: DIFF_OF_HUNK.replace('+b', '+c') } })
    expect(await revertHunk('/repo', tracked('x.ts'), HUNK, run)).toEqual({
      ok: false,
      reason: 'the file changed since the diff was taken',
    })
    expect(calls).toHaveLength(2)
  })

  test('a fresh diff that fails is treated as a moved file', async () => {
    const { run, calls } = fakeGit({ 1: { code: 128, stdout: DIFF_OF_HUNK } })
    expect((await revertHunk('/repo', tracked('x.ts'), HUNK, run)).ok).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test('a hunk with other coordinates is not the same hunk', async () => {
    const { run } = fakeGit({ 1: { code: 0, stdout: DIFF_OF_HUNK.replace('@@ -2,1 +2,1 @@', '@@ -3,1 +3,1 @@') } })
    expect((await revertHunk('/repo', tracked('x.ts'), HUNK, run)).ok).toBe(false)
  })

  test("a failed check reports git's reason", async () => {
    const { run } = fakeGit({ 2: { code: 1, stderr: 'error: patch failed: x.ts:2\nmore' } })
    expect(await revertHunk('/repo', tracked('x.ts'), HUNK, run)).toEqual({
      ok: false,
      reason: 'the file changed since the diff was taken (patch failed: x.ts:2)',
    })
  })

  test("an apply that fails after a clean check reports git's reason", async () => {
    const { run } = fakeGit({ 3: { code: 1, stderr: 'error: patch failed: x.ts:2\nmore' } })
    expect(await revertHunk('/repo', tracked('x.ts'), HUNK, run)).toEqual({ ok: false, reason: 'patch failed: x.ts:2' })
  })

  test('a failed check with no stderr still says why', async () => {
    const { run } = fakeGit({ 2: { code: 1 } })
    expect(await revertHunk('/repo', tracked('x.ts'), HUNK, run)).toEqual({
      ok: false,
      reason: 'the file changed since the diff was taken',
    })
  })

  test('a failed apply with no stderr falls back to a generic reason', async () => {
    const { run } = fakeGit({ 3: { code: 1 } })
    expect(await revertHunk('/repo', tracked('x.ts'), HUNK, run)).toEqual({ ok: false, reason: 'git apply failed' })
  })
})

describe('parseRawHunks', () => {
  test('keeps the no-newline markers and drops the file header', () => {
    const diff =
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n@@ -9,2 +9,3 @@ ctx\n k\n+n\n k\n'
    expect(parseRawHunks(diff)).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file'] },
      { oldStart: 9, oldLines: 2, newStart: 9, newLines: 3, lines: [' k', '+n', ' k'] },
    ])
  })
})

describe('revertBlocker', () => {
  const modified = { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' a', '-b', '+c'] }

  test('a modified hunk of a tracked file can be reverted', () => {
    expect(revertBlocker(tracked('a.ts'), modified)).toBeNull()
  })

  test.each<[string, Partial<RevertableFile>, StructuredPatchHunk, string]>([
    ['binary', { isBinary: true }, modified, 'binary files cannot be reverted hunk by hunk'],
    ['untracked', { isUntracked: true }, modified, 'a new file has no earlier version to go back to'],
    ['new', { isNewFile: true }, modified, 'a new file has no earlier version to go back to'],
    ['added hunk', {}, { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }, 'a new file has no earlier version to go back to'],
    ['deleted', {}, { oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-a', '-b'] }, 'a deleted file cannot be restored hunk by hunk'],
    ['renamed', { renamedFrom: 'old.ts' }, modified, 'renamed files cannot be reverted hunk by hunk'],
    ['large', { isLargeFile: true }, modified, "this file's diff is truncated, so the hunk may be incomplete"],
    ['truncated', { isTruncated: true }, modified, "this file's diff is truncated, so the hunk may be incomplete"],
  ])('%s', (_name, overrides, hunk, reason) => {
    expect(revertBlocker({ ...tracked('a.ts'), ...overrides }, hunk)).toBe(reason)
  })
})

describe('singleHunkPatch', () => {
  test('is a one-hunk unified diff with a/ b/ prefixes and a trailing newline', () => {
    expect(
      singleHunkPatch('src/x.ts', { oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [' keep', '-old', '+new', '\\ No newline at end of file'] }),
    ).toBe('--- a/src/x.ts\n+++ b/src/x.ts\n@@ -4,2 +4,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n')
  })
})

describe('planHunkRevert', () => {
  test('asks to revert a real hunk of the working tree, with its line and counts', () => {
    expect(planHunkRevert('working', tracked('x.ts'), [HUNK], HUNK)).toEqual({
      kind: 'confirm',
      hunk: HUNK,
      question: 'Revert the hunk at line 2 (+1 -1)?',
    })
  })

  test('names the line of the first change, past the leading context', () => {
    const hunk = { oldStart: 32, oldLines: 7, newStart: 32, newLines: 7, lines: [' a', ' b', ' c', '-d', '+e', ' f', ' g'] }
    expect(planHunkRevert('working', tracked('x.ts'), [hunk], hunk)).toMatchObject({
      question: 'Revert the hunk at line 35 (+1 -1)?',
    })
  })

  test.each(['turn', 'stash'] as const)('points a %s source at the working tree', source => {
    expect(planHunkRevert(source, tracked('x.ts'), [HUNK], HUNK)).toEqual({
      kind: 'notice',
      text: 'switch the source to the working tree to revert a hunk',
    })
  })

  test('no file or no hunk under the cursor', () => {
    const notice = { kind: 'notice' as const, text: 'move the cursor onto a changed hunk to revert it' }
    expect(planHunkRevert('working', null, [], HUNK)).toEqual(notice)
    expect(planHunkRevert('working', tracked('x.ts'), [HUNK], null)).toEqual(notice)
  })

  test('a context hunk a gap reveal synthesized is not revertable', () => {
    const revealed = { oldStart: 9, oldLines: 2, newStart: 9, newLines: 2, lines: [' a', ' b'] }
    expect(planHunkRevert('working', tracked('x.ts'), [HUNK], revealed)).toEqual({
      kind: 'notice',
      text: 'move the cursor onto a changed hunk to revert it',
    })
  })

  test("says why a blocked hunk can't be reverted", () => {
    const added = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }
    expect(planHunkRevert('working', { ...tracked('n.ts'), isUntracked: true }, [], added)).toEqual({
      kind: 'notice',
      text: "can't revert: a new file has no earlier version to go back to",
    })
  })
})
