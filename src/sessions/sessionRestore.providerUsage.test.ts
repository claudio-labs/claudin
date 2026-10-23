/**
 * The spend by provider survives a resume through the transcript's
 * `cost-state` entry. The loader's zod schema (resume/transcriptLoad.ts)
 * strips every key it does not declare, which is how `sourceUsage` was once
 * lost; `providerUsage` went the same way until it was declared. Harness
 * copied from sessionRestore.costState.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addToTotalSessionCost,
  getModelUsage,
  getProviderUsage,
  resetCostState,
  resetCostStateOwnerForTesting,
  restoreCostStateForResume,
} from 'src/agent/cost-tracker.js'
import { resetStateForTests, switchSession } from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import { getLastSessionLog } from 'src/sessions/indexing/liteMetadata.js'
import { appendEntryToFile } from 'src/sessions/persistence/_helpers.js'
import {
  getProject,
  resetProjectForTesting,
  setSessionFileForTesting,
} from 'src/sessions/persistence/project.js'
import { clearSessionMessagesCache } from 'src/sessions/resume/cache.js'
import { asSessionId } from 'src/shared/types/ids.js'

const MODEL = 'claude-sonnet-4-5-20250514'
const NO_PROJECT_CONFIG = { restoreFromProjectConfig: () => false }
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'NODE_ENV',
  'TEST_ENABLE_SESSION_PERSISTENCE',
  'CLAUDIN_SKIP_PROMPT_HISTORY',
] as const
const savedEnv = new Map<string, string | undefined>()
function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
let tmpDir: string

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
})
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cost-state-repro-'))
  process.env.CLAUDIN_CONFIG_DIR = tmpDir
  process.env.NODE_ENV = 'test'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  delete process.env.CLAUDIN_SKIP_PROMPT_HISTORY
  resetGlobalConfigForTests()
  resetProjectForTesting()
})
afterEach(async () => {
  restoreEnv()
  clearSessionMessagesCache()
  resetProjectForTesting()
  await rm(tmpDir, { recursive: true, force: true })
})
afterAll(() => {
  restoreEnv()
  resetCostState()
  resetCostStateOwnerForTesting()
  resetStateForTests()
  resetProjectForTesting()
  resetGlobalConfigForTests()
})

function openSession(): { sid: UUID } {
  const sid = randomUUID()
  switchSession(asSessionId(sid), tmpDir)
  resetCostState()
  const path = join(tmpDir, `${sid}.jsonl`)
  appendEntryToFile(path, {
    sessionId: sid,
    isSidechain: false,
    cwd: tmpDir,
    userType: 'external',
    version: 'test',
    parentUuid: null,
    uuid: `${sid.slice(0, 8)}-0000-4000-8000-000000000001`,
    timestamp: '2026-09-23T10:00:00.000Z',
    type: 'user',
    message: { role: 'user', content: 'go' },
  })
  setSessionFileForTesting(path)
  return { sid }
}

test('the spend by provider round-trips through the transcript loader', async () => {
  const { sid } = openSession()
  addToTotalSessionCost(
    0.75,
    {
      input_tokens: 12,
      output_tokens: 900,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 0,
    } as Parameters<typeof addToTotalSessionCost>[1],
    MODEL,
    'repl_main_thread',
  )
  const written = getProviderUsage()
  expect(Object.keys(written).length).toBe(1)

  getProject().reAppendCostState()
  resetCostState()

  const log = await getLastSessionLog(sid)
  expect(restoreCostStateForResume(sid, log!, NO_PROJECT_CONFIG)).toBe('cost-state')

  // The per-model totals come back...
  expect(Object.keys(getModelUsage())).toEqual([MODEL])
  // ...and so must the per-provider split, or the whole resumed session's
  // spend turns into a by-name estimate in /usage.
  expect(getProviderUsage()).toEqual(written)
})
