/**
 * The session's running cost across a resume — Claude Code's `cost-state`
 * transcript entry (2.1.280). It is stamped at exit and before /clear or
 * /resume switch away, read back last-wins, and restored ahead of the
 * project-config slot (one session wide) and of replaying the messages
 * (which cannot see sub-agents). Without it, `-p --resume` reported only the
 * resumed process's spend as `total_cost_usd`.
 *
 * Setup mirrors src/sessions/__tests__/project.test.ts: persistence opted
 * in, CLAUDIN_CONFIG_DIR and the session's project dir on a temp dir, and
 * every process-global this touches put back in afterAll.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addToTotalLinesChanged,
  addToTotalSessionCost,
  getCostSinceRestoreUSD,
  getCostStateEntryFor,
  getTotalCacheReadInputTokens,
  getTotalCost,
  getTotalLinesAdded,
  getTotalOutputTokens,
  hasUnknownModelCost,
  resetCostState,
  resetCostStateOwnerForTesting,
  restoreCostStateForResume,
  restoreCostStateForSession,
  saveCurrentSessionCosts,
} from 'src/agent/cost-tracker.js'
import {
  resetStateForTests,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import { loadConversationForResume } from 'src/sessions/conversationRecovery.js'
import {
  getLastSessionLog,
  loadFullLog,
} from 'src/sessions/indexing/liteMetadata.js'
import { appendEntryToFile } from 'src/sessions/persistence/_helpers.js'
import {
  getProject,
  resetProjectForTesting,
  setSessionFileForTesting,
} from 'src/sessions/persistence/project.js'
import { clearSessionMessagesCache } from 'src/sessions/resume/cache.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { CostStateEntry, LogOption } from 'src/shared/types/logs.js'

const MODEL = 'claude-sonnet-4-5-20250514'
const NO_PROJECT_CONFIG = { restoreFromProjectConfig: () => false }

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'NODE_ENV',
  'TEST_ENABLE_SESSION_PERSISTENCE',
  'CLAUDIN_SKIP_PROMPT_HISTORY',
  'CLAUDIN_SIMPLE',
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
  tmpDir = await mkdtemp(join(tmpdir(), 'cost-state-'))
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

// --- fixture ---------------------------------------------------------------

function usage(o: { input: number; output: number; cacheRead: number }) {
  return {
    input_tokens: o.input,
    output_tokens: o.output,
    cache_read_input_tokens: o.cacheRead,
    cache_creation_input_tokens: 0,
  } as Parameters<typeof addToTotalSessionCost>[1]
}

/** A new session whose transcript lives in tmpDir, counters at zero. */
function openSession(): { sid: UUID; path: string } {
  const sid = randomUUID()
  switchSession(asSessionId(sid), tmpDir)
  resetCostState()
  const path = join(tmpDir, `${sid}.jsonl`)
  const base = {
    sessionId: sid,
    isSidechain: false,
    cwd: tmpDir,
    userType: 'external',
    version: 'test',
  }
  appendEntryToFile(path, {
    ...base,
    parentUuid: null,
    uuid: `${sid.slice(0, 8)}-0000-4000-8000-000000000001`,
    timestamp: '2026-09-23T10:00:00.000Z',
    type: 'user',
    message: { role: 'user', content: 'go' },
  })
  // What a replay of the messages would rebuild — deliberately not what the
  // cost-state entries below say, so the source that won is observable.
  appendEntryToFile(path, {
    ...base,
    parentUuid: `${sid.slice(0, 8)}-0000-4000-8000-000000000001`,
    uuid: `${sid.slice(0, 8)}-0000-4000-8000-000000000002`,
    timestamp: '2026-09-23T10:00:05.000Z',
    type: 'assistant',
    message: {
      id: 'msg_replayed',
      model: MODEL,
      role: 'assistant',
      type: 'message',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: usage({ input: 10, output: 20, cacheRead: 1_000 }),
    },
  })
  setSessionFileForTesting(path)
  return { sid, path }
}

