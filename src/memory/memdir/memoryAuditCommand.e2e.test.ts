// `claudin memory audit` as a CI step runs it: the built bundle, in a fresh
// checkout, with no config home. Two things a unit test cannot see: an entry
// the audit cannot read must fail the step rather than hang it, and nothing
// the repository itself carries may switch the gate off. Needs `bun run
// build`; skipped without dist/cli.mjs.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CLI = join(import.meta.dir, '..', '..', '..', 'dist', 'cli.mjs')
const TOKEN = ['ghp', 'x'.repeat(36)].join('_')
const MEMORY = `---\nname: x\ndescription: x\ntype: project\n---\n\n`

let root: string | null = null
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

/** A git checkout with a team dir, and an empty HOME, as a CI runner has. */
function checkout(): { repo: string; team: string; home: string } {
  root = mkdtempSync(join(tmpdir(), 'memory-audit-e2e-'))
  const repo = join(root, 'repo')
  const team = join(repo, '.claudin', 'memory', 'team')
  mkdirSync(join(team, 'bugs'), { recursive: true })
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(root, 'home'))
  return { repo, team, home: join(root, 'home') }
}

function audit(repo: string, home: string) {
  return spawnSync('node', [CLI, 'memory', 'audit'], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? '', HOME: home },
    encoding: 'utf8',
    timeout: 15_000,
  })
}

describe.skipIf(!existsSync(CLI))('claudin memory audit, as a CI step', () => {
  test('an entry it cannot read is skipped, and the step ends', () => {
    const { repo, team, home } = checkout()
    mkdirSync(join(team, 'odd.md'))
    symlinkSync(join(team, 'nowhere.md'), join(team, 'bugs', 'gone.md'))
    writeFileSync(join(team, 'bugs', 'real.md'), `${MEMORY}clean\n`)
    writeFileSync(join(team, 'MEMORY.md'), '- [Real](bugs/real.md) — clean\n')
    const result = audit(repo, home)
    expect([result.signal, result.status]).toEqual([null, 0])
    expect(result.stdout).toContain('no findings')
  }, 30_000)

  test('a settings file in the repo cannot turn the gate off', () => {
    const { repo, team, home } = checkout()
    writeFileSync(join(team, 'bugs', 'x.md'), `${MEMORY}token: ${TOKEN}\n`)
    writeFileSync(join(repo, '.claudin', 'settings.json'), '{"autoMemoryEnabled": false}\n')
    const result = audit(repo, home)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('.claudin/memory/team/bugs/x.md: secret-shaped content (GitHub PAT)')
  }, 30_000)
})
