/**
 * Integration test: static-dedup end-to-end byte reduction.
 *
 * WHY: the unit tests in *Delta.test.ts verify each scanner in
 * isolation. This file asserts the CLAIM of Phase 2 — that a session
 * with unchanged static context (CLAUDE.md, gitStatus, todo list)
 * sends measurably fewer bytes on turns 2+.
 *
 * Without this, the Phase 2 -30 to -40% body-JSON target is a
 * hypothesis with no guardrail. A future refactor could silently
 * disable one of the swap-ins (wrong conditional, renamed symbol,
 * missing gate) and every unit test would still pass while every
 * turn kept re-emitting the same content.
 *
 * SCOPE: the three scanners that REPLACE their raw counterpart —
 * claudeMd and gitStatus are stripped from the system/user context by
 * `filterStaticDedupKeys`, and the todo reminder diffs its snapshot.
 * Nested memory is NOT one of them and is deliberately absent here:
 * it has no delta scanner at all. Its raw `nested_memory` attachment
 * is emitted once per session by `memoryFilesToAttachments`, and that
 * one-copy-per-session invariant is owned by
 * `src/agent/attachments/memory.dedup.test.ts`.
 *
 * We measure with `stableStringify` — the exact same serializer the
 * openaiShim / codexShim use on the request body, so the numbers
 * reflect what a provider actually sees on the wire.
 *
 * Mirrors the integration-style of src/agent/cost-tracker.cacheIntegration
 * and src/providers/cache/cacheMetricsIntegration: real production
 * functions, no module mocking, scenario-driven assertions. Fewer
 * moving parts, and the test fails for the right reason if anyone
 * breaks the dedup path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import { appendSystemContext, prependUserContext } from 'src/providers/transport/api.js'
import { getClaudeMdDelta } from 'src/memory/instructions/claudeMdDelta.js'
import { getGitStatusDelta } from 'src/vcs/git/gitStatusDelta.js'
import { stableStringify } from 'src/shared/data/stableStringify.js'
import {
  getTodoReminderDelta,
  type TodoSnapshotItem,
} from 'src/agent/todoReminderDelta.js'

// Minimum savings ratio for turn 2+ to declare the dedup active. The
// Phase 2 plan targets -30 to -40%; we use 25% as a conservative
// guardrail so micro-fluctuations in hash length / delta metadata
// don't flap the test. Exceeding it doesn't fail; dropping below
// means dedup silently broke or a new turn-invariant got added to
// the delta payload.
const MIN_SAVINGS_RATIO = 0.25

// Realistic static content sizes observed in open-build sessions.
// CLAUDE.md: ~15KB is common in mature projects (open-source
// guidelines + repo map + team conventions).
const TYPICAL_CLAUDE_MD_SIZE = 15_000
// gitStatus: ~2KB when a handful of files are modified.
const TYPICAL_GIT_STATUS_SIZE = 2_000

// Union of the fields each scanner's local ScannableMessage reads.
// Keeping them all optional here lets a single helper array satisfy
// every scanner signature without casts.
type AttachmentMessage = {
  type: 'attachment'
  attachment: {
    type: string
    contentHash?: string
    addedNames?: string[]
    addedHashes?: string[]
    removedNames?: string[]
    snapshot?: Array<{ id: string; status: string }>
  } & Record<string, unknown>
}

/**
 * Byte length of an attachment list as the shim would serialize it.
 * Reuses stableStringify so the number matches what goes on the wire.
 */
function serialize(attachments: Array<Record<string, unknown>>): number {
  return stableStringify(attachments).length
}

/**
 * Estimated token count of a serialized attachment list, using the
 * JSON typical compression ratio of 2 chars/token — the attachment
 * payload is always JSON on the wire, so this matches what a tokenizer
 * would produce.
 *
 * Byte length (from `serialize`) is what the provider bills for
 * payload-cost providers (Copilot); token estimate is what the plan's
 * claim ("-30 to -40% body JSON") targets semantically. Asserting on
 * both closes the gap between the two units.
 */
function estimateTokens(attachments: Array<Record<string, unknown>>): number {
  return roughTokenCountEstimation(stableStringify(attachments), 2)
}

function repeat(n: number): string {
  return 'x'.repeat(n)
}

// --- Attachment shape factories --------------------------------------------
// These mirror the wrappers in src/agent/attachments/attachments.ts so the scanners
// can reconstruct prior state from the transcript.

