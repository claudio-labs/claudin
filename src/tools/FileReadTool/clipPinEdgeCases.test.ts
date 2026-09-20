// Clip-pin edge cases: the un-pinnable context, the spent cycle, the
// mid-prompt clip registry, the pin ceiling, the abort rethrow, and the two
// fallback shapes a file with no usable outline gets.
//
// Split out of the 2177-line FileReadTool.test.ts. The forced-on describe that
// wrapped these cases is now useForcedClipPin(); the fixtures and the
// process-global env pair live in __testutils__/fileReadHarness.ts.

import { describe, expect, test } from 'bun:test'

import {
  addClippedIds,
  buildClipStub,
  isPinRegistered,
  pinToolResult,
} from 'src/agent/compact/stableStubState.js'
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

  test('a context with no toolUseId is bounded by strikes, not denied on the first', async () => {
    // The un-pinnable case: Tool.ts's toolUseId is optional, and the callers
    // that skip it are user-facing — @-mentions (attachments/file-pipeline.ts
    // calls FileReadTool.call directly), MagicDocs, SessionMemory, the MCP
    // entrypoint. Two wrong answers were shipped here in a row: re-sending
    // forever (nothing records the stand-down), then serving the outline on the
    // FIRST stand-down, which tells a user who explicitly re-@-mentioned a file
    // to stop re-reading it. Lane 2 is the third answer: a real bound, but the
    // model gets bodies first.
    const p = writeFixture('clip-pin-no-id.ts', SAMPLE_TS)
    const ctx = makeContext({ messages: [assistantWithClearing(4)] })
    // No assignFreshToolUseId anywhere in this test: ctx.toolUseId stays
    // undefined, so readFileState entries carry no id.
    const types: string[] = []
    for (let i = 0; i < 6; i++) {
      types.push((await read(p, {}, ctx)).data.type)
    }
    expect(ctx.readFileState.get(p)?.toolUseId).toBeUndefined()

    // The first stand-down must NOT be a refusal.
    expect(types[0]).toBe('text')
    expect(types[1]).toBe('text')
    // ...and the run is still bounded.
    expect(types).toContain('clip_pin_fallback')
    expect(longestRun(types, 'text')).toBeLessThanOrEqual(STAND_DOWN_STRIKES)
  })

  test('a spent cycle lets the Read cache work again on an intact re-read', async () => {
    // isPinRegistered answers true for SPENT ids too, so keying the cache bypass
    // on it would latch: the intact branch retires the id into spent while
    // leaving readFileState pointing at it, and the path would then skip the
    // cache for the rest of the session. isPinShielding is the in-flight half.
    const p = writeFixture('clip-pin-spent-bypass.ts', SAMPLE_TS)
    const ctx = makeContext()
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const pinnedId = lastToolUseId()

    // Close the cycle: prior result intact ⇒ retirePinAfterUse ⇒ id is spent.
    setContextMessages(ctx, [userWithToolResult(pinnedId, 'the real body')])
    await read(p, {}, ctx)
    expect(isPinRegistered(pinnedId)).toBe(true)

    // Still spent, still intact, nothing in flight → the cache is allowed again.
    expect(FileReadTool.bypassResultCache?.({ file_path: p }, ctx)).toBe(false)
  })

  test('a clip registered mid-prompt is caught even though the bytes still look intact', async () => {
    // The blindness the whole feature almost shipped with. The array a tool
    // sees during a turn (toolUseContext.messages, refreshed from
    // messagesForQuery) holds the UNCLIPPED originals — applyStableStubs
    // rewrites a separate copy on its way to the wire and the clipped form is
    // only written back post-turn. So a Read clipped by microCompact in the
    // middle of one long prompt still reads as intact content, the stand-down
    // never fires, and the model gets a dedup stub pointing at bytes it can no
    // longer see: exactly the loop this mechanism exists to close, surviving
    // inside the case where clipping is most aggressive.
    const p = writeFixture('clip-pin-inflight.ts', SAMPLE_TS)
    const ctx = makeContext()
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    const priorId = ctx.readFileState.get(p)?.toolUseId
    expect(priorId).toBeDefined()

    // The transcript the tool can see still carries the REAL body — this is
    // the whole point, the clip has not been written back yet.
    setContextMessages(ctx, [userWithToolResult(priorId!, 'the real body')])
    // ...but the clip path has already registered the id on its way to the API.
    addClippedIds([priorId!])

    assignFreshToolUseId(ctx)
    const { data } = await read(p, {}, ctx)
    // Must re-send. Before the registry check this returned 'file_unchanged',
    // pointing the model at content the API had already dropped.
    expect(data.type).toBe('text')
  })

  test('a SHIELDING pin means a registered clip id is not evidence of a clip', async () => {
    // The other half of the registry check above, and the case it got wrong.
    // The registry records what the clip machinery DECIDED to clip, not what
    // it managed to clip: microCompact adds candidates without consulting the
    // pin registry, and stubOneBlock then skips the pinned ones. So a
    // shielding id sits in the clipped set with its bytes fully intact.
    //
    // Reading the registry alone made the pin actively counterproductive: the
    // model was sent to the outline fallback for content it still had
    // verbatim, and the fallback's exit released the pin, so the block it had
    // been protecting was stubbed on the very next pass. The pin bought a
    // round-trip and nothing else.
    const p = writeFixture('clip-pin-shielded-id.ts', SAMPLE_TS)
    const ctx = makeContext()
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    const priorId = ctx.readFileState.get(p)?.toolUseId
    expect(priorId).toBeDefined()

    // Same setup as above — the id is registered as clipped — except that this
    // one is SHIELDING, which is why the bytes are still in the transcript.
    setContextMessages(ctx, [userWithToolResult(priorId!, 'the real body')])
    pinToolResult(priorId!)
    addClippedIds([priorId!])

    assignFreshToolUseId(ctx)
    // Without the isPinShielding check this returned 'clip_pin_fallback': an
    // outline, for a body sitting in front of the model.
    expect((await read(p, {}, ctx)).data.type).toBe('file_unchanged')
  })

  test('a body over the pin ceiling skips the futile re-send', async () => {
    // Above MAX_PINNED_RESULT_TOKENS pinShieldsBlock retires the id on sight,
    // so the re-sent copy is clipped in the same pass that first examines it
    // and the id lands in the spent registry — which sends the NEXT read to
    // the fallback anyway. One full futile body, every cycle, to reach a
    // decision that was already made.
    //
    // .txt on purpose: with a code fixture the auto-outline pivot intercepts
    // a file this size and the first read never produces the oversized body
    // under test — the sibling-path trap from .claudin/rules/agent-safety.md.
    // ~50k chars sits above the 8k-token ceiling and below the 25k-token read
    // cap, so neither bound is the thing being measured by accident.
    const body = Array.from(
      { length: 1500 },
      (_, i) => `plain log line ${i} with some filler text to pad the bytes`,
    ).join('\n')
    const p = writeFixture('clip-pin-oversized.txt', body)
    // maxTokens raised on purpose. validateContentTokens calls the counting
    // API once the estimate passes maxTokens/4 — 6250 by default, which is
    // BELOW the 8k pin ceiling, so any fixture big enough to test this lane
    // would drag the VCR layer in and record a
    // src/providers/__fixtures__/vcr/token-count-*.json.
    // The read cap is not what is under test here; pin it out of the way.
    const ctx = makeContext({
      fileReadingLimits: { maxSizeBytes: 10 * 1024 * 1024, maxTokens: 100_000 },
    })

    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
    // The stand-down. This used to re-send the whole body and pin it; now it
    // goes straight to the fallback, because that body could never have been
    // shielded in the first place.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )
  })

  test('a sticky fallback entry bypasses the tool-result cache', async () => {
    // The fallback's decision lives on the ENTRY, not in the tool input, and a
    // cache hit short-circuits before call(). Replaying a cached body here
    // would hand back precisely the content the fallback concluded cannot
    // survive, while the marker was never consulted — the loop keeps spinning
    // invisibly for the whole TTL. The old code could not even reach this
    // question: the fallback deleted the entry, so bypassResultCache returned
    // at `if (!prior)` before looking at anything.
    const p = writeFixture('clip-pin-sticky-bypass.ts', SAMPLE_TS)
    const ctx = makeContext()
    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe(
      'clip_pin_fallback',
    )

    // An empty transcript on purpose: it fails every OTHER reason this method
    // has to bypass (no server clearing, no id to ask the pin about), so a
    // true here can only come from the sticky check.
    setContextMessages(ctx, [])
    expect(FileReadTool.bypassResultCache?.({ file_path: p }, ctx)).toBe(true)
  })

  test('a cancelled fallback propagates the abort instead of degrading', async () => {
    // The head-slice helper swallows read errors and returns '' so the fallback
    // degrades to a bare redirect. An abort is not a failed read — it is the
    // user pressing escape — and turning it into '' hands the model a truncated
    // answer for a request that was called off, plus logs a phantom error.
    // An audit found the `if (isAbortError(e)) throw e` rethrow untested.
    //
    // The fixture must have NO outline language (.txt, not .ts): with one, the
    // fallback calls scanFile first and THAT rethrows the abort, so the head
    // slice is never reached and the test passes without touching the line it
    // claims to guard. The first version of this test did exactly that.
    const p = writeFixture('clip-pin-abort.txt', SAMPLE_TS)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)

    // Third read is the fallback. Abort before it runs the head slice.
    const priorId = ctx.readFileState.get(p)?.toolUseId
    setContextMessages(
      ctx,
      priorId ? [userWithToolResult(priorId, buildClipStub('Read', 1234))] : [],
    )
    assignFreshToolUseId(ctx)
    ctx.abortController.abort()

    await expect(read(p, {}, ctx)).rejects.toThrow()
  })

  test('an ordinary dedup hit does not spend the one re-send a later clip is owed', async () => {
    // retirePinAfterUse runs on EVERY intact dedup hit, including for files
    // that were never in a clip loop and never had a pin. Its no-op guard is
    // what keeps such an id out of the spent set — and `spent` is one of the
    // two halves isPinRegistered answers true for, which is what lane 1 of the
    // stand-down keys on.
    //
    // So without the guard: read a file twice normally, and the second (dedup)
    // read marks the id spent; the FIRST time that file is ever clipped, lane 1
    // sees a "registered" id, concludes the protected re-send was already used
    // and goes straight to the outline. The file is never re-sent even once.
    // An audit found this consequence documented on the guard but untested.
    const p = writeFixture('clip-pin-never-pinned.ts', SAMPLE_TS)
    const ctx = makeContext()

    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('text')
    const id = ctx.readFileState.get(p)?.toolUseId
    expect(id).toBeDefined()
    // No pin was ever placed on this id — an ordinary read of an ordinary file.
    expect(isPinRegistered(id!)).toBe(false)

    // An intact dedup hit. This calls retirePinAfterUse(id).
    setContextMessages(ctx, [userWithToolResult(id!, 'the real body')])
    assignFreshToolUseId(ctx)
    expect((await read(p, {}, ctx)).data.type).toBe('file_unchanged')
    // The guard's whole job: an id that never shielded anything stays unknown.
    expect(isPinRegistered(id!)).toBe(false)

    // Now the first clip this file has ever seen. It is owed a real re-send.
    expect((await readWithPriorClipped(p, ctx)).data.type).toBe('text')
  })

  test('a one-symbol file falls back to the head slice, not a one-line outline', async () => {
    // scanFile only returns null at ZERO symbols, so a long file whose parser
    // finds a single top-level symbol used to be "answered" with a one-line
    // outline. That is technically an outline and useless as a view of the
    // file — the same floor the auto-outline pivot applies keeps it on the head
    // slice, which is real content.
    const body = [
      'export function onlySymbol() {',
      ...Array.from({ length: 300 }, (_, i) => `  const v${i} = ${i}`),
      '}',
    ].join('\n')
    const p = writeFixture('clip-pin-onesymbol.ts', body)
    const ctx = makeContext()

    await readWithPriorClipped(p, ctx)
    await readWithPriorClipped(p, ctx)
    const out = await readWithPriorClipped(p, ctx)
    expect(out.data.type).toBe('clip_pin_fallback')
    const file = (
      out.data as { file: { message: string; servedOutline: boolean } }
    ).file
    expect(file.servedOutline).toBe(false)
    // Head slice ⇒ real, line-numbered content from the top of the file.
    expect(file.message).toContain('onlySymbol')
    expect(file.message).toMatch(/\b1→/)
  })

  test('a clipped notebook gets the bare redirect, not raw nbformat JSON', async () => {
    // .ipynb has no outline language, so it reaches the head-slice arm — where
    // its first 60 lines are metadata and base64 outputs, line-numbered to look
    // like content the model can aim at. It cannot.
    //
    // Sibling case, same arm: `a one-symbol file…` below covers a file that
    // HAS an outline language but too few symbols for the outline to be worth
    // serving.
    const nb = writeFixture(
      'clip-pin-nb.ipynb',
      JSON.stringify(
        {
          cells: [
            { cell_type: 'code', source: ['print(1)\n'], outputs: [], metadata: {} },
          ],
          metadata: { kernelspec: { name: 'python3' } },
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        2,
      ),
    )
    const ctx = makeContext()
    await readWithPriorClipped(nb, ctx) // first read
    await readWithPriorClipped(nb, ctx) // the one protected re-send
    const out = await readWithPriorClipped(nb, ctx) // pinned and gone → fallback
    expect(out.data.type).toBe('clip_pin_fallback')
    const message = (out.data as { file: { message: string } }).file.message
    expect(message).not.toContain('nbformat')
    expect(message).not.toContain('kernelspec')
    expect(message).toContain('Stop re-reading this range')
    // The redirect and nothing else — no line-numbered JSON in front of it.
    expect(message.startsWith('<system-reminder>')).toBe(true)
  })
})
