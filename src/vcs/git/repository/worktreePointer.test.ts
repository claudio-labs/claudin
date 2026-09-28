import { describe, expect, test } from 'bun:test'
import { canonicalRootOf, type WorktreeFs } from 'src/vcs/git/repository/worktreePointer.js'

function fakeFs(
  files: Record<string, string>,
  realPaths: Record<string, string | null> = {},
): WorktreeFs {
  return {
    kind: path => (path in files ? 'file' : 'missing'),
    readText: path => files[path] ?? null,
    realPath: path => (path in realPaths ? (realPaths[path] ?? null) : path),
  }
}

// A linked worktree at /work/side of the repository whose main tree is /repo.
const GENUINE: Record<string, string> = {
  '/work/side/.git': 'gitdir: /repo/.git/worktrees/side\n',
  '/repo/.git/worktrees/side/commondir': '../..\n',
  '/repo/.git/worktrees/side/gitdir': '/work/side/.git\n',
}

describe('canonicalRootOf', () => {
  test('a genuine linked worktree maps to the main working tree', () => {
    expect(canonicalRootOf('/work/side', fakeFs(GENUINE))).toBe('/repo')
  })

  test('pointer files written with CRLF line endings read the same', () => {
    const files = Object.fromEntries(
      Object.entries(GENUINE).map(([path, text]) => [path, text.replace('\n', '\r\n')]),
    )
    expect(canonicalRootOf('/work/side', fakeFs(files))).toBe('/repo')
  })

  test("a bare repository's worktree maps to the bare repository itself", () => {
    const files = {
      '/work/co/.git': 'gitdir: /srv/store.git/worktrees/co\n',
      '/srv/store.git/worktrees/co/commondir': '../..\n',
      '/srv/store.git/worktrees/co/gitdir': '/work/co/.git\n',
    }
    expect(canonicalRootOf('/work/co', fakeFs(files))).toBe('/srv/store.git')
  })

  test('an admin directory below <shared dir>/worktrees/<name> is not a registered entry', () => {
    const files = {
      '/work/side/.git': 'gitdir: /repo/.git/worktrees/side/deeper\n',
      '/repo/.git/worktrees/side/deeper/commondir': '../../..\n',
      '/repo/.git/worktrees/side/deeper/gitdir': '/work/side/.git\n',
    }
    expect(canonicalRootOf('/work/side', fakeFs(files))).toBe('/work/side')
  })

  test('a back-link recorded as a relative path is not followed', () => {
    const files = { ...GENUINE, '/repo/.git/worktrees/side/gitdir': '../../../work/side/.git\n' }
    expect(canonicalRootOf('/work/side', fakeFs(files))).toBe('/work/side')
  })

  test('the back-link is compared with the checkout path once its symlinks are resolved', () => {
    const files = { ...GENUINE, '/alias/.git': GENUINE['/work/side/.git'] ?? '' }
    expect(canonicalRootOf('/alias', fakeFs(files, { '/alias': '/work/side' }))).toBe('/repo')
    expect(canonicalRootOf('/alias', fakeFs(files))).toBe('/alias')
  })

  test('a checkout that does not resolve never matches, even when the back-link is missing too', () => {
    const { ['/repo/.git/worktrees/side/gitdir']: _backLink, ...withoutBackLink } = GENUINE
    expect(canonicalRootOf('/work/side', fakeFs(withoutBackLink, { '/work/side': null }))).toBe(
      '/work/side',
    )
  })

  test('only the exact "gitdir: " prefix makes a pointer', () => {
    const files = { ...GENUINE, '/work/side/.git': 'gitdir:/repo/.git/worktrees/side\n' }
    expect(canonicalRootOf('/work/side', fakeFs(files))).toBe('/work/side')
  })

  test('the identity comes back NFC', () => {
    const files = {
      '/work/side/.git': 'gitdir: /cafe\u0301/.git/worktrees/side\n',
      '/cafe\u0301/.git/worktrees/side/commondir': '../..\n',
      '/cafe\u0301/.git/worktrees/side/gitdir': '/work/side/.git\n',
    }
    expect(canonicalRootOf('/work/side', fakeFs(files))).toBe('/caf\u00e9')
  })
})
