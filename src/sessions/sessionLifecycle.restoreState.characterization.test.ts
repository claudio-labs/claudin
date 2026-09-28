/**
 * Characterization of the pieces of session restore that callers also use on
 * their own (sessionRestore.ts), pinned before the clean-base rewrite of
 * `sessions/lifecycle`:
 *
 * - `restoreAgentFromSession`, `computeStandaloneAgentContext`: the agent a
 *   resumed session runs as, and how its name and color are shown;
 * - `restoreSessionStateFromLog`: the todo list and file history rebuilt from
 *   a real transcript, loaded as `--continue` loads it;
 * - `restoreWorktreeForResume`, `exitRestoredWorktree`: moving the session
 *   into and out of a real git worktree, and dropping every cache that was
 *   filled for the directory it left.
 *
 * `processResumedConversation` is in sessionLifecycle.characterization.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import {
  getCwdState,
  getMainLoopModelOverride,
  getMainThreadAgentType,
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  setIsInteractive,
  setMainLoopModelOverride,
  setMainThreadAgentType,
} from 'src/platform/bootstrap/state.js'
import { parseUserSpecifiedModel } from 'src/providers/model/model.js'
import {
  agent,
  definitions,
  directoryCaches,
  enterProject,
  loadLatest,
  primeDirectoryCaches,
  repositoryWithWorktree,
  useRestoreSandbox,
  writeSession,
} from 'src/sessions/__testutils__/restoreHarness.js'
import {
  computeStandaloneAgentContext,
  exitRestoredWorktree,
  restoreAgentFromSession,
  restoreSessionStateFromLog,
  restoreWorktreeForResume,
} from 'src/sessions/sessionRestore.js'
import { getProject } from 'src/sessions/sessionStorage.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type { TodoList } from 'src/tools/TodoWriteTool/types.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
} from 'src/vcs/git/worktree.js'

const sandbox = useRestoreSandbox()

const NO_AGENT = { agentDefinition: undefined, agentType: undefined }

// --- restoreAgentFromSession ----------------------------------------------

describe('restoreAgentFromSession', () => {
  test('an agent chosen on the command line wins, and nothing global changes', () => {
    const fromCli = agent('from-cli')
    const available = definitions([agent('reviewer', { model: 'codexplan' })])
    setMainThreadAgentType('set-at-startup')

    const restored = restoreAgentFromSession('reviewer', fromCli, available)

    expect(restored).toEqual({ agentDefinition: fromCli, agentType: undefined })
    expect(getMainThreadAgentType()).toBe('set-at-startup')
    expect(getMainLoopModelOverride()).toBeUndefined()
  })

  test('a session without an agent clears a stale agent type', () => {
    setMainThreadAgentType('stale')

    const restored = restoreAgentFromSession(undefined, undefined, definitions([agent('stale')]))

    expect(restored).toEqual(NO_AGENT)
    expect(getMainThreadAgentType()).toBeUndefined()
  })

  test('an agent that is no longer active is dropped, even if it is still defined', () => {
    setMainThreadAgentType('stale')

    const restored = restoreAgentFromSession(
      'reviewer',
      undefined,
      definitions([], [agent('reviewer')]),
    )

    expect(restored).toEqual(NO_AGENT)
    expect(getMainThreadAgentType()).toBeUndefined()
  })

  test('an active agent is restored, with its model when the user chose none', () => {
    const reviewer = agent('reviewer', { model: 'codexplan' })

    const restored = restoreAgentFromSession(
      'reviewer',
      undefined,
      definitions([agent('other'), reviewer]),
    )

    expect(restored).toEqual({ agentDefinition: reviewer, agentType: 'reviewer' })
    expect(getMainThreadAgentType()).toBe('reviewer')
    expect(getMainLoopModelOverride()).toBe(parseUserSpecifiedModel('codexplan'))
  })

  test("a model the user already chose is kept over the agent's", () => {
    setMainLoopModelOverride('user-picked-model')

    restoreAgentFromSession(
      'reviewer',
      undefined,
      definitions([agent('reviewer', { model: 'codexplan' })]),
    )

    expect(getMainLoopModelOverride()).toBe('user-picked-model')
  })

  test.each([
    ['inherits the model', { model: 'inherit' }],
    ['names no model', {}],
  ])('an agent that %s sets no model override', (_case, extra) => {
    restoreAgentFromSession('reviewer', undefined, definitions([agent('reviewer', extra)]))

    expect(getMainThreadAgentType()).toBe('reviewer')
    expect(getMainLoopModelOverride()).toBeUndefined()
  })
})

// --- computeStandaloneAgentContext ----------------------------------------

describe('computeStandaloneAgentContext', () => {
  test.each([
    [undefined, undefined, undefined],
    ['', undefined, undefined],
    ['Scout', undefined, { name: 'Scout', color: undefined }],
    [undefined, 'green', { name: '', color: 'green' }],
    ['Scout', 'green', { name: 'Scout', color: 'green' }],
    ['Scout', 'default', { name: 'Scout', color: undefined }],
    ['', 'default', { name: '', color: undefined }],
  ])('name %p and color %p give %p', (name, color, expected) => {
    const context: { name: string; color?: string } | undefined =
      computeStandaloneAgentContext(name, color)
    expect(context).toEqual(expected)
  })
})

// --- restoreSessionStateFromLog -------------------------------------------

type TodoItem = TodoList[number]

const todo = (content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({
  content,
  status,
  activeForm: `Working on ${content}`,
})

/** A stand-in for the UI store: applies each update and counts them. */
function appStateRecorder(initial: AppState = getDefaultAppState()) {
  const recorder = {
    state: initial,
    updates: 0,
    setAppState(update: (prev: AppState) => AppState) {
      recorder.updates++
      recorder.state = update(recorder.state)
    },
  }
  return recorder
}

