import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  FileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import {
  satisfiesReadGate,
  isWholeFileView,
} from 'src/tools/shared/readBeforeEditMessages.js'
import {
  createPlanAttachmentIfNeeded,
  createPlanModeAttachmentIfNeeded,
  createPostCompactFileAttachments,
  seedPlanFileState,
} from 'src/agent/compact/postCompactAttachments.js'
import { getPlanModeInstructions } from 'src/agent/messages/planMode.js'
import { FILE_UNCHANGED_STUB } from 'src/tools/FileReadTool/prompt.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { AgentId } from 'src/shared/types/ids.js'
import type { Message, UserMessage } from 'src/shared/types/message.js'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'post-compact-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createPlanAttachmentIfNeeded', () => {
  test('seeds the plan into the cache it was given, as a whole-file entry', () => {
    // Both compaction paths clear readFileState and then re-inject the plan
    // verbatim; without this seed the model's next Edit of a plan it is
    // holding in full was refused with "has not been read yet".
    const p = join(dir, 'plan.md')
    const plan = '# Plan\n\n- [ ] step\n'
    writeFileSync(p, plan)
    const cache = new FileStateCache(10, 1024 * 1024)

    const attachment = createPlanAttachmentIfNeeded(undefined, cache, {
      getPlan: () => plan,
      getPlanFilePath: () => p,
    })

    expect(attachment?.attachment).toMatchObject({
      type: 'plan_file_reference',
      planFilePath: p,
      planContent: plan,
    })
    const entry = cache.get(p)!
    expect(satisfiesReadGate(entry)).toBe(true)
    expect(isWholeFileView(entry)).toBe(true)
    expect(entry.content).toBe(plan)
    expect(entry.timestamp).toBe(getFileModificationTime(p))
  })

  test('without a cache it only builds the attachment', () => {
    const p = join(dir, 'plan-no-cache.md')
    writeFileSync(p, '# Plan\n')
    const attachment = createPlanAttachmentIfNeeded(undefined, undefined, {
      getPlan: () => '# Plan\n',
      getPlanFilePath: () => p,
    })
    expect(attachment?.attachment).toMatchObject({ type: 'plan_file_reference' })
  })

  test('no plan, no attachment, no entry', () => {
    const cache = new FileStateCache(10, 1024 * 1024)
    expect(
      createPlanAttachmentIfNeeded(undefined, cache, {
        getPlan: () => null,
        getPlanFilePath: () => join(dir, 'absent.md'),
      }),
    ).toBeNull()
    expect(cache.size).toBe(0)
  })
})

describe('seedPlanFileState', () => {
  test('a plan that cannot be stat-ed leaves the cache alone', () => {
    const cache = new FileStateCache(10, 1024 * 1024)
    seedPlanFileState(cache, join(dir, 'never-written.md'), '# Plan\n')
    expect(cache.size).toBe(0)
  })
})

// #227: this is the SECOND plan_mode emitter, and #224 only reached the first.
// The pipeline producer is main-thread only now and a child gets its brief from
// runAgent (subagentPlanMode.ts), so compaction has to rebuild the CHILD's
// brief rather than a hand-rolled one — otherwise a compacting child is handed
// an attachment that contradicts the one it opened with.
describe('createPlanModeAttachmentIfNeeded', () => {
  function makeContext(args: {
    agentId?: AgentId
    mode: string
    toolNames: string[]
  }): ToolUseContext {
    return {
      agentId: args.agentId,
      options: { tools: args.toolNames.map(name => ({ name })) },
      getAppState: () => ({
        toolPermissionContext: { mode: args.mode },
      }),
      setAppState: () => {},
    } as unknown as ToolUseContext
  }

  const CHILD = 'agent_227' as AgentId

  test('a child that can submit a plan is told about the plan file', async () => {
    const out = await createPlanModeAttachmentIfNeeded(
      makeContext({
        agentId: CHILD,
        mode: 'plan',
        toolNames: ['Read', 'ExitPlanMode'],
      }),
    )

    expect(out?.attachment).toMatchObject({
      type: 'plan_mode',
      isSubAgent: true,
      canExitPlanMode: true,
    })
  })

  test('a child without ExitPlanMode is not told to submit one', async () => {
    // The hand-rolled attachment set no canExitPlanMode at all, so a
    // WebResearcher was told to write a plan file with tools it does not have.
    const out = await createPlanModeAttachmentIfNeeded(
      makeContext({ agentId: CHILD, mode: 'plan', toolNames: ['WebFetch'] }),
    )

    expect(out?.attachment).toMatchObject({
      type: 'plan_mode',
      isSubAgent: true,
      canExitPlanMode: false,
    })
  })

  test('a child outside plan mode gets nothing', async () => {
    expect(
      await createPlanModeAttachmentIfNeeded(
        makeContext({ agentId: CHILD, mode: 'default', toolNames: ['Read'] }),
      ),
    ).toBeNull()
  })

  test('the main thread keeps its own wording', async () => {
    const out = await createPlanModeAttachmentIfNeeded(
      makeContext({ mode: 'plan', toolNames: ['Read'] }),
    )

    expect(out?.attachment).toMatchObject({
      type: 'plan_mode',
      isSubAgent: false,
    })
  })

  test('both wordings carry the brief they render now, for a resume to re-send', async () => {
    // The text reads flags, config and the scratchpad path, any of which a
    // resumed process can see differently (.claudin/rules/cache.md §7).
    // Checked against the live renderer, or a snapshot of the wrong wording
    // would pass.
    const texts = (messages: UserMessage[]) => messages.map(m => m.message.content)
    for (const context of [
      makeContext({ mode: 'plan', toolNames: ['Read'] }),
      makeContext({ agentId: CHILD, mode: 'plan', toolNames: ['Read', 'ExitPlanMode'] }),
    ]) {
      const planMode = (await createPlanModeAttachmentIfNeeded(context))?.attachment
      if (planMode?.type !== 'plan_mode') throw new Error('expected a plan_mode attachment')
      const { rendered, ...live } = planMode

      expect(rendered).toBeString()
      expect(texts(getPlanModeInstructions(planMode))).toEqual(texts(getPlanModeInstructions(live)))
    }
  })
})