/** A hand-written entry: what an earlier process stamped for `sid`. */
function stamped(sid: UUID, totalCostUSD: number): CostStateEntry {
  return {
    type: 'cost-state',
    sessionId: sid,
    totalCostUSD,
    totalAPIDuration: 42_000,
    totalAPIDurationWithoutRetries: 41_000,
    totalToolDuration: 7_000,
    totalLinesAdded: 12,
    totalLinesRemoved: 3,
    totalDuration: 90_000,
    startTime: Date.parse('2026-09-23T10:00:00.000Z'),
    modelUsage: {
      [MODEL]: {
        inputTokens: 15,
        outputTokens: 1_300,
        cacheReadInputTokens: 250_000,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: totalCostUSD,
      },
    },
  }
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

async function readEntries(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

// --- tests -----------------------------------------------------------------

describe('cost-state — written, read back, restored', () => {
  test('the exit stamp round-trips: `-p --resume <id>` restores its totals', async () => {
    const { sid } = openSession()
    addToTotalSessionCost(0.75, usage({ input: 12, output: 900, cacheRead: 150_000 }), MODEL)
    addToTotalSessionCost(0.5, usage({ input: 3, output: 400, cacheRead: 100_000 }), MODEL)
    addToTotalLinesChanged(12, 3)
    const written = {
      cost: getTotalCost(),
      cacheRead: getTotalCacheReadInputTokens(),
      output: getTotalOutputTokens(),
      lines: getTotalLinesAdded(),
    }

    getProject().reAppendCostState()
    resetCostState() // the resuming process starts from zero

    const log = await getLastSessionLog(sid)
    const source = restoreCostStateForResume(sid, log!, NO_PROJECT_CONFIG)

    expect(source).toBe('cost-state')
    expect(getTotalCost()).toBe(written.cost)
    expect(getTotalCacheReadInputTokens()).toBe(written.cacheRead)
    expect(getTotalOutputTokens()).toBe(written.output)
    expect(getTotalLinesAdded()).toBe(written.lines)
  })

  test('with two entries the last one wins', async () => {
    const { sid, path } = openSession()
    appendEntryToFile(path, stamped(sid, 1))
    appendEntryToFile(path, stamped(sid, 2.5))

    const log = await getLastSessionLog(sid)
    restoreCostStateForResume(sid, log!, NO_PROJECT_CONFIG)

    expect(getTotalCost()).toBe(2.5)
  })

  test("an entry Claude Code's schema rejects does not win", async () => {
    const { sid, path } = openSession()
    appendEntryToFile(path, stamped(sid, 2.5))
    appendEntryToFile(path, { ...stamped(sid, 9), totalCostUSD: -1 })

    const log = await getLastSessionLog(sid)
    restoreCostStateForResume(sid, log!, NO_PROJECT_CONFIG)

    expect(getTotalCost()).toBe(2.5)
  })

  test('-c and --resume <file>.jsonl carry it too', async () => {
    const { sid, path } = openSession()
    appendEntryToFile(path, stamped(sid, 2.5))

    const continued = await loadFullLog(liteLog(sid, path))
    expect(continued.costState?.totalCostUSD).toBe(2.5)

    process.env.CLAUDIN_SIMPLE = '1' // bare mode: no SessionStart hooks
    const fromFile = await loadConversationForResume('fixture', path)
    expect(fromFile?.costState?.totalCostUSD).toBe(2.5)
  })

  test('a stamp compaction left before the boundary of a large transcript is still found', async () => {
    const { sid, path } = openSession()
    appendEntryToFile(path, stamped(sid, 2.5))
    // Past SKIP_PRECOMPACT_THRESHOLD (5 MB) the loader skips everything before
    // the last compact boundary and recovers metadata by a byte scan.
    const filler = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 6; i++) {
      appendEntryToFile(path, {
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: filler },
        uuid: randomUUID(),
        sessionId: sid,
        timestamp: '2026-09-23T10:01:00.000Z',
        isSidechain: false,
      })
    }
    const boundary = randomUUID()
    appendEntryToFile(path, {
      parentUuid: null,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      uuid: boundary,
      sessionId: sid,
      timestamp: '2026-09-23T10:02:00.000Z',
      isSidechain: false,
      cwd: tmpDir,
      userType: 'external',
      version: 'test',
    })
    appendEntryToFile(path, {
      parentUuid: boundary,
      type: 'user',
      message: { role: 'user', content: 'after the boundary' },
      uuid: randomUUID(),
      sessionId: sid,
      timestamp: '2026-09-23T10:03:00.000Z',
      isSidechain: false,
      cwd: tmpDir,
      userType: 'external',
      version: 'test',
    })

    const log = await getLastSessionLog(sid)

    expect(log?.costState?.totalCostUSD).toBe(2.5)
  })

  test('saving costs before /clear or /resume switch away stamps the session', async () => {
    const { sid, path } = openSession()
    addToTotalSessionCost(0.75, usage({ input: 12, output: 900, cacheRead: 150_000 }), MODEL)

    saveCurrentSessionCosts()

    const stamps = (await readEntries(path)).filter(e => e.type === 'cost-state')
    expect(stamps.at(-1)).toMatchObject({ sessionId: sid, totalCostUSD: 0.75 })
  })
})

