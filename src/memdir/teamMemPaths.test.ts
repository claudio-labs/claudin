import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isTeamMemLikelyGitIgnored } from 'src/memdir/teamMemPaths.js'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'claudin-team-gitignore-'))
}

describe('isTeamMemLikelyGitIgnored', () => {
  test('detects a blanket `/.claudin` ignore line', () => {
    const dir = freshDir()
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n/.claudin\ndist/\n')

    expect(isTeamMemLikelyGitIgnored(dir)).toBe(true)
  })

  test('detects a blanket `.claudin/` ignore line (no leading slash)', () => {
    const dir = freshDir()
    writeFileSync(join(dir, '.gitignore'), '.claudin/\n')

    expect(isTeamMemLikelyGitIgnored(dir)).toBe(true)
  })

  test('returns false when the team dir is already carved out with a negation', () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, '.gitignore'),
      ['/.claudin/*', '!/.claudin/memory/', '/.claudin/memory/*', '!/.claudin/memory/team/', ''].join(
        '\n',
      ),
    )

    expect(isTeamMemLikelyGitIgnored(dir)).toBe(false)
  })

  test('returns false when there is no blanket ignore at all', () => {
    const dir = freshDir()
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n')

    expect(isTeamMemLikelyGitIgnored(dir)).toBe(false)
  })

  test('fails open (false) when there is no .gitignore file', () => {
    const dir = freshDir()

    expect(isTeamMemLikelyGitIgnored(dir)).toBe(false)
  })

  test('ignores comments and blank lines', () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, '.gitignore'),
      ['# comment', '', '  ', '/.claudin', ''].join('\n'),
    )

    expect(isTeamMemLikelyGitIgnored(dir)).toBe(true)
  })
})
