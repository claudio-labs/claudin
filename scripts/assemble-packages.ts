/**
 * Assemble the publishable npm packages for a Claudin binary release.
 *
 * Reads the per-platform binaries from dist/bin/<platform>/ (produced by the
 * native build matrix, each with its vendored rg) plus the wrapper scaffolding
 * (install.cjs, cli-wrapper.cjs, bin/claudin.exe stub, and the Node-fallback
 * bundle dist/cli.mjs) and emits, under dist/packages/:
 *
 *   claudin/                    the wrapper (bin stub + selector + Node fallback)
 *   claudin-<platform>/         one per platform: the native binary + vendored rg
 *
 * The wrapper's optionalDependencies pin each platform package at the release
 * version; postinstall (install.cjs) hardlinks the matching binary over the
 * stub. Per-platform packages declare os/cpu/(libc) so npm installs ONLY the
 * user's platform (avoids pulling all ~8 × ~212MB).
 *
 * Usage: bun run scripts/assemble-packages.ts [version]
 *        (version defaults to the root package.json version)
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

const root = join(import.meta.dir, '..')
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const version = process.argv[2] || rootPkg.version
const PREFIX = '@claudiolabs/claudin'

// Platform metadata → npm os/cpu/libc gating. Keys match dist/bin/<platform>/
// and the PLATFORMS maps in install.cjs / cli-wrapper.cjs.
const PLATFORMS: Record<
  string,
  { os: string; cpu: string; libc?: string; exe?: boolean }
> = {
  'darwin-x64': { os: 'darwin', cpu: 'x64' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', libc: 'glibc' },
  'linux-x64-musl': { os: 'linux', cpu: 'x64', libc: 'musl' },
  'linux-arm64-musl': { os: 'linux', cpu: 'arm64', libc: 'musl' },
  'win32-x64': { os: 'win32', cpu: 'x64', exe: true },
  'win32-arm64': { os: 'win32', cpu: 'arm64', exe: true },
}

const binDir = join(root, 'dist', 'bin')
if (!existsSync(binDir)) {
  console.error(
    '✗ dist/bin/ not found — run the compile matrix (CLAUDIN_COMPILE=1) first.',
  )
  process.exit(1)
}

const outRoot = join(root, 'dist', 'packages')
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })

const built = readdirSync(binDir).filter(p => PLATFORMS[p])
if (built.length === 0) {
  console.error('✗ no known platform dirs under dist/bin/')
  process.exit(1)
}

const commonMeta = {
  version,
  description: rootPkg.description,
  homepage: rootPkg.homepage,
  repository: rootPkg.repository,
  bugs: rootPkg.bugs,
  license: rootPkg.license,
  author: rootPkg.author,
}

// ── per-platform packages ────────────────────────────────────────────────
const optionalDependencies: Record<string, string> = {}
for (const platform of built) {
  const meta = PLATFORMS[platform]!
  const pkgName = `${PREFIX}-${platform}`
  optionalDependencies[pkgName] = version

  const dst = join(outRoot, `claudin-${platform}`)
  mkdirSync(dst, { recursive: true })
  // Copy the whole platform payload (binary + vendor/rg).
  cpSync(join(binDir, platform), dst, { recursive: true })

  const pkgJson: Record<string, unknown> = {
    name: pkgName,
    ...commonMeta,
    os: [meta.os],
    cpu: [meta.cpu],
    // Ship only the binary + its vendored rg.
    files: ['claudin' + (meta.exe ? '.exe' : ''), 'vendor/'],
    // Not a library — nothing to import.
    preferUnplugged: true,
  }
  if (meta.libc) pkgJson.libc = [meta.libc]
  writeFileSync(join(dst, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n')
  console.log(`✓ ${pkgName}`)
}

// ── wrapper package ──────────────────────────────────────────────────────
const wrap = join(outRoot, 'claudin')
mkdirSync(join(wrap, 'bin'), { recursive: true })
mkdirSync(join(wrap, 'dist'), { recursive: true })

// Selector + fallback + stub.
cpSync(join(root, 'install.cjs'), join(wrap, 'install.cjs'))
cpSync(join(root, 'cli-wrapper.cjs'), join(wrap, 'cli-wrapper.cjs'))
cpSync(join(root, 'bin', 'claudin.exe'), join(wrap, 'bin', 'claudin.exe'))
if (existsSync(join(root, 'README.md')))
  cpSync(join(root, 'README.md'), join(wrap, 'README.md'))

// Node fallback bundle: dist/cli.mjs + chunks + help snapshots — NOT dist/bin/.
for (const entry of readdirSync(join(root, 'dist'))) {
  if (entry === 'bin' || entry === 'packages' || entry.endsWith('.map')) continue
  cpSync(join(root, 'dist', entry), join(wrap, 'dist', entry), {
    recursive: true,
  })
}

const wrapperPkg = {
  name: PREFIX,
  ...commonMeta,
  keywords: rootPkg.keywords,
  engines: rootPkg.engines,
  type: rootPkg.type,
  bin: { claudin: './bin/claudin.exe' },
  // Postinstall hardlinks the matching native binary over the stub.
  scripts: { postinstall: 'node install.cjs' },
  optionalDependencies,
  files: ['bin/', 'dist/', 'install.cjs', 'cli-wrapper.cjs', 'README.md'],
}
writeFileSync(
  join(wrap, 'package.json'),
  JSON.stringify(wrapperPkg, null, 2) + '\n',
)
// npm honours .npmignore INSIDE dist/ (root package.json `files` bypasses a
// root-level one) — exclude any stray sourcemaps.
writeFileSync(join(wrap, 'dist', '.npmignore'), '**/*.map\n')
console.log(`✓ ${PREFIX} (wrapper, ${built.length} optionalDependencies)`)

console.log(
  `\nAssembled ${built.length + 1} package(s) at dist/packages/ (version ${version}).`,
)
