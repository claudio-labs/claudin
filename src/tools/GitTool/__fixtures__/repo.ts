/**
 * Real temporary git repositories for the Git tool's test matrix.
 *
 * The tool under test shells out to git and reads what git actually prints, so
 * the fixtures are real repositories rather than mocks: the error text IS the
 * thing being asserted. Every state the matrix needs (empty, dirty, staged,
 * conflicting, mid-rebase, mid-merge, detached, and a local bare `origin` that
 * makes fetch/pull/push testable with no network) has a builder here.
 *
 * Hermetic on purpose, following `TypecheckTool/baseline.test.ts`: inheriting
 * the ambient environment makes these depend on whatever the rest of the run
 * did to it. `GIT_CONFIG_NOSYSTEM` + `GIT_CONFIG_GLOBAL=/dev/null` + explicit
 * identity means the outcome depends on nothing but this module, and the
 * no-prompt vars from `src/utils/worktree.ts` keep a credential prompt from
 * hanging the suite.
 */
import { execFileSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

/** Thrown with git's own stderr attached — a fixture that fails silently is worse than none. */
export class GitFixtureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitFixtureError'
  }
}

/** Fixed so `git log` relative dates and commit ordering do not drift per run. */
const FIXTURE_DATE = '2026-01-01T00:00:00+0000'

/**
 * Config forced on every invocation. `commit.gpgsign` because a developer's
 * global signing key would make every fixture commit fail; `advice.*` because
 * the hints are noise the error-path assertions would have to tolerate.
 */
const GIT_CONFIG_ARGS = [
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'advice.detachedHead=false',
  '-c',
  'advice.statusHints=false',
]

const createdRoots: string[] = []

function track(root: string): string {
  createdRoots.push(root)
  return root
}

function tempDir(label: string): string {
  return track(mkdtempSync(join(tmpdir(), `claudin-git-${label}-`)))
}

export function gitFixtureEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: FIXTURE_DATE,
    GIT_COMMITTER_DATE: FIXTURE_DATE,
    // src/utils/worktree.ts:236 — a credential prompt would hang the suite.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
  }
}

type ExecFailure = {
  status: number | null
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
}

function isExecFailure(e: unknown): e is ExecFailure {
  return typeof e === 'object' && e !== null && 'status' in e
}

function decode(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : value.toString('utf8')
}

export type GitRun = {
  code: number
  stdout: string
  stderr: string
}

