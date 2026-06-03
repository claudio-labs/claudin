import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInvokedFromSourceTree } from 'src/utils/sourceTreeDetect.js'

const PACKAGE_NAME = '@claudiolabs/claudin'

describe('isInvokedFromSourceTree', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'claudin-source-detect-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function makePkg(
    dir: string,
    opts: { name?: string; withGit?: boolean },
  ): Promise<string> {
    const pkgDir = join(root, dir)
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: opts.name ?? PACKAGE_NAME }),
    )
    if (opts.withGit) {
      await mkdir(join(pkgDir, '.git'), { recursive: true })
    }
    const binPath = join(pkgDir, 'bin', 'claudin')
    await writeFile(binPath, '#!/usr/bin/env node\n')
    return binPath
  }

  test('returns true for a dev tree (package.json + .git)', async () => {
    const binPath = await makePkg('dev', { withGit: true })
    expect(await isInvokedFromSourceTree(binPath, PACKAGE_NAME)).toBe(true)
  })

  test('returns false for a real install (package.json, no .git)', async () => {
    // Regression guard: `bun add -g` / `npm i -g` put a matching package.json
    // under <prefix>/node_modules/<pkg>/, but no .git. Misreading that as
    // "development" defeats the bun-global classifier later in the chain and
    // suppresses auto-update entirely.
    const binPath = await makePkg('global-install', { withGit: false })
    expect(await isInvokedFromSourceTree(binPath, PACKAGE_NAME)).toBe(false)
  })

  test('returns true when invoked via a symlink into a dev tree', async () => {
    const binPath = await makePkg('dev-linked', { withGit: true })
    const symlinkPath = join(root, 'claudin-link')
    await symlink(binPath, symlinkPath)
    expect(await isInvokedFromSourceTree(symlinkPath, PACKAGE_NAME)).toBe(true)
  })

  test('returns false for a package whose name does not match', async () => {
    const binPath = await makePkg('foreign', {
      name: '@someone/other-cli',
      withGit: true,
    })
    expect(await isInvokedFromSourceTree(binPath, PACKAGE_NAME)).toBe(false)
  })

  test('returns false when invokedPath is empty', async () => {
    expect(await isInvokedFromSourceTree('', PACKAGE_NAME)).toBe(false)
  })

  test('returns false when invokedPath does not exist', async () => {
    expect(
      await isInvokedFromSourceTree(
        join(root, 'nope', 'claudin'),
        PACKAGE_NAME,
      ),
    ).toBe(false)
  })
})
