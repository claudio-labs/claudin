// Dedup and its stand-downs: server-side clear_tool_uses, client-side
// clipping, and the rule that the file_unchanged stub is never cached.
//
// Split out of the 2177-line FileReadTool.test.ts; the fixtures and the
// process-global env pair live in __testutils__/fileReadHarness.ts. The
// tool-result cache is disabled there for exactly these paths.

import { describe, expect, test } from 'bun:test'

import {
  buildClipStub,
  buildClipStubWithHead,
} from 'src/agent/compact/stableStubState.js'
import { getCached, invalidateAll } from 'src/agent/tools/toolResultCache.js'
import {
  assistantWithAppliedEdits,
  assistantWithClearing,
  userWithToolResult,
} from 'src/tools/FileReadTool/__test-helpers__/contextManagementFixtures.js'
import {
  makeContext,
  read,
  setContextMessages,
  useFileReadEnv,
  writeFixture,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'

useFileReadEnv()

// ---------------------------------------------------------------------------
// Dedup vs server-side clear_tool_uses — once the API has cleared old
// tool_results, the file_unchanged stub would point at content the model can
// no longer see, so dedup must stand down. See serverClearingDetection.ts.
// ---------------------------------------------------------------------------

describe('FileReadTool — dedup vs server-side tool clearing', () => {
  test('dedup is suppressed once clearing has been applied in the session', async () => {
    const p = writeFixture('dedup-cleared.txt', 'alpha\nbeta')
    const ctx = makeContext({ messages: [assistantWithClearing(4)] })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    // Same file, same range, unchanged on disk — would normally dedup to a
    // file_unchanged stub. With clearing evidence in the transcript the full
    // content must be re-sent.
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
    if (second.type !== 'text') throw new Error('expected text')
    expect(second.file.content).toBe('alpha\nbeta')
  })

  test('an applied edit that cleared nothing keeps dedup active', async () => {
    const p = writeFixture('dedup-noop-clear.txt', 'alpha\nbeta')
    const ctx = makeContext({ messages: [assistantWithClearing(0)] })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('a clear_thinking edit keeps dedup active — it leaves tool_results alone', async () => {
    const p = writeFixture('dedup-clear-thinking.txt', 'alpha\nbeta')
    const ctx = makeContext({
      messages: [
        assistantWithAppliedEdits([
          { type: 'clear_thinking_20251015', cleared_thinking_turns: 2 },
        ]),
      ],
    })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('a context without messages keeps dedup active', async () => {
    const p = writeFixture('dedup-no-messages.txt', 'alpha\nbeta')
    const ctx = makeContext()

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('an entry the watcher or a refusal wrote never answers with the stub', async () => {
    // Such an entry carries bytes the model never received as a Read result
    // (fileStateCache.ts `dedupExempt`): the changed-files watcher rewrote a
    // range after an out-of-band edit, or a refused write served the region.
    // Its timestamp IS the current mtime, which is exactly what the gate
    // compares, so without the flag the re-read would be a `file_unchanged`
    // stub pointing at the OLD slice in the transcript.
    const p = writeFixture('dedup-exempt.txt', 'alpha\nbeta')
    const ctx = makeContext()

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const entry = ctx.readFileState.get(p)!
    ctx.readFileState.set(p, { ...entry, dedupExempt: true })

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
    // And the real Read replaces the entry, flag included.
    expect(ctx.readFileState.get(p)!.dedupExempt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Dedup vs client-side clipping — the in-process clip paths (age prune, RSS
// byte-guard, time-based clear, microcompact stable stubs) rewrite old
// tool_results to clip stubs without touching readFileState. The entry
// records the Read's toolUseId; dedup must stand down when THAT tool_result
// is clipped or gone from the transcript. See clientClippingDetection.ts.
// ---------------------------------------------------------------------------

describe('FileReadTool — dedup vs client-side clipping', () => {
  const ID = 'toolu_client_clip'

  test('dedup is suppressed when the prior tool_result was clipped to a pure stub', async () => {
    const p = writeFixture('dedup-clipped-pure.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    setContextMessages(ctx, [
      userWithToolResult(ID, buildClipStub('Read', 1234)),
    ])
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
    if (second.type !== 'text') throw new Error('expected text')
    expect(second.file.content).toBe('alpha\nbeta')
  })

  test('dedup is suppressed when the prior tool_result was clipped to a head-preserving stub', async () => {
    const p = writeFixture('dedup-clipped-head.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    setContextMessages(ctx, [
      userWithToolResult(ID, buildClipStubWithHead('Read', 1234, 'alpha')),
    ])
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
  })

  test('dedup stays active while the prior tool_result is intact in the transcript', async () => {
    const p = writeFixture('dedup-intact.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    setContextMessages(ctx, [
      userWithToolResult(ID, '     1\talpha\n     2\tbeta'),
    ])
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('dedup is suppressed when the prior tool_result is missing from the transcript', async () => {
    const p = writeFixture('dedup-missing.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    // A present messages array with no trace of the prior Read — the stub
    // would point at nothing. Fail toward correctness: re-send.
    setContextMessages(ctx, [])
    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('text')
  })

  test('an entry without a recorded toolUseId keeps the pre-existing dedup behavior', async () => {
    const p = writeFixture('dedup-no-tooluseid.txt', 'alpha\nbeta')
    // No toolUseId on the context → the entry records none → the clipping
    // scan cannot run, even though the transcript holds a clipped result.
    const ctx = makeContext({
      messages: [userWithToolResult(ID, buildClipStub('Read', 50))],
    })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })

  test('a recorded toolUseId with no messages array keeps dedup active', async () => {
    const p = writeFixture('dedup-id-no-messages.txt', 'alpha\nbeta')
    const ctx = makeContext({ toolUseId: ID })

    const first = (await read(p, {}, ctx)).data
    expect(first.type).toBe('text')

    const second = (await read(p, {}, ctx)).data
    expect(second.type).toBe('file_unchanged')
  })
})

// ---------------------------------------------------------------------------
// Dedup stub vs the local tool-result cache — a cached file_unchanged would
// be replayed for the TTL window without running call(), bypassing the
// server-clearing / client-clipping stand-downs exactly when a clip lands
// right after a legitimate dedup hit. The stub must never be stored.
// ---------------------------------------------------------------------------

describe('FileReadTool — dedup stub is not stored in the tool-result cache', () => {
  test('file_unchanged is recomputed per call; text results still cache', async () => {
    const p = writeFixture('dedup-nocache.txt', 'alpha\nbeta')
    const ctx = makeContext()
    // The suite disables the cache at module load (the wrapper reads the env
    // per call); enable it for this test only.
    delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    try {
      const first = (await read(p, {}, ctx)).data
      expect(first.type).toBe('text')
      // Normal results keep getting cached — the noResultCache flag must not
      // widen into a blanket opt-out.
      expect(getCached('Read', { file_path: p })).toBeDefined()

      // Force the next call through to dedup: a cache hit would replay the
      // full text and never reach it.
      invalidateAll()
      const second = (await read(p, {}, ctx)).data
      expect(second.type).toBe('file_unchanged')

      // The decisive assertion: the stub was NOT stored, so the next
      // identical call re-enters call() and re-evaluates the stand-downs.
      expect(getCached('Read', { file_path: p })).toBeUndefined()
    } finally {
      process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
      invalidateAll()
    }
  })
})
