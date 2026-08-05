import { describe, expect, test } from 'bun:test'
import {
  acceptsGitCommand,
  isReadOnlyGitBatch,
  isReadOnlyGitCommand,
  parseGitCommand,
} from './grammar.js'

describe('accept / refuse', () => {
  test('accepts a plain git or gh command', () => {
    expect(acceptsGitCommand('git status')).toBe(true)
    expect(acceptsGitCommand('gh pr view 12')).toBe(true)
  })

  test('accepts quoted arguments — otherwise `git commit -m` is unreachable', () => {
    // The shared hasShellComposition() treats quotes as composition, which is
    // right for a redirect and fatal here.
    expect(acceptsGitCommand('git commit -m "fix: thing"')).toBe(true)
    expect(acceptsGitCommand("git commit -m 'fix: thing'")).toBe(true)
  })

  test('refuses shell operators and names the list as the alternative', () => {
    for (const cmd of [
      'git add -A && git commit -m x',
      'git diff | head -50',
      'git status; git diff',
      'git log > out.txt',
      'git commit -m "$(date)"',
    ]) {
      const parsed = parseGitCommand(cmd)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.reason).toContain('shell operator')
    }
  })

  test('refuses a command that is not git or gh', () => {
    const parsed = parseGitCommand('ls -la')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('does not start with')
  })

  test('refuses an empty command', () => {
    expect(parseGitCommand('   ').ok).toBe(false)
  })
})

/**
 * The whole inventory, in one table. A future edit that flips an entry fails
 * here by name rather than silently widening what plan mode admits.
 */
