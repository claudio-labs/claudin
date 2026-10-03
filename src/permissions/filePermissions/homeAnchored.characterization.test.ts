/**
 * Runs the home-anchored (`~/`) file rule cases in a child process whose HOME
 * is a fresh temp dir. The OS reads HOME once per process, and these cases need
 * real files under home (keys in `~/.ssh`, the config home in `~/.claudin`)
 * without touching the real one. The cases live in
 * `__fixtures__/rewrite/homeAnchored.child.ts`.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHILD = join(import.meta.dir, '__fixtures__', 'rewrite', 'homeAnchored.child.ts')

test('the home-anchored cases pass under a temp HOME', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'file-rules-home-')))
  try {
    const run = Bun.spawnSync(['bun', 'test', CHILD], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, FILE_RULES_HOME_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    const passed = Number(/(\d+) pass/.exec(out)?.[1] ?? 0)
    const failed = Number(/(\d+) fail/.exec(out)?.[1] ?? -1)
    expect({ exitCode: run.exitCode, passed, failed, out: failed === 0 ? '' : out }).toEqual({
      exitCode: 0,
      passed: 9,
      failed: 0,
      out: '',
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 60_000)
