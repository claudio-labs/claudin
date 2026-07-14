import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import {
  resolveRipgrepConfig,
  resolveVendoredRipgrepPath,
  ripgrepCommand,
  wrapRipgrepUnavailableError,
} from './ripgrep.js'

const MOCK_BUILTIN_PATH = path.normalize(
  process.platform === 'win32'
    ? `vendor/ripgrep/${process.arch}-win32/rg.exe`
    : `vendor/ripgrep/${process.arch}-${process.platform}/rg`,
)

test('ripgrepCommand falls back to system rg when builtin binary is missing', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: MOCK_BUILTIN_PATH,
    builtinExists: false,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'system',
    command: 'rg',
    args: [],
  })
})

test('ripgrepCommand keeps builtin mode when bundled binary exists', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: MOCK_BUILTIN_PATH,
    builtinExists: true,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'builtin',
    command: MOCK_BUILTIN_PATH,
    args: [],
  })
})

test('getRipgrepConfig prefers the packaged @vscode/ripgrep binary when present', () => {
  // @vscode/ripgrep is a real dependency, so its per-platform prebuilt rg is in
  // node_modules during tests. getRipgrepConfig should resolve to it (builtin
  // mode, no argv0) rather than the legacy vendored path or a system rg.
  const { rgPath, argv0 } = ripgrepCommand()

  expect(argv0).toBeUndefined()
  // Assert the resolved binary is specifically the packaged one — a
  // node_modules/@vscode/ripgrep* path — not the in-tree vendored copy or a
  // system `rg` (either of which would satisfy a looser "contains ripgrep").
  expect(rgPath).toContain('node_modules')
  expect(rgPath).toContain(`@vscode${path.sep}ripgrep`)
  expect(existsSync(rgPath)).toBe(true)
})

// resolveVendoredRipgrepPath: the compiled-binary vendored-rg lookup. The
// production caller reads process.execPath directly, so these tests exercise the
// helper with a fake exec path — the only coverage of the "vendored rg beside the
// real executable" path (which the whole native-binary search relies on).
const rgRel = (plat: NodeJS.Platform, arch: string) =>
  plat === 'win32'
    ? path.join('vendor', 'ripgrep', `${arch}-win32`, 'rg.exe')
    : path.join('vendor', 'ripgrep', `${arch}-${plat}`, 'rg')

test('resolveVendoredRipgrepPath finds rg beside the executable (not moduleDir)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-exec-'))
  try {
    const binDir = path.join(tmp, 'binroot')
    const rg = path.join(binDir, rgRel(process.platform, process.arch))
    mkdirSync(path.dirname(rg), { recursive: true })
    writeFileSync(rg, '')
    const execPath = path.join(binDir, 'claudin')
    writeFileSync(execPath, '')

    const res = resolveVendoredRipgrepPath(path.join(tmp, 'nowhere'), execPath)
    expect(res.exists).toBe(true)
    expect(res.command).toBe(path.resolve(rg))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveVendoredRipgrepPath resolves a symlinked execPath (npm global bin)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-symlink-'))
  try {
    // Real package layout: <pkg>/bin/{claudin,vendor/...}. The global bin is a
    // symlink into it — realpathSync must resolve to <pkg>/bin to find vendor/.
    const pkgBin = path.join(tmp, 'node_modules', 'claudin', 'bin')
    const rg = path.join(pkgBin, rgRel(process.platform, process.arch))
    mkdirSync(path.dirname(rg), { recursive: true })
    writeFileSync(rg, '')
    const realBinary = path.join(pkgBin, 'claudin.exe')
    writeFileSync(realBinary, '')

    const globalBin = path.join(tmp, 'globalbin')
    mkdirSync(globalBin, { recursive: true })
    const link = path.join(globalBin, 'claudin')
    symlinkSync(realBinary, link)

    const res = resolveVendoredRipgrepPath(path.join(tmp, 'nowhere'), link)
    expect(res.exists).toBe(true)
    expect(res.command).toBe(path.resolve(rg))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveVendoredRipgrepPath reports exists=false when neither root has rg', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-missing-'))
  try {
    const execPath = path.join(tmp, 'bin', 'claudin')
    mkdirSync(path.dirname(execPath), { recursive: true })
    writeFileSync(execPath, '')
    const res = resolveVendoredRipgrepPath(path.join(tmp, 'moduledir'), execPath)
    expect(res.exists).toBe(false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('wrapRipgrepUnavailableError explains missing packaged fallback', () => {
  const error = wrapRipgrepUnavailableError(
    { code: 'ENOENT', message: 'spawn rg ENOENT' },
    { mode: 'builtin', command: 'C:\\fake\\vendor\\ripgrep\\rg.exe', args: [] },
    'win32',
  )

  expect(error.name).toBe('RipgrepUnavailableError')
  expect(error.code).toBe('ENOENT')
  expect(error.message).toContain('packaged ripgrep fallback')
  expect(error.message).toContain('winget install BurntSushi.ripgrep.MSVC')
})

test('wrapRipgrepUnavailableError explains missing system ripgrep', () => {
  const error = wrapRipgrepUnavailableError(
    { code: 'ENOENT', message: 'spawn rg ENOENT' },
    { mode: 'system', command: 'rg', args: [] },
    'linux',
  )

  expect(error.message).toContain('system ripgrep binary was not found on PATH')
  expect(error.message).toContain('apt install ripgrep')
})
