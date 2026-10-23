import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'crypto'

import { resetStateForTests, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import * as sessionIngress from 'src/providers/transport/sessionIngress.js'
import { hydrateRemoteSession } from 'src/sessions/persistence/project.js'
import {
  getProjectDir,
  getTranscriptPathForSession,
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
} from 'src/sessions/sessionStorage.js'

const ORIGINAL_CWD = process.cwd()
const ORIGINAL_CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR
const LOCAL = '{"type":"user","uuid":"local-1"}\n'

let tmpDir: string

beforeEach(async () => {
  mock.restore()
  tmpDir = await mkdtemp(join(tmpdir(), 'hydrate-remote-'))
  process.env.CLAUDIN_CONFIG_DIR = tmpDir
  resetGlobalConfigForTests()
  resetStateForTests()
  resetProjectForTesting()
  resetProjectFlushStateForTesting()
  ;(getProjectDir as unknown as { cache: { clear: () => void } }).cache.clear()
  setOriginalCwd(tmpDir)
})

afterEach(async () => {
  mock.restore()
  resetProjectForTesting()
  resetProjectFlushStateForTesting()
  await rm(tmpDir, { recursive: true, force: true })
})

afterAll(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  setOriginalCwd(ORIGINAL_CWD)
  resetStateForTests()
  resetProjectForTesting()
  resetGlobalConfigForTests()
})

async function withLocalTranscript(): Promise<{ sessionId: string; path: string }> {
  const sessionId = randomUUID()
  const path = getTranscriptPathForSession(sessionId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, LOCAL)
  return { sessionId, path }
}

test('replaces the local transcript with what the remote returns', async () => {
  const { sessionId, path } = await withLocalTranscript()
  const remote = [{ type: 'user', uuid: 'remote-1' }]
  spyOn(sessionIngress, 'getSessionLogs').mockResolvedValue(remote as never)

  expect(await hydrateRemoteSession(sessionId, 'http://127.0.0.1:9/unused')).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('{"type":"user","uuid":"remote-1"}\n')
})

test('keeps the local transcript when the remote fetch fails', async () => {
  const { sessionId, path } = await withLocalTranscript()
  spyOn(sessionIngress, 'getSessionLogs').mockResolvedValue(null)

  expect(await hydrateRemoteSession(sessionId, 'http://127.0.0.1:9/unused')).toBe(false)
  expect(await readFile(path, 'utf8')).toBe(LOCAL)
})

test('keeps the local transcript when the remote returns no entries', async () => {
  const { sessionId, path } = await withLocalTranscript()
  spyOn(sessionIngress, 'getSessionLogs').mockResolvedValue([])

  expect(await hydrateRemoteSession(sessionId, 'http://127.0.0.1:9/unused')).toBe(false)
  expect(await readFile(path, 'utf8')).toBe(LOCAL)
})
