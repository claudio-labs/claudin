// Re-root round trip.
//
// rerootSession() mutates process-wide state — process.cwd() plus three
// bootstrap-state fields — and this suite shares one process with every other
// test file, so each test restores exactly what it moved.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getClaudeMdDeltaAttachment } from 'src/agent/attachments/injections.js'
import { getGitStatus, getSystemContext, getUserContext } from 'src/agent/context.js'
import { clearMemoryFileCaches } from 'src/memory/instructions/claudemd.js'
import type { Message } from 'src/shared/types/message.js'
import {
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  getSessionProjectDir,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import {
  __resetForTests as resetToolResultCache,
  getCached,
  setCached,
} from 'src/agent/tools/toolResultCache.js'
import { getTranscriptPath } from 'src/sessions/pure/paths.js'
import {
  getPreviousSessionDir,
  rerootSession,
} from 'src/sessions/rerootSession.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { setCwd } from 'src/shared/proc/Shell.js'
import { getBranch } from 'src/vcs/git/git.js'
import { resetGitFileWatcher } from 'src/vcs/git/gitFilesystem.js'

let target: string
let restore: () => void

beforeEach(async () => {
  const processCwd = process.cwd()
  const cwd = getCwd()
  const originalCwd = getOriginalCwd()
  const projectRoot = getProjectRoot()
  const sessionId = getSessionId()
  const sessionProjectDir = getSessionProjectDir()
  restore = () => {
    process.chdir(processCwd)
    setCwd(cwd)
    setOriginalCwd(originalCwd)
    setProjectRoot(projectRoot)
    switchSession(sessionId, sessionProjectDir)
  }
  target = realpathSync(await mkdtemp(join(tmpdir(), 'reroot-')))
})

afterEach(async () => {
  restore()
  resetToolResultCache()
  await rm(target, { recursive: true, force: true })
})

test('drops tool results that were cached against the old directory', () => {
  // Cache keys are `tool::input` with no cwd component, so a relative-path
  // Glob/Grep/Read would otherwise serve a hit resolved against the old dir.
  resetToolResultCache()
  setCached('Glob', { pattern: '*.md' }, ['README.md'])
  expect(getCached('Glob', { pattern: '*.md' })).toBeDefined()

  rerootSession(target)

  expect(getCached('Glob', { pattern: '*.md' })).toBeUndefined()
})

test('moves the process cwd, the session root and the project identity', () => {
  const before = getCwd()

  const result = rerootSession(target)

  expect(result).toEqual({ previousCwd: before, newCwd: target })
  expect(getCwd()).toBe(target)
  expect(getOriginalCwd()).toBe(target)
  expect(getProjectRoot()).toBe(target)
  expect(realpathSync(process.cwd())).toBe(target)
})

test('pins the transcript so the .jsonl does not follow the move', () => {
  // Without the switchSession pin, getTranscriptPath() re-derives from the
  // new originalCwd and the session's log splits across two project dirs.
  const before = getTranscriptPath()

  rerootSession(target)

  expect(getTranscriptPath()).toBe(before)
})

test('remembers the directory it left, for /cd -', () => {
  const start = getCwd()

  rerootSession(target)
  expect(getPreviousSessionDir()).toBe(start)

  rerootSession(start)
  expect(getPreviousSessionDir()).toBe(target)
  expect(getCwd()).toBe(start)
})

test('a missing target throws and leaves the session where it was', () => {
  const before = {
    cwd: getCwd(),
    originalCwd: getOriginalCwd(),
    projectRoot: getProjectRoot(),
    processCwd: process.cwd(),
  }

  expect(() => rerootSession(join(target, 'nope'))).toThrow(/does not exist/)

  expect(getCwd()).toBe(before.cwd)
  expect(getOriginalCwd()).toBe(before.originalCwd)
  expect(getProjectRoot()).toBe(before.projectRoot)
  expect(process.cwd()).toBe(before.processCwd)
})

// /cd into another project: the model was told the new directory (env_delta)
// and kept the old one's AGENTS.md, rules and memory indexes until a
// compaction, because the delta read a memo nothing cleared (2026-11-11).
test('the instructions of the new directory are announced after the move', async () => {
  const other = realpathSync(await mkdtemp(join(tmpdir(), 'reroot-other-')))
  try {
    await writeFile(join(target, 'AGENTS.md'), 'ALPHA-INSTRUCTIONS\n')
    await writeFile(join(other, 'AGENTS.md'), 'BRAVO-INSTRUCTIONS\n')

    rerootSession(target)
    getUserContext.cache.clear?.()
    const [first] = (await getClaudeMdDeltaAttachment([])) as Array<{ addedContent: string }>
    expect(first?.addedContent).toContain('ALPHA-INSTRUCTIONS')
    const announced = { type: 'attachment', attachment: first } as unknown as Message

    rerootSession(other)
    const [second] = (await getClaudeMdDeltaAttachment([announced])) as Array<{ addedContent: string }>
    expect(second?.addedContent).toContain('BRAVO-INSTRUCTIONS')
    expect(second?.addedContent).not.toContain('ALPHA-INSTRUCTIONS')
  } finally {
    getUserContext.cache.clear?.()
    clearMemoryFileCaches()
    await rm(other, { recursive: true, force: true })
  }
})

test('the git status snapshot is dropped with the directory it described', async () => {
  await getGitStatus()
  await getSystemContext()
  expect(getSystemContext.cache.has(undefined)).toBe(true)

  rerootSession(target)

  expect(getSystemContext.cache.has(undefined)).toBe(false)
  expect(getGitStatus.cache.has(undefined)).toBe(false)
})

// The watcher caches the branch, HEAD, remote and default branch of the repo
// it started on, and re-reads only when THAT repo's files change. After a /cd
// the new directory's git status was announced under the old one's branch
// (live, 2026-11-11: "BRAVO, alpha-branch"), and the footer kept it too.
test('the branch is the new directory’s after the move', async () => {
  const other = realpathSync(await mkdtemp(join(tmpdir(), 'reroot-other-')))
  try {
    spawnSync('git', ['init', '-q', '-b', 'alpha-branch'], { cwd: target })
    spawnSync('git', ['init', '-q', '-b', 'bravo-branch'], { cwd: other })

    rerootSession(target)
    expect(await getBranch()).toBe('alpha-branch')

    rerootSession(other)
    expect(await getBranch()).toBe('bravo-branch')
  } finally {
    // Not left on a directory this test deletes.
    resetGitFileWatcher()
    await rm(other, { recursive: true, force: true })
  }
})
