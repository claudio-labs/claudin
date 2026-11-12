import { describe, expect, test } from 'bun:test'
import { getGitStatusDelta } from 'src/vcs/git/gitStatusDelta.js'

type FakeMsg = {
  type: string
  attachment?: { type: string; cwd?: string }
}

describe('getGitStatusDelta', () => {
  test('emits full snapshot on turn 1', () => {
    const delta = getGitStatusDelta('branch: main\nclean', [])
    expect(delta).not.toBeNull()
    expect(delta!.content).toBe('branch: main\nclean')
  })

  test('returns null on turn 2 even if content changes', () => {
    // gitStatus is documented as a snapshot in time — if another run
    // somehow produces different content, we still suppress because
    // the scanner's contract is "emit once per session".
    const history: FakeMsg[] = [
      { type: 'attachment', attachment: { type: 'git_status_delta' } },
    ]
    expect(getGitStatusDelta('branch: main', history)).toBeNull()
    expect(getGitStatusDelta('branch: other', history)).toBeNull()
  })

  test('returns null when gitStatus is null / empty', () => {
    expect(getGitStatusDelta(null, [])).toBeNull()
    expect(getGitStatusDelta('', [])).toBeNull()
    expect(getGitStatusDelta(undefined, [])).toBeNull()
  })

  test('ignores other attachment types in the history scan', () => {
    const history: FakeMsg[] = [
      {
        type: 'attachment',
        attachment: { type: 'mcp_instructions_delta' },
      },
      { type: 'user' },
    ]
    const delta = getGitStatusDelta('branch: main', history)
    expect(delta).not.toBeNull()
  })

  test('two consecutive scans of the same state — second is no-op', () => {
    const first = getGitStatusDelta('branch: main', [])
    expect(first).not.toBeNull()
    const history: FakeMsg[] = [
      { type: 'attachment', attachment: { type: 'git_status_delta' } },
    ]
    expect(getGitStatusDelta('branch: main', history)).toBeNull()
  })

  // /cd moves the session to another repository: the snapshot announced for
  // the old one describes the wrong branch and the wrong commits.
  test('a snapshot announced for another directory is announced again, with its directory', () => {
    const history: FakeMsg[] = [
      { type: 'attachment', attachment: { type: 'git_status_delta', cwd: '/repo/a' } },
    ]
    expect(getGitStatusDelta('branch: other', history, '/repo/b')).toEqual({
      content: 'branch: other',
      cwd: '/repo/b',
    })
    expect(getGitStatusDelta('branch: other', history, '/repo/a')).toBeNull()
  })

  test('only the last announcement counts, and one without a directory is never re-announced', () => {
    const moved: FakeMsg[] = [
      { type: 'attachment', attachment: { type: 'git_status_delta', cwd: '/repo/a' } },
      { type: 'attachment', attachment: { type: 'git_status_delta', cwd: '/repo/b' } },
    ]
    expect(getGitStatusDelta('branch: main', moved, '/repo/b')).toBeNull()
    expect(getGitStatusDelta('branch: main', moved, '/repo/a')).not.toBeNull()

    const legacy: FakeMsg[] = [{ type: 'attachment', attachment: { type: 'git_status_delta' } }]
    expect(getGitStatusDelta('branch: main', legacy, '/repo/b')).toBeNull()
  })

  test('the first announcement records the directory it was taken in', () => {
    expect(getGitStatusDelta('branch: main', [], '/repo/a')).toEqual({ content: 'branch: main', cwd: '/repo/a' })
  })
})
