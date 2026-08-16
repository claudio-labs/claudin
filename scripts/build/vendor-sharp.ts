/**
 * Vendor the sharp image-processing runtime beside a compiled Claudin binary.
 *
 * A Bun-compiled standalone binary can't resolve `sharp` (kept `external` in
 * scripts/build/build.ts) from node_modules at runtime — there is no node_modules
 * next to the executable. So each per-platform package ships a self-contained
 * sharp install at vendor/sharp/node_modules/, which src/tools/FileReadTool/
 * imageProcessor.ts probes via dirname(process.execPath) when the bare
 * `import('sharp')` fails. Without this, clipboard-image paste and image
 * resizing silently no-op in the native binary (sharp throws → fallback).
 *
 * sharp 0.35 loads its native addon through a hardcoded
 * `require("@img/sharp-<key>/sharp.node")` (dist/sharp.cjs), which in turn
 * pulls `@img/sharp-libvips-<key>` for the libvips shared library. So the
 * vendored node_modules must contain, in a resolvable layout:
 *   sharp, detect-libc, semver, @img/colour   (JS-only, host-agnostic)
 *   @img/sharp-<key>                           (native addon, target-specific)
 *   @img/sharp-libvips-<key>                   (libvips .so/.dylib; absent on
 *                                               win32, where DLLs ship inside
 *                                               @img/sharp-win32-<arch>)
 *
 * When the host already has the target's @img packages installed (the native
 * release matrix runs each leg on its own runner; a linux-x64 host also carries
 * the musl variant), they are copied directly. Otherwise the pinned version
 * from sharp's optionalDependencies is fetched via `npm pack` — same strategy
 * as scripts/build/vendor-ripgrep.ts.
 *
 * Usage: bun run scripts/build/vendor-sharp.ts               # host platform
 *        CLAUDIN_COMPILE_TARGET=bun-linux-arm64 bun run scripts/build/vendor-sharp.ts
 */

import { execFileSync } from 'child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'

const require = createRequire(import.meta.url)
const root = REPO_ROOT

// Platform-package dir (matches build.ts / assemble-packages.ts keys: strip
// "bun-", windows→win32; keep the -musl suffix).
const target = process.env.CLAUDIN_COMPILE_TARGET || ''
const compilePlatform = target
  ? target.replace(/^bun-/, '').replace(/^windows-/, 'win32-')
  : `${process.platform}-${process.arch}`

// Resolve the TARGET platform/arch/libc and derive sharp's @img package key.
function parseTarget(t: string): {
  platform: string
  arch: string
  musl: boolean
} {
  const musl = /-musl$/.test(t)
  const body = t.replace(/^bun-/, '').replace(/-musl$/, '')
  const m = body.match(/^(darwin|linux|windows)-(x64|arm64)$/)
  if (!m) {
    return {
      platform: process.platform,
      arch: process.arch,
      musl: process.env.CLAUDIN_MUSL === '1',
    }
  }
  return { platform: m[1] === 'windows' ? 'win32' : m[1], arch: m[2], musl }
}

const tgt = target
  ? parseTarget(target)
  : { platform: process.platform, arch: process.arch, musl: false }

// sharp's @img key: linux + musl → "linuxmusl"; everything else is <os>-<arch>.
const osKey =
  tgt.platform === 'linux' && tgt.musl ? 'linuxmusl' : tgt.platform
const sharpKey = `${osKey}-${tgt.arch}`

const nodeModules = join(root, 'node_modules')
const destNodeModules = join(
  root,
  'dist',
  'bin',
  compilePlatform,
  'vendor',
  'sharp',
  'node_modules',
)

// sharp's own optionalDependencies pin the exact @img package versions.
const sharpPkg = JSON.parse(
  readFileSync(join(nodeModules, 'sharp', 'package.json'), 'utf8'),
) as { version: string; optionalDependencies?: Record<string, string> }
const optDeps = sharpPkg.optionalDependencies || {}

/** Copy a host-installed package dir into the vendored node_modules. */
function copyHostPackage(pkg: string): boolean {
  const src = join(nodeModules, pkg)
  if (!existsSync(src)) return false
  const dst = join(destNodeModules, pkg)
  mkdirSync(join(dst, '..'), { recursive: true })
  cpSync(src, dst, { recursive: true, dereference: true })
  return true
}

