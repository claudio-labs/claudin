/**
 * A2 regression — deferred-tools delta default + legacy-session latch.
 *
 * With tengu_glacier_2xr resolving to false in the open build,
 * claude/streaming.ts prepended an ephemeral <available-deferred-tools>
 * block at messages[0] on every request — any change to the deferred pool
 * (MCP connect, tool discovery) rewrote messages[0] and invalidated the
 * entire cached prefix. The flag now defaults to true via
 * _openBuildDefaults, with a per-session compatibility latch so sessions
 * resumed with a warm cache written by a pre-flip binary keep the legacy
 * format (zero break from the flip itself).
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Flag resolution in the open-build GrowthBook stub ──────────────────
// The stub ships as a template string inside no-telemetry-plugin.ts; extract
// and execute it the same way scripts/no-telemetry-growthbook-stub.test.ts
// does, then assert the new default.
const pluginSource = readFileSync(
  join(import.meta.dir, '../../scripts/no-telemetry-plugin.ts'),
  'utf-8',
)
const stubMatch = pluginSource.match(
  /'services\/analytics\/growthbook': `([\s\S]*?)`/,
)

describe('open-build default for tengu_glacier_2xr', () => {
  test('the GrowthBook stub resolves the deferred-tools delta gate to true', async () => {
    expect(stubMatch).not.toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'glacier-stub-'))
    const stubFile = join(dir, 'growthbook-stub.mjs')
    try {
      writeFileSync(stubFile, stubMatch![1]!)
      const stub = await import(stubFile)
      // Mirrors toolSearch.isDeferredToolsDeltaEnabled's call shape.
      expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Legacy-session compatibility latch ──────────────────────────────────
// Force the runtime flag ON (the real growthbook module resolves false
// under bun test — the open-build stub only exists in the bundle).
const realGrowthbook = { ...(await import('../services/analytics/growthbook.js')) }
mock.module('../services/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (key: string, def: unknown) =>
    key === 'tengu_glacier_2xr' ? true : def,
}))

const {
  isDeferredToolsDeltaActive,
  isDeferredToolsDeltaEnabled,
  maybeLatchLegacyDeferredAnnouncement,
} = await import('./toolSearch.js')
const { clearBetaHeaderLatches } = await import('../bootstrap/state.js')

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

function latch(messages: LooseMessage[]): void {
  maybeLatchLegacyDeferredAnnouncement(
    messages as Parameters<typeof maybeLatchLegacyDeferredAnnouncement>[0],
    PROCESS_START,
  )
}

afterEach(() => {
  clearBetaHeaderLatches()
})

describe('maybeLatchLegacyDeferredAnnouncement', () => {
  test('precondition: flag mocked on', () => {
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
      './attachments/injections.js'
    )
    // Real PROCESS_START_MS (no override path through the injector) — build
    // a resume point 10min before the actual process start.
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
  mock.module('../services/analytics/growthbook.js', () => realGrowthbook)
  clearBetaHeaderLatches()
})
