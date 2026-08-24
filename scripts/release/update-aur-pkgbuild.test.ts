import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  PKGBUILD_PATH,
  parseArgs,
  parseSha256Sums,
  pickArchChecksums,
  updatePkgbuild,
} from './update-aur-pkgbuild'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)

const SUMS_FIXTURE = `${HASH_A}  claudin-v1.2.3-darwin-arm64.tar.gz
${HASH_B}  claudin-v1.2.3-linux-arm64-musl.tar.gz
${HASH_C}  claudin-v1.2.3-linux-arm64.tar.gz
${HASH_D}  claudin-v1.2.3-linux-x64.tar.gz
`

describe('parseSha256Sums', () => {
  test('maps every asset to its hash', () => {
    const sums = parseSha256Sums(SUMS_FIXTURE)
    expect(sums.get('claudin-v1.2.3-linux-x64.tar.gz')).toBe(HASH_D)
    expect(sums.size).toBe(4)
  })

  test('tolerates the binary-mode marker and ignores junk lines', () => {
    const sums = parseSha256Sums(`${HASH_A} *claudin-v1.2.3-linux-x64.tar.gz\nnot a checksum line\n`)
    expect(sums.get('claudin-v1.2.3-linux-x64.tar.gz')).toBe(HASH_A)
    expect(sums.size).toBe(1)
  })
})

describe('pickArchChecksums', () => {
  test('picks the glibc assets, never the musl ones', () => {
    const picked = pickArchChecksums(parseSha256Sums(SUMS_FIXTURE), '1.2.3')
    expect(picked).toEqual({ x86_64: HASH_D, aarch64: HASH_C })
  })

  test('throws when the release is missing an arch', () => {
    const partial = parseSha256Sums(`${HASH_D}  claudin-v1.2.3-linux-x64.tar.gz\n`)
    expect(() => pickArchChecksums(partial, '1.2.3')).toThrow(
      /claudin-v1\.2\.3-linux-arm64\.tar\.gz is not in SHA256SUMS/,
    )
  })

  test('throws when the version does not match the assets', () => {
    expect(() => pickArchChecksums(parseSha256Sums(SUMS_FIXTURE), '1.2.4')).toThrow(
      /is not in SHA256SUMS/,
    )
  })
})

describe('updatePkgbuild', () => {
  const sums = {
    wrapper: HASH_A,
    license: HASH_B,
    x86_64: HASH_D,
    aarch64: HASH_C,
  }

  test('rewrites every version and checksum field of the real PKGBUILD', () => {
    const out = updatePkgbuild(
      readFileSync(PKGBUILD_PATH, 'utf-8'),
      '1.2.3',
      sums,
    )
    expect(out).toContain('pkgver=1.2.3')
    expect(out).toContain('pkgrel=1')
    expect(out).toContain(`sha256sums=('${HASH_A}'\n            '${HASH_B}')`)
    expect(out).toContain(`sha256sums_x86_64=('${HASH_D}')`)
    expect(out).toContain(`sha256sums_aarch64=('${HASH_C}')`)
    // No checksum of the previous release survives anywhere.
    expect(out).not.toMatch(/24fb5f3e|e2e6e7e4/)
  })

  test('leaves the arch-independent array alone when rewriting the x86_64 one', () => {
    const out = updatePkgbuild(
      readFileSync(PKGBUILD_PATH, 'utf-8'),
      '1.2.3',
      sums,
    )
    // sha256sums=(…) and sha256sums_x86_64=(…) must not collapse into each other.
    expect(out.match(/^sha256sums=\(/m)).not.toBeNull()
    expect(out.match(/^sha256sums_x86_64=\(/m)).not.toBeNull()
    expect(out.match(/^sha256sums_aarch64=\(/m)).not.toBeNull()
  })

  test('takes an explicit pkgrel for a PKGBUILD-only push', () => {
    const out = updatePkgbuild(readFileSync(PKGBUILD_PATH, 'utf-8'), '1.2.3', sums, 2)
    expect(out).toContain('pkgrel=2')
  })

  test('throws instead of silently skipping a field it cannot find', () => {
    expect(() => updatePkgbuild('pkgname=claudin-bin\n', '1.2.3', sums)).toThrow(
      /no pkgver to rewrite/,
    )
  })
})

describe('parseArgs', () => {
  test('defaults to no version and pkgrel 1', () => {
    expect(parseArgs([])).toEqual({ version: null, pkgrel: 1 })
  })

  test('reads a positional version', () => {
    expect(parseArgs(['1.2.3'])).toEqual({ version: '1.2.3', pkgrel: 1 })
  })

  test('does not mistake the --pkgrel value for the version', () => {
    expect(parseArgs(['--pkgrel', '3'])).toEqual({ version: null, pkgrel: 3 })
    expect(parseArgs(['--pkgrel', '3', '1.2.3'])).toEqual({
      version: '1.2.3',
      pkgrel: 3,
    })
    expect(parseArgs(['1.2.3', '--pkgrel', '3'])).toEqual({
      version: '1.2.3',
      pkgrel: 3,
    })
  })

  test('rejects a pkgrel that is not a positive integer', () => {
    expect(() => parseArgs(['--pkgrel', '0'])).toThrow(/positive integer/)
    expect(() => parseArgs(['--pkgrel', 'next'])).toThrow(/positive integer/)
  })
})
