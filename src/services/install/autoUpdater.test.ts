import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getLatestVersionFromGcs,
  getGcsDistTags,
  getMaxVersion,
  getMaxVersionMessage,
  assertMinVersion,
  repairBunGlobalBinary,
} from 'src/services/install/autoUpdater.js'

describe('autoUpdater — neutralized GCS + kill-switch', () => {
  test('getLatestVersionFromGcs returns null (GCS path neutralized)', async () => {
    const result = await getLatestVersionFromGcs('stable')
    expect(result).toBeNull()
  })

  test('getGcsDistTags returns empty tags (GCS path neutralized)', async () => {
    const result = await getGcsDistTags()
    expect(result).toEqual({ latest: null, stable: null })
  })

  test('getMaxVersion returns undefined (kill-switch neutralized)', async () => {
    expect(await getMaxVersion()).toBeUndefined()
  })

  test('getMaxVersionMessage returns undefined', async () => {
    expect(await getMaxVersionMessage()).toBeUndefined()
  })

  test('assertMinVersion is a no-op (does not throw)', async () => {
    await expect(assertMinVersion()).resolves.toBeUndefined()
  })
})

describe('repairBunGlobalBinary — Bun skipped-postinstall self-heal', () => {
  const PACKAGE_URL = '@claudiolabs/claudin'
  // install.cjs writes this marker so tests can assert whether it actually ran.
  const RAN_MARKER = 'POSTINSTALL_RAN'
  // A fake postinstall that mirrors the real one's effect: hardlink/copy the
  // native binary over the stub. Here it just writes a >4096-byte file and a
  // marker, so we can assert the repair invoked it.
  const FAKE_INSTALL_CJS = `const fs = require('fs')
const path = require('path')
const bin = path.join(__dirname, 'bin', 'claudin.exe')
fs.mkdirSync(path.dirname(bin), { recursive: true })
fs.writeFileSync(bin, Buffer.alloc(8192))
fs.writeFileSync(path.join(__dirname, '${RAN_MARKER}'), 'ok')
`

  let prevMacro: unknown
  let prevBunInstall: string | undefined
  let root: string

  beforeAll(() => {
    prevMacro = (globalThis as { MACRO?: unknown }).MACRO
    ;(globalThis as { MACRO?: unknown }).MACRO = {
      ...(typeof prevMacro === 'object' && prevMacro ? prevMacro : {}),
      PACKAGE_URL,
    }
  })

  afterAll(() => {
    ;(globalThis as { MACRO?: unknown }).MACRO = prevMacro
  })

  // Each test builds its own BUN_INSTALL root so the package dir resolves to
  // <root>/install/global/node_modules/@claudiolabs/claudin.
  async function makePkgDir(): Promise<string> {
    const pkgDir = join(
      root,
      'install',
      'global',
      'node_modules',
      PACKAGE_URL,
    )
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    prevBunInstall = process.env.BUN_INSTALL
    process.env.BUN_INSTALL = root
    return pkgDir
  }

  async function fileSize(p: string): Promise<number> {
    return (await stat(p)).size
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await stat(p)
      return true
    } catch {
      return false
    }
  }

  afterEach(async () => {
    if (prevBunInstall === undefined) delete process.env.BUN_INSTALL
    else process.env.BUN_INSTALL = prevBunInstall
    if (root) await rm(root, { recursive: true, force: true })
  })

  test('runs the skipped postinstall when the launcher is still a stub', async () => {
    root = await mkdtemp(join(tmpdir(), 'claudin-repair-'))
    const pkgDir = await makePkgDir()
    await writeFile(join(pkgDir, 'install.cjs'), FAKE_INSTALL_CJS)
    // 605-byte stub, like the shipped Node placeholder.
    await writeFile(join(pkgDir, 'bin', 'claudin.exe'), Buffer.alloc(605))

    const repaired = await repairBunGlobalBinary()

    expect(repaired).toBe(true)
    expect(await exists(join(pkgDir, RAN_MARKER))).toBe(true)
    expect(await fileSize(join(pkgDir, 'bin', 'claudin.exe'))).toBeGreaterThan(
      4096,
    )
  })

  test('recreates the launcher when it is missing entirely', async () => {
    root = await mkdtemp(join(tmpdir(), 'claudin-repair-'))
    const pkgDir = await makePkgDir()
    await writeFile(join(pkgDir, 'install.cjs'), FAKE_INSTALL_CJS)
    // No bin/claudin.exe at all — postinstall should still be run.

    const repaired = await repairBunGlobalBinary()

    expect(repaired).toBe(true)
    expect(await exists(join(pkgDir, RAN_MARKER))).toBe(true)
  })

  test('no-ops (does not run postinstall) when the native binary is already in place', async () => {
    root = await mkdtemp(join(tmpdir(), 'claudin-repair-'))
    const pkgDir = await makePkgDir()
    await writeFile(join(pkgDir, 'install.cjs'), FAKE_INSTALL_CJS)
    // Already the native binary (large) — postinstall must not re-run.
    await writeFile(join(pkgDir, 'bin', 'claudin.exe'), Buffer.alloc(200_000))

    const repaired = await repairBunGlobalBinary()

    expect(repaired).toBe(false)
    expect(await exists(join(pkgDir, RAN_MARKER))).toBe(false)
  })

  test('no-ops for an npm-style install (no install.cjs at the Bun global path)', async () => {
    root = await mkdtemp(join(tmpdir(), 'claudin-repair-'))
    // Point BUN_INSTALL at a root with no wrapper package at all.
    prevBunInstall = process.env.BUN_INSTALL
    process.env.BUN_INSTALL = root

    const repaired = await repairBunGlobalBinary()

    expect(repaired).toBe(false)
  })
})
