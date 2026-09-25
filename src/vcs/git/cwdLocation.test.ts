import { describe, expect, test } from 'bun:test'
import { describeCwdLocation } from 'src/vcs/git/cwdLocation.js'

const HOME = '/home/dev'

describe('describeCwdLocation', () => {
  test('names the repo root, not the full path', () => {
    const repo = '/home/dev/projects/claudin'
    expect(describeCwdLocation(repo, repo, repo, HOME)).toEqual({ project: 'claudin', worktree: '' })
  })

  test('inside a linked worktree, names the main repo and the worktree', () => {
    expect(
      describeCwdLocation(
        '/home/dev/projects/claudin/.claudin/worktrees/footer-pills',
        '/home/dev/projects/claudin',
        '/home/dev/projects/claudin',
        HOME,
      ),
    ).toEqual({ project: 'claudin', worktree: 'footer-pills' })
  })

  test('started in a subdirectory still names the repo root', () => {
    const repo = '/home/dev/projects/claudin'
    expect(describeCwdLocation(repo, repo, `${repo}/src/vcs`, HOME).project).toBe('claudin')
  })

  test('outside a repo, names the directory Claudin started in', () => {
    expect(describeCwdLocation(null, null, '/home/dev/notes', HOME)).toEqual({
      project: 'notes',
      worktree: '',
    })
    expect(describeCwdLocation(null, null, HOME, HOME).project).toBe('~')
    expect(describeCwdLocation(null, null, '/', HOME).project).toBe('/')
  })
})
