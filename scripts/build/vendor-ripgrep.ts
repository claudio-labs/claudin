/**
 * Vendor the ripgrep binary beside a compiled Claudin binary.
 *
 * A Bun-compiled standalone binary can't resolve @vscode/ripgrep from
 * node_modules at runtime, so each per-platform package ships `rg` next to the
 * executable at vendor/ripgrep/<arch>-<platform>/rg[.exe] — the layout
 * src/shared/fs/ripgrep.ts probes via dirname(process.execPath).
 *
 * In the native release matrix this usually runs on each platform's own runner,
 * so the host's freshly-installed @vscode/ripgrep already holds the correct-
 * platform (and correct-libc, incl. musl) `rg`. We just copy it into the
 * platform's dist/bin/<platform>/ payload.
 *
 * Cross-compile (e.g. darwin-x64 built on an arm64 mac): the host's rg is the
 * wrong arch, so we fetch the target's @vscode/ripgrep-<platform>-<arch> tarball
 * via `npm pack` (pinned to the version @vscode/ripgrep already resolves) and
 * vendor that rg instead. The vendored dir key + rg name always follow the
 * TARGET, matching what src/shared/fs/ripgrep.ts probes at runtime.
 *
 * Usage: bun run scripts/build/vendor-ripgrep.ts            # host platform
 *        CLAUDIN_COMPILE_TARGET=bun-linux-x64 bun run scripts/build/vendor-ripgrep.ts
 */

import { execFileSync } from 'child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createRequire } from 'module'

import { REPO_ROOT } from '../repoRoot'

const require = createRequire(import.meta.url)

// Platform-package dir (matches build.ts: strip "bun-", windows→win32).
const target = process.env.CLAUDIN_COMPILE_TARGET || ''
const compilePlatform = target
  ? target.replace(/^bun-/, '').replace(/^windows-/, 'win32-')
  : `${process.platform}-${process.arch}`

// Resolve the TARGET's Node platform + arch (not the host's). The runtime probe
// in src/shared/fs/ripgrep.ts looks under vendor/ripgrep/<arch>-<platform>/, so both
// the dir key and the rg name must follow the target when cross-compiling.
function parseTarget(t: string): { platform: string; arch: string } {
  const body = t.replace(/^bun-/, '').replace(/-musl$/, '') // "<os>-<arch>"
  const m = body.match(/^(darwin|linux|windows)-(x64|arm64)$/)
  if (!m) return { platform: process.platform, arch: process.arch }
  return { platform: m[1] === 'windows' ? 'win32' : m[1], arch: m[2] }
}

const tgt = target ? parseTarget(target) : { platform: process.platform, arch: process.arch }
const rgDirKey = `${tgt.arch}-${tgt.platform}`
const rgName = tgt.platform === 'win32' ? 'rg.exe' : 'rg'
const isCross = tgt.platform !== process.platform || tgt.arch !== process.arch

// Locate the rg for the target: host's @vscode/ripgrep when native, else the
// target platform package fetched via `npm pack`.
function resolveRgPath(): string {
  if (!isCross) {
    const { rgPath } = require('@vscode/ripgrep') as { rgPath?: string }
    if (!rgPath || !existsSync(rgPath)) {
      console.error(
        `✗ @vscode/ripgrep rgPath not found (${rgPath}). Run \`bun install\` first.`,
      )
      process.exit(1)
    }
    return rgPath
  }

  const platPkg = `@vscode/ripgrep-${tgt.platform}-${tgt.arch}`
  const rgPkgRoot = dirname(dirname(require.resolve('@vscode/ripgrep')))
  const rgPkgJson = JSON.parse(
    readFileSync(join(rgPkgRoot, 'package.json'), 'utf8'),
  ) as { optionalDependencies?: Record<string, string> }
  const ver = rgPkgJson.optionalDependencies?.[platPkg]
  if (!ver) {
    console.error(`✗ ${platPkg} not listed in @vscode/ripgrep optionalDependencies.`)
    process.exit(1)
  }

  const work = mkdtempSync(join(tmpdir(), 'rg-cross-'))
  console.log(`↓ cross-fetch ${platPkg}@${ver} (host is ${process.platform}-${process.arch})`)
  execFileSync('npm', ['pack', `${platPkg}@${ver}`, '--pack-destination', work], {
    stdio: 'inherit',
  })
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'))
  if (!tgz) {
    console.error(`✗ npm pack produced no tarball in ${work}.`)
    process.exit(1)
  }
  execFileSync('tar', ['-xzf', join(work, tgz), '-C', work], { stdio: 'inherit' })
  const src = join(work, 'package', 'bin', rgName)
  if (!existsSync(src)) {
    console.error(`✗ rg not found in ${platPkg} tarball (${src}).`)
    process.exit(1)
  }
  return src
}

const rgPath = resolveRgPath()

const destDir = join(
  REPO_ROOT,
  'dist',
  'bin',
  compilePlatform,
  'vendor',
  'ripgrep',
  rgDirKey,
)
const dest = join(destDir, rgName)
mkdirSync(destDir, { recursive: true })
copyFileSync(rgPath, dest)
if (tgt.platform !== 'win32') chmodSync(dest, 0o755)

console.log(`✓ vendored rg → dist/bin/${compilePlatform}/vendor/ripgrep/${rgDirKey}/${rgName}`)
