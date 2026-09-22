/**
 * The two pure halves of the team-memory secret guard: the prefix test that
 * decides whether a write lands in the git-tracked team dir, and the scanner
 * that decides whether the content may go there.
 *
 * The wrapper, checkTeamMemSecrets, is a `feature('TEAMMEM')` fold: under
 * `bun test` it returns null whatever the input, so it is deliberately not
 * asserted on — a test that stays green with the guard deleted is false
 * coverage (testing.md). The four call sites (FileWriteTool, FileEditTool,
 * applyPatch, stagedWrite) are reachable in the bundle only.
 */
import { describe, expect, test } from 'bun:test'
import { join, sep } from 'path'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { scanForSecrets } from 'src/memory/memdir/secretScanner.js'
import { getTeamMemPath, isTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'

// Fixture credentials, assembled at runtime so no scanner — this one,
// GitHub's push protection, verify:privacy — meets a token-shaped literal
// in source.
const AWS_ACCESS_KEY = ['AKIA', 'Q'.repeat(16)].join('')
const GITHUB_PAT = ['ghp', 'x'.repeat(36)].join('_')

describe('isTeamMemPath', () => {
  const teamDir = getTeamMemPath()
  const memDir = getAutoMemPath()

  test('the team root and its category subdirectories are in', () => {
    expect(isTeamMemPath(join(teamDir, 'MEMORY.md'))).toBe(true)
    expect(isTeamMemPath(join(teamDir, 'convention.md'))).toBe(true)
    expect(isTeamMemPath(join(teamDir, 'bugs', 'x.md'))).toBe(true)
    expect(isTeamMemPath(join(teamDir, 'decisions', 'x.md'))).toBe(true)
    expect(isTeamMemPath(join(teamDir, 'docs', 'x.md'))).toBe(true)
  })

  test('the private root and a sibling sharing the prefix are out', () => {
    // The trailing separator on getTeamMemPath() is what keeps `team-old/`
    // and `teamwork.md` from matching `team/`.
    expect(teamDir.endsWith(sep)).toBe(true)
    expect(isTeamMemPath(join(memDir, 'private.md'))).toBe(false)
    expect(isTeamMemPath(join(memDir, 'team-old', 'x.md'))).toBe(false)
    expect(isTeamMemPath(join(memDir, 'teamwork.md'))).toBe(false)
  })

  test('a traversal is resolved before the prefix test', () => {
    expect(isTeamMemPath(`${teamDir}bugs/../../private.md`)).toBe(false)
    expect(isTeamMemPath(`${teamDir}../team/bugs/x.md`)).toBe(true)
  })

  test('a relative path is resolved against the cwd, never the team dir', () => {
    expect(isTeamMemPath('team/bugs/x.md')).toBe(false)
  })
})

describe('scanForSecrets', () => {
  test('a cloud key and a GitHub PAT each fire their rule, with a readable label', () => {
    const matches = scanForSecrets(`key=${AWS_ACCESS_KEY}\ntoken: ${GITHUB_PAT}\n`)
    expect(matches.map(m => m.ruleId).sort()).toEqual([
      'aws-access-token',
      'github-pat',
    ])
    expect(matches.map(m => m.label).sort()).toEqual([
      'AWS Access Token',
      'GitHub PAT',
    ])
  })

  test('a match never carries the secret itself', () => {
    // The labels end up in an error message the model reads back.
    const matches = scanForSecrets(GITHUB_PAT)
    expect(matches).toHaveLength(1)
    expect(JSON.stringify(matches)).not.toContain(GITHUB_PAT)
  })

  test('ordinary memory prose is clean', () => {
    expect(
      scanForSecrets(
        '**Symptom:** the sync required first-party OAuth. **Where:** src/memory/teamSync/. Rotate the key with `gh auth token`.',
      ),
    ).toEqual([])
  })
})
