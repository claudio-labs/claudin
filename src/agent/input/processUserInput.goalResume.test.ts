// A PauseGoal pause lasts until the user's next message: processUserInput is
// where that message arrives, so it is where the judge comes back.
import { expect, test } from 'bun:test'

import { pauseActiveGoal, setActiveGoal } from 'src/agent/goal/goal.js'
import { processUserInput, type ProcessUserInputContext } from 'src/agent/input/processUserInput.js'
import { clearRegisteredHooks, getSessionId, registerHookCallbacks } from 'src/platform/bootstrap/state.js'
import { useIsolatedHooksConfig } from 'src/platform/lifecycleHooks/__testutils__/isolatedHooksConfig.js'
import type { SessionStore } from 'src/platform/lifecycleHooks/sessionHooks.js'
import { isStopConditionJudge } from 'src/platform/lifecycleHooks/stopConditionJudge.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'

// processUserInput runs the UserPromptSubmit hooks: only ones a test registers.
useIsolatedHooksConfig()

function pausedSession() {
  let state = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: { commands: [] },
    sessionHooks: new Map<string, SessionStore>(),
    activeGoal: undefined,
  } as unknown as AppState
  const setAppState = (updater: (prev: AppState) => AppState) => {
    state = updater(state)
  }
  setActiveGoal(setAppState, getSessionId(), 'tests pass')
  pauseActiveGoal(setAppState, getSessionId(), 'which suite?')
  const context = {
    agentId: undefined,
    options: {
      tools: [],
      commands: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => state,
    setAppState,
    readFileState: new Map(),
    abortController: new AbortController(),
  } as unknown as ProcessUserInputContext
  const judges = () =>
    ((state.sessionHooks.get(getSessionId()) as SessionStore | undefined)?.hooks.Stop ?? [])
      .flatMap(m => m.hooks)
      .filter(h => isStopConditionJudge(h.hook))
  return { context, judges, paused: () => state.activeGoal?.paused }
}

test("the user's next prompt resumes a paused goal", async () => {
  const s = pausedSession()
  expect(s.judges()).toHaveLength(0)
  await processUserInput({ input: 'the unit suite', mode: 'prompt', setToolJSX: () => {}, context: s.context })
  expect(s.paused()).toBeUndefined()
  expect(s.judges()).toHaveLength(1)
})

test('a scheduled prompt or another agent writing does not resume it', async () => {
  const s = pausedSession()
  await processUserInput({ input: 'cron fire', mode: 'prompt', isMeta: true, setToolJSX: () => {}, context: s.context })
  await processUserInput({
    input: 'from a background agent',
    mode: 'prompt',
    skipInputDirectives: true,
    setToolJSX: () => {},
    context: s.context,
  })
  expect(s.paused()?.reason).toBe('which suite?')
  expect(s.judges()).toHaveLength(0)
})

test('a task notification is not the user answering', async () => {
  const s = pausedSession()
  await processUserInput({ input: '<task-notification>done</task-notification>', mode: 'task-notification', setToolJSX: () => {}, context: s.context })
  expect(s.paused()?.reason).toBe('which suite?')
  expect(s.judges()).toHaveLength(0)
})

// query.ts drains the replies typed while a turn runs; the call there is the
// only wiring, so it is pinned on the source.
test('the main thread resumes a paused goal on a reply drained mid-turn', async () => {
  const source = await Bun.file(new URL('../query.ts', import.meta.url)).text()
  expect(source).toContain(
    '      removeFromQueue(consumedCommands)\n      if (isMainThread) {\n        resumePausedGoalOnQueuedReply(consumedCommands, toolUseContext.setAppState, getSessionId())\n      }\n',
  )
})

// A UserPromptSubmit hook that blocks the prompt means the model never got
// the message, so the user has not answered yet.
test('a prompt a UserPromptSubmit hook blocks does not resume it', async () => {
  const s = pausedSession()
  registerHookCallbacks({
    UserPromptSubmit: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'echo "not now" >&2; exit 2' }],
        pluginRoot: '/tmp',
        pluginName: 'block-probe',
      },
    ] as never,
  })
  try {
    const result = await processUserInput({ input: 'the unit suite', mode: 'prompt', setToolJSX: () => {}, context: s.context })
    expect(result.shouldQuery).toBe(false)
    expect(s.paused()?.reason).toBe('which suite?')
    expect(s.judges()).toHaveLength(0)
  } finally {
    clearRegisteredHooks()
  }
})
