/**
 * S3 regression — stub byte stability across content views.
 *
 * A tool_result whose content differs between two views of the same
 * conversation (a preview in one, the full original in another) and that
 * gets clipped by the size-based microcompact trigger used to emit DIFFERENT
 * stub bytes depending on which view the rewriter saw: stubOneBlock derived
 * the stub from the content present at stub time — `[clipped: ~N tokens from
 * <tool>]` embeds a token count of that content, and the head-preserving form
 * additionally embeds the first stubKeepHeadChars of it. Preview on the clip
 * turn vs full original on the next turn → different N → wire byte flip →
 * prompt-cache break on the id.
 *
 * Fixed by the first-write-wins stub registry (perKeyStubText): the first
 * emission for an id records the exact bytes, and every later rewriter —
 * over any view — replays them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
} from 'src/agent/compact/stableStubState.js'
import { buildLargeToolResultMessage, processPreMappedToolResultBlock } from 'src/agent/tools/toolResultStorage.js'
import { _resetCacheProfileForTesting } from 'src/agent/cache/cacheProfile.js'
import {
  createAssistantMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import type { Message } from 'src/shared/types/message.js'

const TOOL_USE_ID = 'toolu_s3_byte_stability'
const TOOL_NAME = 'Bash'

// ~44K chars of varied output → ~11K estimated tokens.
const FULL_CONTENT = Array.from(
  { length: 800 },
  (_, i) => `line ${i}: ${'output-payload-'.repeat(3)}${i * 7919}`,
).join('\n')

// A page of the same result (built with the real production builder) — the
// content one view carries while another still holds the full body.
const PREVIEW = buildLargeToolResultMessage(
  { filepath: '/tmp/claudin-s3-test/tool-output.txt', originalSize: FULL_CONTENT.length },
  FULL_CONTENT,
  2_000,
)

// The page names its file, so the stub names it too: the model can read the
// result back instead of running the call again.
const STUB_FORM = /\[clipped: ~\d+ tokens from Bash( — head preserved)?; the full result is saved at \/tmp\/claudin-s3-test\/tool-output\.txt\]$/

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

/**
 * Run the clip-turn sequence and return both wire byte-strings:
 *  - stubTurnN:  what request N (the clip turn) serializes — its view carries
 *                the preview when the id is clipped.
 *  - stubTurnN1: what request N+1 serializes when the view is reseeded from
 *                a persistent array still holding the FULL content (e.g.
 *                QueryEngine.mutableMessages; swarm teammate arrays).
 */
function runTwoTurns(): { stubTurnN: string; stubTurnN1: string } {
  // ---- Turn N: the request on which the size trigger clips the id ----
  const viewN = makeEngineMessages(PREVIEW)
  addClippedIds([TOOL_USE_ID])
  const stubTurnN = contentOf(applyStableStubs(viewN))

  // ---- Turn N+1: view reseeded from the persistent array (FULL content).
  const stubTurnN1 = contentOf(applyStableStubs(makeEngineMessages(FULL_CONTENT)))

  return { stubTurnN, stubTurnN1 }
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
    test('stub bytes are IDENTICAL between the clip turn (preview view) and the next turn reseeded from full content', () => {
      setProfile(headChars)
      const { stubTurnN, stubTurnN1 } = runTwoTurns()

      // Both are well-formed stable stubs for the SAME tool_use_id...
      expect(stubTurnN).toMatch(STUB_FORM)
      expect(stubTurnN1).toMatch(STUB_FORM)
      // ...and the registry replays the first emission byte-for-byte even
      // though the two turns saw different content (preview vs full).
      expect(stubTurnN1).toBe(stubTurnN)
    })
  })
}

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

// A result shipped whole was saved all the same (SAVE_WHOLE_FROM_CHARS), so the
// stub that clips it names the copy: the model reads it back instead of running
// the call again. Without a copy the stub is the plain one.
describe('a clipped whole result names its saved copy', () => {
  // Under Bash's line and past SAVE_WHOLE_FROM_CHARS.
  const WHOLE = FULL_CONTENT.slice(0, 40_000)
  const prevConfigDir = process.env.CLAUDIN_CONFIG_DIR
  const testConfigDir = join(tmpdir(), `claudin-stub-copy-${process.pid}-${Date.now()}`)
  beforeAll(() => {
    process.env.CLAUDIN_CONFIG_DIR = testConfigDir
    mkdirSync(testConfigDir, { recursive: true })
  })
  afterAll(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = prevConfigDir
    rmSync(testConfigDir, { recursive: true, force: true })
  })

  test('saved by storage, the stub points at the file holding these exact bytes', async () => {
    setProfile('0')
    const out = await processPreMappedToolResultBlock(
      { type: 'tool_result', tool_use_id: TOOL_USE_ID, content: WHOLE },
      { name: TOOL_NAME, maxResultSizeChars: 50_000 },
    )
    // Under the line: it ships whole, and is saved all the same.
    expect(out.content).toBe(WHOLE)
    addClippedIds([TOOL_USE_ID])
    const stub = contentOf(applyStableStubs(makeEngineMessages(WHOLE)))
    const path = /; the full result is saved at (\S+)\]$/.exec(stub)![1]!
    expect(readFileSync(path, 'utf8')).toBe(WHOLE)
  })

  test('never saved, the stub stays the plain one', () => {
    setProfile('0')
    addClippedIds([TOOL_USE_ID])
    const stub = contentOf(applyStableStubs(makeEngineMessages(`${FULL_CONTENT}\nnever saved`)))
    expect(stub).toMatch(/^\[clipped: ~\d+ tokens from Bash\]$/)
  })
})
