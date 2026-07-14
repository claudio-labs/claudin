/**
 * Vendor the ripgrep binary beside a compiled Claudin binary.
 *
 * A Bun-compiled standalone binary can't resolve @vscode/ripgrep from
 * node_modules at runtime, so each per-platform package ships `rg` next to the
 * executable at vendor/ripgrep/<arch>-<platform>/rg[.exe] — the layout
 * src/utils/ripgrep.ts probes via dirname(process.execPath).
 *
 * In the native release matrix this runs on each platform's own runner, so the
 * host's freshly-installed @vscode/ripgrep already holds the correct-platform
 * (and correct-libc, incl. musl) `rg`. We just copy it into the platform's
 * dist/bin/<platform>/ payload.
 *
 * Usage: bun run scripts/vendor-ripgrep.ts            # host platform
 *        CLAUDIN_COMPILE_TARGET=bun-linux-x64 bun run scripts/vendor-ripgrep.ts
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Platform-package dir (matches build.ts: strip "bun-", windows→win32).
const target = process.env.CLAUDIN_COMPILE_TARGET || ''
const compilePlatform = target
  ? target.replace(/^bun-/, '').replace(/^windows-/, 'win32-')
  : `${process.platform}-${process.arch}`

// ripgrep vendored dir uses process.arch + process.platform ('linux' even for
// musl); the rg binary itself carries the right libc since this runs natively.
const rgDirKey = `${process.arch}-${process.platform}`
const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg'

const { rgPath } = require('@vscode/ripgrep') as { rgPath?: string }
if (!rgPath || !existsSync(rgPath)) {
  console.error(
    `✗ @vscode/ripgrep rgPath not found (${rgPath}). Run \`bun install\` first.`,
  )
  process.exit(1)
}

const destDir = join(
  import.meta.dir,
  '..',
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
if (process.platform !== 'win32') chmodSync(dest, 0o755)

console.log(`✓ vendored rg → dist/bin/${compilePlatform}/vendor/ripgrep/${rgDirKey}/${rgName}`)
