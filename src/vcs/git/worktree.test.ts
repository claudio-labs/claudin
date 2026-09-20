import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getCwd } from 'src/shared/fs/cwd.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import { setCwd } from 'src/shared/proc/Shell.js'
import * as worktreeModule from 'src/vcs/git/worktree.js'
import type { WorktreeSession } from 'src/vcs/git/worktree.js'
import {
  _resetGitWorktreeMutationLocksForTesting,
  attachExistingWorktree,
  generateTmuxSessionName,
  getCurrentWorktreeSession,
  getTmuxInstallInstructions,
  parsePRReference,
  restoreWorktreeSession,
  validateWorktreeSlug,
  withGitWorktreeMutationLock,
  worktreeBranchName,
} from 'src/vcs/git/worktree.js'

afterEach(() => {
  _resetGitWorktreeMutationLocksForTesting()
  // currentWorktreeSession is module-level process-global state: a session
  // left behind here is read by every later file in the run (prompts, the
  // REPL header, the stale-worktree sweep).
  restoreWorktreeSession(null)
})

test('withGitWorktreeMutationLock serializes mutations for the same repo', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })

  const first = withGitWorktreeMutationLock('/repo', async () => {
    order.push('first:start')
    await firstGate
    order.push('first:end')
  })

  const second = withGitWorktreeMutationLock('/repo', async () => {
    order.push('second:start')
    order.push('second:end')
  })

  await Promise.resolve()
  await Promise.resolve()
  expect(order).toEqual(['first:start'])

  releaseFirst()
  await Promise.all([first, second])

  expect(order).toEqual([
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ])
})

test('withGitWorktreeMutationLock does not serialize different repos', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })

  const first = withGitWorktreeMutationLock('/repo-a', async () => {
    order.push('a:start')
    await firstGate
    order.push('a:end')
  })

  const second = withGitWorktreeMutationLock('/repo-b', async () => {
    order.push('b:start')
    order.push('b:end')
  })

  await Promise.resolve()
  await Promise.resolve()
  expect(order).toEqual(['a:start', 'b:start', 'b:end'])

  releaseFirst()
  await Promise.all([first, second])
})

// attachExistingWorktree — rejection paths only. These throw BEFORE any global
// state mutation or config write (findIndex/matchIdx checks happen before the
// session is built and persisted), so they're side-effect free and safe to unit
// test. The ExitWorktree remove→keep coercion is covered at the validateInput
// gate-skip level in ExitWorktreeTool.test.ts (also side-effect free). Only the
// attach HAPPY path (which mutates currentWorktreeSession + writes project
// config + chdir) is left to the manual e2e steps in the plan.
test('attachExistingWorktree rejects a path that is not a registered worktree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'claudin-wt-'))
  const prevCwd = getCwd()
  try {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('commit', '--allow-empty', '-m', 'init')
    setCwd(repo)

    await expect(
      attachExistingWorktree(join(repo, 'does-not-exist'), 'sess-1'),
    ).rejects.toThrow('not a registered worktree')
  } finally {
    restoreWorktreeSession(null)
    setCwd(prevCwd)
    rmSync(repo, { recursive: true, force: true })
  }
})