function claudeMdDeltaMsg(
  addedContent: string,
  contentHash: string,
  isInitial: boolean,
): AttachmentMessage {
  return {
    type: 'attachment',
    attachment: {
      type: 'claude_md_delta',
      addedContent,
      contentHash,
      isInitial,
    },
  }
}

function gitStatusDeltaMsg(content: string): AttachmentMessage {
  return {
    type: 'attachment',
    attachment: { type: 'git_status_delta', content },
  }
}

function todoReminderDeltaMsg(
  snapshot: Array<{ id: string; status: string }>,
): AttachmentMessage {
  return {
    type: 'attachment',
    attachment: { type: 'todo_reminder_delta', snapshot },
  }
}

// --- Baseline shapes -------------------------------------------------------
// What would be injected WITHOUT dedup (the always-emit path today).

function baselineClaudeMd(content: string): Record<string, unknown> {
  return { type: 'user_context', claudeMd: content }
}

function baselineGitStatus(content: string): Record<string, unknown> {
  return { type: 'system_context', gitStatus: content }
}

function baselineTodoReminder(
  todos: TodoSnapshotItem[],
): Record<string, unknown> {
  return { type: 'todo_reminder', todos }
}

describe('static-dedup integration: per-scanner byte savings', () => {
  test('CLAUDE.md: turn 2+ emits zero bytes when content unchanged', () => {
    const claudeMdContent = repeat(TYPICAL_CLAUDE_MD_SIZE)
    const transcript: AttachmentMessage[] = []

    // Turn 1 — initial emission
    const turn1Delta = getClaudeMdDelta(claudeMdContent, transcript)
    expect(turn1Delta).not.toBeNull()
    expect(turn1Delta!.isInitial).toBe(true)
    expect(turn1Delta!.addedContent.length).toBe(TYPICAL_CLAUDE_MD_SIZE)
    transcript.push(
      claudeMdDeltaMsg(
        turn1Delta!.addedContent,
        turn1Delta!.contentHash,
        turn1Delta!.isInitial,
      ),
    )

    // Turn 2 & 3 — content unchanged
    expect(getClaudeMdDelta(claudeMdContent, transcript)).toBeNull()
    expect(getClaudeMdDelta(claudeMdContent, transcript)).toBeNull()

    // Byte + token accounting for turn 2 specifically. Tokens are the
    // unit the Fase 2 plan targets (-30 to -40% body JSON); bytes are
    // what Copilot bills. Both must move.
    const baselineTurn2Bytes = serialize([baselineClaudeMd(claudeMdContent)])
    const dedupTurn2Bytes = serialize([]) // null → no attachment emitted
    const byteSavings =
      (baselineTurn2Bytes - dedupTurn2Bytes) / baselineTurn2Bytes
    expect(byteSavings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)

    const baselineTurn2Tokens = estimateTokens([
      baselineClaudeMd(claudeMdContent),
    ])
    const dedupTurn2Tokens = estimateTokens([])
    const tokenSavings =
      (baselineTurn2Tokens - dedupTurn2Tokens) / baselineTurn2Tokens
    expect(tokenSavings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)
  })

  test('gitStatus: turn 2+ emits zero bytes (snapshot is immutable)', () => {
    const gitStatusSnapshot = repeat(TYPICAL_GIT_STATUS_SIZE)
    const transcript: AttachmentMessage[] = []

    const turn1Delta = getGitStatusDelta(gitStatusSnapshot, transcript)
    expect(turn1Delta).not.toBeNull()
    expect(turn1Delta!.content).toBe(gitStatusSnapshot)
    transcript.push(gitStatusDeltaMsg(turn1Delta!.content))

    // By design: subsequent turns never re-emit (snapshot is immutable)
    expect(getGitStatusDelta(gitStatusSnapshot, transcript)).toBeNull()
    expect(getGitStatusDelta(gitStatusSnapshot, transcript)).toBeNull()

    const baselineTurn2Bytes = serialize([baselineGitStatus(gitStatusSnapshot)])
    const dedupTurn2Bytes = serialize([])
    const byteSavings =
      (baselineTurn2Bytes - dedupTurn2Bytes) / baselineTurn2Bytes
    expect(byteSavings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)
  })

  test('todo reminder: turn 2+ emits zero bytes when list unchanged', () => {
    const todoSnapshot: TodoSnapshotItem[] = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `task-${index}`,
        status: 'pending',
        text: `Task number ${index} with enough context to be realistic`,
      }),
    )
    const transcript: AttachmentMessage[] = []

    const turn1Delta = getTodoReminderDelta(todoSnapshot, transcript)
    expect(turn1Delta).not.toBeNull()
    expect(turn1Delta!.isInitial).toBe(true)
    expect(turn1Delta!.added.length).toBe(10)
    transcript.push(todoReminderDeltaMsg(turn1Delta!.snapshot))

    expect(getTodoReminderDelta(todoSnapshot, transcript)).toBeNull()
    expect(getTodoReminderDelta(todoSnapshot, transcript)).toBeNull()

    const baselineTurn2Bytes = serialize([baselineTodoReminder(todoSnapshot)])
    const dedupTurn2Bytes = serialize([])
    const byteSavings =
      (baselineTurn2Bytes - dedupTurn2Bytes) / baselineTurn2Bytes
    expect(byteSavings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)
  })
})

