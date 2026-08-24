#!/usr/bin/env bun
/**
 * Points packaging/aur/claudin-bin/PKGBUILD at a published release: rewrites
 * pkgver, pkgrel and every sha256 array from that release's SHA256SUMS.txt.
 *
 * Run by the `aur` job of .github/workflows/release-binaries.yml after the
 * binaries are attached, and by hand (`bun run release:aur`) before pushing a
 * PKGBUILD-only change to the AUR.
 *
 * The two arch-independent sources are hashed locally, not downloaded: the
 * wrapper lives in this repo, and the LICENSE the PKGBUILD fetches from the tag
 * is the LICENSE of the checkout the release was cut from.
 *
 * Usage:
 *   bun run scripts/release/update-aur-pkgbuild.ts [version] [--pkgrel N]
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../repoRoot'

export const PKGBUILD_PATH = join(
  REPO_ROOT,
  'packaging',
  'aur',
  'claudin-bin',
  'PKGBUILD',
)
const WRAPPER_PATH = join(REPO_ROOT, 'packaging', 'aur', 'claudin-bin', 'claudin.sh')
const LICENSE_PATH = join(REPO_ROOT, 'LICENSE')

const PKGVER_RE = /^pkgver=.*$/m
const PKGREL_RE = /^pkgrel=.*$/m
const SUMS_RE = /^sha256sums=\([^)]*\)/m
const SUMS_X86_RE = /^sha256sums_x86_64=\([^)]*\)/m
const SUMS_ARM_RE = /^sha256sums_aarch64=\([^)]*\)/m

/** The two release assets the PKGBUILD consumes, keyed by PKGBUILD array. */
export const ARCH_ASSETS = {
  x86_64: 'linux-x64',
  aarch64: 'linux-arm64',
} as const

export type Checksums = {
  wrapper: string
  license: string
  x86_64: string
  aarch64: string
}

/**
 * Parse the `<sha256>  <filename>` lines of a release's SHA256SUMS.txt.
 * Tolerates the ` *` binary marker some sha256sum implementations emit.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/)
    if (match) out.set(match[2]!, match[1]!)
  }
  return out
}

/**
 * Pull the two glibc Linux assets out of a parsed SHA256SUMS.txt. Throws
 * rather than writing a PKGBUILD that would fail `makepkg --verifysource`
 * hours later, on someone else's machine.
 */
export function pickArchChecksums(
  sums: Map<string, string>,
  version: string,
): Pick<Checksums, 'x86_64' | 'aarch64'> {
  const picked = {} as Pick<Checksums, 'x86_64' | 'aarch64'>
  for (const [arch, platform] of Object.entries(ARCH_ASSETS)) {
    const asset = `claudin-v${version}-${platform}.tar.gz`
    const hash = sums.get(asset)
    if (!hash) {
      throw new Error(
        `${asset} is not in SHA256SUMS.txt (found: ${[...sums.keys()].join(', ') || 'nothing'})`,
      )
    }
    picked[arch as keyof typeof ARCH_ASSETS] = hash
  }
  return picked
}

/**
 * Rewrite the version and checksum lines of a PKGBUILD. Every field it targets
 * must already be there — a silently-skipped substitution would publish the
 * previous release's checksums under the new version.
 */
export function updatePkgbuild(
  pkgbuild: string,
  version: string,
  sums: Checksums,
  pkgrel = 1,
): string {
  const edits: [RegExp, string, string][] = [
    [PKGVER_RE, `pkgver=${version}`, 'pkgver'],
    [PKGREL_RE, `pkgrel=${pkgrel}`, 'pkgrel'],
    [
      SUMS_RE,
      `sha256sums=('${sums.wrapper}'\n            '${sums.license}')`,
      'sha256sums',
    ],
    [SUMS_X86_RE, `sha256sums_x86_64=('${sums.x86_64}')`, 'sha256sums_x86_64'],
    [SUMS_ARM_RE, `sha256sums_aarch64=('${sums.aarch64}')`, 'sha256sums_aarch64'],
  ]

  let out = pkgbuild
  for (const [re, replacement, field] of edits) {
    if (!re.test(out)) throw new Error(`PKGBUILD has no ${field} to rewrite`)
    out = out.replace(re, replacement)
  }
  return out
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * `[version] [--pkgrel N]`, in any order. `version` defaults to the caller's
 * (package.json's, at the call site) and pkgrel to 1, which is what a version
 * bump wants — a PKGBUILD-only push to the AUR is the case that has to pass it.
 */
export function parseArgs(argv: string[]): {
  version: string | null
  pkgrel: number
} {
  const relIdx = argv.indexOf('--pkgrel')
  let pkgrel = 1
  if (relIdx !== -1) {
    pkgrel = Number(argv[relIdx + 1])
    if (!Number.isInteger(pkgrel) || pkgrel < 1) {
      throw new Error(`--pkgrel wants a positive integer, got ${argv[relIdx + 1]}`)
    }
  }
  const version =
    argv.find(
      (a, i) => !a.startsWith('--') && (relIdx === -1 || i !== relIdx + 1),
    ) ?? null
  return { version, pkgrel }
}

async function fetchReleaseSums(version: string): Promise<Map<string, string>> {
  const url = `https://github.com/claudio-labs/claudin/releases/download/v${version}/SHA256SUMS.txt`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  }
  return parseSha256Sums(await res.text())
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2))
  const { pkgrel } = parsed
  const version =
    parsed.version ??
    (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      version: string
    }).version

  const sums: Checksums = {
    wrapper: sha256File(WRAPPER_PATH),
    license: sha256File(LICENSE_PATH),
    ...pickArchChecksums(await fetchReleaseSums(version), version),
  }

  writeFileSync(
    PKGBUILD_PATH,
    updatePkgbuild(readFileSync(PKGBUILD_PATH, 'utf-8'), version, sums, pkgrel),
  )
  console.log(`✓ PKGBUILD → claudin-bin ${version}-${pkgrel}`)
}
