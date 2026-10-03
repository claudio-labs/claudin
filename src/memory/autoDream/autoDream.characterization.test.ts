/**
 * Characterization of the background consolidation ("auto-dream"),
 * through `initAutoDream`, `executeAutoDream` and `isAutoDreamEnabled`.
 *
 * One boundary is replaced: the forked agent. The double records what the
 * unit asks of it and answers from a script; a script that wants to look at
 * the run while it is in progress does so from inside. Everything else is
 * real: the settings file, the memory directory with its lock, the session
 * transcripts, the app state the task lives in.
 *
 * Under `bun test` every build flag reads false. The team-memory variant and
 * the never-initialized state are pinned in
 * autoDream.shipped.characterization.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ForkedAgentParams } from 'src/agent/coordinator/forkedAgent.js'
import { createAssistantMessage } from 'src/agent/messages/messages.js'
import { DreamTask, type DreamTaskState } from 'src/agent/tasks/DreamTask/DreamTask.js'
import { executeAutoDream, initAutoDream } from 'src/memory/autoDream/autoDream.js'
import { isAutoDreamEnabled } from 'src/memory/autoDream/config.js'
import { buildConsolidationPrompt } from 'src/memory/autoDream/consolidationPrompt.js'
import { collectDreamDigest } from 'src/memory/autoDream/dreamDigest.js'
import {
  announceSavedMemories,
  assistantCalls,
  assistantSays,
  forkReturns,
  humanSays,
  nextToolUseId,
  turnEnded,
  useForkDouble,
  useScene,
  type ToolUse,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import {
  getOriginalCwd,
  getSessionId,
  setKairosActive,
} from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import type { AssistantMessage, Message, UserMessage } from 'src/shared/types/message.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

const scene = useScene()
const fork = useForkDouble()

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// The digest runs `git log`; keep git away from the user's configuration.
const GIT_VARIABLES = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const gitBefore = new Map<string, string | undefined>()
beforeAll(() => {
  for (const [name, value] of Object.entries(GIT_VARIABLES)) {
    gitBefore.set(name, process.env[name])
    process.env[name] = value
  }
})
afterAll(() => {
  for (const [name, value] of gitBefore) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

beforeEach(() => {
  initAutoDream()
  setDreamSetting(true)
})

afterEach(() => {
  setSystemTime()
  setKairosActive(false)
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  getAutoMemPath.cache.clear?.()
})

// ---------------------------------------------------------------- the scene

function setDreamSetting(value: boolean | undefined, file = join(scene().configDir, 'settings.json')): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value === undefined ? {} : { autoDreamEnabled: value }))
  resetSettingsCache()
}

const wholeSecond = (ms: number) => Math.floor(ms / 1000) * 1000
const lockFile = () => join(scene().memoryDir, '.consolidate-lock')
const transcriptDir = () => getProjectDir(getOriginalCwd())
const inMemory = (name: string) => join(scene().memoryDir, name)

/** The last consolidation, as the lock records it; a whole second in the past. */
function lastConsolidatedHoursAgo(hours: number, body = ''): number {
  const at = wholeSecond(Date.now() - hours * HOUR)
  mkdirSync(scene().memoryDir, { recursive: true })
  writeFileSync(lockFile(), body)
  utimesSync(lockFile(), at / 1000, at / 1000)
  return at
}

const lockTime = () => statSync(lockFile()).mtimeMs
const lockBody = () => readFileSync(lockFile(), 'utf8')

/** `count` session transcripts of this project, the newest touched at `mtimeMs`, a second apart. */
function sessionsTouched(count: number, mtimeMs = Date.now() - MINUTE): string[] {
  mkdirSync(transcriptDir(), { recursive: true })
  return Array.from({ length: count }, (_, i) => {
    const id = randomUUID()
    const file = join(transcriptDir(), `${id}.jsonl`)
    const at = (mtimeMs - i * 1000) / 1000
    writeFileSync(file, `${JSON.stringify({ type: 'user', sessionId: id })}\n`)
    utimesSync(file, at, at)
    return id
  })
}