const CLASSIFICATION: ReadonlyArray<readonly [string, boolean]> = [
  // --- always-read git subcommands -------------------------------------
  ['git status', true],
  ['git diff', true],
  ['git diff HEAD~1 -- src/', true],
  ['git log -5', true],
  ['git show abc123', true],
  ['git blame src/x.ts', true],
  ['git shortlog -sn', true],
  ['git describe --tags', true],
  ['git ls-files', true],
  ['git ls-tree HEAD', true],
  ['git ls-remote origin', true],
  ['git cat-file -p HEAD', true],
  ['git rev-parse HEAD', true],
  ['git rev-list --count HEAD', true],
  ['git name-rev HEAD', true],
  ['git merge-base main HEAD', true],
  ['git for-each-ref', true],
  ['git cherry main', true],
  ['git range-diff main...HEAD', true],
  ['git diff-tree -r HEAD', true],
  ['git whatchanged -2', true],
  ['git grep needle', true],
  ['git check-ignore dist', true],
  ['git check-attr text -- a.ts', true],
  ['git count-objects -v', true],
  ['git verify-commit HEAD', true],
  ['git var GIT_EDITOR', true],
  ['git version', true],
  ['git help log', true],
  // Global options resolve through to the real subcommand.
  ['git --no-pager log -3', true],
  ['git --no-pager diff', true],

  // --- plain mutations --------------------------------------------------
  ['git add -A', false],
  ['git commit -m x', false],
  ['git push', false],
  ['git pull', false],
  ['git checkout main', false],
  ['git switch main', false],
  ['git restore src/x.ts', false],
  ['git reset --hard', false],
  ['git revert HEAD', false],
  ['git cherry-pick abc', false],
  ['git merge main', false],
  ['git rebase main', false],
  ['git clean -fd', false],
  ['git mv a b', false],
  ['git rm a', false],
  ['git apply p.patch', false],
  ['git gc', false],
  // Writes refs despite touching no worktree file.
  ['git fetch', false],
  ['git fetch --all', false],

  // --- `-C` / `-c` re-point git; never read-only ------------------------
  ['git -C /other status', false],
  ['git -c core.pager=cat log', false],

  // --- branch -----------------------------------------------------------
  ['git branch', true],
  ['git branch -l', true],
  ['git branch -a', true],
  ['git branch -r', true],
  ['git branch -v', true],
  ['git branch --contains HEAD', true],
  ['git branch --merged main', true],
  ['git branch --list feat/*', true],
  ['git branch feat/new', false],
  ['git branch -d old', false],
  ['git branch -D old', false],
  ['git branch -m old new', false],
  ['git branch -f main HEAD', false],
  ['git branch --set-upstream-to origin/main', false],

  // --- tag --------------------------------------------------------------
  ['git tag', true],
  ['git tag -l', true],
  ['git tag -n', true],
  ['git tag -n5', true],
  ['git tag --list v1*', true],
  ['git tag --contains HEAD', true],
  ['git tag v1.0.0', false],
  ['git tag -d v1.0.0', false],
  ['git tag -a v1 -m msg', false],
  ['git tag -f v1', false],

  // --- stash / worktree / submodule / notes / bisect / reflog ----------
  ['git stash list', true],
  ['git stash show', true],
  ['git stash', false],
  ['git stash push', false],
  ['git stash pop', false],
  ['git stash drop', false],
  ['git worktree list', true],
  ['git worktree add ../wt', false],
  ['git worktree remove ../wt', false],
  ['git submodule status', true],
  ['git submodule summary', true],
  ['git submodule update --init', false],
  ['git notes list', true],
  ['git notes show', true],
  ['git notes add -m x', false],
  ['git bisect log', true],
  ['git bisect view', true],
  ['git bisect start', false],
  ['git bisect good', false],
  ['git reflog show', true],
  ['git reflog exists refs/heads/main', true],
  ['git reflog expire --expire=now', false],

  // --- config -----------------------------------------------------------
  ['git config --get user.name', true],
  ['git config --get-all remote.origin.url', true],
  ['git config --list', true],
  ['git config -l', true],
  ['git config user.name Someone', false],
  ['git config --unset user.name', false],
  ['git config --add remote.origin.url x', false],

  // --- remote -----------------------------------------------------------
  ['git remote', true],
  ['git remote -v', true],
  ['git remote show origin', true],
  ['git remote get-url origin', true],
  ['git remote add upstream url', false],
  ['git remote remove upstream', false],
  ['git remote set-url origin url', false],
  ['git remote prune origin', false],

  // --- gh reads ---------------------------------------------------------
  ['gh pr list', true],
  ['gh pr view 12', true],
  ['gh pr diff 12', true],
  ['gh pr checks', true],
  ['gh pr status', true],
  ['gh issue list', true],
  ['gh issue view 3', true],
  ['gh issue status', true],
  ['gh run list', true],
  ['gh run view 99', true],
  ['gh workflow list', true],
  ['gh workflow view ci', true],
  ['gh release list', true],
  ['gh release view v1', true],
  ['gh repo view', true],
  ['gh repo list', true],
  ['gh label list', true],
  ['gh secret list', true],
  ['gh variable list', true],
  ['gh cache list', true],
  ['gh gist list', true],
  ['gh gist view abc', true],
  ['gh auth status', true],
  ['gh status', true],
  ['gh search repos cli', true],
  ['gh search issues bug', true],

  // --- gh writes --------------------------------------------------------
  // Writes the working tree despite living under the `pr` family.
  ['gh pr checkout 12', false],
  ['gh pr create --title t --body b', false],
  ['gh pr merge 12', false],
  ['gh pr close 12', false],
  ['gh pr comment 12 --body hi', false],
  ['gh pr edit 12 --title t', false],
  ['gh pr review 12 --approve', false],
  ['gh issue create --title t --body b', false],
  ['gh issue close 3', false],
  ['gh issue comment 3 --body hi', false],
  ['gh run rerun 99', false],
  ['gh run cancel 99', false],
  ['gh workflow run ci', false],
  ['gh workflow enable ci', false],
  ['gh release create v1', false],
  ['gh release upload v1 f', false],
  ['gh secret set NAME', false],
  ['gh label create bug', false],
  ['gh repo create name', false],
  ['gh repo fork', false],
  // Opens a browser — a side effect, and a hang risk headless.
  ['gh browse', false],

  // --- gh api method sniffing -------------------------------------------
  ['gh api repos/o/r', true],
  ['gh api repos/o/r --method GET', true],
  ['gh api repos/o/r -X GET', true],
  ['gh api repos/o/r -X POST', false],
  ['gh api repos/o/r -XPOST', false],
  ['gh api repos/o/r --method=PATCH', false],
  ['gh api repos/o/r --method DELETE', false],
  ['gh api repos/o/r -f name=x', false],
  ['gh api repos/o/r -F count=1', false],
  ['gh api repos/o/r --field name=x', false],
  ['gh api repos/o/r --input body.json', false],

  // --- fail-closed defaults ---------------------------------------------
  ['git frobnicate', false],
  ['gh weather today', false],
  ['gh pr frobnicate', false],
]

