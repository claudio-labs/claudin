/**
 * The fixes of the rewrite that show through `executeAutoDream`, driven like
 * the characterization suite: the forked agent is the harness's double, the
 * rest is real.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAssistantMessage } from 'src/agent/messages/messages.js'
import type { DreamTaskState } from 'src/agent/tasks/DreamTask/DreamTask.js'
import { executeAutoDream, initAutoDream } from 'src/memory/autoDream/autoDream.js'
import {
  announceSavedMemories,
  assistantCalls,
  forkReturns,
  humanSays,
  toolAnswers,
  turnEnded,
  useForkDouble,
  useScene,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { STATE } from 'src/platform/bootstrap/state/store.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import type { Message } from 'src/shared/types/message.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

const scene = useScene()
const fork = useForkDouble()

const remoteBefore = STATE.isRemoteMode
beforeEach(() => {
  initAutoDream()
  writeFileSync(join(scene().configDir, 'settings.json'), JSON.stringify({ autoDreamEnabled: true }))
  resetSettingsCache()
  const transcripts = getProjectDir(getOriginalCwd())
  mkdirSync(transcripts, { recursive: true })
  const recent = (Date.now() - 60_000) / 1000
  for (let i = 0; i < 5; i++) {
    const file = join(transcripts, `${randomUUID()}.jsonl`)
    writeFileSync(file, '{}\n')
    utimesSync(file, recent - i, recent - i)
  }
})
afterEach(() => {
  STATE.isRemoteMode = remoteBefore
})

function endOfTurn() {
  let state = { tasks: {} } as unknown as AppState
  const context = turnEnded([humanSays('ship it')], {
    getAppState: () => state,
    setAppState: update => {
      state = update(state)
    },
  })
  const task = () => Object.values(state.tasks ?? {})[0] as DreamTaskState
  return { context, task }
}

const streams = (...messages: Message[]) => async (request: Parameters<Parameters<typeof fork.answer>[0]>[0]) => {
  for (const message of messages) request.onMessage?.(message)
  return forkReturns(messages)
}

describe('executeAutoDream, the fixes', () => {
  test('remote mode no longer closes the gate (finding 1)', async () => {
    STATE.isRemoteMode = true
    await executeAutoDream(endOfTurn().context)
    expect(fork.requests).toHaveLength(1)
  })

  test('the notice leaves out a write outside memory and a write that failed (finding 2)', async () => {
    announceSavedMemories(true)
    const saved = join(scene().memoryDir, 'saved.md')
    const failed = join(scene().memoryDir, 'failed.md')
    fork.answer(
      streams(
        assistantCalls(
          { tool: FILE_WRITE_TOOL_NAME, input: { file_path: saved }, id: 'f1' },
          { tool: FILE_WRITE_TOOL_NAME, input: { file_path: join(scene().projectDir, 'x.md') }, id: 'f2' },
          { tool: FILE_WRITE_TOOL_NAME, input: { file_path: failed }, id: 'f3' },
        ),
        toolAnswers('f2', 'denied', true),
        toolAnswers('f3', 'disk full', true),
      ),
    )
    const notices: unknown[] = []
    const { context, task } = endOfTurn()
    await executeAutoDream(context, m => notices.push(m))
    expect(task().filesTouched).toEqual([saved, failed])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ writtenPaths: [saved] })
  })

  test('two text blocks of one message reach the task on two lines (finding 4)', async () => {
    const twoBlocks = createAssistantMessage({
      content: [
        { type: 'text', text: 'Done.' },
        { type: 'text', text: 'Next' },
      ] as unknown as Parameters<typeof createAssistantMessage>[0]['content'],
    })
    fork.answer(streams(twoBlocks))
    const { context, task } = endOfTurn()
    await executeAutoDream(context)
    expect(task().turns).toEqual([{ text: 'Done.\nNext', toolUseCount: 0 }])
  })
})