describe('createPostCompactFileAttachments', () => {
  let priorSimpleMode: string | undefined
  beforeAll(() => {
    // Skill discovery on the restored paths touches the real filesystem and
    // is irrelevant here.
    priorSimpleMode = process.env.CLAUDIN_SIMPLE
    process.env.CLAUDIN_SIMPLE = '1'
  })
  afterAll(() => {
    if (priorSimpleMode === undefined) delete process.env.CLAUDIN_SIMPLE
    else process.env.CLAUDIN_SIMPLE = priorSimpleMode
  })

  function makeReadContext(): ToolUseContext {
    return {
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: true,
        },
      }),
      setAppState: () => {},
      options: {},
    } as unknown as ToolUseContext
  }

  test('a restored file counts once against the budget, not again for its snapshot', async () => {
    // A restored file keeps its Read block as rendered, for a resume to
    // re-send (FileAttachment.rendered) — the same file again, line-numbered.
    // Thirty files of ~1k tokens fit the 50k budget counted once and do not
    // fit it counted twice. Each stays under a quarter of the per-file cap,
    // so no read reaches the token-count API.
    const body = Array.from({ length: 100 }, (_, i) => `row ${i}`.padEnd(39, '.')).join('\n')
    const readFileState: Record<string, { content: string; timestamp: number }> = {}
    for (let i = 0; i < 30; i++) {
      const p = join(dir, `restored-${i}.txt`)
      writeFileSync(p, body)
      readFileState[p] = { content: body, timestamp: i }
    }

    const restored = await createPostCompactFileAttachments(readFileState, makeReadContext(), 30)

    // The snapshot is there to be counted, so it is the budget that decides.
    expect(
      restored.every(m => m.attachment.type === 'file' && m.attachment.rendered !== undefined),
    ).toBe(true)
    expect(restored).toHaveLength(30)
  })

  // CLAUDIN_READ_MULTI: one tool_use names several files, and its result
  // shows each under a `==> path <==` header (batchRead.ts).
  describe('a batch Read in the preserved tail', () => {
    function files(...names: string[]): string[] {
      return names.map(name => {
        const p = join(dir, `batch-${name}.txt`)
        writeFileSync(p, `${name}\n`)
        return p
      })
    }

    /** One Read, answered with `result`: the preserved tail. */
    function tailOf(input: unknown, result: string): Message[] {
      return [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_batch', name: 'Read', input }],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_batch', content: result }],
          },
        },
      ] as unknown as Message[]
    }

    async function restoredNames(paths: string[], tail: Message[]): Promise<string[]> {
      const readFileState = Object.fromEntries(
        paths.map((p, i) => [p, { content: 'x', timestamp: i }]),
      )
      const restored = await createPostCompactFileAttachments(
        readFileState,
        makeReadContext(),
        10,
        tail,
      )
      return restored.map(m => (m.attachment.type === 'file' ? m.attachment.filename : '')).sort()
    }

    test('spares the files it showed, and only those', async () => {
      // The file it answered with the unchanged stub and the one left out for
      // its budget are not in the tail, so they are restored like any other.
      const [shown, stubbed, notShown, other] = files('shown', 'stubbed', 'not-shown', 'other')
      const tail = tailOf(
        { file_path: null, file_paths: [shown, stubbed, notShown] },
        [
          `==> ${shown} <==\n     1→shown`,
          `==> ${stubbed} <==\n${FILE_UNCHANGED_STUB}`,
          `Not shown — over the 25k tokens one Read returns: ${notShown}. Read them in another call.`,
        ].join('\n\n'),
      )
      expect(await restoredNames([shown!, stubbed!, notShown!, other!], tail)).toEqual(
        [stubbed!, notShown!, other!].sort(),
      )
    })

    test('one the schema refused counts its file_path, as a Read of it always has', async () => {
      const [refused, other] = files('refused', 'refused-other')
      const tail = tailOf(
        { file_path: refused, symbol: ['x', 'y'] },
        'InputValidationError: symbol: Expected string',
      )
      expect(await restoredNames([refused!, other!], tail)).toEqual([other!])
    })

    test('spares the files a glob it named showed (CLAUDIN_READ_GLOBS)', async () => {
      const [a, b, other] = files('glob-a', 'glob-b', 'glob-other')
      const tail = tailOf(
        { file_paths: [join(dir, 'batch-glob-[ab].txt')] },
        [`==> ${a} <==\n     1→glob-a`, `==> ${b} <==\n     1→glob-b`].join('\n\n'),
      )
      expect(await restoredNames([a!, b!, other!], tail)).toEqual([other!])
    })
  })
})