/** Runs git and returns its output; a non-zero exit is reported, never swallowed. */
export function gitTry(cwd: string, args: string[]): GitRun {
  try {
    const stdout = execFileSync('git', [...GIT_CONFIG_ARGS, ...args], {
      cwd,
      encoding: 'utf8',
      env: gitFixtureEnv(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    if (!isExecFailure(e)) throw e
    return {
      code: e.status ?? 1,
      stdout: decode(e.stdout),
      stderr: decode(e.stderr),
    }
  }
}

/** Same, but a non-zero exit is a broken fixture. */
export function git(cwd: string, args: string[]): string {
  const run = gitTry(cwd, args)
  if (run.code !== 0) {
    throw new GitFixtureError(
      `git ${args.join(' ')} failed in ${cwd} (exit ${run.code})\n${run.stderr || run.stdout}`,
    )
  }
  return run.stdout
}

export function writeRepoFile(root: string, rel: string, body: string): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}


function init(root: string): void {
  git(root, ['init', '-q', '-b', 'main'])
  // Written INTO the repo, not just passed to `git()`. A fixture is also driven
  // by things that are not this helper — the Git tool runs through a real shell
  // and inherits the machine's git config, not `gitFixtureEnv`. CI has no
  // identity at all, so a commit made that way fails there and passes locally.
  git(root, ['config', 'user.name', 'fixture'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  // `diff.mnemonicPrefix` turns `a/ b/` into `i/ w/`, which changes which
  // header lines the Bash output filter recognises and therefore what the diff
  // budget receives. A developer who sets it globally would otherwise be
  // testing a different code path than CI. The prefixed shape has its own test.
  git(root, ['config', 'diff.mnemonicPrefix', 'false'])
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message])
}

/** `git init`, zero commits — the state where `git log` has nothing to show. */
export function emptyRepo(): string {
  const root = tempDir('empty')
  init(root)
  return root
}

/**
 * `count` commits on `main`, each rewriting `src/app.ts` so a diff between any
 * two of them has real hunks, plus a stable `README.md` and a `big.txt` sized
 * to exercise the big-diff pivot.
 */
export function repoWithCommits(count = 3): string {
  const root = tempDir('commits')
  init(root)
  writeRepoFile(root, 'README.md', '# fixture\n')
  writeRepoFile(root, 'src/app.ts', 'export const version = 0\n')
  commitAll(root, 'initial commit')
  for (let i = 1; i < count; i++) {
    writeRepoFile(root, 'src/app.ts', `export const version = ${i}\n`)
    writeRepoFile(root, `src/mod${i}.ts`, `export const mod${i} = ${i}\n`)
    commitAll(root, `commit ${i}`)
  }
  return root
}

/** Tracked file modified, nothing staged. */
export function dirtyRepo(): string {
  const root = repoWithCommits()
  writeRepoFile(root, 'src/app.ts', 'export const version = 99\n// dirty\n')
  return root
}

/** Tracked file modified AND staged. */
export function stagedRepo(): string {
  const root = repoWithCommits()
  writeRepoFile(root, 'src/app.ts', 'export const version = 42\n// staged\n')
  git(root, ['add', 'src/app.ts'])
  return root
}

/** A file git has never seen. */
export function untrackedRepo(): string {
  const root = repoWithCommits()
  writeRepoFile(root, 'scratch/notes.txt', 'untracked\n')
  return root
}

/**
 * A repo whose `.git/hooks/pre-commit` always rejects — the "hook rejection"
 * error path. Hooks are NOT disabled globally in this module precisely so this
 * fixture can exist.
 */
export function repoWithFailingPreCommitHook(): string {
  const root = repoWithCommits()
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho "pre-commit says no" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  writeRepoFile(root, 'src/app.ts', 'export const version = 7\n')
  git(root, ['add', 'src/app.ts'])
  return root
}

export type BranchedRepo = {
  path: string
  base: string
  feature: string
  /** The file both branches rewrote — merging/rebasing conflicts on it. */
  conflictPath: string
}

/**
 * `main` and `feature` both rewrote the same line. Nothing is merged: the
 * caller triggers merge / rebase / cherry-pick and asserts on the failure.
 */
export function conflictingBranches(): BranchedRepo {
  const root = tempDir('conflict')
  init(root)
  writeRepoFile(root, 'conflict.txt', 'base\n')
  writeRepoFile(root, 'README.md', '# conflict fixture\n')
  commitAll(root, 'base')
  git(root, ['checkout', '-q', '-b', 'feature'])
  writeRepoFile(root, 'conflict.txt', 'feature\n')
  commitAll(root, 'feature edit')
  git(root, ['checkout', '-q', 'main'])
  writeRepoFile(root, 'conflict.txt', 'main\n')
  commitAll(root, 'main edit')
  return { path: root, base: 'main', feature: 'feature', conflictPath: 'conflict.txt' }
}

/** Conflicted `git merge` left unresolved — `.git/MERGE_HEAD` present. */
export function midMergeRepo(): BranchedRepo {
  const repo = conflictingBranches()
  const run = gitTry(repo.path, ['merge', repo.feature])
  if (run.code === 0) {
    throw new GitFixtureError('midMergeRepo: the merge was expected to conflict but succeeded')
  }
  return repo
}

/** Conflicted `git rebase` left unresolved — `.git/rebase-merge` present. */
export function midRebaseRepo(): BranchedRepo {
  const repo = conflictingBranches()
  const run = gitTry(repo.path, ['rebase', repo.feature])
  if (run.code === 0) {
    throw new GitFixtureError('midRebaseRepo: the rebase was expected to conflict but succeeded')
  }
  return repo
}

/** HEAD pointing straight at a commit, no branch. */
export function detachedHeadRepo(): string {
  const root = repoWithCommits(3)
  git(root, ['checkout', '-q', '--detach', 'HEAD~1'])
  return root
}

export type RemoteRepo = {
  /** The working clone — run the command under test here. */
  path: string
  /** The bare repository acting as `origin`. */
  remote: string
}

function bareRemote(): string {
  const bare = tempDir('origin')
  git(bare, ['init', '-q', '--bare', '-b', 'main'])
  return bare
}

/**
 * A working repo with a local bare `origin` it is in sync with. `fetch`,
 * `pull` and `push` all run for real against the filesystem — no network.
 */
export function repoWithOrigin(): RemoteRepo {
  const remote = bareRemote()
  const root = repoWithCommits(2)
  git(root, ['remote', 'add', 'origin', remote])
  git(root, ['push', '-q', '-u', 'origin', 'main'])
  return { path: root, remote }
}

/**
 * Same, but `origin` has since gained a commit the working repo does not have,
 * while the working repo has one of its own — so `git push` is rejected
 * non-fast-forward and `git pull` has something to merge.
 */
export function repoBehindOrigin(): RemoteRepo {
  const { path: root, remote } = repoWithOrigin()
  const other = tempDir('other-clone')
  git(other, ['clone', '-q', remote, 'clone'])
  const clone = join(other, 'clone')
  writeRepoFile(clone, 'src/app.ts', 'export const version = 1000\n')
  commitAll(clone, 'remote-side commit')
  git(clone, ['push', '-q', 'origin', 'main'])

  writeRepoFile(root, 'src/app.ts', 'export const version = 2000\n')
  commitAll(root, 'local-side commit')
  return { path: root, remote }
}

/** `origin` points at a path that does not exist — the unreachable-remote path. */
export function repoWithUnreachableOrigin(): RemoteRepo {
  const root = repoWithCommits(2)
  const remote = join(tmpdir(), 'claudin-git-nonexistent-remote.git')
  git(root, ['remote', 'add', 'origin', remote])
  return { path: root, remote }
}

/** Deletes every repository this module created. Safe to call more than once. */
export function cleanupAllRepos(): void {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true })
  }
}
