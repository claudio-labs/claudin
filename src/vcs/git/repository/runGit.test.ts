import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { runGit } from 'src/vcs/git/repository/runGit.js'

const scratch = new ScratchGit()
afterAll(() => scratch.cleanup())

/** A stand-in for git: a shell script that receives the arguments git would. */
function program(name: string, body: string): string {
  const path = join(scratch.tempDir('program'), name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('runGit', () => {
  test("read-only commands skip git's optional locks; commands that change the repository take them", async () => {
    const echoArgs = program('echo-args', 'printf "%s\\n" "$@"')
    const dir = scratch.tempDir('locks')
    const read = await runGit(['status', '--porcelain'], { cwd: { dir }, program: echoArgs })
    const change = await runGit(['stash', 'push'], { cwd: { dir }, program: echoArgs, mutates: true })
    expect(read).toEqual({ ok: true, stdout: '--no-optional-locks\nstatus\n--porcelain\n' })
    expect(change).toEqual({ ok: true, stdout: 'stash\npush\n' })
  })

  test('a git that outlives the time limit is a failed run, and does not hold the caller', async () => {
    const slow = program('slow', 'exec sleep 3')
    const started = Date.now()
    const run = await runGit(['status'], {
      cwd: { dir: scratch.tempDir('slow') },
      program: slow,
      timeoutMs: 200,
    })
    expect(run.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_500)
  })

  test('a directory that does not exist is a failed run, with nothing started', async () => {
    const marker = join(scratch.tempDir('marker'), 'started')
    const touch = program('touch', `touch '${marker}'`)
    const run = await runGit(['status'], {
      cwd: { dir: join(scratch.tempDir('gone'), 'missing') },
      program: touch,
    })
    expect(run).toEqual({ ok: false, stdout: '' })
    expect(existsSync(marker)).toBe(false)
  })
})
