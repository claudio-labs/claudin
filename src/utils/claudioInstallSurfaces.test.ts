import { afterEach, expect, mock, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const originalEnv = { ...process.env }
const originalMacro = (globalThis as Record<string, unknown>).MACRO

afterEach(() => {
  process.env = { ...originalEnv }
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  mock.restore()
})

async function importFreshInstallCommand() {
  return import(`../commands/install.tsx?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshInstaller() {
  return import(`./nativeInstaller/installer.ts?ts=${Date.now()}-${Math.random()}`)
}

test('install command displays ~/.local/bin/claudio on non-Windows', async () => {
  const realEnv = await import('../utils/env.js')
  mock.module('../utils/env.js', () => ({
    ...realEnv,
    env: { platform: 'darwin' },
  }))

  const { getInstallationPath } = await importFreshInstallCommand()

  expect(getInstallationPath()).toBe('~/.local/bin/claudio')
})

test('install command displays claudio.exe path on Windows', async () => {
  const realEnv = await import('../utils/env.js')
  mock.module('../utils/env.js', () => ({
    ...realEnv,
    env: { platform: 'win32' },
  }))

  const { getInstallationPath } = await importFreshInstallCommand()

  expect(getInstallationPath()).toBe(
    join(homedir(), '.local', 'bin', 'claudio.exe').replace(/\//g, '\\'),
  )
})

test('cleanupNpmInstallations removes both claudio and legacy claude local install dirs', async () => {
  const removedPaths: string[] = []
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@claudiolabs/claudio',
  }

  mock.module('fs/promises', () => ({
    ...fsPromises,
    rm: async (path: string) => {
      removedPaths.push(path)
    },
  }))

  mock.module('./execFileNoThrow.js', () => ({
    execFileNoThrowWithCwd: async () => ({
      code: 1,
      stderr: 'npm ERR! code E404',
    }),
  }))

  // Spread real envUtils so the namespace shape carries every export
  // (isEnvDefinedFalsy, hasNodeOption, etc.) — Bun locks shape on first
  // mock.module call and leaks the partial shape into every later test
  // file that imports those symbols transitively.
  const realEnvUtilsForCleanup = await import('./envUtils.js')
  mock.module('./envUtils.js', () => ({
    ...realEnvUtilsForCleanup,
    getClaudioConfigHomeDir: () => join(homedir(), '.claudio'),
    // Note: no isEnvTruthy override — the previous `value === '1'` was
    // narrower than the real implementation and leaked into other test
    // files (e.g. BashTool prompt tests setting env to 'true').
  }))

  const { cleanupNpmInstallations } = await importFreshInstaller()
  await cleanupNpmInstallations()

  expect(removedPaths).toContain(join(homedir(), '.claudio', 'local'))
  expect(removedPaths).toContain(join(homedir(), '.claude', 'local'))
})
