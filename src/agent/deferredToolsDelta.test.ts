/**
 * A2 regression — deferred-tools delta default + legacy-session latch.
 *
 * With the delta off, claude/streaming.ts prepended an ephemeral
 * <available-deferred-tools> block at messages[0] on every request — any
 * change to the deferred pool (MCP connect, tool discovery) rewrote
 * messages[0] and invalidated the entire cached prefix. It is on by default
 * (CLAUDIN_DEFERRED_TOOLS_DELTA=0 turns it off), with a per-session
 * compatibility latch so sessions resumed with a warm cache written by a
 * pre-flip binary keep the legacy format (zero break from the flip itself).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const {
  isDeferredToolsDeltaActive,
  isDeferredToolsDeltaEnabled,
  maybeLatchLegacyDeferredAnnouncement,
} = await import('src/agent/tools/toolSearch.js')
const { clearBetaHeaderLatches } = await import('src/platform/bootstrap/state.js')

type LooseMessage = {
  type: string
  timestamp?: string
  attachment?: { type: string; addedNames?: string[]; removedNames?: string[] }
}

function deltaAttachment(): LooseMessage {
  return {
    type: 'attachment',
    attachment: {
      type: 'deferred_tools_delta',
      addedNames: ['mcp__foo__bar'],
      removedNames: [],
    },
  }
}

const PROCESS_START = Date.parse('2026-06-11T12:00:00Z')

function assistantAt(minutesBeforeStart: number): LooseMessage {
  return {
    type: 'assistant',
    timestamp: new Date(
      PROCESS_START - minutesBeforeStart * 60_000,
    ).toISOString(),
  }
}

function latch(
  messages: LooseMessage[],
  opts: { subagent?: boolean } = {},
): void {
  maybeLatchLegacyDeferredAnnouncement(
    messages as unknown as Parameters<
      typeof maybeLatchLegacyDeferredAnnouncement
    >[0],
    { epochMs: PROCESS_START, ...opts },
  )
}

afterEach(() => {
  clearBetaHeaderLatches()
})

describe('maybeLatchLegacyDeferredAnnouncement', () => {
  test('precondition: the delta is on', () => {
    expect(isDeferredToolsDeltaEnabled()).toBe(true)
    expect(isDeferredToolsDeltaActive()).toBe(true)
  })

  test('fresh session (no pre-process assistant) never latches → delta active', () => {
    latch([{ type: 'user' }])
    expect(isDeferredToolsDeltaActive()).toBe(true)
  })

  test('resumed with a WARM legacy cache (last assistant 30min before start) latches legacy', () => {
    latch([{ type: 'user' }, assistantAt(30), { type: 'user' }])
    expect(isDeferredToolsDeltaActive()).toBe(false)
    // Sticky: later requests (now with post-start assistants appended)
    // stay legacy even though the newest assistant is from this process.
    latch([
      assistantAt(30),
      { type: 'assistant', timestamp: new Date(PROCESS_START + 60_000).toISOString() },
    ])
    expect(isDeferredToolsDeltaActive()).toBe(false)
  })

  test('resumed with a COLD cache (last assistant 2h before start) does not latch → delta active', () => {
    latch([assistantAt(120), { type: 'user' }])
    expect(isDeferredToolsDeltaActive()).toBe(true)
  })

  test('the newest PRE-PROCESS assistant decides, not older ones', () => {
    // Old turn 3h ago, but the resume point is 10min ago → warm → legacy.
    latch([assistantAt(180), assistantAt(10)])
    expect(isDeferredToolsDeltaActive()).toBe(false)
  })

  test('assistants produced by THIS process are ignored by the warm check', () => {
    const postStart = {
      type: 'assistant',
      timestamp: new Date(PROCESS_START + 5 * 60_000).toISOString(),
    }
    latch([postStart])
    expect(isDeferredToolsDeltaActive()).toBe(true)
  })

  test('clearBetaHeaderLatches (/clear, /compact — cache-cold moments) releases the latch', () => {
    latch([assistantAt(5)])
    expect(isDeferredToolsDeltaActive()).toBe(false)
    clearBetaHeaderLatches()
    expect(isDeferredToolsDeltaActive()).toBe(true)
  })

  test('unparseable timestamps are skipped, not treated as warm', () => {
    latch([{ type: 'assistant', timestamp: 'not-a-date' }])
    expect(isDeferredToolsDeltaActive()).toBe(true)
  })

  // Format-aware: the latch protects warm caches written in the LEGACY
  // (prepend) format. A history that already carries persisted
  // deferred_tools_delta attachments was written by a delta-format binary —
  // latching there would itself add the prepend at messages[0] and break
  // the warm prepend-less cache on every warm resume of a delta session.
  test('warm resume of a DELTA-format history (has delta attachments) does NOT latch', () => {
    latch([
      { type: 'user' },
      deltaAttachment(),
      assistantAt(10),
      { type: 'user' },
    ])
    expect(isDeferredToolsDeltaActive()).toBe(true)
  })

  test('warm resume with a delta attachment ANYWHERE in history stays delta', () => {
    // Attachment after the resume-point assistant (e.g. pool changed on the
    // previous process's last turn).
    latch([assistantAt(30), deltaAttachment(), assistantAt(10)])
    expect(isDeferredToolsDeltaActive()).toBe(true)
  })

  test('warm resume WITHOUT delta attachments still latches legacy', () => {
    latch([{ type: 'user' }, assistantAt(10), { type: 'user' }])
    expect(isDeferredToolsDeltaActive()).toBe(false)
  })

  // The latch is process-wide but its meaning is "the MAIN conversation
  // resumed onto a warm legacy cache". A subagent's history (forked,
  // summarized, or restored — possibly delta-attachment-free) must never
  // settle it: that would flip the parent to the legacy prepend mid-session
  // and break the parent's warm delta cache.
  test('a subagent history never settles the process-wide latch', () => {
    const warmLegacyHistory = [
      { type: 'user' },
      assistantAt(10),
      { type: 'user' },
    ]
    latch(warmLegacyHistory, { subagent: true })
    expect(isDeferredToolsDeltaActive()).toBe(true)
    // Control: the identical history scanned as the main conversation latches.
    latch(warmLegacyHistory)
    expect(isDeferredToolsDeltaActive()).toBe(false)
  })

  // The format-aware check is only sound if the marker survives /resume:
  // session persistence must NOT filter deferred_tools_delta attachments
  // out of the transcript (src/sessions/pure/attachmentPersistence.ts decides
  // per type). If this regresses, resumed histories are marker-free
  // and every warm resume of a delta session latches legacy → prepend onto
  // a prepend-less warm cache → the exact break A2 fixes.
  test('persistence premise: deferred_tools_delta attachments are loggable for external users', async () => {
    const { isLoggableMessage } = await import('src/sessions/sessionStorage.js')
    expect(
      isLoggableMessage({
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['mcp__foo__bar'],
          addedLines: ['- mcp__foo__bar'],
          removedNames: [],
        },
      } as unknown as Parameters<typeof isLoggableMessage>[0]),
    ).toBe(true)
  })
})

// ── Conversation scoping: session switches reset and re-anchor the latch ─
// The latch is stored process-wide but its meaning is per-conversation.
// Both directions broke across an in-REPL /resume (switchSession):
// a carried-over latch injected the legacy prepend into a delta-format
// history, and the process-start anchor never latched sessions written
// after this process launched (real under the claudin/claudindev
// dual-binary setup). The sessionSwitched funnel fixes both: it clears
// the latch and advances the session epoch.
describe('session switch (in-REPL /resume, /branch)', () => {
  test('releases a carried-over latch — the incoming conversation re-evaluates', async () => {
    const { getSessionId, switchSession } = await import(
      'src/platform/bootstrap/state.js'
    )
    const { randomUUID } = await import('node:crypto')
    const originalSession = getSessionId()
    latch([assistantAt(10)])
    expect(isDeferredToolsDeltaActive()).toBe(false)
    try {
      switchSession(randomUUID() as ReturnType<typeof getSessionId>)
      expect(isDeferredToolsDeltaActive()).toBe(true)
    } finally {
      switchSession(originalSession)
    }
  })

  test('advances the epoch: a history written AFTER process start still latches on in-process resume', async () => {
    const { getSessionEpochMs, getSessionId, switchSession } = await import(
      'src/platform/bootstrap/state.js'
    )
    const { randomUUID } = await import('node:crypto')
    const originalSession = getSessionId()
    // Assistant turn written while this process was already running — the
    // old PROCESS_START_MS anchor classified it as "this process's own
    // output" and skipped it, so the resumed session flipped to delta and
    // busted its warm legacy cache.
    const postStartTs = new Date().toISOString()
    await new Promise(resolve => setTimeout(resolve, 5))
    try {
      switchSession(randomUUID() as ReturnType<typeof getSessionId>)
      expect(getSessionEpochMs()).toBeGreaterThan(Date.parse(postStartTs))
      // Default-epoch path (no epochMs injection) — exercises the real
      // getSessionEpochMs() wiring.
      maybeLatchLegacyDeferredAnnouncement([
        { type: 'user' },
        { type: 'assistant', timestamp: postStartTs },
        { type: 'user' },
      ] as unknown as Parameters<
        typeof maybeLatchLegacyDeferredAnnouncement
      >[0])
      expect(isDeferredToolsDeltaActive()).toBe(false)
    } finally {
      switchSession(originalSession)
    }
  })
})

// ── Call-site wiring (source guards) ─────────────────────────────────────
// The subagent gate only works if every production scan passes the flag.
// Call-shaped greps so deleting a gate (not just renaming it) fails here.
describe('latch call sites pass the subagent scan context', () => {
  const sourceAt = (relPath: string): string =>
    readFileSync(join(import.meta.dir, relPath), 'utf-8')

  test('attachments injector derives subagent from the pipeline callSite', () => {
    const src = sourceAt('./attachments/injections.ts')
    expect(src).toContain(
      'maybeLatchLegacyDeferredAnnouncement(messages ?? [], {',
    )
    expect(src).toContain("scanContext?.callSite === 'attachments_subagent'")
  })

  test('queryModel marks sidechain query sources as subagent', () => {
    const src = sourceAt('../providers/shims/claude/streaming.ts')
    expect(src).toContain('maybeLatchLegacyDeferredAnnouncement(messages, {')
    expect(src).toContain('options.querySource.startsWith("agent:")')
    expect(src).toContain('options.querySource === "hook_agent"')
  })

  test('compact re-announce sites mark subagent compactions', () => {
    const src = sourceAt('./compact/compact.ts')
    expect(src).toContain(
      "{ callSite: 'compact_full', subagent: Boolean(context.agentId) }",
    )
    expect(src).toContain(
      "{ callSite: 'compact_partial', subagent: Boolean(context.agentId) }",
    )
  })
})

// ── Pipeline ordering: the attachment injector settles the latch ────────
// The attachments pipeline runs BEFORE queryModel's latch call. If the
// injector consulted isDeferredToolsDeltaActive() without settling the
// latch first, the first request of a legacy-resumed session would persist
// a full-pool delta attachment AND emit the legacy prepend post-latch —
// both announcement formats in one request.
describe('getDeferredToolsDeltaAttachment settles the latch first', () => {
  test('legacy-resume history: injector returns no attachment and leaves the session latched', async () => {
    const { getDeferredToolsDeltaAttachment } = await import(
      'src/agent/attachments/injections.js'
    )
    // Real session epoch (no override path through the injector) — build a
    // resume point 10min before process start: earlier than any epoch this
    // test process can hold, yet still inside the warm TTL.
    const realStart = Date.now() - process.uptime() * 1000
    const history = [
      { type: 'user' },
      {
        type: 'assistant',
        timestamp: new Date(realStart - 10 * 60_000).toISOString(),
      },
      { type: 'user' },
    ]
    expect(isDeferredToolsDeltaActive()).toBe(true)
    const attachments = getDeferredToolsDeltaAttachment(
      [] as Parameters<typeof getDeferredToolsDeltaAttachment>[0],
      'claude-sonnet-4-6',
      history as Parameters<typeof getDeferredToolsDeltaAttachment>[2],
    )
    expect(attachments).toEqual([])
    // The latch settled INSIDE the injector call, before its active check.
    expect(isDeferredToolsDeltaActive()).toBe(false)
  })
})

afterAll(() => {
  clearBetaHeaderLatches()
})
