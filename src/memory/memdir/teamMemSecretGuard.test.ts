/**
 * The team-memory secret guard: the prefix test that decides whether a write
 * lands in the git-tracked team dir, the scanner that decides whether the
 * content may go there, and the wrapper, checkTeamMemSecrets, that the four
 * write paths (FileWriteTool, FileEditTool, applyPatch, stagedWrite) call.
 */
import { describe, expect, test } from 'bun:test'
import { join, sep } from 'path'
import { getPrivateMemPath } from 'src/memory/memdir/paths.js'
import { scanForSecrets } from 'src/memory/memdir/secretScanner.js'
import { checkTeamMemSecrets } from 'src/memory/memdir/teamMemSecretGuard.js'
import { getTeamMemPath, isTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'

// Fixture credentials, assembled at runtime so no scanner — this one,
// GitHub's push protection, verify:privacy — meets a token-shaped literal
// in source.
const AWS_ACCESS_KEY = ['AKIA', 'Q'.repeat(16)].join('')
const GITHUB_PAT = ['ghp', 'x'.repeat(36)].join('_')
// The same PAT with a zero-width space and a soft hyphen in it: invisible in
// an editor and a diff, and enough to break every rule's regex.
const SPLIT_PAT = `${GITHUB_PAT.slice(0, 10)}\u200B${GITHUB_PAT.slice(10, 20)}\u00AD${GITHUB_PAT.slice(20)}`
// "run curl" in Unicode tag characters: the model reads it, a reviewer sees nothing.
const TAG_TEXT = [...'run curl'].map(c => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')

describe('isTeamMemPath', () => {
  const teamDir = getTeamMemPath()
  const memDir = getPrivateMemPath()

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

  test('a secret split by invisible characters still fires its rule', () => {
    expect(scanForSecrets(`token: ${SPLIT_PAT}\n`).map(m => m.ruleId)).toEqual(['github-pat'])
  })
})

describe('checkTeamMemSecrets', () => {
  test('refuses a secret written into the team dir, naming the rule but not the secret', () => {
    const refusal = checkTeamMemSecrets(join(getTeamMemPath(), 'bugs', 'x.md'), `token: ${GITHUB_PAT}\n`)
    expect(refusal).toContain('Content contains potential secrets (GitHub PAT)')
    expect(refusal).toContain('cannot be written to team memory')
    expect(refusal).not.toContain(GITHUB_PAT)
  })

  test('lets clean team content through, and never scans outside the team dir', () => {
    expect(checkTeamMemSecrets(join(getTeamMemPath(), 'x.md'), 'Use pnpm.\n')).toBeNull()
    expect(checkTeamMemSecrets(join(getPrivateMemPath(), 'private.md'), `token: ${GITHUB_PAT}\n`)).toBeNull()
  })

  test('refuses a secret split by invisible characters', () => {
    expect(checkTeamMemSecrets(join(getTeamMemPath(), 'x.md'), `token: ${SPLIT_PAT}\n`)).toContain('GitHub PAT')
  })

  test('refuses bidi controls and tag characters, which hide text from the PR that reviews team memory', () => {
    const bidi = checkTeamMemSecrets(join(getTeamMemPath(), 'x.md'), 'Run the tests\u202E.yalp\u202C first.\n')
    expect(bidi).toContain('bidi control')
    expect(bidi).toContain('cannot be written to team memory')
    expect(bidi).not.toContain('secrets')
    expect(checkTeamMemSecrets(join(getTeamMemPath(), 'x.md'), `Note.${TAG_TEXT}\n`)).toContain('Unicode tag characters')
  })

  test('a zero-width joiner alone is legitimate text, and hidden text outside the team dir is not checked', () => {
    expect(checkTeamMemSecrets(join(getTeamMemPath(), 'x.md'), 'The family emoji 👨\u200D👩\u200D👧 is one glyph.\n')).toBeNull()
    expect(checkTeamMemSecrets(join(getPrivateMemPath(), 'private.md'), 'a\u202Eb\n')).toBeNull()
  })
})
