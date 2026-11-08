// In a git worktree, /diff's working-tree source resolves the cwd to the MAIN
// checkout (findCanonicalGitRoot; bugs/diff-reviewer-worktree-canonicalization,
// deferred on purpose), so its hunks are the main checkout's. `x` must not
// revert them from the worktree session: that writes into another checkout.
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fetchGitDiffHunks } from 'src/vcs/git/gitDiff.js'
import { resolveWorkspaceRoots } from 'src/vcs/git/git.js'
import { planHunkRevert, worktreeShadowedRoots } from 'src/vcs/diff/revertHunk.js'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-revert-')))
const main = join(base, 'main')
const wt = join(base, 'wt')
const plain = join(base, 'plain')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })

function repo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'a@b.c')
  git(dir, 'config', 'user.name', 'n')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
}

repo(main)
git(main, 'worktree', 'add', '-q', wt, '-b', 'feature')
repo(plain)

afterAll(() => rmSync(base, { recursive: true, force: true }))

const file = { path: 'a.txt', isBinary: false, isLargeFile: false, isTruncated: false }

describe('/diff hunk revert inside a git worktree', () => {
  test("a worktree's canonical root is shadowed; a plain repo's is not", () => {
    expect([...worktreeShadowedRoots([wt])]).toEqual([main])
    expect([...worktreeShadowedRoots([plain])]).toEqual([])
    expect([...worktreeShadowedRoots([join(base, 'not-a-repo')])]).toEqual([])
  })

  test("x from the worktree session refuses the main checkout's hunk", async () => {
    // Uncommitted work in the main checkout (another session, or the user).
    writeFileSync(join(main, 'a.txt'), 'one\nMAIN EDIT\nthree\n')
    // What DiffDialog does with getCwd() === wt.
    const [root] = resolveWorkspaceRoots(wt, [])
    expect(root).toBe(main)
    const [hunk] = (await fetchGitDiffHunks(root)).get('a.txt') ?? []
    expect(hunk).toBeDefined()

    const shadowed = worktreeShadowedRoots([wt]).has(root!)
    expect(planHunkRevert('working', file, [hunk!], hunk!, { shadowedRoot: shadowed })).toEqual({
      kind: 'notice',
      text: "can't revert: /diff shows the main checkout here, not this worktree",
    })
  })
})