describe('read-only classification (fail-closed)', () => {
  for (const [command, expected] of CLASSIFICATION) {
    test(`${command} → ${expected ? 'read' : 'mutating'}`, () => {
      expect(isReadOnlyGitCommand(command)).toBe(expected)
    })
  }

  test('an unrecognised subcommand defaults to mutating', () => {
    // The fail-closed default, pinned on its own: a command nobody has
    // classified must never widen what plan mode admits.
    expect(isReadOnlyGitCommand('git totally-new-subcommand')).toBe(false)
    expect(isReadOnlyGitCommand('gh totally-new-family sub')).toBe(false)
    expect(isReadOnlyGitCommand('gh onlyfamily')).toBe(false)
  })

  test('a refused command is never read-only', () => {
    // Otherwise a refusal would still open the plan-mode door.
    expect(isReadOnlyGitCommand('git diff | head -5')).toBe(false)
    expect(isReadOnlyGitCommand('git add -p')).toBe(false)
  })

  test('a batch is read-only only when every element is', () => {
    expect(isReadOnlyGitBatch(['git status', 'git diff'])).toBe(true)
    expect(isReadOnlyGitBatch(['git status', 'git commit -m x'])).toBe(false)
    expect(isReadOnlyGitBatch([])).toBe(false)
  })
})

describe('interactive forms are declined, not run', () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['git add -p', 'hang'],
    ['git add --patch', 'hang'],
    ['git add -i', 'hang'],
    ['git checkout -p', 'hang'],
    ['git restore -p', 'hang'],
    ['git stash push -p', 'hang'],
    ['git clean -i', 'hang'],
    ['git rebase -i HEAD~3', 'rebasing nothing'],
    ['git rebase --interactive HEAD~3', 'rebasing nothing'],
    ['git commit', '-m'],
    ['git commit -a', '-m'],
    ['git commit --amend', '-m'],
    ['git tag -a v1', '-m'],
    ['git config --edit', 'editor'],
    ['git mergetool', 'merge program'],
    ['git difftool', 'prompts'],
    ['git send-email', 'prompts'],
    ['gh auth login', 'terminal'],
    ['gh pr create', 'prompts interactively'],
    ['gh issue create', 'prompts interactively'],
  ]

  for (const [command, needle] of CASES) {
    test(`${command} is refused`, () => {
      const parsed = parseGitCommand(command)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.reason).toContain(needle)
    })
  }

  test('the refusal costs microseconds, not a timeout', () => {
    // The point of declining these is that `git add -p` would otherwise block
    // on a stdin nobody writes to until the 2-minute default timeout.
    const started = performance.now()
    for (let i = 0; i < 1000; i++) parseGitCommand('git add -p')
    expect(performance.now() - started).toBeLessThan(200)
  })

  const ALLOWED: readonly string[] = [
    'git commit -m "msg"',
    'git commit -am "msg"',
    'git commit --amend --no-edit',
    'git commit -F msg.txt',
    'git commit --fixup HEAD',
    'git tag -a v1 -m "release"',
    'git tag v1',
    'git rebase main',
    'git add -A',
    'git add .',
    'git difftool --no-prompt',
    'gh pr create --title t --body b',
    'gh auth status',
  ]
  for (const command of ALLOWED) {
    test(`${command} is NOT refused`, () => {
      expect(acceptsGitCommand(command)).toBe(true)
    })
  }
})
