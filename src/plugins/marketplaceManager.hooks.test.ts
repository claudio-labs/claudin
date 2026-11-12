import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { gitClone } from 'src/plugins/marketplaceManager.js'

// A marketplace clone must never run the user's git hooks: a global
// core.hooksPath with a post-checkout that installs dependencies would run
// the marketplace's own code. Clone and pull pass core.hooksPath=/dev/null;
// the sparse path's follow-up `checkout HEAD` did not.
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const
const savedEnv: Record<string, string | undefined> = {}
let root = ''

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, stdio: 'ignore' },
  )
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  root = mkdtempSync(join(tmpdir(), 'marketplace-hooks-'))

  const source = join(root, 'source')
  mkdirSync(join(source, 'plugins', 'a'), { recursive: true })
  mkdirSync(join(source, 'plugins', 'b'), { recursive: true })
  writeFileSync(join(source, 'plugins', 'a', 'x.txt'), 'x')
  writeFileSync(join(source, 'plugins', 'b', 'y.txt'), 'y')
  git(source, 'init', '-q')
  git(source, 'add', '-A')
  git(source, 'commit', '-qm', 'init')

  const hooks = join(root, 'hooks')
  mkdirSync(hooks)
  writeFileSync(
    join(hooks, 'post-checkout'),
    `#!/bin/sh\necho ran >> "${join(root, 'marker')}"\n`,
  )
  chmodSync(join(hooks, 'post-checkout'), 0o755)

  writeFileSync(join(root, 'gitconfig'), `[core]\n\thooksPath = ${hooks}\n`)
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(root, { recursive: true, force: true })
})

describe('marketplace git calls ignore the user hooks', () => {
  test('a sparse clone runs no post-checkout hook', async () => {
    const target = join(root, 'clone')
    const result = await gitClone(`file://${join(root, 'source')}`, target, undefined, [
      'plugins/a',
    ])

    expect(result.code).toBe(0)
    expect(existsSync(join(target, 'plugins', 'a', 'x.txt'))).toBe(true)
    expect(existsSync(join(root, 'marker'))).toBe(false)
  })

  // `sparse-checkout set` runs no hook in today's git, so no behavior can tell
  // whether it passes the flag; what keeps the next call from forgetting it is
  // that none of them starts its argument list with a bare subcommand.
  test('every git call opens with config flags, not a bare subcommand', () => {
    const source = readFileSync(
      join(import.meta.dir, 'marketplaceManager.ts'),
      'utf8',
    )
    expect(source.match(/gitExe\(\),\s*\[\s*'[a-z-]+'/g) ?? []).toEqual([])
  })
})