/** Fetch a pinned package version via `npm pack` and extract it into place. */
function fetchPackage(pkg: string, version: string): void {
  const work = mkdtempSync(join(tmpdir(), 'sharp-cross-'))
  console.log(`↓ cross-fetch ${pkg}@${version}`)
  execFileSync('npm', ['pack', `${pkg}@${version}`, '--pack-destination', work], {
    stdio: 'inherit',
  })
  const tgz = readdirSync(work).find(f => f.endsWith('.tgz'))
  if (!tgz) {
    console.error(`✗ npm pack produced no tarball for ${pkg} in ${work}.`)
    process.exit(1)
  }
  execFileSync('tar', ['-xzf', join(work, tgz), '-C', work], { stdio: 'inherit' })
  const dst = join(destNodeModules, pkg)
  mkdirSync(join(dst, '..'), { recursive: true })
  cpSync(join(work, 'package'), dst, { recursive: true })
}

/** Copy from host if present, else npm-pack the pinned version. */
function vendorPackage(pkg: string, requirePin = true): void {
  if (copyHostPackage(pkg)) return
  const version = optDeps[pkg]
  if (!version) {
    if (requirePin) {
      console.error(
        `✗ ${pkg} not installed and not pinned in sharp optionalDependencies.`,
      )
      process.exit(1)
    }
    return
  }
  fetchPackage(pkg, version)
}

// JS-only runtime deps — host copies are platform-agnostic.
for (const pkg of ['sharp', 'detect-libc', 'semver', '@img/colour']) {
  if (!copyHostPackage(pkg)) {
    console.error(`✗ ${pkg} not found in node_modules — run \`bun install\`.`)
    process.exit(1)
  }
}

// Native addon for the target platform.
vendorPackage(`@img/sharp-${sharpKey}`)

// libvips shared library. Not published as a separate package for win32 (the
// DLLs ship inside @img/sharp-win32-<arch>), so only vendor it when sharp lists
// it as an optional dependency.
const libvipsPkg = `@img/sharp-libvips-${sharpKey}`
if (optDeps[libvipsPkg]) {
  vendorPackage(libvipsPkg)
}

// ── Bun-compiled-binary resolver fixups ──────────────────────────────────
// A Bun standalone binary resolves external bare specifiers by looking only
// for a root index.js — it ignores the package.json `main`/`exports` fields
// (verified empirically against Bun 1.3). Two consequences for this tree:
//
//   1. Deps sharp requires bare whose entry isn't a root index.js won't
//      resolve (detect-libc → lib/detect-libc.js, @img/colour → index.cjs).
//      Drop a root index.js shim that re-exports the real entry.
//   2. sharp loads its native addon via `require("@img/sharp-<key>/sharp.node")`,
//      which only works through the ignored `exports` map ("./sharp.node" →
//      "./index.cjs"). Rewrite it to require the real file `/index.cjs`; that
//      file's own relative `require("./lib/….node")` preserves the addon's
//      $ORIGIN RPATH so libvips is found in the sibling
//      @img/sharp-libvips-<key>/lib.
function ensureIndexShim(pkg: string): void {
  const dir = join(destNodeModules, pkg)
  const indexJs = join(dir, 'index.js')
  if (existsSync(indexJs)) return
  const main =
    (
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        main?: string
      }
    ).main || 'index.js'
  writeFileSync(indexJs, `module.exports = require('./${main}')\n`)
}

for (const pkg of ['detect-libc', 'semver', '@img/colour']) {
  ensureIndexShim(pkg)
}

const sharpCjs = join(destNodeModules, 'sharp', 'dist', 'sharp.cjs')
writeFileSync(
  sharpCjs,
  readFileSync(sharpCjs, 'utf8').replace(/\/sharp\.node"/g, '/index.cjs"'),
)

console.log(
  `✓ vendored sharp ${sharpPkg.version} (@img key ${sharpKey}) → dist/bin/${compilePlatform}/vendor/sharp/node_modules/`,
)
