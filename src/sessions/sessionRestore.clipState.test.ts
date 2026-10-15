/**
 * The main thread's clipped set across a resume — the `clip-state` transcript
 * entry. It is written at each clip event, read back last-wins, cleared by a
 * compact boundary, and restored by --resume, -c and /resume. Without it a
 * resumed process sent every clipped result in full again and missed the
 * cache from the first one on (resumePrefixDeterminism.test.ts pins the bytes).
 *
 * Setup mirrors sessionRestore.costState.test.ts: persistence opted in,
 * CLAUDIN_CONFIG_DIR and the session's project dir on a temp dir, and every
 * process-global this touches put back in afterAll.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  _resetAllClippedIdsForTesting,
  addClippedIds,
  addClippedInputs,
  getClippedIds,
  getClippedInputFields,
  restoreClippedState,
  snapshotClippedState,
} from 'src/agent/compact/stableStubState.js'
import { resetStateForTests, switchSession } from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import { loadConversationForResume } from 'src/sessions/conversationRecovery.js'
import { getLastSessionLog, loadFullLog } from 'src/sessions/indexing/liteMetadata.js'
import { appendEntryToFile } from 'src/sessions/persistence/_helpers.js'
import { resetProjectForTesting, setSessionFileForTesting } from 'src/sessions/persistence/project.js'
import { clearSessionMessagesCache } from 'src/sessions/resume/cache.js'
import { saveClipState } from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { LogOption } from 'src/shared/types/logs.js'

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'NODE_ENV',
  'TEST_ENABLE_SESSION_PERSISTENCE',
  'CLAUDIN_SKIP_PROMPT_HISTORY',
  'CLAUDIN_SIMPLE',
] as const
const savedEnv = new Map<string, string | undefined>()

let tmpDir: string

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'clip-state-'))
  process.env.CLAUDIN_CONFIG_DIR = tmpDir
  process.env.NODE_ENV = 'test'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  delete process.env.CLAUDIN_SKIP_PROMPT_HISTORY
  resetGlobalConfigForTests()
  resetProjectForTesting()
  _resetAllClippedIdsForTesting()
})

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(async () => {
  restoreEnv()
  clearSessionMessagesCache()
  resetProjectForTesting()
  _resetAllClippedIdsForTesting()
  await rm(tmpDir, { recursive: true, force: true })
})

afterAll(() => {
  restoreEnv()
  resetStateForTests()
  resetProjectForTesting()
  resetGlobalConfigForTests()
})

/** A session whose transcript lives in tmpDir: one prompt, one reply. */
function openSession(): { sid: UUID; path: string } {
  const sid = randomUUID()
  switchSession(asSessionId(sid), tmpDir)
  const path = join(tmpDir, `${sid}.jsonl`)
  const base = { sessionId: sid, isSidechain: false, cwd: tmpDir, userType: 'external', version: 'test' }
  appendEntryToFile(path, {
    ...base,
    parentUuid: null,
    uuid: `${sid.slice(0, 8)}-0000-4000-8000-000000000001`,
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'user',
    message: { role: 'user', content: 'go' },
  })
  appendEntryToFile(path, {
    ...base,
    parentUuid: `${sid.slice(0, 8)}-0000-4000-8000-000000000001`,
    uuid: `${sid.slice(0, 8)}-0000-4000-8000-000000000002`,
    timestamp: '2026-10-15T10:00:05.000Z',
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'done' }] },
  })
  setSessionFileForTesting(path)
  return { sid, path }
}

function liteLog(sid: UUID, path: string): LogOption {
  const now = new Date()
  return {
    date: now.toISOString(),
    messages: [],
    fullPath: path,
    value: 0,
    created: now,
    modified: now,
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    isLite: true,
    sessionId: sid,
  }
}

/** What the next process holds after restoring `log`. */
function restoredFrom(log: { clipState?: Parameters<typeof restoreClippedState>[0] } | null | undefined) {
  _resetAllClippedIdsForTesting()
  restoreClippedState(log?.clipState)
  return {
    resultIds: [...getClippedIds()].sort(),
    inputFields: Object.fromEntries(getClippedInputFields()),
  }
}

describe('clip-state — written, read back, restored', () => {
  test('a clip event round-trips through --resume <id>', async () => {
    const { sid } = openSession()
    addClippedIds(['toolu_a', 'toolu_b'])
    addClippedInputs('toolu_w', ['content'])
    saveClipState(snapshotClippedState())

    expect(restoredFrom(await getLastSessionLog(sid))).toEqual({
      resultIds: ['toolu_a', 'toolu_b'],
      inputFields: { toolu_w: ['content'] },
    })
  })

  test('the last clip event wins', async () => {
    const { sid } = openSession()
    addClippedIds(['toolu_a'])
    saveClipState(snapshotClippedState())
    addClippedIds(['toolu_b'])
    saveClipState(snapshotClippedState())

    expect(restoredFrom(await getLastSessionLog(sid)).resultIds).toEqual(['toolu_a', 'toolu_b'])
  })

  test('-c and --resume <file>.jsonl carry it too', async () => {
    const { sid, path } = openSession()
    addClippedIds(['toolu_a'])
    saveClipState(snapshotClippedState())

    expect(restoredFrom(await loadFullLog(liteLog(sid, path))).resultIds).toEqual(['toolu_a'])
    process.env.CLAUDIN_SIMPLE = '1' // bare mode: no SessionStart hooks
    expect(restoredFrom(await loadConversationForResume('fixture', path)).resultIds).toEqual(['toolu_a'])
  })

  test('a compact boundary after it drops it: compaction reset the set', async () => {
    const { sid, path } = openSession()
    addClippedIds(['toolu_a'])
    saveClipState(snapshotClippedState())
    appendEntryToFile(path, {
      sessionId: sid,
      isSidechain: false,
      cwd: tmpDir,
      userType: 'external',
      version: 'test',
      parentUuid: null,
      uuid: `${sid.slice(0, 8)}-0000-4000-8000-000000000003`,
      timestamp: '2026-10-15T10:01:00.000Z',
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compactMetadata: { trigger: 'auto', preTokens: 1000 },
    })

    expect(restoredFrom(await getLastSessionLog(sid)).resultIds).toEqual([])
  })

  test('a malformed entry is skipped', async () => {
    const { sid, path } = openSession()
    addClippedIds(['toolu_a'])
    saveClipState(snapshotClippedState())
    appendEntryToFile(path, { type: 'clip-state', sessionId: sid, resultIds: 'toolu_b', inputFields: {} })

    expect(restoredFrom(await getLastSessionLog(sid)).resultIds).toEqual(['toolu_a'])
  })
})
