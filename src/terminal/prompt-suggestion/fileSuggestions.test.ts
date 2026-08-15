import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { getCwdState, setCwdState } from 'src/platform/bootstrap/state.js'
import { getProjectFilePaths } from 'src/terminal/prompt-suggestion/fileSuggestions.js'

// Regression: getProjectFilePaths used to pass '.' as the ripgrep target, which
// ripGrepRaw resolves against process.cwd() (the launch dir) rather than the
// session's getCwd(). Those diverge whenever the session dir was changed
// without a process.chdir() (ssh/direct-connect/`open` sessions, per-agent
// runWithCwdOverride) — e.g. /explorer showing "0 files" for a project that has
// many. This test forces the divergence (setCwdState without process.chdir) and
// asserts the file list reflects the SESSION dir, not process.cwd().

let savedCwd: string
let sessionDir: string

beforeEach(() => {
  savedCwd = getCwdState()
  sessionDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'explorer-files-')))
  writeFileSync(path.join(sessionDir, 'a.txt'), 'a')
  mkdirSync(path.join(sessionDir, 'sub'))
  writeFileSync(path.join(sessionDir, 'sub', 'b.txt'), 'b')
})

afterEach(() => {
  setCwdState(savedCwd)
  rmSync(sessionDir, { recursive: true, force: true })
})

test('lists files from the session cwd, not process.cwd()', async () => {
  // Point the session dir at the temp dir WITHOUT chdir — process.cwd() stays on
  // the repo root, reproducing the ssh/open/agent-override divergence.
  setCwdState(sessionDir)
  expect(sessionDir).not.toBe(process.cwd())

  const paths = await getProjectFilePaths()

  // Files are relative to the session dir — no leaked repo files, no '..'
  // escapes, no absolute paths.
  expect(paths.sort()).toEqual([path.join('sub', 'b.txt'), 'a.txt'].sort())
  for (const p of paths) {
    expect(path.isAbsolute(p)).toBe(false)
    expect(p.startsWith('..')).toBe(false)
  }
})