describe('restoreCostStateForResume — what every resume path calls', () => {
  test('the entry wins over the project-config slot and over replaying the messages', () => {
    const { sid } = openSession()
    const consulted: string[] = []
    const entry = { ...stamped(sid, 2.5), hasUnknownModelCost: true }

    const source = restoreCostStateForResume(
      sid,
      {
        costState: entry,
        messages: [{ type: 'assistant', message: { id: 'm', model: MODEL, usage: usage({ input: 1, output: 1, cacheRead: 1 }) } }],
      },
      { restoreFromProjectConfig: id => (consulted.push(id), true) },
    )

    expect(source).toBe('cost-state')
    expect(consulted).toEqual([])
    expect(getTotalCost()).toBe(2.5)
    expect(getTotalCacheReadInputTokens()).toBe(250_000)
    expect(hasUnknownModelCost()).toBe(true)
    // The next stamp keeps the session's first start, not this process's.
    expect(getCostStateEntryFor(sid)?.startTime).toBe(entry.startTime)
  })

  test('the restored cost stays separate: a budget counts only what this process spends', () => {
    const { sid } = openSession()
    restoreCostStateForResume(sid, { costState: stamped(sid, 1.5), messages: [] }, NO_PROJECT_CONFIG)
    expect(getCostSinceRestoreUSD()).toBe(0)

    addToTotalSessionCost(0.25, usage({ input: 1, output: 10, cacheRead: 100 }), MODEL)

    expect(getTotalCost()).toBe(1.75)
    expect(getCostSinceRestoreUSD()).toBe(0.25)
  })

  test('every source counts as restored, and a reset starts the budget over', () => {
    const { sid } = openSession()
    const fromConfig = restoreCostStateForResume(
      sid,
      { messages: [] },
      {
        // The real slot on a match: it disowns the counters (it cannot vouch
        // for them) and puts the saved totals back. The temp config holds no
        // match, so the real call contributes the disowning alone.
        restoreFromProjectConfig: id => (
          restoreCostStateForSession(id),
          addToTotalSessionCost(0.75, usage({ input: 1, output: 1, cacheRead: 1 }), MODEL),
          true
        ),
      },
    )
    expect(fromConfig).toBe('project-config')
    expect(getTotalCost()).toBe(0.75)
    expect(getCostSinceRestoreUSD()).toBe(0)
    // The resume vouches for them again: the exit may stamp this session.
    expect(getCostStateEntryFor(sid)?.totalCostUSD).toBe(0.75)

    const fromMessages = restoreCostStateForResume(
      sid,
      { messages: [{ type: 'assistant', message: { id: 'm', model: MODEL, usage: usage({ input: 10, output: 20, cacheRead: 1_000 }) } }] },
      NO_PROJECT_CONFIG,
    )
    expect(fromMessages).toBe('messages')
    expect(getTotalCost()).toBeGreaterThan(0)
    expect(getCostSinceRestoreUSD()).toBe(0)

    resetCostState() // /clear, /branch: what follows is all this process's
    addToTotalSessionCost(0.25, usage({ input: 1, output: 10, cacheRead: 100 }), MODEL)
    expect(getCostSinceRestoreUSD()).toBe(0.25)
  })

  test("a fresh session's first stamp claims the counters", () => {
    resetCostStateOwnerForTesting()
    const d = randomUUID()
    switchSession(asSessionId(d), tmpDir) // --session-id, or the startup id

    expect(getCostStateEntryFor(d)?.sessionId).toBe(d)
  })

  test('a session reached without that restore gets no entry: its counters hold only part of its cost', () => {
    const a = openSession()
    restoreCostStateForResume(a.sid, { costState: stamped(a.sid, 1.5), messages: [] }, NO_PROJECT_CONFIG)
    expect(getCostStateEntryFor(a.sid)?.totalCostUSD).toBe(1.5)

    // A reset, then a switchSession that no restore follows: the counters
    // are not the target's cost.
    resetCostState()
    const b = randomUUID()
    switchSession(asSessionId(b), tmpDir)
    expect(getCostStateEntryFor(b)).toBeUndefined()

    // Before anything claimed the counters: switchSession, then the
    // project-config slot alone, which cannot vouch for the whole cost.
    resetCostStateOwnerForTesting()
    const c = randomUUID()
    switchSession(asSessionId(c), tmpDir)
    restoreCostStateForSession(c)
    expect(getCostStateEntryFor(c)).toBeUndefined()
  })
})
