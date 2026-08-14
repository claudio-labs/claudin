/**
 * S3 regression — stub byte stability across content views.
 *
 * A tool_result under budget-replacement (ContentReplacementState
 * replacements → preview string) that gets clipped by the size-based
 * microcompact trigger used to emit DIFFERENT stub bytes depending on
 * which content view the rewriter saw: stubOneBlock derived the stub from
 * the content present at stub time — `[clipped: ~N tokens from <tool>]`
 * embeds a token count of that content, and the head-preserving form
 * additionally embeds the first stubKeepHeadChars of it. Preview on the
 * clip turn vs full original on the next turn → different N → wire byte
 * flip → prompt-cache break on the id.
 *
 * Fixed by the first-write-wins stub registry (perKeyStubText): the first
 * emission for an id records the exact bytes, and every later rewriter —
 * over any view — replays them.
 *
 * Realistic per-request order (verified in source):
 *   query.ts:425  enforceToolResultBudget  → applies preview to the view
 *   query.ts:469  microcompactMessages     → addClippedIds + crs.replacements.delete
 *   streaming.ts:540 applyStableStubs      → wire bytes (computed from the view)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
} from './stableStubState.js'
import {
  applyToolResultReplacementsToMessages,
  buildLargeToolResultMessage,
  createContentReplacementState,
  enforceToolResultBudget,
  type ContentReplacementState,
} from 'src/utils/toolResultStorage.js'
import { _resetCacheProfileForTesting } from 'src/services/cache/cacheProfile.js'
import {
  createAssistantMessage,
  createUserMessage,
} from 'src/utils/messages.js'
import type { Message } from 'src/types/message.js'

const TOOL_USE_ID = 'toolu_s3_byte_stability'
const TOOL_NAME = 'Bash'

// ~44K chars of varied output → ~11K estimated tokens.
const FULL_CONTENT = Array.from(
  { length: 800 },
  (_, i) => `line ${i}: ${'output-payload-'.repeat(3)}${i * 7919}`,
).join('\n')

// The exact preview string the budget would have cached on the turn the
// replacement was created (built with the real production builder).
const PREVIEW = buildLargeToolResultMessage({
  filepath: '/tmp/claudin-s3-test/tool-output.txt',
  originalSize: FULL_CONTENT.length,
  isJson: false,
  preview: FULL_CONTENT.slice(0, 2000),
  hasMore: true,
})

const STUB_FORM = /\[clipped: ~\d+ tokens from Bash( — head preserved)?\]$/

function makeEngineMessages(content: string): Message[] {
  const assistant = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: TOOL_USE_ID,
        name: TOOL_NAME,
        input: { command: 'generate-output' },
      },
    ] as never,
  })
  const user = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: TOOL_USE_ID,
        content,
        is_error: false,
      },
    ],
  })
  return [assistant, user] as Message[]
}

function contentOf(messages: readonly Message[]): string {
  for (const msg of messages) {
    const inner = (msg as { message?: { content?: unknown } }).message
    const blocks = inner?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks as Array<{
      type?: string
      tool_use_id?: string
      content?: unknown
    }>) {
      if (block?.type === 'tool_result' && block.tool_use_id === TOOL_USE_ID) {
        return String(block.content)
      }
    }
  }
  throw new Error('tool_result not found in fixture')
}

function makeReplacedState(): ContentReplacementState {
  // State as it exists right before the clip turn: the id was replaced on
  // an earlier turn (mustReapply path — pure Map lookup, no file I/O).
  const state = createContentReplacementState()
  state.seenIds.add(TOOL_USE_ID)
  state.replacements.set(TOOL_USE_ID, PREVIEW)
  return state
}

/**
 * Run the realistic clip-turn sequence and return both wire byte-strings:
 *  - stubTurnN:  what request N (the clip turn) serializes — view has the
 *                budget preview applied; clip + replacement-delete happen
 *                between budget and applyStableStubs.
 *  - stubTurnN1: what request N+1 serializes when the view is reseeded from
 *                a persistent array still holding the FULL content (e.g.
 *                QueryEngine.mutableMessages; swarm teammate arrays).
 */
async function runTwoTurns(): Promise<{
  stubTurnN: string
  stubTurnN1: string
  state: ContentReplacementState
  engineMessages: Message[]
}> {
  const state = makeReplacedState()
  const engineMessages = makeEngineMessages(FULL_CONTENT)

  // ---- Turn N: the request on which the size trigger clips the id ----
  // query.ts:425 — budget re-applies the cached preview to the request view.
  const { messages: viewN } = await enforceToolResultBudget(
    engineMessages,
    state,
  )
  expect(contentOf(viewN)).toBe(PREVIEW)

  // microCompact.ts — id enters clippedIds, replacement deleted.
  // seenIds intentionally kept.
  addClippedIds([TOOL_USE_ID])
  state.replacements.delete(TOOL_USE_ID)

  // streaming.ts — wire bytes of turn N.
  const stubTurnN = contentOf(applyStableStubs(viewN))

  // ---- Turn N+1: view reseeded from the persistent array (FULL content),
  // which never received the preview (syncToolResultReplacements is wired
  // only in the REPL). Budget sees the id frozen (in seenIds, no
  // replacement) and leaves it untouched.
  const { messages: viewN1 } = await enforceToolResultBudget(
    engineMessages,
    state,
  )
  expect(viewN1).toBe(engineMessages) // frozen → identity fast path
  const stubTurnN1 = contentOf(applyStableStubs(viewN1))

  return { stubTurnN, stubTurnN1, state, engineMessages }
}

