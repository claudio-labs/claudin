import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getLauncherPath } from './bundledMode.js'

const originalArgv1 = process.argv[1]
const originalExecPath = process.execPath

afterEach(() => {
  process.argv[1] = originalArgv1 as string
  process.execPath = originalExecPath
})

test('getLauncherPath returns argv[1] for a normal script launch', () => {
  process.argv[1] = '/usr/local/lib/node_modules/@claudiolabs/claudin/cli.mjs'

  expect(getLauncherPath()).toBe(
    '/usr/local/lib/node_modules/@claudiolabs/claudin/cli.mjs',
  )
})

test('getLauncherPath falls back to execPath for the bun VFS path', () => {
  // A bun-compiled binary reports the in-binary VFS path in argv[1]. Taking it
  // at face value is what classified every native install as `unknown`.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'launcher-'))
  const binary = join(dir, 'claudin.exe')
  writeFileSync(binary, '')

  process.argv[1] = '/$bunfs/root/claudin'
  process.execPath = binary

  expect(getLauncherPath()).toBe(binary)
})

test('getLauncherPath resolves an execPath symlink to the package location', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'launcher-'))
  const binary = join(dir, 'claudin.exe')
  writeFileSync(binary, '')
  const link = join(dir, 'claudin-link')
  symlinkSync(binary, link)

  process.argv[1] = '/$bunfs/root/claudin'
  process.execPath = link

  expect(getLauncherPath()).toBe(binary)
})

test('getLauncherPath treats the Windows bun VFS path as a VFS path', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'launcher-'))
  const binary = join(dir, 'claudin.exe')
  writeFileSync(binary, '')

  process.argv[1] = 'B:\\~BUN\\root\\claudin'
  process.execPath = binary

  expect(getLauncherPath()).toBe(binary)
})

test('getLauncherPath returns the unresolved execPath when it cannot be resolved', () => {
  process.argv[1] = '/$bunfs/root/claudin'
  process.execPath = '/nonexistent/claudin.exe'

  expect(getLauncherPath()).toBe('/nonexistent/claudin.exe')
})