test('attachExistingWorktree rejects the main worktree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'claudin-wt-'))
  const prevCwd = getCwd()
  try {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('commit', '--allow-empty', '-m', 'init')
    setCwd(repo)

    await expect(attachExistingWorktree(repo, 'sess-1')).rejects.toThrow(
      'main worktree',
    )
  } finally {
    restoreWorktreeSession(null)
    setCwd(prevCwd)
    rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// validateWorktreeSlug — the security-shaped one.
//
// The slug is joined into `<repo>/.claudin/worktrees/<slug>` with path.join,
// which normalizes `..` and discards everything before an absolute path. The
// allowlist regex and the length cap are the only things standing between an
// attacker-chosen worktree name and an arbitrary directory on disk, so each
// rejected shape is pinned on its own rather than as one "invalid" bucket.
// ---------------------------------------------------------------------------
describe('validateWorktreeSlug', () => {
  test('accepts the shapes the worktree tools actually produce', () => {
    for (const slug of [
      'feature',
      'feature-123',
      'a.b_c-d',
      'user/feature',
      'a/b/c',
      'agent-a1b2c3d',
      'wf_0123abcd-4ef-2',
      'a'.repeat(64),
    ]) {
      expect(() => validateWorktreeSlug(slug)).not.toThrow()
    }
  })

  test('rejects a ".." segment — path.join would climb out of worktrees/', () => {
    expect(() => validateWorktreeSlug('..')).toThrow('".." path segments')
    expect(() => validateWorktreeSlug('../../../target')).toThrow(
      '".." path segments',
    )
    expect(() => validateWorktreeSlug('a/../../etc')).toThrow(
      '".." path segments',
    )
  })

  test('rejects a "." segment', () => {
    expect(() => validateWorktreeSlug('.')).toThrow('".." path segments')
    expect(() => validateWorktreeSlug('a/./b')).toThrow('".." path segments')
  })

  test('rejects an absolute path — path.join would discard the prefix', () => {
    // A leading `/` splits into an empty first segment, which the allowlist
    // rejects because the character class requires at least one character.
    expect(() => validateWorktreeSlug('/etc/passwd')).toThrow(
      'must be non-empty',
    )
    expect(() => validateWorktreeSlug('/')).toThrow('must be non-empty')
  })

  test('rejects a Windows path separator and a drive spec', () => {
    // `\` and `:` are outside the allowlist, so neither a UNC-ish path nor
    // `C:\Windows` survives — on win32 path.join treats both as separators.
    expect(() => validateWorktreeSlug('..\\..\\target')).toThrow(
      'only letters, digits, dots, underscores, and dashes',
    )
    expect(() => validateWorktreeSlug('C:\\Windows')).toThrow(
      'only letters, digits, dots, underscores, and dashes',
    )
  })

  test('rejects an empty slug and an empty segment', () => {
    expect(() => validateWorktreeSlug('')).toThrow('must be non-empty')
    expect(() => validateWorktreeSlug('a//b')).toThrow('must be non-empty')
    expect(() => validateWorktreeSlug('trailing/')).toThrow('must be non-empty')
  })

  test('rejects characters that are not in the allowlist', () => {
    for (const slug of ['has space', 'semi;colon', 'dollar$sign', 'a|b', '~']) {
      expect(() => validateWorktreeSlug(slug)).toThrow(
        'only letters, digits, dots, underscores, and dashes',
      )
    }
  })

  test('caps the slug at 64 characters', () => {
    expect(() => validateWorktreeSlug('a'.repeat(65))).toThrow(
      'must be 64 characters or fewer (got 65)',
    )
    // The cap is measured before the allowlist, so an over-length slug that is
    // otherwise legal still fails on length and not on the character class.
    expect(() => validateWorktreeSlug('a'.repeat(400))).toThrow(
      'must be 64 characters or fewer (got 400)',
    )
  })
})

// ---------------------------------------------------------------------------
// The naming round trip. `flattenSlug` and `worktreePathFor` are private to the
// module, so the branch name is the observable half; the collision claim below
// is what makes the private half safe.
// ---------------------------------------------------------------------------
describe('worktreeBranchName', () => {
  test('prefixes the slug with worktree-', () => {
    expect(worktreeBranchName('feature')).toBe('worktree-feature')
    expect(worktreeBranchName('a.b_c-d')).toBe('worktree-a.b_c-d')
  })

  test('flattens nesting with + so the ref is never a D/F conflict', () => {
    // `worktree-user` (a file under refs/heads) and `worktree-user/feature`
    // (which needs `worktree-user` to be a directory) cannot coexist in git.
    expect(worktreeBranchName('user/feature')).toBe('worktree-user+feature')
    expect(worktreeBranchName('a/b/c')).toBe('worktree-a+b+c')
  })

  test('two different valid slugs cannot collide onto one branch or path', () => {
    // The mapping is injective only because `+` is outside the slug allowlist:
    // the one slug that would collide with `a/b` is itself rejected.
    expect(worktreeBranchName('a/b')).toBe('worktree-a+b')
    expect(() => validateWorktreeSlug('a+b')).toThrow(
      'only letters, digits, dots, underscores, and dashes',
    )
  })
})

// ---------------------------------------------------------------------------
// generateTmuxSessionName — tmux rejects `.` and `:` in a session name, and a
// name that collides attaches the user to somebody else's session.
// ---------------------------------------------------------------------------
describe('generateTmuxSessionName', () => {
  test('joins the repo basename to the branch with an underscore', () => {
    expect(generateTmuxSessionName('/home/u/projects/myrepo', 'main')).toBe(
      'myrepo_main',
    )
  })

  test('uses the basename, not the whole repo path', () => {
    // The separators in the path would otherwise land in the session name.
    expect(generateTmuxSessionName('/home/u/projects/myrepo', 'main')).toBe(
      generateTmuxSessionName('/somewhere/else/myrepo', 'main'),
    )
  })

  test('replaces every slash and dot with an underscore', () => {
    expect(
      generateTmuxSessionName('/home/u/my.repo', 'worktree-feat/x.1'),
    ).toBe('my_repo_worktree-feat_x_1')
  })

  test('leaves dashes and underscores alone', () => {
    expect(generateTmuxSessionName('/r/a-b_c', 'w-1_2')).toBe('a-b_c_w-1_2')
  })
})

// ---------------------------------------------------------------------------
// parsePRReference — drives `--worktree <ref>`, so a shape that answers a
// number when it should answer null silently retargets the worktree.
// ---------------------------------------------------------------------------
describe('parsePRReference', () => {
  test('parses the #N form', () => {
    expect(parsePRReference('#123')).toBe(123)
    expect(parsePRReference('#1')).toBe(1)
  })

  test('parses a GitHub pull URL, including GHE hosts', () => {
    expect(parsePRReference('https://github.com/owner/repo/pull/123')).toBe(123)
    expect(parsePRReference('http://github.com/owner/repo/pull/7')).toBe(7)
    expect(parsePRReference('https://ghe.example.com/o/r/pull/42')).toBe(42)
    expect(parsePRReference('HTTPS://GitHub.com/o/r/PULL/9')).toBe(9)
  })

  test('tolerates a trailing slash, a query string and a fragment', () => {
    expect(parsePRReference('https://github.com/o/r/pull/5/')).toBe(5)
    expect(parsePRReference('https://github.com/o/r/pull/5?w=1')).toBe(5)
    expect(parsePRReference('https://github.com/o/r/pull/5#issuecomment-1')).toBe(
      5,
    )
  })

  test('answers null for a bare number — that is a worktree name, not a PR', () => {
    expect(parsePRReference('123')).toBeNull()
  })

  test('answers null for the shapes that are not a GitHub pull reference', () => {
    for (const input of [
      '',
      'feature-123',
      '#',
      '#12a',
      '# 12',
      'x#123',
      '#123x',
      'https://github.com/o/r/pull/abc',
      'https://github.com/o/r/pull/',
      'https://github.com/o/r/pull/12/files',
      'https://gitlab.com/o/r/-/merge_requests/12',
      'https://bitbucket.org/o/r/pull-requests/12',
      'ftp://github.com/o/r/pull/12',
    ]) {
      expect(parsePRReference(input)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// getTmuxInstallInstructions. getPlatform() is memoized, so the fake
// process.platform has to be installed with the memo cache cleared on both
// sides — and restored before anything else in the run reads it.
// ---------------------------------------------------------------------------
function withPlatform<T>(platform: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
  getPlatform.cache.clear?.()
  try {
    return fn()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
    getPlatform.cache.clear?.()
  }
}

describe('getTmuxInstallInstructions', () => {
  test('names Homebrew on macOS', () => {
    expect(withPlatform('darwin', getTmuxInstallInstructions)).toBe(
      'Install tmux with: brew install tmux',
    )
  })

  test('names apt and dnf on Linux (and on WSL, which shares the arm)', () => {
    expect(withPlatform('linux', getTmuxInstallInstructions)).toBe(
      'Install tmux with: sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora/RHEL)',
    )
  })

  test('says tmux is unavailable on Windows rather than offering a command', () => {
    expect(withPlatform('win32', getTmuxInstallInstructions)).toBe(
      'tmux is not natively available on Windows. Consider using WSL or Cygwin.',
    )
  })

  test('falls back to a generic hint on an unrecognized platform', () => {
    expect(withPlatform('freebsd', getTmuxInstallInstructions)).toBe(
      'Install tmux using your system package manager.',
    )
  })
})

// ---------------------------------------------------------------------------
// The mutation lock. The two ordering tests above already pin same-key
// serialization and different-key independence; what is left is the reset and
// the release-on-throw contract, both written with real promises.
// ---------------------------------------------------------------------------
describe('withGitWorktreeMutationLock', () => {
  test('returns whatever the critical section returned', async () => {
    await expect(
      withGitWorktreeMutationLock('/repo-ret', async () => 'payload'),
    ).resolves.toBe('payload')
  })

  test('releases the lock when the critical section throws', async () => {
    await expect(
      withGitWorktreeMutationLock('/repo-throw', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // Without the `finally` release the next holder of the same key would
    // never be scheduled and this would time out.
    let ran = false
    await withGitWorktreeMutationLock('/repo-throw', async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test('_resetGitWorktreeMutationLocksForTesting drops a still-held lock', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const first = withGitWorktreeMutationLock('/repo-reset', () => firstGate)

    // Let the first holder enter the critical section, then drop the map.
    await Promise.resolve()
    await Promise.resolve()
    _resetGitWorktreeMutationLocksForTesting()

    let secondStarted = false
    const second = withGitWorktreeMutationLock('/repo-reset', async () => {
      secondStarted = true
    })
    await Promise.resolve()
    await Promise.resolve()
    // Still held, so without the reset this is false.
    expect(secondStarted).toBe(true)

    releaseFirst()
    await Promise.all([first, second])
  })
})

// ---------------------------------------------------------------------------
// The session accessors over the single module-level `currentWorktreeSession`.
// Two copies of that binding would mean two answers about which tree the
// session is in, and the cleanup path would then operate on the wrong one.
// ---------------------------------------------------------------------------
describe('the current worktree session', () => {
  const session: WorktreeSession = {
    originalCwd: '/repo',
    worktreePath: '/repo/.claudin/worktrees/feature',
    worktreeName: 'feature',
    worktreeBranch: 'worktree-feature',
    sessionId: 'sess-accessor',
  }

  test('starts out null in a fresh process', () => {
    expect(getCurrentWorktreeSession()).toBeNull()
  })

  test('restore then get round-trips the same object', () => {
    restoreWorktreeSession(session)
    expect(getCurrentWorktreeSession()).toBe(session)
    expect(getCurrentWorktreeSession()?.worktreePath).toBe(
      '/repo/.claudin/worktrees/feature',
    )
  })

  test('restoring null clears the session', () => {
    restoreWorktreeSession(session)
    expect(getCurrentWorktreeSession()).not.toBeNull()
    restoreWorktreeSession(null)
    expect(getCurrentWorktreeSession()).toBeNull()
  })

  test('the accessor reads one binding, not a snapshot taken at import', () => {
    const other: WorktreeSession = { ...session, worktreeName: 'other' }
    restoreWorktreeSession(session)
    restoreWorktreeSession(other)
    expect(getCurrentWorktreeSession()?.worktreeName).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// SURFACE PIN.
//
// worktree.ts is a barrel over worktree/. A barrel that loses a re-export still
// builds and still type-checks for every consumer that does not import the
// dropped name — this is the only thing that catches it, and the consumers are
// the REPL header, the exit dialog, AgentTool and the cli.tsx tmux fast path,
// where a missing symbol is a runtime TypeError mid-session.
//
// It is also where the surface that is NOT tested behaviourally is recorded,
// rather than left looking covered. Everything in NOT_BEHAVIOURALLY_COVERED
// below shells out to git or tmux, mutates process.cwd() or writes the project
// config; under `bun test` they are pinned by name and arity only, and nothing
// here claims they behave.
// ---------------------------------------------------------------------------
/** Every value export, exactly. Adding one here is a deliberate act. */
const EXPECTED_EXPORTS = [
  '_resetGitWorktreeMutationLocksForTesting',
  'attachExistingWorktree',
  'cleanupStaleAgentWorktrees',
  'cleanupWorktree',
  'copyWorktreeIncludeFiles',
  'createAgentWorktree',
  'createTmuxSessionForWorktree',
  'createWorktreeForSession',
  'execIntoTmuxWorktree',
  'generateTmuxSessionName',
  'getCurrentWorktreeSession',
  'getTmuxInstallInstructions',
  'hasWorktreeChanges',
  'isTmuxAvailable',
  'keepWorktree',
  'killTmuxSession',
  'parsePRReference',
  'removeAgentWorktree',
  'restoreWorktreeSession',
  'validateWorktreeSlug',
  'withGitWorktreeMutationLock',
  'worktreeBranchName',
] as const

/** Covered by name and arity only — see the block comment above. */
const NOT_BEHAVIOURALLY_COVERED = [
  'attachExistingWorktree', // rejection paths only; the happy path chdirs
  'cleanupStaleAgentWorktrees',
  'cleanupWorktree',
  'copyWorktreeIncludeFiles',
  'createAgentWorktree',
  'createTmuxSessionForWorktree',
  'createWorktreeForSession',
  'execIntoTmuxWorktree',
  'hasWorktreeChanges',
  'isTmuxAvailable',
  'keepWorktree',
  'killTmuxSession',
  'removeAgentWorktree',
] as const

describe('worktree surface', () => {
  test('exports exactly the expected set of names', () => {
    expect(Object.keys(worktreeModule).sort()).toEqual([...EXPECTED_EXPORTS])
  })

  test('every exported name is callable', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(typeof worktreeModule[name]).toBe('function')
    }
  })

  test('the I/O half is declared, not claimed as covered', () => {
    for (const name of NOT_BEHAVIOURALLY_COVERED) {
      expect(EXPECTED_EXPORTS).toContain(name)
    }
  })

  test('the WorktreeSession type survives the barrel', () => {
    // Compile-time pin: dropping the type re-export is a tsc error here, which
    // is what `typecheck` reports as new.
    const s: WorktreeSession = {
      originalCwd: '/a',
      worktreePath: '/a/.claudin/worktrees/b',
      worktreeName: 'b',
      sessionId: 's',
      attached: true,
      hookBased: false,
      usedSparsePaths: false,
      creationDurationMs: 1,
      originalBranch: 'main',
      originalHeadCommit: 'deadbeef',
      worktreeBranch: 'worktree-b',
      tmuxSessionName: 'r_worktree-b',
    }
    expect([s.worktreeName, s.attached]).toEqual(['b', true])
  })

  // Arity is the cheap half of a signature: it catches a parameter silently
  // gaining a default, or an options object being flattened, during a
  // relocation that still type-checks at every call site.
  test.each([
    ['validateWorktreeSlug', 1],
    ['getCurrentWorktreeSession', 0],
    ['restoreWorktreeSession', 1],
    ['generateTmuxSessionName', 2],
    ['withGitWorktreeMutationLock', 2],
    ['_resetGitWorktreeMutationLocksForTesting', 0],
    ['worktreeBranchName', 1],
    ['copyWorktreeIncludeFiles', 2],
    ['parsePRReference', 1],
    ['isTmuxAvailable', 0],
    ['getTmuxInstallInstructions', 0],
    ['createTmuxSessionForWorktree', 2],
    ['killTmuxSession', 1],
    // Optional params still count towards Function.length (TS `?` compiles to
    // a bare parameter), so a `= undefined` default appearing on one of these
    // drops the count — which is exactly the shape this pin is here to catch.
    ['createWorktreeForSession', 4],
    ['attachExistingWorktree', 2],
    ['keepWorktree', 0],
    ['cleanupWorktree', 0],
    ['createAgentWorktree', 1],
    ['removeAgentWorktree', 4],
    ['cleanupStaleAgentWorktrees', 1],
    ['hasWorktreeChanges', 2],
    ['execIntoTmuxWorktree', 1],
  ] as const)('%s takes %d required parameter(s)', (name, arity) => {
    expect(worktreeModule[name].length).toBe(arity)
  })
})