describe('static-dedup integration: combined 3-turn session', () => {
  test('total payload across turns 2-3 is ≥25% smaller than baseline', () => {
    const claudeMdContent = repeat(TYPICAL_CLAUDE_MD_SIZE)
    const gitStatusSnapshot = repeat(TYPICAL_GIT_STATUS_SIZE)
    const todoSnapshot: TodoSnapshotItem[] = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `task-${index}`,
        status: 'pending',
        text: `Task ${index}`,
      }),
    )

    // --- Baseline (always-emit) accounting for turns 2 and 3 ---
    const bytesPerBaselineTurn = serialize([
      baselineClaudeMd(claudeMdContent),
      baselineGitStatus(gitStatusSnapshot),
      baselineTodoReminder(todoSnapshot),
    ])
    const baselineBytesTurns23 = bytesPerBaselineTurn * 2

    // --- Dedup path: simulate turn 1 emission, then measure turns 2+3 ---
    const transcript: AttachmentMessage[] = []

    // Turn 1 — initial emissions. Each scanner pushes its delta into
    // the transcript so subsequent scans can reconstruct prior state.
    const turn1ClaudeMd = getClaudeMdDelta(claudeMdContent, transcript)
    transcript.push(
      claudeMdDeltaMsg(
        turn1ClaudeMd!.addedContent,
        turn1ClaudeMd!.contentHash,
        turn1ClaudeMd!.isInitial,
      ),
    )
    const turn1GitStatus = getGitStatusDelta(gitStatusSnapshot, transcript)
    transcript.push(gitStatusDeltaMsg(turn1GitStatus!.content))
    const turn1Todo = getTodoReminderDelta(todoSnapshot, transcript)
    transcript.push(todoReminderDeltaMsg(turn1Todo!.snapshot))

    // Turn 2 — measure what gets added (expected: ~nothing).
    const turn2Additions: Record<string, unknown>[] = []
    const turn2ClaudeMd = getClaudeMdDelta(claudeMdContent, transcript)
    if (turn2ClaudeMd)
      turn2Additions.push({ type: 'claude_md_delta', ...turn2ClaudeMd })
    const turn2GitStatus = getGitStatusDelta(gitStatusSnapshot, transcript)
    if (turn2GitStatus)
      turn2Additions.push({ type: 'git_status_delta', ...turn2GitStatus })
    const turn2Todo = getTodoReminderDelta(todoSnapshot, transcript)
    if (turn2Todo)
      turn2Additions.push({ type: 'todo_reminder_delta', ...turn2Todo })

    // Turn 3 — measure what gets added.
    const turn3Additions: Record<string, unknown>[] = []
    const turn3ClaudeMd = getClaudeMdDelta(claudeMdContent, transcript)
    if (turn3ClaudeMd)
      turn3Additions.push({ type: 'claude_md_delta', ...turn3ClaudeMd })
    const turn3GitStatus = getGitStatusDelta(gitStatusSnapshot, transcript)
    if (turn3GitStatus)
      turn3Additions.push({ type: 'git_status_delta', ...turn3GitStatus })
    const turn3Todo = getTodoReminderDelta(todoSnapshot, transcript)
    if (turn3Todo)
      turn3Additions.push({ type: 'todo_reminder_delta', ...turn3Todo })

    const dedupBytesTurns23 =
      serialize(turn2Additions) + serialize(turn3Additions)
    const byteSavings =
      (baselineBytesTurns23 - dedupBytesTurns23) / baselineBytesTurns23
    expect(byteSavings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)

    // Token-level savings — matches the unit the Fase 2 plan targets.
    // Uses the JSON typical compression ratio (~2 chars/token), so the
    // number reflects what a tokenizer would produce on the wire, not
    // a hardcoded char-per-token guess.
    const baselineTokensTurns23 =
      estimateTokens([
        baselineClaudeMd(claudeMdContent),
        baselineGitStatus(gitStatusSnapshot),
        baselineTodoReminder(todoSnapshot),
      ]) * 2
    const dedupTokensTurns23 =
      estimateTokens(turn2Additions) + estimateTokens(turn3Additions)
    const tokenSavings =
      (baselineTokensTurns23 - dedupTokensTurns23) / baselineTokensTurns23
    expect(tokenSavings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)

    // Stability: turn 3 must not regress vs turn 2 (scanners idempotent
    // once state is announced).
    expect(turn3Additions.length).toBe(turn2Additions.length)
  })

  test('dedup path respects a real content change on turn 2', () => {
    // Regression guard: if CLAUDE.md actually changes turn-to-turn,
    // the delta must re-emit. A savings claim that silently dropped
    // real changes would be dangerous; make sure the "always return
    // null" path is never the accidental fast path.
    const originalContent = repeat(TYPICAL_CLAUDE_MD_SIZE)
    const changedContent = originalContent + 'NEW_SECTION'
    const transcript: AttachmentMessage[] = []

    const turn1Delta = getClaudeMdDelta(originalContent, transcript)
    transcript.push(
      claudeMdDeltaMsg(
        turn1Delta!.addedContent,
        turn1Delta!.contentHash,
        turn1Delta!.isInitial,
      ),
    )
    // Real drift: must re-emit
    const turn2Delta = getClaudeMdDelta(changedContent, transcript)
    expect(turn2Delta).not.toBeNull()
    expect(turn2Delta!.addedContent).toBe(changedContent)
    expect(turn2Delta!.isInitial).toBe(false)
  })
})

