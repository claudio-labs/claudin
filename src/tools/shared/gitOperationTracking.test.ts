import { describe, expect, test } from 'bun:test'

import {
  applyBashFilterToStdout,
  planBashFilter,
} from 'src/tools/shared/outputFilter/Bash/index.js'
import {
  detectGitOperation,
  parseGitCommitId,
  trackGitOperations,
} from 'src/tools/shared/gitOperationTracking.js'

describe('detectGitOperation', () => {
  test('parses commit sha and push branch from raw output', () => {
    const command = 'git commit -m wip && git push'
    const output =
      '[main 154654a] wip\n   abc1234..def5678  main -> main\n'
    const r = detectGitOperation(command, output)
    expect(r.commit).toEqual({ sha: '154654', kind: 'committed' })
    expect(r.push).toEqual({ branch: 'main' })
  })

  test('strips bash-output-filtered wrapper so closing tag is not captured as branch', () => {
    const command = 'git commit -m wip && git push'
    // The bash-output filter wraps stdout; the push ref line ends the body so
    // the closing tag abuts the branch name with no separating whitespace.
    const output =
      '<bash-output-filtered original="git push" lines="2/9" reduction="78%">' +
      '[main 154654a] wip\n   abc1234..def5678  main -> main' +
      '</bash-output-filtered>\n'
    const r = detectGitOperation(command, output)
    expect(r.commit).toEqual({ sha: '154654', kind: 'committed' })
    expect(r.push).toEqual({ branch: 'main' })
  })

  test('strips bash-output-rewritten wrapper too', () => {
    const command = 'git push'
    const output =
      '<bash-output-rewritten original="git push" actual="git push">' +
      '   abc1234..def5678  feature/x -> feature/x' +
      '</bash-output-rewritten>'
    const r = detectGitOperation(command, output)
    expect(r.push).toEqual({ branch: 'feature/x' })
  })

  test('reports nothing for a command that is not a tracked git operation', () => {
    // The sha in `git log` output must not read as a commit.
    expect(detectGitOperation('git log -1', '[main 154654a] wip\n')).toEqual({})
  })
})

describe('detectGitOperation — commits', () => {
  test('a commit whose output carries no sha is not reported', () => {
    expect(detectGitOperation('git commit -m x', 'nothing to commit\n').commit).toBeUndefined()
  })

  test('--amend reads as amended', () => {
    const r = detectGitOperation('git commit --amend --no-edit', '[main 9f8e7d6] wip\n')
    expect(r.commit).toEqual({ sha: '9f8e7d', kind: 'amended' })
  })

  test('cherry-pick reads as cherry-picked', () => {
    const r = detectGitOperation('git cherry-pick 1234abc', '[main abcdef1] picked\n')
    expect(r.commit).toEqual({ sha: 'abcdef', kind: 'cherry-picked' })
  })

  test('global options between git and the subcommand are tolerated', () => {
    const r = detectGitOperation(
      'git -c commit.gpgsign=false commit -m x',
      '[feat/x 1a2b3c4] x\n',
    )
    expect(r.commit).toEqual({ sha: '1a2b3c', kind: 'committed' })
  })
})

describe('detectGitOperation — push', () => {
  test('a new branch', () => {
    const r = detectGitOperation(
      'git push -u origin feat/x',
      'To github.com:o/r.git\n * [new branch]      feat/x -> feat/x\n',
    )
    expect(r.push).toEqual({ branch: 'feat/x' })
  })

  test('a forced update', () => {
    const r = detectGitOperation(
      'git push --force-with-lease',
      ' + abc1234...def5678 main -> main (forced update)\n',
    )
    expect(r.push).toEqual({ branch: 'main' })
  })

  test('up to date reports no push', () => {
    expect(detectGitOperation('git push', 'Everything up-to-date\n').push).toBeUndefined()
  })
})

describe('detectGitOperation — merge and rebase', () => {
  test('a fast-forward merge names the ref', () => {
    const r = detectGitOperation('git merge feat/x', 'Updating a..b\nFast-forward\n')
    expect(r.branch).toEqual({ ref: 'feat/x', action: 'merged' })
  })

  test('flags before the ref are skipped', () => {
    const r = detectGitOperation(
      'git merge --no-ff feat/x',
      "Merge made by the 'ort' strategy.\n",
    )
    expect(r.branch).toEqual({ ref: 'feat/x', action: 'merged' })
  })

  test('a merge that did not complete is not reported', () => {
    expect(
      detectGitOperation('git merge feat/x', 'CONFLICT (content): Merge conflict in a.ts\n').branch,
    ).toBeUndefined()
  })

  test('git merge-base is not a merge', () => {
    expect(detectGitOperation('git merge-base a b', 'Fast-forward\n').branch).toBeUndefined()
  })

  test('the ref scan stops at a shell operator', () => {
    expect(
      detectGitOperation('git merge --ff-only | tail -1', 'Fast-forward\n').branch,
    ).toBeUndefined()
  })

  test('a rebase names the ref it rebased onto', () => {
    const r = detectGitOperation(
      'git rebase origin/main',
      'Successfully rebased and updated refs/heads/feat/x.\n',
    )
    expect(r.branch).toEqual({ ref: 'origin/main', action: 'rebased' })
  })

  test('a rebase with no success line is not reported', () => {
    expect(detectGitOperation('git rebase main', 'error: cannot rebase\n').branch).toBeUndefined()
  })
})