const ORIG_PROFILE = process.env.CLAUDIN_CACHE_PROFILE
const ORIG_HEAD = process.env.CLAUDIN_STUB_HEAD_CHARS

function setProfile(headChars: string | undefined): void {
  process.env.CLAUDIN_CACHE_PROFILE = 'aggressive'
  if (headChars === undefined) delete process.env.CLAUDIN_STUB_HEAD_CHARS
  else process.env.CLAUDIN_STUB_HEAD_CHARS = headChars
  _resetCacheProfileForTesting()
}

beforeEach(() => {
  _resetAllClippedIdsForTesting()
})

afterEach(() => {
  _resetAllClippedIdsForTesting()
  if (ORIG_PROFILE === undefined) delete process.env.CLAUDIN_CACHE_PROFILE
  else process.env.CLAUDIN_CACHE_PROFILE = ORIG_PROFILE
  if (ORIG_HEAD === undefined) delete process.env.CLAUDIN_STUB_HEAD_CHARS
  else process.env.CLAUDIN_STUB_HEAD_CHARS = ORIG_HEAD
  _resetCacheProfileForTesting()
})

for (const [label, headChars] of [
  ['pure stub (CLAUDIN_STUB_HEAD_CHARS=0)', '0'],
  ['head-preserving stub (aggressive default, head=1000)', undefined],
] as const) {
  describe(`S3 regression — ${label}`, () => {
    test('stub bytes are IDENTICAL between the clip turn (preview view) and the next turn reseeded from full content', async () => {
      setProfile(headChars)
      const { stubTurnN, stubTurnN1 } = await runTwoTurns()

      // Both are well-formed stable stubs for the SAME tool_use_id...
      expect(stubTurnN).toMatch(STUB_FORM)
      expect(stubTurnN1).toMatch(STUB_FORM)
      // ...and the registry replays the first emission byte-for-byte even
      // though the two turns saw different content (preview vs full).
      expect(stubTurnN1).toBe(stubTurnN)
    })
  })
}

describe('S3 — REPL main thread (display array seeds the next turn)', () => {
  test('synced preview + post-turn applyStableStubs makes the turn-N bytes sticky', async () => {
    setProfile('0')
    const { stubTurnN, state, engineMessages } = await runTwoTurns()

    // REPL.tsx — at the turn the replacement was created,
    // syncToolResultReplacements wrote the PREVIEW into the display array.
    const display = applyToolResultReplacementsToMessages(
      engineMessages,
      new Map([[TOOL_USE_ID, PREVIEW]]),
    )
    // REPL.tsx — post-turn pass persists the stub into the display
    // array that seeds the next turn's API view.
    const displayAfter = applyStableStubs(display)
    // Bytes identical to what turn N already sent on the wire...
    expect(contentOf(displayAfter)).toBe(stubTurnN)

    // ...and final from here on: the next request's budget (frozen id) and
    // applyStableStubs (isClipStubContent guard) both leave them unchanged.
    const { messages: viewNext } = await enforceToolResultBudget(
      displayAfter,
      state,
    )
    expect(contentOf(applyStableStubs(viewNext))).toBe(stubTurnN)
  })
})

describe('S3 — registry lifecycle', () => {
  test('reset clears recorded stub bytes (fresh session recomputes)', async () => {
    setProfile('0')
    addClippedIds([TOOL_USE_ID])
    const fullStub = contentOf(
      applyStableStubs(makeEngineMessages(FULL_CONTENT)),
    )
    _resetAllClippedIdsForTesting()
    addClippedIds([TOOL_USE_ID])
    const previewStub = contentOf(applyStableStubs(makeEngineMessages(PREVIEW)))
    // After a reset the registry is empty, so the stub derives from the
    // (different) content again — proves the replay path was the registry.
    expect(previewStub).not.toBe(fullStub)
  })
})

describe('control — stub determinism for an unchanging content view', () => {
  test('same content + same profile → byte-identical stub on repeated application', async () => {
    setProfile('0')
    addClippedIds([TOOL_USE_ID])
    const messages = makeEngineMessages(FULL_CONTENT)
    const once = applyStableStubs(messages)
    const twice = applyStableStubs(once)
    expect(contentOf(twice)).toBe(contentOf(once))
  })
})
