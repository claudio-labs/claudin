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

describe('read-only classification (fail-closed)', () => {
  test('the known reads are reads', () => {
    for (const cmd of [
      'git diff',
      'git diff HEAD~1 -- src/',
      'git log -5',
      'git status',
      'git show abc123',
      'git blame src/x.ts',
      'gh pr view 12',
      'gh pr list',
      'gh pr checks',
    ]) {
      expect(isReadOnlyGitCommand(cmd)).toBe(true)
    }
  })

  test('mutations are not reads', () => {
    for (const cmd of [
      'git commit -m x',
      'git push',
      'git add -A',
      'git checkout main',
      // Writes refs despite touching no worktree file.
      'git fetch',
      // Writes the working tree despite living under the `pr` family.
      'gh pr checkout 12',
    ]) {
      expect(isReadOnlyGitCommand(cmd)).toBe(false)
    }
  })

  test('an unrecognised subcommand defaults to mutating', () => {
    expect(isReadOnlyGitCommand('git frobnicate')).toBe(false)
    expect(isReadOnlyGitCommand('gh weather today')).toBe(false)
  })

  test('a refused command is never read-only', () => {
    // Otherwise a refusal would still open the plan-mode door.
    expect(isReadOnlyGitCommand('git diff | head -5')).toBe(false)
  })

  test('a batch is read-only only when every element is', () => {
    expect(isReadOnlyGitBatch(['git status', 'git diff'])).toBe(true)
    expect(isReadOnlyGitBatch(['git status', 'git commit -m x'])).toBe(false)
    expect(isReadOnlyGitBatch([])).toBe(false)
  })
})