describe('restoreSessionStateFromLog', () => {
  test("rebuilds the todo list from the transcript's last TodoWrite, for this session", async () => {
    await writeSession({
      todoWrites: [
        [todo('read the parser')],
        [todo('read the parser', 'completed'), todo('fix the bug')],
      ],
    })
    const loaded = await loadLatest()
    const theirs = { 'teammate-1': [todo('theirs')] }
    const recorder = appStateRecorder({ ...getDefaultAppState(), todos: theirs as never })

    restoreSessionStateFromLog(loaded, recorder.setAppState)

    expect(recorder.state.todos).toEqual({
      ...theirs,
      [getSessionId()]: [todo('read the parser', 'completed'), todo('fix the bug')],
    })
  })

  test('a malformed last TodoWrite restores nothing, even after a valid one', async () => {
    const malformed = { content: '', status: 'pending', activeForm: 'x' }
    await writeSession({ todoWrites: [[todo('valid')], [malformed]] })
    const loaded = await loadLatest()
    const recorder = appStateRecorder()

    restoreSessionStateFromLog(loaded, recorder.setAppState)

    expect(recorder.updates).toBe(0)
  })

  test('an empty todo list restores nothing', async () => {
    await writeSession({ todoWrites: [[]] })
    const loaded = await loadLatest()
    const recorder = appStateRecorder()

    restoreSessionStateFromLog(loaded, recorder.setAppState)

    expect(recorder.updates).toBe(0)
  })

  test('a TodoWrite whose input is not an object restores nothing', () => {
    const call = { type: 'tool_use', id: 't', name: 'TodoWrite', input: 'oops' }
    const recorder = appStateRecorder()

    restoreSessionStateFromLog(
      { messages: [createAssistantMessage({ content: [call] as never })] },
      recorder.setAppState,
    )

    expect(recorder.updates).toBe(0)
  })

  test('assistant messages without a TodoWrite are skipped over', () => {
    const write = { type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [todo('kept')] } }
    const read = { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.ts' } }
    const messages = [
      createAssistantMessage({ content: [write] as never }),
      createAssistantMessage({ content: [read] as never }),
      createUserMessage({ content: 'and then?' }),
    ]
    const recorder = appStateRecorder()

    restoreSessionStateFromLog({ messages }, recorder.setAppState)

    expect(recorder.state.todos[getSessionId()]).toEqual([todo('kept')])
  })

  test.each([
    ['in an interactive session', () => setIsInteractive(true)],
    ['when tasks are enabled', () => (process.env.CLAUDIN_ENABLE_TASKS = '1')],
  ])('todos are not restored %s', async (_case, arrange) => {
    await writeSession({ todoWrites: [[todo('read the parser')]] })
    const loaded = await loadLatest()
    arrange()
    const recorder = appStateRecorder()

    restoreSessionStateFromLog(loaded, recorder.setAppState)

    expect(recorder.updates).toBe(0)
  })

  test('rebuilds file history from the snapshots, with paths relative to the project', async () => {
    process.env.CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING = '1'
    const inside = join(sandbox.projectDir, 'src', 'a.ts')
    await writeSession({ trackedFiles: [inside, '/outside/b.ts'] })
    const loaded = await loadLatest()
    const recorder = appStateRecorder()

    restoreSessionStateFromLog(loaded, recorder.setAppState)

    const history = recorder.state.fileHistory
    const expectedPaths = ['/outside/b.ts', join('src', 'a.ts')]
    expect(history.snapshotSequence).toBe(1)
    expect([...history.trackedFiles].sort()).toEqual(expectedPaths)
    expect(Object.keys(history.snapshots[0]!.trackedFileBackups).sort()).toEqual(expectedPaths)
  })

  test('file history is not restored when checkpointing is off', async () => {
    await writeSession({ trackedFiles: [join(sandbox.projectDir, 'a.ts')] })
    const loaded = await loadLatest()
    const recorder = appStateRecorder()

    restoreSessionStateFromLog(
      { fileHistorySnapshots: loaded.fileHistorySnapshots },
      recorder.setAppState,
    )

    expect(recorder.updates).toBe(0)
  })

  test('with nothing to restore the state is never touched', () => {
    const recorder = appStateRecorder()

    restoreSessionStateFromLog({}, recorder.setAppState)
    restoreSessionStateFromLog({ messages: [], fileHistorySnapshots: [] }, recorder.setAppState)

    expect(recorder.updates).toBe(0)
  })
})