/**
 * End-to-end: compute the wire-size savings that the per-turn delta
 * pipeline actually delivers, vs. the historical always-emit baseline.
 *
 * The per-scanner tests above simulate both paths with hand-built
 * attachment arrays. This block treats the feature as a black box:
 * for each turn, build the delta payload (current behavior) and the
 * always-emit payload (historical baseline shape) and compute the
 * savings percentage that ships in the PR claim.
 */
describe('static-dedup integration: end-to-end savings', () => {
  /**
   * Build the per-turn delta payload (current production shape).
   * Scanners emit full content on turn 1 and null on turn 2+ when
   * nothing changed.
   */
  function emitDeltaTurnPayload(
    transcript: AttachmentMessage[],
    claudeMdContent: string,
    gitStatusSnapshot: string,
    todoSnapshot: TodoSnapshotItem[],
  ): Record<string, unknown>[] {
    const emitted: Record<string, unknown>[] = []
    const claudeMdDelta = getClaudeMdDelta(claudeMdContent, transcript)
    if (claudeMdDelta) {
      emitted.push({ type: 'claude_md_delta', ...claudeMdDelta })
      transcript.push(
        claudeMdDeltaMsg(
          claudeMdDelta.addedContent,
          claudeMdDelta.contentHash,
          claudeMdDelta.isInitial,
        ),
      )
    }
    const gitStatusDelta = getGitStatusDelta(gitStatusSnapshot, transcript)
    if (gitStatusDelta) {
      emitted.push({ type: 'git_status_delta', ...gitStatusDelta })
      transcript.push(gitStatusDeltaMsg(gitStatusDelta.content))
    }
    const todoDelta = getTodoReminderDelta(todoSnapshot, transcript)
    if (todoDelta) {
      emitted.push({ type: 'todo_reminder_delta', ...todoDelta })
      transcript.push(todoReminderDeltaMsg(todoDelta.snapshot))
    }
    return emitted
  }

  /**
   * Build the historical always-emit payload — every turn re-ships the
   * full static bundle. Used only as the comparison baseline; nothing
   * in the live code path emits this shape any more.
   */
  function emitBaselineTurnPayload(
    claudeMdContent: string,
    gitStatusSnapshot: string,
    todoSnapshot: TodoSnapshotItem[],
  ): Record<string, unknown>[] {
    return [
      baselineClaudeMd(claudeMdContent),
      baselineGitStatus(gitStatusSnapshot),
      baselineTodoReminder(todoSnapshot),
    ]
  }

  /** Simulate a stable N-turn session and return per-turn payload sizes. */
  function measureSession(
    turnCount: number,
    mode: 'delta' | 'baseline',
  ): { totalBytes: number; totalTokens: number; turnBytes: number[] } {
    const claudeMdContent = repeat(TYPICAL_CLAUDE_MD_SIZE)
    const gitStatusSnapshot = repeat(TYPICAL_GIT_STATUS_SIZE)
    const todoSnapshot: TodoSnapshotItem[] = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `task-${index}`,
        status: 'pending',
        text: `Task ${index}`,
      }),
    )

    const transcript: AttachmentMessage[] = []
    let totalBytes = 0
    let totalTokens = 0
    const turnBytes: number[] = []
    for (let turnIndex = 0; turnIndex < turnCount; turnIndex++) {
      const turnPayload =
        mode === 'delta'
          ? emitDeltaTurnPayload(
              transcript,
              claudeMdContent,
              gitStatusSnapshot,
              todoSnapshot,
            )
          : emitBaselineTurnPayload(
              claudeMdContent,
              gitStatusSnapshot,
              todoSnapshot,
            )
      const bytes = serialize(turnPayload)
      totalBytes += bytes
      totalTokens += estimateTokens(turnPayload)
      turnBytes.push(bytes)
    }
    return { totalBytes, totalTokens, turnBytes }
  }

  test('always-emit baseline: every turn carries full payload (historical shape)', () => {
    const baseline = measureSession(3, 'baseline')
    expect(baseline.turnBytes[0]).toBe(baseline.turnBytes[1])
    expect(baseline.turnBytes[1]).toBe(baseline.turnBytes[2])
  })

  test('delta shape: turn 2+ payloads collapse to near-zero', () => {
    const dedup = measureSession(3, 'delta')
    expect(dedup.turnBytes[0]).toBeGreaterThan(1_000)
    expect(dedup.turnBytes[1]).toBeLessThan(50)
    expect(dedup.turnBytes[2]).toBeLessThan(50)
  })

  test('measured savings: delta vs always-emit baseline over a 10-turn session', () => {
    const baseline = measureSession(10, 'baseline')
    const dedup = measureSession(10, 'delta')

    const byteSavings =
      (baseline.totalBytes - dedup.totalBytes) / baseline.totalBytes
    const tokenSavings =
      (baseline.totalTokens - dedup.totalTokens) / baseline.totalTokens

    expect(byteSavings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)
    expect(tokenSavings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)

    // eslint-disable-next-line no-console
    console.log(
      `[static-dedup measured] bytes: baseline=${baseline.totalBytes} dedup=${dedup.totalBytes} savings=${(byteSavings * 100).toFixed(1)}% | tokens: baseline=${baseline.totalTokens} dedup=${dedup.totalTokens} savings=${(tokenSavings * 100).toFixed(1)}%`,
    )
  })
})

