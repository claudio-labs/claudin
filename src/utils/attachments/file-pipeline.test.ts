import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import { getFileModificationTimeAsync } from '../file.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../fileStateCache.js'
import { generateFileAttachment } from './file-pipeline.js'

// Skill discovery touches the real filesystem and is irrelevant here.
process.env.CLAUDE_CODE_SIMPLE = '1'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-pipeline-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeCtx(): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
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
      'ev_success',
      'ev_error',
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
      'ev_success',
      'ev_error',
      'at-mention',
    )
    expect(attachment?.type).toBe('already_read_file')
  })
})