/** A consolidation that is due: a day and more since the last, five other sessions since. */
function dueForConsolidation(): { lastAt: number; sessions: string[] } {
  return { lastAt: lastConsolidatedHoursAgo(30), sessions: sessionsTouched(5) }
}

type Store = {
  state: () => AppState
  set: (update: (prev: AppState) => AppState) => void
}

function newStore(): Store {
  let state = { tasks: {} } as unknown as AppState
  return {
    state: () => state,
    set: update => {
      state = update(state)
    },
  }
}

const dreamTasks = (store: Store): DreamTaskState[] =>
  Object.values(store.state().tasks ?? {}).filter(
    (task): task is DreamTaskState => (task as { type?: string }).type === 'dream',
  )

function onlyDreamTask(store: Store): DreamTaskState {
  const tasks = dreamTasks(store)
  expect(tasks).toHaveLength(1)
  return tasks[0]!
}

/** The end of a main-thread turn, with an app state for the task. */
function turnEndedWith(store: Store, extra: Partial<ToolUseContext> = {}) {
  return turnEnded([humanSays('wrap up the release')], {
    getAppState: store.state,
    setAppState: store.set,
    ...extra,
  })
}

function promptOf(request: ForkedAgentParams | undefined): string {
  expect(request?.promptMessages).toHaveLength(1)
  const only = request!.promptMessages[0] as UserMessage
  expect(only.type).toBe('user')
  expect(typeof only.message.content).toBe('string')
  return only.message.content as string
}

/** A fork that streams `messages` through the unit's watcher, then returns them. */
function forkStreams(...messages: Message[]) {
  return async (request: ForkedAgentParams) => {
    for (const message of messages) request.onMessage?.(message)
    return forkReturns(messages)
  }
}

const writes = (path: string): ToolUse => ({ tool: FILE_WRITE_TOOL_NAME, input: { file_path: path, content: 'x' } })
const edits = (path: string): ToolUse => ({
  tool: FILE_EDIT_TOOL_NAME,
  input: { file_path: path, old_string: 'a', new_string: 'b' },
})
const reads = (path: string): ToolUse => ({ tool: FILE_READ_TOOL_NAME, input: { file_path: path } })

// ---------------------------------------------------------------- the setting

