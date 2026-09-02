// Re-root round trip.
//
// rerootSession() mutates process-wide state — process.cwd() plus three
// bootstrap-state fields — and this suite shares one process with every other
// test file, so each test restores exactly what it moved.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
