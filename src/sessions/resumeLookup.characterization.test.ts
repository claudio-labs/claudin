/**
 * Characterization of the two small lookups around a resume, pinned before
 * the clean-base rewrite of `sessions/resume`:
 *
 * - `listCandidates`: the session transcripts of one project directory, found
 *   by name (and optionally stat'ed), without reading them. `/dream`'s
 *   consolidation gate counts sessions with it.
 * - `checkCrossProjectResume`: whether a session picked in the resume picker
 *   belongs to another directory, and the command that resumes it there.
 *
 * Real directories under a temp root; the cd command is run by a real bash.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'

import { useRestoreSandbox } from 'src/sessions/__testutils__/restoreHarness.js'
import { scratchDirs } from 'src/sessions/__testutils__/resumeTranscripts.js'
import { checkCrossProjectResume } from 'src/sessions/crossProjectResume.js'
import { listCandidates } from 'src/sessions/sessionCandidates.js'
import type { LogOption } from 'src/shared/types/logs.js'

const sandbox = useRestoreSandbox()
const dirs = scratchDirs('resume-lookup-')
afterEach(() => dirs.cleanup())

// --- listCandidates ---------------------------------------------------------------

describe('listCandidates', () => {
  const LOWER = '0b5e55ed-0000-4000-8000-000000000001'
  const UPPER = '0B5E55ED-0000-4000-8000-00000000000A'
  const AS_DIR = '0b5e55ed-0000-4000-8000-000000000003'
  const DANGLING = '0b5e55ed-0000-4000-8000-000000000004'

  function populated(): string {
    const dir = dirs.make()
    const file = (name: string) => writeFileSync(join(dir, name), '{}\n')
    file(`${LOWER}.jsonl`)
    file(`${UPPER}.jsonl`)
    file('agent-a1b2c3d4e5f60718.jsonl')
    file(`${LOWER}.json`)
    file(`${LOWER}.jsonl.bak`)
    file('notes.jsonl')
    file('0b5e55ed-0000-4000-8000-00000000001.jsonl')
    mkdirSync(join(dir, `${AS_DIR}.jsonl`))
    symlinkSync(join(dir, 'nowhere'), join(dir, `${DANGLING}.jsonl`))
    const when = new Date('2026-09-01T12:00:00.000Z')
    utimesSync(join(dir, `${LOWER}.jsonl`), when, when)
    return dir
  }
  const byId = <T extends { sessionId: string }>(list: T[]) => [...list].sort((a, b) => a.sessionId.localeCompare(b.sessionId))

  test('without stat: every <uuid>.jsonl entry, mtime 0, whatever it points to', async () => {
    const dir = populated()
    const found = byId(await listCandidates(dir, false, '/work/app'))
    expect(found).toEqual(
      byId([LOWER, UPPER, AS_DIR, DANGLING].map(sessionId => ({
        sessionId,
        filePath: join(dir, `${sessionId}.jsonl`),
        mtime: 0,
        projectPath: '/work/app',
      }))),
    )
  })

  test('with stat: the modification time in ms, and entries that cannot be stat’ed left out', async () => {
    const dir = populated()
    const found = byId(await listCandidates(dir, true))
    expect(found.map(c => c.sessionId)).toEqual(byId([{ sessionId: LOWER }, { sessionId: UPPER }, { sessionId: AS_DIR }]).map(c => c.sessionId))
    expect(found.find(c => c.sessionId === LOWER)).toEqual({
      sessionId: LOWER,
      filePath: join(dir, `${LOWER}.jsonl`),
      mtime: Date.parse('2026-09-01T12:00:00.000Z'),
      projectPath: undefined,
    })
  })

  test('a directory that cannot be read gives an empty list', async () => {
    expect(await listCandidates(join(dirs.make(), 'absent'), true)).toEqual([])
    const file = join(dirs.make(), 'plain-file')
    writeFileSync(file, '')
    expect(await listCandidates(file, false)).toEqual([])
  })
})

// --- checkCrossProjectResume ----------------------------------------------------------------

describe('checkCrossProjectResume', () => {
  const SESSION = '0b5e55ed-0000-4000-8000-0000000000ff'
  const log = (fields: Partial<LogOption>) => ({ messages: [], sessionId: SESSION, ...fields }) as LogOption

  const same = [
    { name: 'the picker shows only this project', log: () => log({ projectPath: '/other/project' }), all: false },
    { name: 'the session has no project path', log: () => log({}), all: true },
    { name: 'the session is from this directory', log: () => log({ projectPath: sandbox.projectDir }), all: true },
  ]
  for (const c of same) {
    test(`not cross-project when ${c.name}`, () => {
      expect(checkCrossProjectResume(c.log(), c.all, [])).toEqual({ isCrossProject: false })
    })
  }

  const COMMAND = /^cd (.+) && (\S+) --resume (\S+)$/

  test('another directory: a cd into it, then a resume of the session id', () => {
    const outcome = checkCrossProjectResume(log({ projectPath: '/other/project' }), true, [])
    expect(outcome).toMatchObject({ isCrossProject: true, isSameRepoWorktree: false, projectPath: '/other/project' })
    const [, target, , session] = (outcome as { command: string }).command.match(COMMAND)!
    expect([target, session]).toEqual(['/other/project', SESSION])
  })

  test('a worktree of the same repository is still treated as another project', () => {
    const worktree = join(sandbox.root, 'worktrees', 'feature')
    const outcome = checkCrossProjectResume(log({ projectPath: worktree }), true, [sandbox.projectDir, worktree])
    expect(outcome).toMatchObject({ isCrossProject: true, isSameRepoWorktree: false, projectPath: worktree })
  })

  test('the session id falls back to the first message’s', () => {
    const outcome = checkCrossProjectResume(
      log({ projectPath: '/other/project', sessionId: undefined, messages: [{ sessionId: 'from-message' }] as never }),
      true,
      [],
    )
    expect((outcome as { command: string }).command.match(COMMAND)![3]).toBe('from-message')
  })

  test('the directory is shell-quoted, so the cd lands in it whatever its name holds', () => {
    const awkward = join(sandbox.root, `it's a "dir"; echo pwned $(id) && x`)
    mkdirSync(awkward, { recursive: true })
    const { command } = checkCrossProjectResume(log({ projectPath: awkward }), true, []) as { command: string }
    const [, quoted] = command.match(COMMAND)!
    const shell = Bun.spawnSync(['bash', '-c', `cd ${quoted} && pwd`])
    expect(shell.exitCode).toBe(0)
    expect(shell.stdout.toString().trim()).toBe(awkward)
  })
})