describe('isAutoDreamEnabled', () => {
  test('is on only when autoDreamEnabled is true in the settings', () => {
    const cases: Array<[string, boolean | undefined, boolean]> = [
      ['unset', undefined, false],
      ['false', false, false],
      ['true', true, true],
    ]
    for (const [name, value, expected] of cases) {
      setDreamSetting(value)
      expect({ name, on: isAutoDreamEnabled() }).toEqual({ name, on: expected })
    }
  })

  test('the project settings of the repository can turn it on', () => {
    setDreamSetting(undefined)
    setDreamSetting(true, join(scene().projectDir, '.claudin', 'settings.json'))
    expect(isAutoDreamEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------- the gates

describe('executeAutoDream, when an end of turn consolidates', () => {
  test('a due consolidation starts one fork, labelled auto_dream, with no transcript', async () => {
    dueForConsolidation()
    const store = newStore()
    const context = turnEndedWith(store)
    await expect(executeAutoDream(context)).resolves.toBeUndefined()

    expect(fork.requests).toHaveLength(1)
    const request = fork.requests[0]!
    expect(request.querySource).toBe('auto_dream')
    expect(request.forkLabel).toBe('auto_dream')
    expect(request.skipTranscript).toBe(true)
    expect(request.maxTurns).toBeUndefined()
    expect(request.maxOutputTokens).toBeUndefined()
    expect(request.skipCacheWrite).toBeFalsy()
    expect(request.overrides?.abortController).toBeInstanceOf(AbortController)
    expect(Object.keys(request.overrides ?? {})).toEqual(['abortController'])
    expect(typeof request.onMessage).toBe('function')
    promptOf(request)
  })

  test('the fork shares the parent conversation as it came', async () => {
    dueForConsolidation()
    const store = newStore()
    const context = turnEndedWith(store)
    await executeAutoDream(context)
    const params = fork.requests[0]!.cacheSafeParams
    expect(params.systemPrompt).toBe(context.systemPrompt)
    expect(params.userContext).toBe(context.userContext)
    expect(params.systemContext).toBe(context.systemContext)
    expect(params.toolUseContext).toBe(context.toolUseContext)
    expect(params.forkContextMessages).toEqual(context.messages)
  })

  test('nothing happens while a gate is closed', async () => {
    const cases: Array<{ name: string; arrange: () => void }> = [
      { name: 'the setting is unset', arrange: () => setDreamSetting(undefined) },
      { name: 'the setting is false', arrange: () => setDreamSetting(false) },
      {
        name: 'auto memory is off by variable',
        arrange: () => {
          process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
        },
      },
      {
        name: 'auto memory is off in the settings',
        arrange: () => {
          writeFileSync(
            join(scene().configDir, 'settings.json'),
            JSON.stringify({ autoDreamEnabled: true, autoMemoryEnabled: false }),
          )
          resetSettingsCache()
        },
      },
      {
        name: 'bare mode',
        arrange: () => {
          process.env.CLAUDIN_SIMPLE = '1'
        },
      },
      { name: 'assistant (KAIROS) mode is active', arrange: () => setKairosActive(true) },
    ]
    for (const { name, arrange } of cases) {
      initAutoDream()
      setDreamSetting(true)
      const lastAt = lastConsolidatedHoursAgo(30)
      sessionsTouched(5)
      arrange()
      const store = newStore()
      await executeAutoDream(turnEndedWith(store))
      expect({ name, forks: fork.requests.length, tasks: dreamTasks(store).length }).toEqual({
        name,
        forks: 0,
        tasks: 0,
      })
      expect({ name, lock: lockTime() }).toEqual({ name, lock: lastAt })
      delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY
      delete process.env.CLAUDIN_SIMPLE
      setKairosActive(false)
      rmSync(transcriptDir(), { recursive: true, force: true })
    }
  })

  test('the last consolidation must be at least 24 hours old', async () => {
    const lastAt = lastConsolidatedHoursAgo(48)
    sessionsTouched(5)

    setSystemTime(new Date(lastAt + 24 * HOUR - 1))
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(0)

    setSystemTime(new Date(lastAt + 24 * HOUR))
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(1)
  })

  test('a project never consolidated is due as soon as it has the sessions', async () => {
    rmSync(lockFile(), { force: true })
    sessionsTouched(5)
    const store = newStore()
    await executeAutoDream(turnEndedWith(store))
    expect(fork.requests).toHaveLength(1)
    expect(onlyDreamTask(store).priorMtime).toBe(0)
  })

  test('it needs five other sessions touched since the last consolidation', async () => {
    const cases: Array<{ name: string; arrange: (lastAt: number) => void; forks: number }> = [
      { name: 'four', arrange: () => sessionsTouched(4), forks: 0 },
      { name: 'five', arrange: () => sessionsTouched(5), forks: 1 },
      {
        name: 'five, one of them the current session',
        arrange: () => {
          sessionsTouched(4)
          const current = join(transcriptDir(), `${getSessionId()}.jsonl`)
          writeFileSync(current, '{}\n')
        },
        forks: 0,
      },
      {
        name: 'five, one last touched exactly at the last consolidation',
        arrange: lastAt => {
          sessionsTouched(4)
          sessionsTouched(1, lastAt)
        },
        forks: 0,
      },
      {
        name: 'four sessions and a sub-agent transcript',
        arrange: () => {
          sessionsTouched(4)
          writeFileSync(join(transcriptDir(), `agent-${randomUUID()}.jsonl`), '{}\n')
        },
        forks: 0,
      },
    ]
    for (const { name, arrange, forks } of cases) {
      initAutoDream()
      fork.requests.length = 0
      rmSync(transcriptDir(), { recursive: true, force: true })
      const lastAt = lastConsolidatedHoursAgo(30)
      arrange(lastAt)
      await executeAutoDream(turnEndedWith(newStore()))
      expect({ name, forks: fork.requests.length }).toEqual({ name, forks })
    }
  })

  test('after a scan that found too few sessions, the next scan waits ten minutes', async () => {
    const lastAt = lastConsolidatedHoursAgo(30)
    sessionsTouched(4)
    const scannedAt = Date.now()
    setSystemTime(new Date(scannedAt))
    await executeAutoDream(turnEndedWith(newStore()))
    sessionsTouched(1)

    setSystemTime(new Date(scannedAt + 10 * MINUTE - 1))
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(0)

    setSystemTime(new Date(scannedAt + 10 * MINUTE))
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(1)
    expect(lastAt).toBeLessThan(scannedAt)
  })

  test('initAutoDream forgets the last scan', async () => {
    lastConsolidatedHoursAgo(30)
    sessionsTouched(4)
    await executeAutoDream(turnEndedWith(newStore()))
    sessionsTouched(1)
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(0)

    initAutoDream()
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(1)
  })

  test('a turn stopped by the 24-hour gate does not count as a scan', async () => {
    lastConsolidatedHoursAgo(2)
    sessionsTouched(5)
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(0)

    lastConsolidatedHoursAgo(25)
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(1)
  })

  test('when the lock cannot be taken, nothing starts and nothing throws', async () => {
    sessionsTouched(5)
    const blocker = join(scene().root, 'a-file')
    writeFileSync(blocker, 'not a directory')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = join(blocker, 'memory')
    getAutoMemPath.cache.clear?.()
    const store = newStore()
    await expect(executeAutoDream(turnEndedWith(store))).resolves.toBeUndefined()
    expect(fork.requests).toHaveLength(0)
    expect(dreamTasks(store)).toHaveLength(0)
  })

  test('a turn that ends while a consolidation runs starts no second one', async () => {
    dueForConsolidation()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    fork.answer(async () => {
      await held
      return forkReturns([])
    })
    const first = executeAutoDream(turnEndedWith(newStore()))
    while (fork.requests.length === 0) await Bun.sleep(1)

    initAutoDream()
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(1)
    release()
    await first
  })
})

// ---------------------------------------------------------------- the run

describe('executeAutoDream, while the fork runs', () => {
  test('the lock holds this PID and the current time', async () => {
    const { lastAt } = dueForConsolidation()
    const before = Date.now()
    let seen: { body: string; mtime: number } | undefined
    fork.answer(async () => {
      seen = { body: lockBody(), mtime: lockTime() }
      return forkReturns([])
    })
    await executeAutoDream(turnEndedWith(newStore()))
    expect(seen?.body).toBe(String(process.pid))
    expect(seen!.mtime).toBeGreaterThanOrEqual(before - 1_000)
    expect(seen!.mtime).toBeGreaterThan(lastAt)
  })

  test('a running dream task is registered with the session count and the time to roll back to', async () => {
    const { lastAt } = dueForConsolidation()
    const store = newStore()
    let seen: DreamTaskState | undefined
    fork.answer(async () => {
      seen = { ...onlyDreamTask(store) }
      return forkReturns([])
    })
    await executeAutoDream(turnEndedWith(store))
    expect(seen).toMatchObject({
      type: 'dream',
      status: 'running',
      phase: 'starting',
      sessionsReviewing: 5,
      filesTouched: [],
      turns: [],
      priorMtime: lastAt,
    })
    expect(seen?.abortController).toBe(fork.requests[0]!.overrides!.abortController)
  })

  test('the task goes to the task-state setter when the context has one', async () => {
    dueForConsolidation()
    const main = newStore()
    const forTasks = newStore()
    await executeAutoDream(turnEndedWith(main, { setAppStateForTasks: forTasks.set }))
    expect(dreamTasks(main)).toHaveLength(0)
    expect(onlyDreamTask(forTasks).status).toBe('completed')
  })

  test("each assistant turn of the fork shows up on the task: its text, its tool count, the files it edits", async () => {
    dueForConsolidation()
    const store = newStore()
    const a = inMemory('topic-a.md')
    const b = inMemory('topic-b.md')
    const snapshots: Array<Pick<DreamTaskState, 'phase' | 'filesTouched' | 'turns'>> = []
    const snap = () => {
      const { phase, filesTouched, turns } = onlyDreamTask(store)
      snapshots.push({ phase, filesTouched: [...filesTouched], turns: [...turns] })
    }
    const nonStringPath: ToolUse = { tool: FILE_WRITE_TOOL_NAME, input: { file_path: 42, content: 'x' } }
    const turns: Message[] = [
      createAssistantMessage({ content: '  Looking around.  ' }),
      assistantCalls(reads(inMemory('MEMORY.md'))),
      humanSays('a tool result the watcher ignores'),
      assistantCalls(writes(a), edits(b), nonStringPath),
      assistantCalls(edits(a)),
    ]
    fork.answer(async request => {
      for (const message of turns) {
        request.onMessage?.(message)
        snap()
      }
      return forkReturns(turns)
    })
    await executeAutoDream(turnEndedWith(store))

    expect(snapshots.map(s => s.phase)).toEqual(['starting', 'starting', 'starting', 'updating', 'updating'])
    expect(snapshots.at(-1)?.filesTouched).toEqual([a, b])
    expect(snapshots.at(-1)?.turns).toEqual([
      { text: 'Looking around.', toolUseCount: 0 },
      { text: '', toolUseCount: 1 },
      { text: '', toolUseCount: 3 },
      { text: '', toolUseCount: 1 },
    ])
  })

  test('text and tool calls of one assistant message are reported together', async () => {
    dueForConsolidation()
    const store = newStore()
    const mixed = createAssistantMessage({
      content: [
        { type: 'text', text: 'Merging the two notes.' },
        { type: 'tool_use', id: nextToolUseId(), name: FILE_WRITE_TOOL_NAME, input: { file_path: inMemory('x.md') } },
      ] as unknown as Parameters<typeof createAssistantMessage>[0]['content'],
    })
    fork.answer(forkStreams(mixed))
    await executeAutoDream(turnEndedWith(store))
    const task = onlyDreamTask(store)
    expect(task.turns).toEqual([{ text: 'Merging the two notes.', toolUseCount: 1 }])
    expect(task.filesTouched).toEqual([inMemory('x.md')])
  })

  test('the fork may read anything, write only memory files, and run only read-only Bash', async () => {
    dueForConsolidation()
    await executeAutoDream(turnEndedWith(newStore()))
    const decide = fork.requests[0]!.canUseTool
    const ask = (tool: unknown, input: Record<string, unknown>) =>
      decide(tool as Tool, input, {} as ToolUseContext, assistantSays('asking') as AssistantMessage, nextToolUseId())

    const cases: Array<[string, unknown, Record<string, unknown>, 'allow' | 'deny']> = [
      ['read outside memory', FileReadTool, { file_path: '/etc/hosts' }, 'allow'],
      ['write in memory', FileWriteTool, { file_path: inMemory('a.md'), content: '' }, 'allow'],
      ['write outside memory', FileWriteTool, { file_path: join(scene().projectDir, 'a.md'), content: '' }, 'deny'],
      ['read-only bash', BashTool, { command: 'ls -la' }, 'allow'],
      ['bash that deletes', BashTool, { command: `rm -rf ${scene().memoryDir}` }, 'deny'],
    ]
    for (const [name, tool, input, behavior] of cases) {
      const decision = await ask(tool, input)
      expect({ name, behavior: decision.behavior }).toEqual({ name, behavior })
    }
  })
})

// ---------------------------------------------------------------- the prompt

describe('executeAutoDream, the prompt', () => {
  test('is the dream prompt for this memory directory and these transcripts, with the run in its additional context', async () => {
    const { sessions } = dueForConsolidation()
    await executeAutoDream(turnEndedWith(newStore()))
    const prompt = promptOf(fork.requests[0])
    const base = `${buildConsolidationPrompt(scene().memoryDir, transcriptDir(), '')}\n\n## Additional context\n\n`
    expect(prompt.startsWith(base)).toBe(true)
    expect(prompt).not.toContain('## Team categories')

    const extra = prompt.slice(base.length)
    expect(extra).toContain(`(${sessions.length})`)
    for (const id of sessions) expect(extra).toContain(`\n- ${id}`)
    expect(extra).not.toContain(getSessionId())
  })

  test('the session list comes before the decision digest of the period, which closes the prompt', async () => {
    const { lastAt } = dueForConsolidation()
    await executeAutoDream(turnEndedWith(newStore()))
    const prompt = promptOf(fork.requests[0])
    const listed = [...prompt.matchAll(/^- ([0-9a-f-]{36})$/gm)].map(match => match[1]!)
    expect(listed).toHaveLength(5)
    const digest = await collectDreamDigest(lastAt, listed)
    expect(prompt.endsWith(digest)).toBe(true)
    expect(prompt.lastIndexOf(`- ${listed.at(-1)}`)).toBeLessThan(prompt.length - digest.length)
    expect(digest).toContain(new Date(lastAt).toISOString())
  })

  test('tells the fork that Bash is read-only in this run, naming the commands it may use', async () => {
    dueForConsolidation()
    await executeAutoDream(turnEndedWith(newStore()))
    const prompt = promptOf(fork.requests[0])
    const extra = prompt.slice(prompt.indexOf('## Additional context'))
    expect(extra).toMatch(/Bash/)
    expect(extra).toMatch(/read-only/)
    for (const command of ['ls', 'find', 'grep', 'cat', 'stat', 'wc', 'head', 'tail']) {
      expect(extra).toContain(`\`${command}\``)
    }
    const firstSession = extra.search(/^- [0-9a-f-]{36}$/m)
    expect(firstSession).toBeGreaterThan(0)
    expect(extra.indexOf('read-only')).toBeLessThan(firstSession)
  })
})

// ---------------------------------------------------------------- the outcome

describe('executeAutoDream, when the fork ends', () => {
  test('success completes the task and keeps the lock at the run time', async () => {
    const { lastAt } = dueForConsolidation()
    const store = newStore()
    await executeAutoDream(turnEndedWith(store))
    const task = onlyDreamTask(store)
    expect(task.status).toBe('completed')
    expect(task.notified).toBe(true)
    expect(task.abortController).toBeUndefined()
    expect(typeof task.endTime).toBe('number')
    expect(lockBody()).toBe(String(process.pid))
    expect(lockTime()).toBeGreaterThan(lastAt)
  })

  test('the saved-memory notice lists the touched files, as "Improved", when the user asked for notices', async () => {
    dueForConsolidation()
    announceSavedMemories(true)
    const store = newStore()
    const notices: unknown[] = []
    const paths = [inMemory('topic.md'), inMemory('MEMORY.md')]
    fork.answer(forkStreams(assistantCalls(writes(paths[0]!)), assistantCalls(edits(paths[1]!))))
    await executeAutoDream(turnEndedWith(store), message => notices.push(message))

    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      type: 'system',
      subtype: 'memory_saved',
      writtenPaths: paths,
      isMeta: false,
      verb: 'Improved',
    })
    const notice = notices[0] as { timestamp: string; uuid: string }
    expect(new Date(notice.timestamp).toISOString()).toBe(notice.timestamp)
    expect(notice.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('no notice in the other cases', async () => {
    const cases: Array<{ name: string; announce: boolean | undefined; touches: boolean; listener: boolean }> = [
      { name: 'notices are off', announce: false, touches: true, listener: true },
      { name: 'notices are unset', announce: undefined, touches: true, listener: true },
      { name: 'nothing was edited', announce: true, touches: false, listener: true },
      { name: 'no one listens', announce: true, touches: true, listener: false },
    ]
    for (const { name, announce, touches, listener } of cases) {
      initAutoDream()
      rmSync(transcriptDir(), { recursive: true, force: true })
      dueForConsolidation()
      announceSavedMemories(announce as boolean)
      const notices: unknown[] = []
      fork.answer(
        forkStreams(touches ? assistantCalls(writes(inMemory('t.md'))) : assistantSays('all tidy already')),
      )
      const call = executeAutoDream(turnEndedWith(newStore()), listener ? m => notices.push(m) : undefined)
      await expect(call).resolves.toBeUndefined()
      expect({ name, notices: notices.length }).toEqual({ name, notices: 0 })
    }
  })

  test('no notice when the task cannot be found in the app state the context reads', async () => {
    dueForConsolidation()
    announceSavedMemories(true)
    const notices: unknown[] = []
    fork.answer(forkStreams(assistantCalls(writes(inMemory('t.md')))))
    const elsewhere = newStore()
    await executeAutoDream(turnEndedWith(newStore(), { setAppStateForTasks: elsewhere.set }), m =>
      notices.push(m),
    )
    expect(notices).toHaveLength(0)
    expect(onlyDreamTask(elsewhere).filesTouched).toEqual([inMemory('t.md')])
  })

  test('a failed fork fails the task and puts the lock back as it was', async () => {
    const cases: Array<{ name: string; before: () => number }> = [
      { name: 'consolidated before', before: () => lastConsolidatedHoursAgo(30) },
      {
        name: 'never consolidated',
        before: () => {
          rmSync(lockFile(), { force: true })
          return 0
        },
      },
    ]
    for (const { name, before } of cases) {
      initAutoDream()
      rmSync(transcriptDir(), { recursive: true, force: true })
      const lastAt = before()
      sessionsTouched(5)
      fork.answer(async () => {
        throw new Error('the model went away')
      })
      const store = newStore()
      await expect(executeAutoDream(turnEndedWith(store))).resolves.toBeUndefined()
      const task = onlyDreamTask(store)
      expect({ name, status: task.status, notified: task.notified }).toEqual({
        name,
        status: 'failed',
        notified: true,
      })
      expect(task.abortController).toBeUndefined()
      if (lastAt === 0) {
        expect({ name, lockLeft: existsSync(lockFile()) }).toEqual({ name, lockLeft: false })
      } else {
        expect({ name, lock: lockTime(), body: lockBody() }).toEqual({ name, lock: lastAt, body: '' })
      }
    }
  })

  test('after a failure the next turn, within ten minutes, does not retry', async () => {
    dueForConsolidation()
    fork.answer(async () => {
      throw new Error('the model went away')
    })
    await executeAutoDream(turnEndedWith(newStore()))
    fork.answer(async () => forkReturns([]))
    await executeAutoDream(turnEndedWith(newStore()))
    expect(fork.requests).toHaveLength(1)
  })

  test('a dream killed from the task list ends killed, with the lock put back once', async () => {
    const { lastAt } = dueForConsolidation()
    const store = newStore()
    fork.answer(async request => {
      const task = onlyDreamTask(store)
      await DreamTask.kill(task.id, store.set)
      expect(request.overrides?.abortController?.signal.aborted).toBe(true)
      throw new Error('aborted')
    })
    await expect(executeAutoDream(turnEndedWith(store))).resolves.toBeUndefined()
    expect(onlyDreamTask(store).status).toBe('killed')
    expect(lockTime()).toBe(lastAt)
    expect(lockBody()).toBe('')
  })

  test('a fork that fails after its run was aborted leaves the task and the lock to whoever aborted it', async () => {
    const { lastAt } = dueForConsolidation()
    const store = newStore()
    fork.answer(async request => {
      request.overrides?.abortController?.abort()
      throw new Error('aborted')
    })
    await expect(executeAutoDream(turnEndedWith(store))).resolves.toBeUndefined()
    expect(onlyDreamTask(store).status).toBe('running')
    expect(lockBody()).toBe(String(process.pid))
    expect(lockTime()).toBeGreaterThan(lastAt)
  })
})
