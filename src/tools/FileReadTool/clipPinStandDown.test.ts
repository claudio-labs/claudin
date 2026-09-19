// Clip-pin stand-down: the killswitch lane, the first pinned re-send, and the
// sticky fallback's two bounds (never an unbounded run of futile bodies, never
// an indefinite refusal) plus every way out of the sticky marker.
//
// Split out of the 2177-line FileReadTool.test.ts. The forced-on describe that
// wrapped these cases is now useForcedClipPin(); the fixtures and the
// process-global env pair live in __testutils__/fileReadHarness.ts.

import { beforeEach, describe, expect, test } from 'bun:test'
import { utimesSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  _resetAllClippedIdsForTesting,
  bumpStandDownEpoch,
  isPinRegistered,
} from 'src/agent/compact/stableStubState.js'
import {
  STAND_DOWN_STRIKES,
  STICKY_REPLAY_BUDGET,
} from 'src/tools/FileReadTool/FileReadTool.js'
import {
  SAMPLE_TS,
  fixtureDir,
  lastToolUseId,
  longestRun,
  makeContext,
  readWithPriorClipped,
  useFileReadEnv,
  useForcedClipPin,
  writeFixture,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'

useFileReadEnv()

describe('FileReadTool — clip pin disabled (default) never falls back', () => {
  beforeEach(() => {
    _resetAllClippedIdsForTesting()
  })

  test('the killswitch path is still bounded by the strike counter', async () => {
    // With the pin gated off there is nothing to remember a stand-down by, so
    // this used to re-send the full body on every re-read, forever — strictly
    // worse than the three-strike breaker this feature replaced. The env var a
    // frustrated user reaches for handed them the original bug. Lane 2 sits
    // outside clipPinEnabled() precisely so that is no longer true.
    const p = writeFixture('clip-pin-off.ts', SAMPLE_TS)
    const ctx = makeContext()

    const types: string[] = []
    for (let i = 0; i < 5; i++) {
      types.push((await readWithPriorClipped(p, ctx)).data.type)
    }
    // Bounded: the run of consecutive bodies never exceeds the threshold.
    expect(types).toContain('clip_pin_fallback')
    expect(longestRun(types, 'text')).toBeLessThanOrEqual(STAND_DOWN_STRIKES)
    // …and the exact shape, because the bound above is satisfied by more than
    // one regime and let STAND_DOWN_STRIKES's doc claim three re-sends for a
    // while when there are two: the count starts at 1 on the first stand-down
    // and the check is `>= STAND_DOWN_STRIKES`, so the third one serves the
    // fallback. Read 1 is the initial body, which stands down from nothing.
    expect(types).toEqual([
      'text',
      'text',
      'text',
      'clip_pin_fallback',
      'clip_pin_fallback',
    ])
    // Gate off ⇒ nothing was pinned either.
    expect(isPinRegistered(lastToolUseId())).toBe(false)
  })
})

describe('FileReadTool — clip pin (forced on)', () => {
  useForcedClipPin()

  test('the first clipped stand-down re-sends the body and pins the copy', async () => {
    const p = writeFixture('clip-pin-first.ts', SAMPLE_TS)
    const ctx = makeContext()

    // read 1: fresh full read (no prior state to dedup against) — nothing to
    // stand down from, so nothing to protect yet.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect(isPinRegistered(lastToolUseId())).toBe(false)

    // read 2: the prior result is clipped → stand down, re-send the body, and
    // pin THIS copy so the next clip pass skips it (that is what ends the loop
    // in production; here the fixture keeps clipping regardless).
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect(isPinRegistered(lastToolUseId())).toBe(true)
  })

  test('a pinned copy that is clipped anyway serves an outline instead of re-sending', async () => {
    const p = writeFixture('clip-pin-fallback.ts', SAMPLE_TS)
    const ctx = makeContext()

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')

    // The pinned copy got clipped too → re-sending is futile.
    const tripped = await readWithPriorClipped(p, ctx)
    expect(tripped.data.type).toBe('clip_pin_fallback')
    if (tripped.data.type !== 'clip_pin_fallback') {
      throw new Error('expected the clip-pin fallback')
    }
    expect(tripped.data.file.servedOutline).toBe(true)
    // The served message is the structural outline (carries symbol names) plus
    // a redirect footer telling the model to stop re-reading.
    expect(tripped.data.file.message).toContain('alpha')
    // Footer-exclusive text: renderOutline's own body also mentions symbol=,
    // so asserting /symbol=/ alone is tautological — this string only exists
    // in the fallback footer (audit finding).
    //
    // The phrase used to be "…even though it was protected". Dropped: this arm
    // also fires for an id retired on sight by MAX_PINNED_RESULT_TOKENS, which
    // is registered but over the ceiling and never actually shielded anything,
    // so the claim was not always true (audit finding).
    expect(tripped.data.file.message).toContain(
      'that copy is no longer in the conversation',
    )
    // The sticky outline is served because the pinned copy got clipped — no
    // cap was hit and the file never crossed the auto-outline threshold, so
    // the header must stay neutral. Mutation testing found this call site
    // (FileReadTool.ts, reason: 'explicit') unguarded: flipping it to
    // 'overcap' passed the entire suite, which is how the same wording bug
    // reached production on the pivot path.
    expect(tripped.data.file.message).toContain('Structural outline')
    expect(tripped.data.file.message).not.toContain('exceeds the read cap')
    expect(tripped.data.file.message).not.toContain('is large')
    // Cache-safety: transcript-dependent, must never be replayed from cache.
    // (noResultCache is optional across the call() return union; cast to read.)
    expect((tripped as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('the fallback BOUNDS the loop without ever denying the file for good', async () => {
    // TWO properties, and every version of this mechanism so far has traded
    // one away for the other:
    //   (1) never an unbounded run of futile full bodies — the original bug;
    //   (2) never an indefinite refusal for a file readable on disk.
    // Returning the outline without touching readFileState kept (1) and broke
    // (2). Deleting the entry to re-arm kept (2) and broke (1) — two bodies
    // every THREE reads under this harness (which clips every prior result, so
    // the pin never protects a round; four when it does), forever. A
    // permanently sticky marker kept (1) and broke (2) again, worse: the
    // marker sets isPartialView, so Edit/Write were refused too, and Read
    // stopped rewriting the entry, so nothing could ever lift the refusal.
    //
    // STICKY_REPLAY_BUDGET holds both at once, and this asserts both.
    const p = writeFixture('clip-pin-stays.ts', SAMPLE_TS)
    const ctx = makeContext()

    // Three full cycles' worth, so the assertions below are about a repeating
    // regime and not about one lucky prefix.
    const period = STICKY_REPLAY_BUDGET + 3
    const types: string[] = []
    for (let i = 0; i < period * 3; i++) {
      types.push((await readWithPriorClipped(p, ctx)).data.type)
    }

    expect(types).toContain('clip_pin_fallback')
    expect(types).toContain('text')
    // (1) Bodies are bounded, back to back AND as a rate. The rate is the half
    // the delete-to-re-arm version failed: it satisfied longestRun and still
    // paid two bodies every three reads.
    //
    // Asserted EXACTLY, not with <=. The regime is deterministic, so a loose
    // bound here would let a real rate regression through: `<= 2 * 3 + 1`
    // passed while the code delivered 6, i.e. it tolerated a 17% regression
    // silently. These stay symbolic in STICKY_REPLAY_BUDGET on purpose — the
    // tuning of the constant is a judgement call documented at its definition,
    // while the SHAPE it produces is what must not drift.
    expect(longestRun(types, 'text')).toBe(2)
    expect(types.filter(t => t === 'text').length).toBe(2 * 3)
    // (2) Outlines are bounded too, so the refusal always ends. Exactly one
    // more than the budget: the fallback that WRITES the marker, then `budget`
    // replays off it.
    expect(longestRun(types, 'clip_pin_fallback')).toBe(
      STICKY_REPLAY_BUDGET + 1,
    )
    // …stated as the thing the user actually cares about: after the outlines
    // start, a body always comes back.
    const firstFallback = types.indexOf('clip_pin_fallback')
    expect(types.slice(firstFallback)).toContain('text')
  })

  test('the sticky refusal lifts, so Edit stops being blocked forever', async () => {
    // The deadlock that the permanent marker created, pinned as the exact
    // predicate the edit tools use. FileEditTool.ts, FileWriteTool.ts,
    // applyPatch.ts and NotebookEditTool.ts all gate on `!entry ||
    // entry.isPartialView`, and the sticky entry sets isPartialView — so while
    // the marker stands, an Edit is refused with "File has not been read yet".
    //
    // That refusal is CORRECT (the model has seen an outline, not the body);
    // what was broken is that Read replayed the marker without rewriting the
    // entry, so the model could neither read its way to a body nor edit. The
    // budget is the only thing that lifts it.
    const p = writeFixture('clip-pin-edit-unblock.ts', SAMPLE_TS)
    const ctx = makeContext()

    const editWouldBeRefused = () => {
      const entry = ctx.readFileState.get(p)
      return !entry || entry.isPartialView === true
    }

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    expect(editWouldBeRefused()).toBe(true)

    // Keep re-reading the way a blocked model would. The body must come back
    // within the budget — before the marker was budgeted this loop never
    // terminated, for any number of iterations.
    let readsUntilEditable = 0
    while (editWouldBeRefused() && readsUntilEditable < 20) {
      readsUntilEditable++
      await readWithPriorClipped(p, ctx)
    }
    expect(editWouldBeRefused()).toBe(false)
    expect(readsUntilEditable).toBeLessThanOrEqual(STICKY_REPLAY_BUDGET + 1)
  })

  // The sticky marker must be sticky, NOT permanent — the failure mode of the
  // first version of this fallback. Four ways out, one test each — except the
  // range key, which is four separate comparisons (offset, limit, view,
  // symbol) and so gets four. They cannot share a fixture: the first read to
  // escape replaces the entry, leaving the later cases no marker to match and
  // no way to fail. The limit case found that out the hard way.

  test('a changed file breaks out of the sticky fallback', async () => {
    const p = writeFixture('clip-pin-escape-mtime.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    // Still stuck while the bytes hold still.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // Now the file changes. The outline describes bytes that no longer exist,
    // so the marker must not answer for them. utimesSync rather than a second
    // write: two writes inside one millisecond can share an mtime, which would
    // make this pass or fail on timing rather than on the guard.
    writeFileSync(p, `${SAMPLE_TS}\nexport const added = 1\n`)
    const future = new Date(Date.now() + 5_000)
    utimesSync(p, future, future)

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('a main-thread compaction breaks out of the sticky fallback', async () => {
    const p = writeFixture('clip-pin-escape-epoch.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // Compaction rewrote the transcript and relieved the pressure that clipped
    // the body. postCompactCleanup bumps the epoch for main-thread compacts
    // (its own test pins that gate); here we assert what the bump BUYS.
    bumpStandDownEpoch()

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('a different range is never answered by the sticky fallback', async () => {
    const p = writeFixture('clip-pin-escape-range.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // The marker is per (path, offset, limit). A read of a DIFFERENT range is
    // a different question and must get real content — the fallback's redirect
    // footer tells the model to do exactly this, so answering it with the same
    // outline would be a dead end.
    expect((await readWithPriorClipped(p, ctx, { offset: 2 })).data.type).toBe(
      'text',
    )
  })

  test('a different limit is never answered by the sticky fallback either', async () => {
    // The `limit` half of the range key, which needs its OWN marker to test
    // against: asserting it right after the offset case above proved nothing,
    // because that read had already replaced the entry and there was no marker
    // left for the branch to match. It passed with the limit comparison
    // deleted — a vacuous assertion, caught by break-and-restore.
    const p = writeFixture('clip-pin-escape-limit.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // Same offset as the marker, different limit. Only the limit comparison
    // can send this to a real read.
    expect((await readWithPriorClipped(p, ctx, { limit: 2 })).data.type).toBe(
      'text',
    )
  })

  test('a view request is never answered by the sticky fallback', async () => {
    // `view`/`symbol` ask a different QUESTION about the same range, and the
    // stored outline is not an answer to either. An audit found both guards
    // untested — no clip-pin test passed `view:` or `symbol:` at all, so
    // deleting `view === undefined` left the whole file green — which meant a
    // `view:'outline'` issued against a sticky path would have been served the
    // stale replay instead of the view that was asked for.
    const p = writeFixture('clip-pin-escape-view.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    const { data } = await readWithPriorClipped(p, ctx, { view: 'outline' })
    // A freshly rendered outline, which the replay cannot produce: the sticky
    // answer is a `clip_pin_fallback`, so the type alone separates them, and
    // the symbol count proves a real scan ran.
    expect(data.type).toBe('outline')
    if (data.type !== 'outline') throw new Error('expected outline')
    expect(data.file.symbolCount).toBe(4)
  })

  test('a symbol request is never answered by the sticky fallback either', async () => {
    // Its OWN fixture and its own marker, for the reason the limit case
    // documents: the view read above already replaced the entry, so asserting
    // this against that marker would pass with `symbol === undefined` deleted.
    const p = writeFixture('clip-pin-escape-symbol.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    const { data } = await readWithPriorClipped(p, ctx, { symbol: 'beta' })
    expect(data.type).toBe('text')
    if (data.type !== 'text') throw new Error('expected text')
    // The expanded symbol specifically — asserting `type === 'text'` alone
    // would also accept a full body, and the fallback has a text arm of its
    // own for non-code files.
    expect(data.file.startLine).toBe(11)
    expect(data.file.content).toBe(
      'export const beta = (y: number) => {\n  return y * 2\n}',
    )
  })

  test('an encoding request is never answered by the sticky fallback', async () => {
    // Same class as the view/symbol guards above, and found the same way: no
    // clip-pin test passed `encoding:`, so deleting `encoding === undefined`
    // left the whole file green while a UTF-16 read against a sticky path got
    // the stale replay of the mojibake body instead of decoded text.
    const p = join(fixtureDir(), 'clip-pin-escape-encoding.ts')
    writeFileSync(p, Buffer.from(SAMPLE_TS, 'utf16le'))
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    const { data } = await readWithPriorClipped(p, ctx, {
      encoding: 'utf-16le',
    })
    expect(data.type).toBe('text')
    if (data.type !== 'text') throw new Error('expected text')
    // Decoded, not the replayed stub and not the UTF-8 misread.
    expect(data.file.content).toContain('export const beta')
    expect(data.file.content).not.toContain('\u0000')
  })

  test('a file that changes before the fallback never goes sticky', async () => {
    // The fallback's own mtime guard, which is a DIFFERENT line from the one
    // the sticky replay checks — same expression, 30 lines apart, and only the
    // replay's copy had a test. Forcing this one to `if (true)` left the whole
    // suite green (audit finding), which is trap (a) from
    // .claudin/rules/agent-safety.md exactly: two identical-looking lines.
    const p = writeFixture('clip-pin-write-arm-mtime.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)

    // The file changes BETWEEN the pinned re-send and the fallback. The
    // outline about to be rendered describes the NEW bytes while the entry's
    // content and timestamp describe the old ones, so there is no coherent
    // pair to make sticky — and a marker keyed to a stale mtime would just sit
    // there being skipped.
    writeFileSync(p, `${SAMPLE_TS}\nexport const added = 1\n`)
    const future = new Date(Date.now() + 5_000)
    utimesSync(p, future, future)

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
    // Delete-and-re-arm instead: no entry at all, so the next read is a real
    // body of the new content.
    expect(ctx.readFileState.get(p)).toBeUndefined()
  })

  test('the sticky replay is never served from the tool-result cache', async () => {
    // The first fallback asserts this too, but they are separate returns with
    // separate flags, and the replay is the one that runs for the rest of the
    // marker's life. A cached replay would freeze the budget as well, since
    // call() would never run to charge it.
    const p = writeFixture('clip-pin-replay-nocache.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)

    const replay = await readWithPriorClipped(p, ctx)
    expect(replay.data.type).toBe('clip_pin_fallback')
    expect((replay as { noResultCache?: boolean }).noResultCache).toBe(true)
  })

  test('the sticky fallback keeps Edit/Write demanding a real Read first', async () => {
    // Keeping an entry where the previous design deleted one must not quietly
    // buy back the Edit permission: isPartialView is what preserves it, and
    // FileEditTool, FileWriteTool, applyPatch and NotebookEditTool all check
    // that same field. (A test asserting the marker is DROPPED by a direct
    // readFileState.set used to sit here, framed as the Edit/Write exit. It
    // was deleted: it passed with the entire sticky replay disabled, and the
    // exit it advertised cannot open in production anyway — the marker refuses
    // the Edit that would have replaced the entry. The budget is that exit
    // now, covered by "the sticky refusal lifts" above.)
    const p = writeFixture('clip-pin-partial-view.ts', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    const sticky = ctx.readFileState.get(p)
    // Assert the entry EXISTS first: `?.toolUseId` being undefined is also
    // true when there is no entry at all, so on its own it was tautological.
    expect(sticky?.standDownOutline).toBeDefined()
    expect(sticky?.isPartialView).toBe(true)
    // …and it carries no tool_use id, so the blind-pointer stub the dedup
    // serves is not even representable from this state.
    expect(sticky?.toolUseId).toBeUndefined()
  })
})
