/**
 * The write guard for the team memory directory, as the file tools call it:
 * a target path and the content about to land there, answered with a refusal
 * message or null.
 *
 * The guard only acts in a build with the TEAMMEM flag, which the shipped
 * build turns on (`scripts/build/build.ts`) and plain `bun test` leaves off.
 * So this file has two lives. Under the plain runner it checks the flag-off
 * answer, then runs itself again in a child `bun test --feature=TEAMMEM`, and
 * fails if the child does. In that child the shipped behaviour is checked.
 */
import { feature } from 'bun:bundle'
import { describe, expect, test } from 'bun:test'
import { join, resolve, sep } from 'node:path'

import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { checkTeamMemSecrets } from 'src/memory/memdir/teamMemSecretGuard.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'

const world = useMemdirWorld()

// Credential-shaped values, glued at run time (see the scanner suite).
const cycle = (alphabet: string, n: number): string =>
  Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('')
const AWS_KEY = ['AK', 'IA', cycle('ZXCVBNMASDFG2345', 16)].join('')
const GITHUB_PAT = ['gh', 'p_', cycle('m3Nb5Vc7Xz9Lk', 36)].join('')
const SLACK_BOT = ['xo', 'xb-', cycle('5647382910', 11), '-', cycle('0192837465', 12), '-', cycle('aZ9', 24)].join('')

const note = (secret: string): string =>
  ['---', 'name: deploy-access', 'description: how CI reaches staging', 'type: project', '---', '', `Use ${secret} for staging.`, ''].join('\n')

const CLEAN_NOTE = note('the token from the vault')

const inTeam = (...segments: string[]): string => join(getTeamMemPath(), ...segments)
const inPrivate = (...segments: string[]): string => join(getAutoMemPath(), ...segments)

// `feature()` must sit directly in a ternary condition under `bun test`.
const TEAM_BUILD = feature('TEAMMEM') ? true : false

if (!TEAM_BUILD) {
  test('without the team build flag, nothing is refused', () => {
    for (const path of [inTeam('deploy.md'), inTeam('bugs', 'x.md'), inPrivate('x.md')]) {
      expect(checkTeamMemSecrets(path, note(GITHUB_PAT))).toBeNull()
      expect(checkTeamMemSecrets(path, CLEAN_NOTE)).toBeNull()
    }
  })

  test('with the team build flag, the guard holds', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--feature=TEAMMEM', import.meta.path],
      {
        cwd: resolve(import.meta.dir, '..', '..', '..'),
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const report = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '-1')
    if (code !== 0 || failed !== 0 || passed < 8) {
      throw new Error(`the TEAMMEM run failed (exit ${code}):\n${report.slice(-6_000)}`)
    }
  }, 120_000)
} else {
  describe('a write into team memory that carries a credential is refused', () => {
    const targets: Array<[string, () => string]> = [
      ['a note at the team root', () => inTeam('deploy.md')],
      ['a note in a category directory', () => inTeam('decisions', 'ci-tokens.md')],
      ['the team index', () => inTeam('MEMORY.md')],
      ['a path that climbs back into team', () => `${inPrivate('elsewhere')}${sep}..${sep}team${sep}x.md`],
      ['a file of any extension', () => inTeam('notes.txt')],
    ]
    test.each(targets)('%s', (_what, target) => {
      const refusal = checkTeamMemSecrets(target(), note(GITHUB_PAT))
      expect(refusal).not.toBeNull()
      expect(refusal).toContain('(GitHub PAT)')
    })
  })

  test('the refusal names every family found, says why, and never repeats the value', () => {
    const content = `${note(SLACK_BOT)}\nAlso ${GITHUB_PAT} and ${AWS_KEY}, and ${GITHUB_PAT} again.\n`
    const refusal = checkTeamMemSecrets(inTeam('deploy.md'), content)!
    // Families appear once each, in the scanner's family order.
    expect(refusal).toContain('(AWS Access Token, GitHub PAT, Slack Bot Token)')
    expect(refusal).toMatch(/potential secrets/)
    expect(refusal).toMatch(/team memory/)
    expect(refusal).toMatch(/shared with all repository collaborators/)
    expect(refusal).toMatch(/Remove the sensitive content/)
    for (const value of [AWS_KEY, GITHUB_PAT, SLACK_BOT]) {
      expect(refusal).not.toContain(value)
    }
  })

  test('the refusal is one stable message for the same families', () => {
    const a = checkTeamMemSecrets(inTeam('a.md'), `x ${AWS_KEY}`)
    const b = checkTeamMemSecrets(inTeam('bugs', 'b.md'), `y\n${['AS', 'IA', cycle('QWERTY234567', 16)].join('')}\n`)
    expect(a).toBe(b)
    expect(a!.startsWith('Content contains potential secrets (AWS Access Token)')).toBe(true)
  })

  describe('everything else is let through', () => {
    const cases: Array<[string, () => string, string]> = [
      ['clean content in team memory', () => inTeam('deploy.md'), CLEAN_NOTE],
      ['empty content in team memory', () => inTeam('deploy.md'), ''],
      ['a credential in private memory', () => inPrivate('deploy.md'), note(GITHUB_PAT)],
      ['a credential in a sibling of team', () => inPrivate('team-old', 'x.md'), note(GITHUB_PAT)],
      ['a credential that climbs out of team', () => `${inTeam('bugs')}${sep}..${sep}..${sep}x.md`, note(AWS_KEY)],
      ['a credential in the project', () => join(world().project, 'config.md'), note(AWS_KEY)],
      ['a relative path', () => join('team', 'x.md'), note(AWS_KEY)],
    ]
    test.each(cases)('%s', (_what, target, content) => {
      expect(checkTeamMemSecrets(target(), content)).toBeNull()
    })
  })

  test('the guard holds even with auto memory switched off', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    world().refresh()
    expect(checkTeamMemSecrets(inTeam('deploy.md'), note(AWS_KEY))).toContain('(AWS Access Token)')
  })

  test('the team directory follows the session project', () => {
    const other = world().mkdir('other-project')
    const before = inTeam('deploy.md')
    world().enter(other)
    expect(inTeam('deploy.md')).not.toBe(before)
    expect(checkTeamMemSecrets(before, note(AWS_KEY))).toBeNull()
    expect(checkTeamMemSecrets(inTeam('deploy.md'), note(AWS_KEY))).not.toBeNull()
  })
}
