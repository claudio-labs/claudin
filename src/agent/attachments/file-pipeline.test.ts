import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { getFileModificationTimeAsync } from 'src/shared/fs/file.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import { generateFileAttachment } from 'src/agent/attachments/file-pipeline.js'
import type { Attachment, FileAttachment } from 'src/agent/attachments/types.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/attachments.js'
import {
  _resetReadReminderStateForTesting,
  _setMitigationModelResolverForTesting,
} from 'src/tools/FileReadTool/resultContent.js'

let dir: string
let priorSimpleMode: string | undefined

beforeAll(() => {
  // Skill discovery touches the real filesystem and is irrelevant here.
  // Scoped to this file rather than set at module scope: bun runs every test
  // file in one process, so a bare assignment leaks --bare mode into every
  // file that runs afterwards. It disabled the task_reconcile attachment in
  // src/agent/query/taskReconcile.pipeline.test.ts, which has nothing to do
  // with this one. (The static imports above are hoisted over it either way,
  // so nothing here ever read it at module-init time.)
  priorSimpleMode = process.env.CLAUDIN_SIMPLE
  process.env.CLAUDIN_SIMPLE = '1'
  dir = mkdtempSync(join(tmpdir(), 'file-pipeline-'))
})

afterAll(() => {
  if (priorSimpleMode === undefined) delete process.env.CLAUDIN_SIMPLE
  else process.env.CLAUDIN_SIMPLE = priorSimpleMode
  rmSync(dir, { recursive: true, force: true })
})

function makeCtx(
  fileReadingLimits?: ToolUseContext['fileReadingLimits'],
): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    fileReadingLimits,
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

describe('generateFileAttachment — the already-read optimization', () => {
  // The optimization means "the model already has this file, do not re-send
  // it". A PARTIAL entry makes that false: an outline, a head slice or a
  // stripped auto-injection is not the file. The gate only compared
  // timestamps, so any partial entry whose timestamp happens to be the mtime
  // suppressed the injection.
  //
  // The clip-pin sticky marker is the case that made this urgent — its
  // timestamp IS the mtime, always, so it matched every time. An @-mention is
  // the user's manual way to put the real file back in front of the model, and
  // it is the one escape from a stand-down that does not depend on the model's
  // own next move.

  test('a partial entry does NOT suppress the injection', async () => {
    const p = join(dir, 'partial.ts')
    writeFileSync(p, 'export const alpha = 1\n')
    const ctx = makeCtx()
    const mtimeMs = await getFileModificationTimeAsync(p)

    ctx.readFileState.set(p, {
      content: 'export const alpha = 1\n',
      timestamp: mtimeMs,
      offset: 1,
      limit: undefined,
      isPartialView: true,
      standDownOutline: {
        message: '<outline>',
        servedOutline: true,
        epoch: 0,
        replays: 0,
      },
    })

    const attachment = await generateFileAttachment(
      p,
      ctx,
      'at-mention',
    )
    expect(attachment?.type).toBe('file')
  })

  test('a full entry still suppresses it — the optimization is intact', async () => {
    // The control arm. Without it the test above would also pass if the
    // optimization were deleted outright, which would re-send every mentioned
    // file on every turn.
    const p = join(dir, 'full.ts')
    writeFileSync(p, 'export const beta = 2\n')
    const ctx = makeCtx()
    const mtimeMs = await getFileModificationTimeAsync(p)

    ctx.readFileState.set(p, {
      content: 'export const beta = 2\n',
      timestamp: mtimeMs,
      offset: 1,
      limit: undefined,
    })

    const attachment = await generateFileAttachment(
      p,
      ctx,
      'at-mention',
    )
    expect(attachment?.type).toBe('already_read_file')
  })
})

describe('generateFileAttachment — the Read block a resumed process re-sends', () => {
  // An @-mention is rendered again on every request, and by a resumed process
  // from its transcript copy — which has lost what rode on the result
  // object's identity (the once-per-agent reminder) and reads the model gate
  // and the line format live. So a text file keeps its Read block as rendered
  // at creation (.claudin/rules/cache.md §7). Each case compares the snapshot
  // with the live renderer at creation, or a snapshot that drifted would pass.
  const withoutSnapshot = ({ rendered: _, ...live }: FileAttachment): FileAttachment => live
  const sent = (a: Attachment): unknown[] =>
    normalizeAttachmentForAPI(a).map(m => m.message.content)

  test('a text file carries the block it rendered', async () => {
    const p = join(dir, 'mentioned.ts')
    writeFileSync(p, 'export function quote() {}\n')
    // A model the reminder is not exempt for, and an agent that has not read
    // yet: the block then carries the reminder keyed on the result object,
    // the part a transcript round trip loses.
    _resetReadReminderStateForTesting()
    _setMitigationModelResolverForTesting(() => 'claude-sonnet-5')
    try {
      const attachment = await generateFileAttachment(p, makeCtx(), 'at-mention')
      if (attachment?.type !== 'file') throw new Error('expected a file attachment')

      expect(attachment.rendered).toContain('consider whether it would be considered malware')
      expect(sent(attachment)).toEqual(sent(withoutSnapshot(attachment)))
    } finally {
      _setMitigationModelResolverForTesting(undefined)
      _resetReadReminderStateForTesting()
    }
  })

  test('so does the head of a file too large to read whole', async () => {
    // The other `type: 'file'` return: past the byte cap the full read throws
    // and the pipeline sends the first MAX_LINES_TO_READ lines. The over-cap
    // preview would answer before it does, so the preview is off here.
    const p = join(dir, 'too-large.txt')
    writeFileSync(p, Array.from({ length: 100 }, (_, i) => `row ${i}`.padEnd(40, '.')).join('\n'))
    const priorDisable = process.env.CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION
    const priorForce = process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION
    process.env.CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION = '1'
    delete process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION
    try {
      const attachment = await generateFileAttachment(
        p,
        makeCtx({ maxSizeBytes: 1024 }),
        'at-mention',
      )
      if (attachment?.type !== 'file') throw new Error('expected a file attachment')

      expect(attachment.truncated).toBe(true)
      expect(attachment.rendered).toBeString()
      expect(sent(attachment)).toEqual(sent(withoutSnapshot(attachment)))
    } finally {
      if (priorDisable === undefined) delete process.env.CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION
      else process.env.CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION = priorDisable
      if (priorForce !== undefined) process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION = priorForce
    }
  })

  test('a non-text file carries none: its block renders from the payload alone', async () => {
    // The control arm. Keeping a text copy of any other arm would turn an
    // image block into a string, and only the text arm reads live state.
    const p = join(dir, 'mentioned.ipynb')
    writeFileSync(
      p,
      JSON.stringify({
        cells: [{ cell_type: 'code', source: 'print(1)', metadata: {}, outputs: [], execution_count: null }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    )
    const attachment = await generateFileAttachment(p, makeCtx(), 'at-mention')
    if (attachment?.type !== 'file') throw new Error('expected a file attachment')

    expect(attachment.content.type).toBe('notebook')
    expect(attachment.rendered).toBeUndefined()
  })
})
