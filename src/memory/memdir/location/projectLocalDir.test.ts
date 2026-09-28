import { describe, expect, test } from 'bun:test'
import {
  adoptProjectLocalDir,
  type ProjectLocalDeps,
  type ProjectLocalFs,
} from 'src/memory/memdir/location/projectLocalDir.js'

const CANDIDATE = {
  dir: '/repo/.claudin/memory/',
  repoRoot: '/repo',
  legacyDir: '/home/ann/.claudin/projects/-repo/memory/',
}

type Calls = { made: string[]; modes: string[]; copies: string[] }

const TRAILING_SLASH_RE = /\/$/

function makeDeps(fs: Partial<ProjectLocalFs> = {}): {
  deps: ProjectLocalDeps
  calls: Calls
} {
  const calls: Calls = { made: [], modes: [], copies: [] }
  const deps: ProjectLocalDeps = {
    fs: {
      makeDir: dir => {
        calls.made.push(dir)
      },
      realPath: path => path.replace(TRAILING_SLASH_RE, ''),
      setMode: path => {
        calls.modes.push(path)
      },
      ...fs,
    },
    copyLegacyMemory: (from, to) => {
      calls.copies.push(`${from} -> ${to}`)
    },
    copiedRoots: new Set(),
  }
  return { deps, calls }
}

describe('adoptProjectLocalDir', () => {
  test('creates, tightens and offers the legacy copy once per project root', () => {
    const { deps, calls } = makeDeps()
    expect(adoptProjectLocalDir(CANDIDATE, '/repo/packages/app', deps)).toBe(true)
    expect(adoptProjectLocalDir(CANDIDATE, '/repo/packages/app', deps)).toBe(true)
    expect(adoptProjectLocalDir(CANDIDATE, '/repo', deps)).toBe(true)
    expect(calls.made).toHaveLength(3)
    expect(calls.modes).toHaveLength(3)
    expect(calls.copies).toEqual([
      `${CANDIDATE.legacyDir} -> ${CANDIDATE.dir}`,
      `${CANDIDATE.legacyDir} -> ${CANDIDATE.dir}`,
    ])
  })

  test('a directory resolving outside the repository is refused, untouched', () => {
    const { deps, calls } = makeDeps({
      realPath: path => (path === CANDIDATE.repoRoot ? '/repo' : '/home/ann/.ssh/memory'),
    })
    expect(adoptProjectLocalDir(CANDIDATE, '/repo', deps)).toBe(false)
    expect(calls.modes).toEqual([])
    expect(calls.copies).toEqual([])
  })

  test('the repository root itself does not count as inside it', () => {
    const { deps } = makeDeps({ realPath: () => '/repo' })
    expect(adoptProjectLocalDir(CANDIDATE, '/repo', deps)).toBe(false)
  })

  test('a directory that cannot be created is refused', () => {
    const { deps } = makeDeps({
      makeDir: () => {
        throw new Error('EROFS: read-only file system')
      },
    })
    expect(adoptProjectLocalDir(CANDIDATE, '/repo', deps)).toBe(false)
  })

  test('failing to tighten the mode or to copy does not refuse the directory', () => {
    const { deps } = makeDeps({
      setMode: () => {
        throw new Error('EPERM')
      },
    })
    const failingCopy: ProjectLocalDeps = {
      ...deps,
      copyLegacyMemory: () => {
        throw new Error('copy failed')
      },
    }
    expect(adoptProjectLocalDir(CANDIDATE, '/repo', failingCopy)).toBe(true)
  })
})
