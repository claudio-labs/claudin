#!/usr/bin/env node
// Postinstall for the @claudiolabs/claudin wrapper package.
//
// Detects the platform, finds the matching native binary from
// optionalDependencies, and hardlinks (or copies) it over the bin/claudin.exe
// placeholder. After this runs, `claudin` execs the native binary directly —
// no Node.js process stays resident.
//
// If no native package is present (unsupported platform, or --omit=optional),
// the bin/claudin.exe stub is left in place. That stub delegates to
// cli-wrapper.cjs, which falls back to the bundled Node build (dist/cli.mjs).
// So an unsupported platform still runs Claudin via Node instead of hard-failing.
//
// Platform detection + PLATFORMS map is duplicated in cli-wrapper.cjs — keep in
// sync.

const { spawnSync } = require('child_process')
const {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  unlinkSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  statSync,
} = require('fs')
const { arch } = require('os')
const path = require('path')

const PACKAGE_PREFIX = '@claudiolabs/claudin'
const BINARY_NAME = 'claudin'
const WRAPPER_NAME = require('./package.json').name

const PLATFORMS = {
  'darwin-arm64': { pkg: PACKAGE_PREFIX + '-darwin-arm64', bin: BINARY_NAME },
  'darwin-x64': { pkg: PACKAGE_PREFIX + '-darwin-x64', bin: BINARY_NAME },
  'linux-x64': { pkg: PACKAGE_PREFIX + '-linux-x64', bin: BINARY_NAME },
  'linux-arm64': { pkg: PACKAGE_PREFIX + '-linux-arm64', bin: BINARY_NAME },
  'linux-x64-musl': { pkg: PACKAGE_PREFIX + '-linux-x64-musl', bin: BINARY_NAME },
  'linux-arm64-musl': {
    pkg: PACKAGE_PREFIX + '-linux-arm64-musl',
    bin: BINARY_NAME,
  },
  'win32-x64': { pkg: PACKAGE_PREFIX + '-win32-x64', bin: BINARY_NAME + '.exe' },
  'win32-arm64': {
    pkg: PACKAGE_PREFIX + '-win32-arm64',
    bin: BINARY_NAME + '.exe',
  },
}

function detectMusl() {
  if (process.platform !== 'linux') {
    return false
  }
  const report =
    typeof process.report?.getReport === 'function'
      ? process.report.getReport()
      : null
  return report != null && report.header?.glibcVersionRuntime === undefined
}

function getPlatformKey() {
  const platform = process.platform
  let cpu = arch()
  if (platform === 'linux') {
    return 'linux-' + cpu + (detectMusl() ? '-musl' : '')
  }
  if (platform === 'darwin' && cpu === 'x64') {
    const r = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], {
      encoding: 'utf8',
    })
    if (r.stdout?.trim() === '1') {
      cpu = 'arm64'
    }
  }
  return platform + '-' + cpu
}

function placeBinary(src, dest) {
  // Try hardlink first (instant, zero extra disk for a ~200MB binary; src and
  // dest are both under node_modules/ so same-filesystem is the common case).
  try {
    linkSync(src, dest)
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Read the stub before unlinking so we can restore it if both link and
      // copy fail. Only read if dest is stub-sized (on re-install dest is the
      // ~200MB binary).
      const stub = statSync(dest).size < 4096 ? readFileSync(dest) : null
      unlinkSync(dest)
      try {
        linkSync(src, dest)
      } catch {
        try {
          copyFileSync(src, dest)
        } catch (copyErr) {
          if (stub) {
            try {
              writeFileSync(dest, stub, { mode: 0o755 })
            } catch {
              // Do nothing
            }
          }
          throw copyErr
        }
      }
    } else if (err.code === 'EXDEV' || err.code === 'EPERM') {
      // Cross-device or no-link-perms — copyFileSync overwrites existing dest.
      copyFileSync(src, dest)
    } else {
      throw err
    }
  }
  if (process.platform !== 'win32') {
    chmodSync(dest, 0o755)
  }
}

function main() {
  const platformKey = getPlatformKey()
  const info = PLATFORMS[platformKey]
  // Always write to bin/claudin.exe — the package.json bin field points here.
  // The .exe extension + no-shebang-needed stub makes npm's cmd-shim emit a
  // direct exec on Windows; Unix ignores the extension. Same pattern as Bun's
  // and Claude Code's npm packages.
  const dest = path.join(__dirname, 'bin', 'claudin.exe')

  const leaveStub = reason => {
    console.error(`[${WRAPPER_NAME} postinstall] ${reason}`)
    console.error(
      '  Leaving the Node-fallback launcher in place — `claudin` will run via Node (dist/cli.mjs).',
    )
  }

  if (!info) {
    leaveStub(
      `No native binary for platform ${process.platform} ${arch()}. Supported: ${Object.keys(PLATFORMS).join(', ')}`,
    )
    return
  }

  const optionalDeps = require('./package.json').optionalDependencies || {}
  if (!optionalDeps[info.pkg]) {
    leaveStub(
      `Native binaries for ${platformKey} are not available on this release channel.`,
    )
    return
  }

  let src
  try {
    const pkgDir = path.dirname(require.resolve(info.pkg + '/package.json'))
    src = path.join(pkgDir, info.bin)
  } catch {
    leaveStub(
      `Native package "${info.pkg}" not found (--omit=optional or a failed download).`,
    )
    return
  }

  try {
    placeBinary(src, dest)
  } catch (err) {
    console.error(
      `[${WRAPPER_NAME} postinstall] Failed to place binary: ${err.message}`,
    )
    console.error('  Fallback: node ' + path.join(__dirname, 'cli-wrapper.cjs'))
    process.exitCode = 1
    return
  }

  // The compiled binary finds its vendored ripgrep via
  // dirname(process.execPath)/vendor/ripgrep/… (src/utils/ripgrep.ts). The
  // hardlink above places the binary in bin/, away from the platform package's
  // vendor/, so mirror vendor/ beside the binary. Non-fatal: search falls back
  // to a system `rg` if this can't be copied.
  try {
    const srcVendor = path.join(path.dirname(src), 'vendor')
    if (existsSync(srcVendor)) {
      cpSync(srcVendor, path.join(__dirname, 'bin', 'vendor'), {
        recursive: true,
      })
    }
  } catch (err) {
    console.error(
      `[${WRAPPER_NAME} postinstall] Could not vendor ripgrep beside the binary: ${err.message}`,
    )
  }
}

main()
