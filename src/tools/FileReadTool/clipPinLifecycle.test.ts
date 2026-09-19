// Clip-pin lifecycle: the non-code head slice, the killswitches, the
// server-clearing arm, cache bypass, and pin ownership — every way of losing
// the readFileState entry has to release the pin it asked for.
//
// Split out of the 2177-line FileReadTool.test.ts. The forced-on describe that
// wrapped these cases is now useForcedClipPin(); the fixtures and the
// process-global env pair live in __testutils__/fileReadHarness.ts.

import { describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'

import {
  _getPinnedToolResultsForTesting,
  buildClipStub,
  isPinRegistered,
  pinToolResult,
} from 'src/agent/compact/stableStubState.js'
import { cloneFileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getCached, invalidateAll } from 'src/agent/tools/toolResultCache.js'
import {
  assistantWithClearing,
  userWithToolResult,
} from 'src/tools/FileReadTool/__test-helpers__/contextManagementFixtures.js'
import {
  FileReadTool,
  STAND_DOWN_STRIKES,
} from 'src/tools/FileReadTool/FileReadTool.js'
import {
  SAMPLE_TS,
  assignFreshToolUseId,
  lastToolUseId,
  longestRun,
  makeContext,
  read,
  readWithPriorClipped,
  setContextMessages,
  useFileReadEnv,
  useForcedClipPin,
  writeFixture,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'

useFileReadEnv()

describe('FileReadTool — clip pin (forced on)', () => {
  useForcedClipPin()

  test('non-code file falls back to the head of the file plus a redirect', async () => {
    // 200 lines: past CLIP_PIN_HEAD_LINES (60), so the cap is exercised rather
    // than incidentally satisfied by a short fixture.
    const body = Array.from({ length: 200 }, (_, i) => `plain line ${i}`).join(
      '\n',
    )
    const p = writeFixture('clip-pin-noncode.txt', body)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const tripped = await readWithPriorClipped(p, ctx)
    expect(tripped.data.type).toBe('clip_pin_fallback')
    if (tripped.data.type !== 'clip_pin_fallback') {
      throw new Error('expected the clip-pin fallback')
    }
    expect(tripped.data.file.servedOutline).toBe(false)
    expect(tripped.data.file.message).toMatch(/re-read/i)
    expect((tripped as { noResultCache?: boolean }).noResultCache).toBe(true)
    // The code arm serves an outline — a real view of the file. The non-code
    // arm used to serve a bare system-reminder, i.e. the model asked to read a
    // file and got zero bytes of it, which is worse than the three-strike
    // breaker this replaced (two more full bodies first). It must carry the
    // head of the file with the redirect.
    expect(tripped.data.file.message).toContain('plain line 0')
    expect(tripped.data.file.message).toContain('plain line 59')
    // …the HEAD of it, not the whole thing — the fallback exists because the
    // full body keeps getting clipped, so re-sending it would defeat the point.
    expect(tripped.data.file.message).not.toContain('plain line 199')
    // Line-numbered like every other Read result: the redirect tells the model
    // to go read a different part of the file, which needs anchors.
    expect(tripped.data.file.message).toMatch(/1→plain line 0\b/)
  })

  test('the legacy CLAUDIN_DISABLE_READ_RERUN_BREAKER killswitch still works', async () => {
    // The mechanism shipped under the old name; the rename must not silently
    // take a working opt-out away from anyone who had already set it.
    const p = writeFixture('clip-pin-legacy-killswitch.ts', SAMPLE_TS)
    const ctx = makeContext()
    process.env.CLAUDIN_DISABLE_READ_RERUN_BREAKER = '1'
    try {
      // Still opts out of the PIN (nothing gets protected), but not out of the
      // strike bound — a killswitch that reinstates an unbounded loop is a
      // trap, not an opt-out.
      const types: string[] = []
      types.push((await readWithPriorClipped(p, ctx)).data.type)
      types.push((await readWithPriorClipped(p, ctx)).data.type)
      // IMMEDIATELY after the stand-down re-send: this is the id the pin
      // would protect if the alias were ignored. Asserting any later is
      // blind — the next fallback deletes the entry and the dispose hook
      // releases the pin, so a delayed check passes with the env check
      // deleted.
      expect(isPinRegistered(lastToolUseId())).toBe(false)
      for (let i = 0; i < 2; i++) {
        types.push((await readWithPriorClipped(p, ctx)).data.type)
      }
      expect(longestRun(types, 'text')).toBeLessThanOrEqual(STAND_DOWN_STRIKES)
    } finally {
      delete process.env.CLAUDIN_DISABLE_READ_RERUN_BREAKER
    }
  })

  test('the server-clearing arm reaches the fallback but never claims the copy was protected', async () => {
    const p = writeFixture('clip-pin-servercleared.ts', SAMPLE_TS)
    const ctx = makeContext({ messages: [assistantWithClearing(4)] })

    // Static server-cleared transcript on every read; fresh id per read.
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    assignFreshToolUseId(ctx)
    const tripped = await read(p, {}, ctx)
    expect(tripped.data.type).toBe('clip_pin_fallback')
    if (tripped.data.type !== 'clip_pin_fallback') {
      throw new Error('expected the clip-pin fallback')
    }
    // clear_tool_uses latches session-wide and reports counts only, so we never
    // observe THIS result being cleared — and a client-side pin cannot stop
    // server-side clearing anyway. Borrowing the clipped arm's wording here
    // would tell the model something we did not verify.
    expect(tripped.data.file.message).not.toContain(
      'that copy is no longer in the conversation',
    )
    expect(tripped.data.file.message).toContain('the API keeps clearing tool results')
  })

  test('a latched server clear still reaches the fallback while the local copy looks intact', async () => {
    // REGRESSION GUARD. The tempting optimisation here is "the prior block is
    // still visible in context.messages AND we pinned it, so the session-wide
    // clear latch must be stale evidence about some OTHER result — take the
    // intact branch". It is wrong in the worst possible way: clear_tool_uses
    // is applied API-side and never rewrites our local copy (the response
    // carries counts only), so isPriorReadClippedOrMissing is structurally
    // blind to it and "still visible locally" is true for EVERY cleared block.
    // The gate would therefore be permanently on under a latched clear,
    // replacing the outline fallback with a dedup stub that points at content
    // the API removed — re-read, same stub, forever.
    const p = writeFixture('clip-pin-latch-visible.ts', SAMPLE_TS)
    const ctx = makeContext({ messages: [assistantWithClearing(4)] })

    const readWithPriorVisible = async () => {
      const priorId = ctx.readFileState.get(p)?.toolUseId
      setContextMessages(ctx, [
        assistantWithClearing(4),
        ...(priorId ? [userWithToolResult(priorId, 'the real body')] : []),
      ])
      assignFreshToolUseId(ctx)
      return read(p, {}, ctx)
    }

    // 1st: ordinary read. 2nd: the latch forces a stand-down re-send, which
    // pins the copy it delivers — even though the pin cannot survive a
    // server-side clear, which is exactly why the 3rd read must not trust it.
    expect((await readWithPriorVisible()).data.type).toBe('text')
    expect((await readWithPriorVisible()).data.type).toBe('text')
    expect(isPinRegistered(lastToolUseId())).toBe(true)

    const third = await readWithPriorVisible()
    expect(third.data.type).toBe('clip_pin_fallback')
  })

  test('a cached first read never preempts the stand-down', async () => {
    const p = writeFixture('clip-pin-cache.ts', SAMPLE_TS)
    const ctx = makeContext()
    // The suite disables the cache at module load; enable it for this test.
    delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    try {
      setContextMessages(ctx, [])
      assignFreshToolUseId(ctx)
      expect((await read(p, {}, ctx)).data.type).toBe('text')
      // The first read is a pure function of input + disk, so it caches.
      expect(getCached('Read', { file_path: p })).toBeDefined()

      // Same input, but now the prior result is clipped. A cache hit would
      // short-circuit call() for the whole 60s TTL, handing the model an
      // UNPINNED replay and freezing the stand-down state machine — the loop
      // would spin invisibly instead of terminating after one re-send.
      const { data } = await readWithPriorClipped(p, ctx)
      expect(data.type).toBe('text')
      expect(isPinRegistered(lastToolUseId())).toBe(true)
    } finally {
      process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
      invalidateAll()
    }
  })

  test('bypassResultCache fires on stand-down evidence, not on "have I read this"', async () => {
    const p = writeFixture('clip-pin-bypass.ts', SAMPLE_TS)
    const ctx = makeContext()
    const bypasses = () =>
      FileReadTool.bypassResultCache?.({ file_path: p }, ctx)

    // 1. Never read here → nothing to stand down from → cache normally.
    setContextMessages(ctx, [])
    expect(bypasses()).toBe(false)

    assignFreshToolUseId(ctx)
    await read(p, {}, ctx)
    const priorId = lastToolUseId()

    // 2. Read, and the prior tool_result is sitting intact in the transcript.
    //    THIS is the case that decides whether the Read cache keeps any value:
    //    keying the bypass on mere readFileState presence would return true
    //    here and, because readFileState is session-lifetime with no TTL and is
    //    written by Bash/Edit/Write/attachments too, would stay true forever —
    //    deleting every in-context Read hit while the dead entries kept
    //    evicting live Glob/Grep results from the shared LRU.
    setContextMessages(ctx, [userWithToolResult(priorId, 'the real body')])
    expect(bypasses()).toBe(false)

    // 3. Prior result clipped → the stand-down could fire → call() must run.
    setContextMessages(ctx, [
      userWithToolResult(priorId, buildClipStub('Read', 1234)),
    ])
    expect(bypasses()).toBe(true)

    // 4. Prior result intact again, but the API cleared something this session.
    //    Session-wide latch, no ids: call() has to make that call, not the cache.
    setContextMessages(ctx, [
      assistantWithClearing(4),
      userWithToolResult(priorId, 'the real body'),
    ])
    expect(bypasses()).toBe(true)
  })

  test('CLAUDIN_DISABLE_READ_CLIP_PIN wins over the force flag', async () => {
    process.env.CLAUDIN_DISABLE_READ_CLIP_PIN = '1'
    try {
      const p = writeFixture('clip-pin-disabled.ts', SAMPLE_TS)
      const ctx = makeContext()
      const types: string[] = []
      types.push((await readWithPriorClipped(p, ctx)).data.type)
      types.push((await readWithPriorClipped(p, ctx)).data.type)
      // The killswitch must mean "nothing gets pinned" — checked IMMEDIATELY
      // after the re-send that would have pinned. The final read of the loop
      // serves the fallback (never pinned) and a later fallback would release
      // this id through the dispose hook, so a check anywhere else passes
      // with the env check deleted.
      expect(isPinRegistered(lastToolUseId())).toBe(false)
      for (let i = 0; i < 4; i++) {
        types.push((await readWithPriorClipped(p, ctx)).data.type)
      }
      // ...but the strike bound still applies (lane 2 is outside the gate).
      expect(longestRun(types, 'text')).toBeLessThanOrEqual(STAND_DOWN_STRIKES)
    } finally {
      delete process.env.CLAUDIN_DISABLE_READ_CLIP_PIN
    }
  })

  test('a different range gets its own pin, not the previous range\u2019s', async () => {
    const p = writeFixture('clip-pin-range.ts', SAMPLE_TS)
    const ctx = makeContext()

    // Default range: fresh read, then a stand-down that pins its copy.
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    // A DIFFERENT range overwrites the entry (new id, unpinned), so its first
    // clipped stand-down re-sends instead of inheriting the other range's pin.
    expect(
      (await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })).data.type,
    ).toBe('text')
    expect(
      (await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })).data.type,
    ).toBe('text')
    // …and only then does that range reach the fallback on its own.
    expect(
      (await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })).data.type,
    ).toBe('clip_pin_fallback')
  })

  test('an intact-content dedup hit frees the slot but remembers the re-send', async () => {
    const p = writeFixture('clip-pin-release.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastToolUseId()
    expect(isPinRegistered(pinnedId)).toBe(true)

    // A read where the prior result is INTACT → normal dedup hit. The model is
    // not looping, so the protection is released.
    setContextMessages(ctx, [
      userWithToolResult(pinnedId, '     1\texport function alpha'),
    ])
    expect((await read(p, {}, ctx)).data.type).toBe('file_unchanged')
    // The SHIELD goes — the slot is freed and the clip frontier stops stalling
    // on this block.
    expect(_getPinnedToolResultsForTesting().has(pinnedId)).toBe(false)
    // The MEMORY stays. Fully forgetting it here is what re-arms the loop:
    // the block is still intact, so an ordinary re-read erases the state, the
    // next clip pass stubs it, and the stand-down grants another full re-send —
    // one body per rotation, with no bound. This copy already had its one
    // protected re-send, so a later clip goes straight to the outline.
    expect(isPinRegistered(pinnedId)).toBe(true)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
  })

  test('an Edit/Write-style overwrite drops the dedup entry entirely', async () => {
    const p = writeFixture('clip-pin-edit.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    // Simulate FileEditTool/FileWriteTool updating readFileState after an
    // edit: offset/limit undefined, no toolUseId. The dedup gate requires a
    // Read-written entry, so the next reads are plain full reads again.
    ctx.readFileState.set(p, {
      content: SAMPLE_TS,
      timestamp: Date.now(),
      offset: undefined,
      limit: undefined,
    })
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  // -------------------------------------------------------------------------
  // Pin ownership: a pin is only justified while the readFileState entry that
  // asked for it still points at that tool_result. Every way of losing the
  // entry must release the pin — a leaked pin keeps its block out of every
  // clip path, which keeps the block mutable, which parks the prompt-cache
  // clip frontier at that block's index for the rest of the session.
  // -------------------------------------------------------------------------

  test('switching range releases the abandoned range\u2019s pin', async () => {
    const p = writeFixture('clip-pin-leak-range.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastToolUseId()
    expect(isPinRegistered(pinnedId)).toBe(true)

    // The model moves on to a different range: the entry now vouches for that
    // read instead, so nothing owns the old pin any more.
    await readWithPriorClipped(p, ctx, { offset: 2, limit: 2 })
    expect(isPinRegistered(pinnedId)).toBe(false)
  })

  test('an Edit/Write-style overwrite releases the pin', async () => {
    const p = writeFixture('clip-pin-leak-edit.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastToolUseId()
    expect(isPinRegistered(pinnedId)).toBe(true)

    ctx.readFileState.set(p, {
      content: SAMPLE_TS,
      timestamp: Date.now(),
      offset: undefined,
      limit: undefined,
    })
    expect(isPinRegistered(pinnedId)).toBe(false)
  })

  test('dropping the file entry (delete / LRU eviction) releases the pin', async () => {
    const p = writeFixture('clip-pin-leak-evict.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastToolUseId()
    expect(isPinRegistered(pinnedId)).toBe(true)

    // Eviction bypasses delete() in production; both funnel through the same
    // dispose hook, so exercising the explicit drop covers the pair.
    ctx.readFileState.delete(p)
    expect(isPinRegistered(pinnedId)).toBe(false)
  })

  test('the stand-down re-send is never replayed from the tool-result cache', async () => {
    const p = writeFixture('clip-pin-nocache.ts', SAMPLE_TS)
    const ctx = makeContext()

    // A plain first read is cacheable — that is the whole point of the cache.
    const first = await readWithPriorClipped(p, ctx)
    expect(first.data.type).toBe('text')
    expect((first as { noResultCache?: boolean }).noResultCache).toBeUndefined()

    // The re-send is not: a cache hit short-circuits before call(), so
    // replaying it would hand the model an UNPINNED copy and leave the state
    // machine parked for the Read TTL — the loop spins with nothing observing
    // it. This suite runs with the cache disabled, so the flag is the only
    // thing standing between the feature and that bypass in production.
    const resend = await readWithPriorClipped(p, ctx)
    expect(resend.data.type).toBe('text')
    expect((resend as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('a re-send that throws pins nothing', async () => {
    const p = writeFixture('clip-pin-throws.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    // The file disappears between the stand-down decision and the read: the
    // pin is placed only on a body actually delivered, so a throw must leave
    // the registry untouched instead of burning a slot on an id whose content
    // the state machine will never look at again.
    rmSync(p)
    await expect(readWithPriorClipped(p, ctx)).rejects.toThrow(
      /File does not exist/,
    )
    expect(isPinRegistered(lastToolUseId())).toBe(false)
  })

  test('a re-send that pivots to auto-outline pins nothing', async () => {
    const p = writeFixture('clip-pin-pivot.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)

    // The stand-down arms skip the mtime check on purpose, so the file can
    // cross the auto-outline threshold (10k chars / 250 lines / 3 symbols)
    // between the clipped read and the re-send.
    writeFileSync(
      p,
      Array.from(
        { length: 400 },
        (_, i) => `export function fn${i}(): number {\n  return ${i}\n}\n`,
      ).join('\n'),
    )
    const prevForce = process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION
    process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION = '1'
    try {
      const pivoted = await readWithPriorClipped(p, ctx)
      expect(pivoted.data.type).toBe('outline')
      // The outline rewrites the entry as a partial view with no toolUseId:
      // it disarms the dedup gate, so nothing would ever release a pin placed
      // here. Pinning is conditioned on the entry still owning the id.
      expect(ctx.readFileState.get(p)?.isPartialView).toBe(true)
      expect(isPinRegistered(lastToolUseId())).toBe(false)
      // Still uncacheable: the decision to re-send was transcript-dependent
      // whatever shape the answer took.
      expect((pivoted as { noResultCache?: boolean }).noResultCache).toBe(true)
    } finally {
      if (prevForce === undefined) {
        delete process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION
      } else {
        process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION = prevForce
      }
    }
  })

  test('a clone releases only the pins it took in itself', async () => {
    const p = writeFixture('clip-pin-clone.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastToolUseId()
    expect(isPinRegistered(pinnedId)).toBe(true)

    // Forked sub-agents (the default spawn) run on a clone of the parent's
    // readFileState and clear() it on exit — runAgent.ts / forkedAgent.ts.
    // clear() disposes every inherited entry, so an unconditional release
    // there would unpin a block the parent's entry still vouches for: the
    // parent would go on believing its content is protected while it had
    // quietly become clippable again.
    const clone = cloneFileStateCache(ctx.readFileState)
    clone.set('/other/file.ts', {
      content: 'x',
      timestamp: Date.now(),
      offset: 1,
      limit: undefined,
      toolUseId: 'toolu_clone_own',
    })
    pinToolResult('toolu_clone_own')

    clone.clear()
    expect(isPinRegistered(pinnedId)).toBe(true)
    // Entries it took in through set() it does own, so those release normally.
    expect(isPinRegistered('toolu_clone_own')).toBe(false)

    // And the parent still releases when ITS entry goes.
    ctx.readFileState.delete(p)
    expect(isPinRegistered(pinnedId)).toBe(false)
  })
})