/**
 * Real production pipeline: call the exact `appendSystemContext` and
 * `prependUserContext` functions used by `src/providers/shims/claude.ts`
 * before every request and verify the static-dedup keys are stripped.
 *
 * `prependUserContext` early-returns when NODE_ENV === 'test' (a guard
 * that prevents noisy test output); we override it so the production
 * path actually runs during this block and restore it on teardown.
 */
describe('static-dedup integration: production injection functions', () => {
  // Minimal SystemPrompt-branded empty array for calling
  // appendSystemContext. Matches the shape of production callers in
  // src/providers/shims/claude.ts when the dynamic-boundary split yields
  // an empty prefix half.
  const EMPTY_SYSTEM_PROMPT = [] as unknown as Parameters<
    typeof appendSystemContext
  >[0]
  let originalNodeEnv: string | undefined

  beforeAll(() => {
    originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
  })

  afterAll(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  function buildFixtureContext(): Record<string, string> {
    return {
      claudeMd: repeat(TYPICAL_CLAUDE_MD_SIZE),
      gitStatus: repeat(TYPICAL_GIT_STATUS_SIZE),
      directoryStructure: 'src/\n  utils/\n  services/\n', // sample non-static
      platform: 'linux',
    }
  }

  test('appendSystemContext strips claudeMd/gitStatus', () => {
    const output = appendSystemContext(EMPTY_SYSTEM_PROMPT, buildFixtureContext())
    const joined = output.join('\n')
    expect(joined).not.toContain('claudeMd:')
    expect(joined).not.toContain('gitStatus:')
    // Non-static keys still flow through.
    expect(joined).toContain('directoryStructure:')
    expect(joined).toContain('platform:')
    // Payload is smaller by at least the sum of the stripped bodies.
    expect(joined.length).toBeLessThan(
      TYPICAL_CLAUDE_MD_SIZE + TYPICAL_GIT_STATUS_SIZE,
    )
  })

  test('prependUserContext omits claudeMd/gitStatus', () => {
    const output = prependUserContext([], buildFixtureContext())
    // With claudeMd + gitStatus stripped, remaining context keys
    // (directoryStructure, platform) should still trigger injection.
    expect(output.length).toBe(1)
    const injected = stableStringify(output[0])
    expect(injected).not.toContain('claudeMd')
    expect(injected).not.toContain('gitStatus')
    expect(injected).toContain('directoryStructure')
  })

  test('prependUserContext skips injection entirely if only dedup keys present', () => {
    // Edge case: the only context keys are the ones that get stripped.
    // The filtered context is empty → no system-reminder.
    const output = prependUserContext([], {
      claudeMd: 'some content',
      gitStatus: 'M file.ts',
    })
    expect(output.length).toBe(0)
  })

  // Reference comparison for the dedup vs always-emit shape.
  test('appendSystemContext output is materially smaller than the historical always-emit shape', () => {
    const ctx = buildFixtureContext()
    const dedupOut = appendSystemContext(EMPTY_SYSTEM_PROMPT, ctx)
    const dedupBytes = stableStringify(dedupOut).length
    // Reconstruct the historical shape — claudeMd + gitStatus inlined
    // into the system prompt — for the comparison baseline.
    const baselineBytes = stableStringify([
      `claudeMd: ${ctx.claudeMd}`,
      `gitStatus: ${ctx.gitStatus}`,
      `directoryStructure: ${ctx.directoryStructure}`,
      `platform: ${ctx.platform}`,
    ]).length
    const savings = (baselineBytes - dedupBytes) / baselineBytes
    expect(savings).toBeGreaterThanOrEqual(MIN_SAVINGS_RATIO)
    // eslint-disable-next-line no-console
    console.log(
      `[static-dedup pipeline] bytes: baseline=${baselineBytes} dedup=${dedupBytes} savings=${(savings * 100).toFixed(1)}%`,
    )
  })

  // INVARIANT: memory-related context keys must NOT be stripped by
  // filterStaticDedupKeys. Only claudeMd and gitStatus have a delta
  // scanner standing in for them; nested memory has none. Its content
  // reaches the model solely through the raw `nested_memory`
  // attachment (deduped per session by `memoryFilesToAttachments` —
  // see src/agent/attachments/memory.dedup.test.ts), so adding a
  // NESTED_MEMORY_CONTEXT_KEY to the strip list here would drop
  // content with nothing re-emitting it.
  test('filterStaticDedupKeys does NOT strip memory or non-dedup keys', () => {
    const context = {
      claudeMd: 'should be stripped',
      gitStatus: 'should be stripped',
      // Keys below are NOT dedup targets and must survive the filter.
      nestedMemory: 'nested memory payload — no delta scanner replaces it',
      directoryStructure: 'src/\n  utils/\n',
      platform: 'linux',
      mcpInstructions: 'some mcp instructions',
    }
    const output = appendSystemContext(EMPTY_SYSTEM_PROMPT, context)
    const joined = output.join('\n')

    // Dedup keys stripped.
    expect(joined).not.toContain('claudeMd:')
    expect(joined).not.toContain('gitStatus:')

    // Non-dedup keys — including memory-related — must survive.
    expect(joined).toContain('nestedMemory:')
    expect(joined).toContain('directoryStructure:')
    expect(joined).toContain('platform:')
    expect(joined).toContain('mcpInstructions:')
  })
})