describe('detectGitOperation — gh pr', () => {
  test('create reads the PR from its URL', () => {
    const r = detectGitOperation(
      'gh pr create --title t --body b',
      'https://github.com/claudio-labs/claudin/pull/42\n',
    )
    expect(r.pr).toEqual({
      number: 42,
      url: 'https://github.com/claudio-labs/claudin/pull/42',
      action: 'created',
    })
  })

  test('merge reads the number from the text when there is no URL', () => {
    const r = detectGitOperation(
      'gh pr merge 1234 --squash',
      '✓ Squashed and merged pull request claudio-labs/claudin#1234 (title)\n',
    )
    expect(r.pr).toEqual({ number: 1234, action: 'merged' })
  })

  test.each([
    ['gh pr edit 7 --title x', 'edited'],
    ['gh pr comment 7 --body x', 'commented'],
    ['gh pr close 7', 'closed'],
    ['gh pr ready 7', 'ready'],
  ] as const)('%s reads as %s', (command, action) => {
    const r = detectGitOperation(command, 'https://github.com/o/r/pull/7\n')
    expect(r.pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7', action })
  })

  test('a PR action with neither URL nor number reports no PR', () => {
    expect(detectGitOperation('gh pr close 7', 'done\n').pr).toBeUndefined()
  })

  test('gh pr view is not an action', () => {
    expect(detectGitOperation('gh pr view 7', 'https://github.com/o/r/pull/7\n').pr).toBeUndefined()
  })
})

describe('parseGitCommitId', () => {
  test('extracts sha from commit output', () => {
    expect(parseGitCommitId('[main 154654a] wip')).toBe('154654a')
  })

  test('extracts sha from root commit', () => {
    expect(parseGitCommitId('[main (root-commit) abc1234] init')).toBe(
      'abc1234',
    )
  })

  test('a branch name with a slash', () => {
    expect(parseGitCommitId('[feat/x-1.2 1a2b3c4] wip')).toBe('1a2b3c4')
  })

  test('no commit header → undefined', () => {
    expect(parseGitCommitId('On branch main\nnothing to commit')).toBeUndefined()
  })

  test('the Bash output filter\'s line', () => {
    expect(parseGitCommitId('✓ committed 1a2b3c4\n')).toBe('1a2b3c4')
  })

  test('the filter\'s words mid-line are not a commit', () => {
    expect(parseGitCommitId('earlier: ✓ committed 1a2b3c4 by hand')).toBeUndefined()
  })
})

describe('a bare git commit, after the Bash output filter', () => {
  // The filter and the parser share FILTERED_COMMIT_MARK; this is the round
  // trip that breaks if either stops speaking the other's form.
  const command = 'git commit -m "fix: thing"'
  const raw = '[main 1a2b3c4] fix: thing\n 2 files changed, 5 insertions(+), 1 deletion(-)\n'
  const filtered = applyBashFilterToStdout(
    raw,
    false,
    planBashFilter(command, { allowRewrite: true }),
    0,
  )

  test('the filter does rewrite the header (or the next test proves nothing)', () => {
    expect(filtered).not.toContain('[main')
  })

  test('still yields its sha', () => {
    expect(detectGitOperation(command, filtered).commit).toEqual({
      sha: '1a2b3c',
      kind: 'committed',
    })
  })
})

describe('trackGitOperations', () => {
  // Only the paths that link nothing: the PR-create link writes to session
  // storage through a dynamic import, which this suite does not drive.
  test('a failed command is ignored', () => {
    expect(() =>
      trackGitOperations('gh pr create', 1, 'https://github.com/o/r/pull/1'),
    ).not.toThrow()
  })

  test('a PR create without stdout, and a non-create command, are no-ops', () => {
    expect(() => trackGitOperations('gh pr create', 0)).not.toThrow()
    expect(() => trackGitOperations('gh pr create', 0, 'no url here')).not.toThrow()
    expect(() => trackGitOperations('git commit -m x', 0, '[main 1a2b3c4] x')).not.toThrow()
  })
})
