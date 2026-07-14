#!/usr/bin/env node
// Fallback launcher for the @claudiolabs/claudin wrapper package.
//
// Normally the postinstall (install.cjs) hardlinks the native binary over
// bin/claudin.exe, so this file is never invoked. It exists for environments
// where postinstall doesn't run (--ignore-scripts): users can run
// `node cli-wrapper.cjs` directly and pay the Node-process spawn overhead.
//
// If no native binary is available for this platform (unsupported OS/arch, or
// --omit=optional), it falls back to the Node bundle (dist/cli.mjs) shipped in
// this same package — a Claudin advantage over a hard-fail.
//
// Platform detection + PLATFORMS map is duplicated in install.cjs — keep in sync.

const { spawnSync } = require('child_process')
const { arch, constants } = require('os')
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
  // process.report is available in Node ≥12; glibcVersionRuntime is absent on
  // musl. Faster than spawning `ldd` and avoids the ENOENT→musl false positive.
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
  // Rosetta 2: an x64 Node on Apple Silicon reports arch()==='x64'. Prefer the
  // native arm64 binary — the x64 build needs AVX, which Rosetta doesn't emulate.
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

// Resolve the native binary path for this platform, or null if unavailable.
function findNativeBinary() {
  const platformKey = getPlatformKey()
  const info = PLATFORMS[platformKey]
  if (!info) {
    return null
  }
  const optionalDeps = require('./package.json').optionalDependencies || {}
  if (!optionalDeps[info.pkg]) {
    return null
  }
  try {
    const pkgDir = path.dirname(require.resolve(info.pkg + '/package.json'))
    return path.join(pkgDir, info.bin)
  } catch {
    return null
  }
}

function runNativeBinary(binaryPath) {
  const result = spawnSync(binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, CLAUDIN_INSTALLED_VIA_NPM_WRAPPER: '1' },
  })
  if (result.error) {
    console.error(
      `[${WRAPPER_NAME}] Failed to execute native binary at ` + binaryPath,
    )
    console.error('  ' + result.error.message)
    process.exit(1)
  }
  if (result.signal) {
    // Node ignores some signals (SIGPIPE → SIG_IGN), so re-raising is
    // unreliable. Exit with the POSIX convention 128+signum instead.
    const signum = constants.signals[result.signal] ?? 0
    process.exit(128 + signum)
  }
  process.exit(result.status ?? 1)
}

// Node fallback: run the bundled dist/cli.mjs via the current Node process.
// Used when no native binary exists for this platform.
function runNodeFallback() {
  const dist = path.join(__dirname, 'dist', 'cli.mjs')
  const { existsSync } = require('fs')
  if (!existsSync(dist)) {
    console.error(
      `[${WRAPPER_NAME}] No native binary for ${getPlatformKey()} and no Node bundle found.`,
    )
    process.exit(1)
  }
  const { pathToFileURL } = require('url')
  return import(pathToFileURL(dist).href)
}

const binaryPath = findNativeBinary()
if (binaryPath) {
  runNativeBinary(binaryPath)
} else {
  runNodeFallback()
}
