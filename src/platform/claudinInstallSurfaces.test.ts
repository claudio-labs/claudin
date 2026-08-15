import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const originalEnv = { ...process.env }
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const realEnvUtils = { ...(await import('src/shared/envUtils.js')) }
const realExecFileNoThrowInstall = { ...(await import('src/shared/proc/execFileNoThrow.js')) }
// Plain snapshot of the real fs/promises taken BEFORE any mock.module runs.
// `fsPromises` above is a live namespace view — once the rm stub is installed
// it reflects the mock (fsPromises.rm === the no-op), so restoring with the
// live view would re-install the stub. Copy the real exports out now.
const realFsPromises = { ...fsPromises }

afterEach(() => {
  process.env = { ...originalEnv }
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
})

async function importFreshInstallCommand() {
  return import(`src/commands/install.tsx?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshInstaller() {
  return import(`src/platform/install/installer.ts?ts=${Date.now()}-${Math.random()}`)
}

test('install command displays ~/.local/bin/claudin on non-Windows', async () => {
  const realEnv = await import('src/shared/env.js')
  mock.module('src/shared/env.js', () => ({
    ...realEnv,
    env: { platform: 'darwin' },
  }))

  const { getInstallationPath } = await importFreshInstallCommand()

  expect(getInstallationPath()).toBe('~/.local/bin/claudin')
})

test('install command displays claudin.exe path on Windows', async () => {
  const realEnv = await import('src/shared/env.js')
  mock.module('src/shared/env.js', () => ({
    ...realEnv,
    env: { platform: 'win32' },
  }))

  const { getInstallationPath } = await importFreshInstallCommand()

  expect(getInstallationPath()).toBe(
    join(homedir(), '.local', 'bin', 'claudin.exe').replace(/\//g, '\\'),
  )
})

test('cleanupNpmInstallations removes both claudin and legacy claude local install dirs', async () => {
  const removedPaths: string[] = []
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@claudiolabs/claudin',
  }

  mock.module('fs/promises', () => ({
    ...fsPromises,
    rm: async (path: string) => {
      removedPaths.push(path)
    },
  }))

  mock.module('src/shared/proc/execFileNoThrow.js', () => ({
    execFileNoThrowWithCwd: async () => ({
      code: 1,
      stderr: 'npm ERR! code E404',
    }),
  }))

  // Spread real envUtils so the namespace shape carries every export
  // (isEnvDefinedFalsy, hasNodeOption, etc.) — Bun locks shape on first
  // mock.module call and leaks the partial shape into every later test
  // file that imports those symbols transitively.
  const realEnvUtilsForCleanup = await import('src/shared/envUtils.js')
  mock.module('src/shared/envUtils.js', () => ({
    ...realEnvUtilsForCleanup,
    getClaudinConfigHomeDir: () => join(homedir(), '.claudin'),
    // Note: no isEnvTruthy override — the previous `value === '1'` was
    // narrower than the real implementation and leaked into other test
    // files (e.g. BashTool prompt tests setting env to 'true').
  }))

  const { cleanupNpmInstallations } = await importFreshInstaller()
  await cleanupNpmInstallations()

  expect(removedPaths).toContain(join(homedir(), '.claudin', 'local'))
  expect(removedPaths).toContain(join(homedir(), '.claude', 'local'))
})

afterAll(() => {
  mock.module('src/shared/envUtils.js', () => realEnvUtils)
  mock.module('src/shared/envUtils.js', () => realEnvUtils)
  mock.module('src/shared/proc/execFileNoThrow.js', () => realExecFileNoThrowInstall)
  mock.module('src/shared/proc/execFileNoThrow.js', () => realExecFileNoThrowInstall)
  // The `rm` stub above (records paths instead of deleting) is process-global
  // and mock.restore() does not revert mock.module(); left installed it turns
  // rm() into a no-op for every sibling file, e.g. unlinkSessionSpillDir's
  // cleanup silently stops removing spill dirs. Re-install the real module
  // under both specifiers (Bun keys the two builtins separately).
  mock.module('fs/promises', () => realFsPromises)
  mock.module('node:fs/promises', () => realFsPromises)
})