// --- worktrees ------------------------------------------------------------

describe('restoreWorktreeForResume', () => {
  test('enters the worktree and re-roots the session there, without moving the project root', () => {
    const { repo, worktree, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)

    restoreWorktreeForResume(session)

    expect([process.cwd(), getCwdState(), getOriginalCwd()]).toEqual([
      worktree,
      worktree,
      worktree,
    ])
    expect(getProjectRoot()).toBe(repo)
    expect(getCurrentWorktreeSession()).toBe(session)
  })

  test('drops what was cached for the old directory', async () => {
    const { repo, worktree, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)
    await primeDirectoryCaches()

    restoreWorktreeForResume(session)

    const caches = await directoryCaches()
    expect(caches.toolResultCached).toBe(false)
    expect(caches.promptSection).toBe('computed after')
    expect(caches.plansDirectory).toBe(join(worktree, '.claudin', 'plans'))
    expect(caches.instructionFiles).toContain(join(worktree, 'AGENTS.md'))
    expect(caches.instructionFiles).not.toContain(join(repo, 'AGENTS.md'))
  })

  test('a worktree that no longer exists is recorded as exited, and nothing moves', async () => {
    const { repo, worktree, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)
    rmSync(worktree, { recursive: true, force: true })
    await primeDirectoryCaches()

    restoreWorktreeForResume(session)

    expect([process.cwd(), getOriginalCwd()]).toEqual([repo, repo])
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(getProject().currentSessionWorktree).toBeNull()
    expect((await directoryCaches()).toolResultCached).toBe(true)
  })

  test.each([null, undefined])('%p changes nothing', async worktreeSession => {
    await primeDirectoryCaches()

    restoreWorktreeForResume(worktreeSession)

    expect(process.cwd()).toBe(sandbox.projectDir)
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(getProject().currentSessionWorktree).toBeUndefined()
    expect((await directoryCaches()).toolResultCached).toBe(true)
  })

  test('a worktree this run already created takes precedence and is recorded for the session', () => {
    const { repo, worktree, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)
    const created = { ...session, worktreeName: 'fresh', sessionId: getSessionId() }
    restoreWorktreeSession(created)

    restoreWorktreeForResume({ ...session, worktreeName: 'from-transcript' })

    expect(process.cwd()).toBe(repo)
    expect(getCurrentWorktreeSession()).toBe(created)
    expect(getProject().currentSessionWorktree).toEqual(created)
    expect(existsSync(worktree)).toBe(true)
  })
})

describe('exitRestoredWorktree', () => {
  test("goes back to the session's original directory and drops the worktree", async () => {
    const { repo, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)
    restoreWorktreeForResume(session)
    await primeDirectoryCaches()

    exitRestoredWorktree()

    expect([process.cwd(), getCwdState(), getOriginalCwd()]).toEqual([repo, repo, repo])
    expect(getCurrentWorktreeSession()).toBeNull()
    const caches = await directoryCaches()
    expect(caches.toolResultCached).toBe(false)
    expect(caches.promptSection).toBe('computed after')
    expect(caches.plansDirectory).toBe(join(repo, '.claudin', 'plans'))
    expect(caches.instructionFiles).toContain(join(repo, 'AGENTS.md'))
  })

  test('when the original directory is gone it stays put, but still drops the worktree and the caches', async () => {
    const { worktree, session } = repositoryWithWorktree(sandbox.root)
    restoreWorktreeForResume({ ...session, originalCwd: join(sandbox.root, 'vanished') })
    await primeDirectoryCaches()

    exitRestoredWorktree()

    expect([process.cwd(), getOriginalCwd()]).toEqual([worktree, worktree])
    expect(getCurrentWorktreeSession()).toBeNull()
    expect((await directoryCaches()).toolResultCached).toBe(false)
  })

  test('outside a worktree it does nothing', async () => {
    await primeDirectoryCaches()

    exitRestoredWorktree()

    expect(process.cwd()).toBe(sandbox.projectDir)
    expect((await directoryCaches()).toolResultCached).toBe(true)
  })
})
