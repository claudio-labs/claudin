// A WorktreeRemove hook that runs and fails did not remove the worktree:
// cleanupWorktree must not report it removed.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearRegisteredHooks, registerHookCallbacks } from 'src/platform/bootstrap/state.js'
import { useIsolatedHooksConfig } from 'src/platform/lifecycleHooks/__testutils__/isolatedHooksConfig.js'
import { cleanupWorktree, restoreWorktreeSession } from 'src/vcs/git/worktree.js'

useIsolatedHooksConfig()

const dirs: string[] = []
const processCwd = process.cwd()
afterEach(() => {
  process.chdir(processCwd)
  clearRegisteredHooks()
  restoreWorktreeSession(null)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-hook-')))
  dirs.push(dir)
  return dir
}

test("the hooks that run here are only the test's: the user settings are an empty temp dir", () => {
  expect(process.env.CLAUDIN_CONFIG_DIR).toContain(join(tmpdir(), 'hooks-config-'))
})

test('a failing WorktreeRemove hook leaves the worktree, and cleanup says so', async () => {
  const worktree = tempDir()
  registerHookCallbacks({
    WorktreeRemove: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'echo "remove refused" >&2; exit 3' }],
        pluginRoot: tempDir(),
        pluginName: 'wt-probe',
      },
    ] as never,
  })
  restoreWorktreeSession({
    originalCwd: tempDir(),
    worktreePath: worktree,
    worktreeName: 'hooked',
    sessionId: 'sess-test',
    hookBased: true,
  })
  const cleanup = await cleanupWorktree()
  expect(existsSync(worktree)).toBe(true)
  expect(cleanup.removed).toBe(false)
  expect(cleanup.removeError).toContain('remove refused')
})
