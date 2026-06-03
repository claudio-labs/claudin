// Characterization tests for src/utils/sessionStorage.ts, written before the
// 11c split (ROADMAP.md). Locks in observable JSONL/chain behavior so the
// upcoming module-extraction PR can't regress /resume or the stable-stub
// compression contract silently.
//
// Wave 0 only — no production code is modified by this test file. The
// directory src/utils/sessionStorage/ exists solely to host this fixture
// until the split lands.

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'

import {
  resetStateForTests,
  setOriginalCwd,
  switchSession,
} from 'src/bootstrap/state.js'
import { asSessionId } from 'src/types/ids.js'
import { resetGlobalConfigForTests } from 'src/utils/config.js'
import {
  flushSessionStorage,
  getProjectDir,
  getTranscriptPath,
  recordTranscript,
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
} from 'src/utils/sessionStorage.js'

const ORIGINAL_CWD = process.cwd()
const ORIGINAL_CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR
const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_TEST_PERSIST = process.env.TEST_ENABLE_SESSION_PERSISTENCE

let tmpDir: string

beforeEach(async () => {
  // Unwind any mock.module aliases left behind by upstream tests in the same
  // worker (toolResultSummarizer.integration.test.ts re-aliases analytics
  // modules and forks our project singleton).
  mock.restore()
  process.env.NODE_ENV = 'test'
  // Project.shouldSkipPersistence() short-circuits when NODE_ENV=test unless
  // this env opt-in is set. Required for any test that exercises the
  // gravação real para disco (record* / appendEntry / flushSessionStorage).
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  tmpDir = await mkdtemp(join(tmpdir(), 'sessstor-char-'))
  process.env.CLAUDIN_CONFIG_DIR = tmpDir
  // See team memory bun-test-global-config-isolation.md: reset the in-memory
  // global config singleton to defend against state leaked by upstream tests
  // in the same worker (--max-concurrency=1).
  resetGlobalConfigForTests()
  resetStateForTests()
  resetProjectForTesting()
  resetProjectFlushStateForTesting()
  // See pure.test.ts: clear the lodash memoize on getProjectDir so a prior
  // suite's CLAUDIN_CONFIG_DIR doesn't leak into this run via the cwd key.
  ;(
    getProjectDir as unknown as { cache: { clear: () => void } }
  ).cache.clear()
  // Force originalCwd to our tmpDir so upstream tests that called
  // setOriginalCwd() (e.g. toolResultSummarizer.integration.test.ts) can't
  // leak their tempRoot.
  setOriginalCwd(tmpDir)
  // New deterministic session per test — switchSession also resets
  // sessionProjectDir to null so getTranscriptPath derives from originalCwd
  // (which is still ORIGINAL_CWD after resetStateForTests).
  switchSession(asSessionId(randomUUID()))
})

afterEach(async () => {
  await flushSessionStorage()
  resetProjectForTesting()
  resetProjectFlushStateForTesting()
  await rm(tmpDir, { recursive: true, force: true })
})

afterAll(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.CLAUDIN_CONFIG_DIR
  } else {
    process.env.CLAUDIN_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
  }
  if (ORIGINAL_TEST_PERSIST === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = ORIGINAL_TEST_PERSIST
  }
  process.chdir(ORIGINAL_CWD)
  resetGlobalConfigForTests()
})

const TS = '2026-04-02T00:00:00.000Z'

function deterministicUuid(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`
}

function baseMeta(uuid: string, parentUuid: string | null) {
  return {
    uuid: uuid as UUID,
    parentUuid: parentUuid as UUID | null,
    timestamp: TS,
    cwd: ORIGINAL_CWD,
    userType: 'external',
    version: 'test',
    isSidechain: false,
  }
}

function mkUser(uuid: string, parentUuid: string | null, text: string) {
  return {
    ...baseMeta(uuid, parentUuid),
    type: 'user' as const,
    isMeta: false,
    message: {
      role: 'user' as const,
      content: text,
    },
  }
}

function mkAssistant(uuid: string, parentUuid: string | null, text: string) {
  return {
    ...baseMeta(uuid, parentUuid),
    type: 'assistant' as const,
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant' as const,
      content: [{ type: 'text', text }],
      model: 'test-model',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

const TS_RE = /"timestamp":"[^"]+"/g
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

function redact(raw: string, dirs: string[] = []): string {
  let s = raw
  for (const d of dirs) {
    if (d) s = s.split(d).join('<TMP>')
  }
  s = s.replace(TS_RE, '"timestamp":"<TS>"')
  const seen = new Map<string, string>()
  s = s.replace(UUID_RE, raw => {
    if (!seen.has(raw)) seen.set(raw, `UUID_${seen.size}`)
    return seen.get(raw)!
  })
  return s
}

// Wave 0 checkpoint: prove that recordTranscript → flush → read raw JSONL
// round-trip is reachable from a test. If this passes the rest of the
// Project-side blocks can reuse the same beforeEach setup.
test('recordTranscript linear: writes user/assistant pair as JSONL with chained parentUuid', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const u1 = mkUser(deterministicUuid(1), null, 'hello') as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a1 = mkAssistant(deterministicUuid(2), deterministicUuid(1), 'hi') as any

  await recordTranscript([u1, a1])
  await flushSessionStorage()

  const path = getTranscriptPath()
  const raw = await readFile(path, 'utf8')
  const lines = raw.split('\n').filter(l => l.length > 0)
  expect(lines.length).toBeGreaterThanOrEqual(2)

  const parsed = lines.map(l => JSON.parse(l) as Record<string, unknown>)
  const chainOnly = parsed
    .filter(e => e.type === 'user' || e.type === 'assistant')
    .map(e => ({ type: e.type, uuid: e.uuid, parentUuid: e.parentUuid }))

  expect(redact(JSON.stringify(chainOnly, null, 2), [tmpDir, ORIGINAL_CWD])).toMatchSnapshot()
})
