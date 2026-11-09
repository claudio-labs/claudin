// a sub-agent's write through Claudin's own edit tools is shown
// as a rewind conflict ("changed outside Claudin"), and the step's default,
// "Keep my changes", then skips the file — the rewind no longer undoes it.
// Sub-agent contexts get a no-op updateFileHistoryState (forkedAgent.ts:413),
// so the tool's fileHistoryTrackEdit / fileHistoryRecordWrite never reach
// AppState.fileHistory, while the main loop's fingerprint of the file stays.
// Same setup as fileHistory.conflicts.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getIsInteractive, getOriginalCwd, setIsInteractive, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import { createSubagentContext } from 'src/agent/coordinator/forkedAgent.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import {
  fileHistoryFindConflicts,
  fileHistoryMakeSnapshot,
  fileHistoryRecordWrite,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from 'src/shared/fs/fileHistory.js'

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDIN_DISABLE_FILE_CHECKPOINTING'] as const
const savedEnv: Record<string, string | undefined> = {}
let savedCwd = ''
let savedInteractive = false
let root = ''
let project = ''

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  savedCwd = getOriginalCwd()
  savedInteractive = getIsInteractive()
  root = mkdtempSync(join(tmpdir(), 'subagentConflict-'))
  setOriginalFsImplementation()
})
beforeEach(() => {
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING = '1'
  delete process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING
  setIsInteractive(false)
  project = mkdtempSync(join(root, 'project-'))
  setOriginalCwd(project)
})
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setOriginalCwd(savedCwd)
  setIsInteractive(savedInteractive)
  rmSync(root, { recursive: true, force: true })
})

type Updater = (prev: FileHistoryState) => FileHistoryState

describe('rewind conflicts and sub-agent writes', () => {
  test("a sub-agent's Edit is not a change made outside Claudin", async () => {
    let state: FileHistoryState = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
    const update = (u: Updater) => {
      state = u(state)
    }
    const parent = {
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext: { shouldAvoidPermissionPrompts: true } }),
      setAppState: () => {},
      readFileState: createFileStateCacheWithSizeLimit(10),
      updateFileHistoryState: update,
      updateAttributionState: () => {},
      options: {},
      messages: [],
    } as unknown as ToolUseContext
    const sub = createSubagentContext(parent)

    const abs = join(project, 'a.ts')
    writeFileSync(abs, 'v0\n')
    const m1 = randomUUID()
    await fileHistoryMakeSnapshot(update, m1)
    // Main loop edits a.ts (FileEditTool order: trackEdit, write, recordWrite).
    await fileHistoryTrackEdit(update, abs, m1)
    writeFileSync(abs, 'v1 main\n')
    await fileHistoryRecordWrite(update, abs)
    const m2 = randomUUID()
    await fileHistoryMakeSnapshot(update, m2)
    // A delegated Agent edits the same file through the same tool path.
    await fileHistoryTrackEdit(sub.updateFileHistoryState, abs, m2)
    writeFileSync(abs, 'v2 subagent\n')
    await fileHistoryRecordWrite(sub.updateFileHistoryState, abs)

    const conflicts = await fileHistoryFindConflicts(state, m1)
    // Default choice of the conflict step: keep the "conflicts".
    await fileHistoryRewind(update, m1, { keep: new Set(conflicts) })
    expect(conflicts).toEqual([])
    expect(readFileSync(abs, 'utf8')).toBe('v0\n')
  })
})
