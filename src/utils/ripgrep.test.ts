import { expect, test } from 'bun:test'
import { existsSync } from 'fs'
import path from 'path'

import {
  resolveRipgrepConfig,
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
