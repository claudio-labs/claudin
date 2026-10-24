// A shell write into the team memory dir must not ride the memory carve-out.
// The carve-out lets the file tools write memory without a prompt because each
// of them runs checkTeamMemSecrets on the content first; a shell command
// carries no content the guard can see, so `echo <key> > team/x.md` would reach
// a git-tracked file — and every teammate's next pull — unscanned. The private
// dir keeps the carve-out for the shell, since nothing written there is shared.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getGlobalMemPath, getPrivateMemPath } from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { isPathAllowed } from 'src/permissions/pathValidation.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { bashToolHasPermission } from 'src/tools/BashTool/bashPermissions.js'
import {
  makePermissionContext,
  makeToolUseContext,
  overrideSandbox,
  resetPermissionState,
  stubMacroVersion,
} from 'src/tools/BashTool/__testutils__/permissionContext.js'
import { validatePath as validatePowerShellPath } from 'src/tools/PowerShellTool/pathValidation/pathAllowlist.js'

const CONFIG_KEY = 'CLAUDIN_CONFIG_DIR'
let priorConfig: string | undefined
let configDir: string

beforeAll(() => {
  // The memory dirs read settings from the config home; a fresh one keeps the
  // developer's autoMemoryDirectory out of the paths under test.
  priorConfig = process.env[CONFIG_KEY]
  configDir = mkdtempSync(join(tmpdir(), 'team-shell-writes-'))
  process.env[CONFIG_KEY] = configDir
  getPrivateMemPath.cache.clear?.()
})

afterAll(() => {
  if (priorConfig === undefined) delete process.env[CONFIG_KEY]
  else process.env[CONFIG_KEY] = priorConfig
  getPrivateMemPath.cache.clear?.()
  rmSync(configDir, { recursive: true, force: true })
})

beforeEach(() => {
  stubMacroVersion()
  overrideSandbox({ isSandboxingEnabled: () => false })
})
afterEach(() => resetPermissionState())

const teamFile = () => join(getTeamMemPath(), 'bugs', 'probe.md')
const privateFile = () => join(getPrivateMemPath(), 'probe.md')

describe('a shell write into team memory', () => {
  test('the team dir sits inside the working directory, as in a real checkout', () => {
    expect(teamFile().startsWith(getCwd())).toBe(true)
  })

  test('a redirect into the team dir is not auto-allowed', async () => {
    for (const op of ['>', '>>']) {
      const command = `echo hi ${op} ${teamFile()}`
      const result = await bashToolHasPermission({ command }, makeToolUseContext())
      expect([command, result.behavior]).toEqual([command, 'ask'])
    }
  })

  test('the shared path check gives the team dir no carve-out', () => {
    const result = isPathAllowed(teamFile(), makePermissionContext(), 'write')
    expect(result.allowed).toBe(false)
  })

  test('PowerShell gives the team dir no carve-out either', () => {
    const result = validatePowerShellPath(teamFile(), getCwd(), makePermissionContext(), 'write')
    expect(result.allowed).toBe(false)
  })
})

describe('a shell write into private memory', () => {
  test('a redirect into the private dir keeps its carve-out', async () => {
    const command = `echo hi > ${privateFile()}`
    const result = await bashToolHasPermission({ command }, makeToolUseContext())
    expect(result.behavior).toBe('allow')
  })

  test('the shared path check still allows it, naming the private dir', () => {
    const result = isPathAllowed(privateFile(), makePermissionContext(), 'write')
    expect(result.allowed).toBe(true)
    expect((result.decisionReason as { reason?: string } | undefined)?.reason).toBe(
      'private memory files are allowed for writing',
    )
  })
})

// Auto mode skips the classifier for what acceptEdits would allow
// (permissions.ts), so these run under acceptEdits: the check auto mode asks.
describe('moving a memory between the private and global dirs', () => {
  const globalFile = () => join(getGlobalMemPath(), 'probe.md')
  const acceptEdits = () => makeToolUseContext(makePermissionContext({}, { mode: 'acceptEdits' }))

  test('`mv -n`, as /memory sort writes it, is allowed both ways', async () => {
    for (const command of [
      `mv ${privateFile()} ${globalFile()}`,
      `mv -n ${privateFile()} ${globalFile()}`,
      `mv --no-clobber ${globalFile()} ${privateFile()}`,
      `cp -n ${privateFile()} ${globalFile()}`,
    ]) {
      const result = await bashToolHasPermission({ command }, acceptEdits())
      expect([command, result.behavior]).toEqual([command, 'allow'])
    }
  })

  test('the team dir still asks, and so does a flag that takes a path of its own', async () => {
    for (const command of [
      `mv -n ${privateFile()} ${teamFile()}`,
      `mv -t ${getGlobalMemPath()} ${privateFile()}`,
      `mv --target-directory=/etc ${privateFile()}`,
      `mv -S .bak ${privateFile()} ${globalFile()}`,
    ]) {
      const result = await bashToolHasPermission({ command }, acceptEdits())
      expect([command, result.behavior]).toEqual([command, 'ask'])
    }
  })

  test('outside auto and accept-edits mode the move still asks', async () => {
    const command = `mv -n ${privateFile()} ${globalFile()}`
    const result = await bashToolHasPermission({ command }, makeToolUseContext())
    expect(result.behavior).toBe('ask')
  })
})
