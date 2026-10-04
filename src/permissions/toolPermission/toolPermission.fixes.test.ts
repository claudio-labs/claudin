/**
 * The findings of the toolPermission spec this rewrite fixes, flag-off.
 * Finding 8 (the classifier indicator) exists only with BASH_CLASSIFIER, so
 * it is pinned in toolPermission.classifiers.fixes.test.tsx.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { clearAllPendingCallbacks, processMailboxPermissionResponse } from 'src/agent/coordinator/hooks/useSwarmPermissionPoller.js'
import { standIn, useDecisionWorld } from 'src/permissions/__testutils__/decisionWorld.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { handleInteractivePermission } from 'src/permissions/toolPermission/handlers/interactiveHandler.js'
import { handleSwarmWorkerPermission } from 'src/permissions/toolPermission/handlers/swarmWorkerHandler.js'
import { createPermissionContext, createPermissionQueueOps } from 'src/permissions/toolPermission/PermissionContext.js'
import {
  contextSink,
  dialogQueue,
  joinCrew,
  mountRouter,
  openSession,
  TURN,
  until,
  type Crew,
  type MountedRouter,
} from 'src/permissions/toolPermission/__testutils__/routeWorld.js'
import type { BridgePermissionCallbacks, BridgePermissionResponse } from 'src/platform/bridge/bridgePermissionCallbacks.js'
import type { Tool } from 'src/tools/Tool.js'

const world = useDecisionWorld()
const ID = 'toolu_fixes'
const INPUT = { command: 'npm publish' }

let crew: Crew | undefined
const mounted: MountedRouter[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.close()
  crew?.leave()
  crew = undefined
  clearAllPendingCallbacks()
})

function forward(abort = new AbortController()) {
  const session = openSession({ abort })
  const ctx = createPermissionContext(standIn({ name: 'Bash' }), INPUT, session, TURN, ID, contextSink().set)
  const decision = handleSwarmWorkerPermission({ ctx, description: 'publish', updatedInput: undefined, suggestions: undefined })
  return { decision, session }
}

describe('finding 2: an undeliverable swarm request falls back to the worker’s own dialog', () => {
  const undeliverable: Array<[string, (configDir: string) => Crew]> = [
    ['no team file, so no leader', dir => joinCrew(dir, { teamFile: false })],
    [
      'an inbox directory that cannot be made',
      dir => {
        const joined = joinCrew(dir)
        writeFileSync(join(dir, 'teams', 'crew', 'inboxes'), 'not a directory')
        return joined
      },
    ],
  ]
  test.each(undeliverable)('%s: no decision, the turn goes on, and the worker is not shown as waiting', async (_name, setUp) => {
    crew = setUp(world().configDir)
    const run = forward()
    expect(await run.decision).toBeNull()
    expect([run.session.abortController.signal.aborted, run.session.state().pendingWorkerRequest]).toEqual([false, null])
  })

  test('through the gate, the worker’s own dialog opens', async () => {
    crew = joinCrew(world().configDir, { teamFile: false })
    const queue = dialogQueue()
    const router = await mountRouter(queue.set, contextSink().set)
    mounted.push(router)
    const tool = standIn({ name: 'Scribe', verdict: { behavior: 'ask', message: 'asks' } }) as unknown as Tool
    void router.canUseTool()(tool, INPUT, openSession({ tools: [tool] }), TURN, ID)
    await until(() => queue.items().length === 1)
    expect(queue.only().toolUseID).toBe(ID)
  })
})

describe('finding 9: an abort stops listening for the leader', () => {
  test('a leader answer after the abort finds nobody waiting', async () => {
    crew = joinCrew(world().configDir)
    const abort = new AbortController()
    const run = forward(abort)
    await until(() => (crew?.leaderInbox().length ?? 0) === 1)
    const requestId = String(crew.leaderInbox()[0]?.request_id)
    abort.abort()
    expect((await run.decision)?.behavior).toBe('ask')
    expect(processMailboxPermissionResponse({ requestId, decision: 'approved' })).toBe(false)
  })
})

describe('finding 5: a remote allow is labelled by what it really saved', () => {
  function remoteDialog() {
    let answer: (response: BridgePermissionResponse) => void = () => {}
    const callbacks: BridgePermissionCallbacks = {
      sendRequest() {},
      sendResponse() {},
      cancelRequest() {},
      onResponse(_id, next) {
        answer = next
        return () => {}
      },
    }
    const session = openSession()
    const ctx = createPermissionContext(standIn({ name: 'Scribe' }), INPUT, session, TURN, ID, contextSink().set, createPermissionQueueOps(dialogQueue().set))
    const decisions: PermissionDecision[] = []
    handleInteractivePermission(
      { ctx, description: 'd', result: { behavior: 'ask', message: 'm' }, awaitAutomatedChecksBeforeDialog: true, bridgeCallbacks: callbacks },
      d => decisions.push(d),
    )
    return { answer: (r: BridgePermissionResponse) => answer(r), decisions, record: () => session.toolDecisions?.get(ID)?.source }
  }

  const rule = (destination: PermissionUpdate['destination']): PermissionUpdate => ({
    type: 'addRules',
    rules: [{ toolName: 'Scribe' }],
    behavior: 'allow',
    destination,
  })
  const cases: Array<[string, PermissionUpdate[], string]> = [
    ['a session rule only', [rule('session')], 'user_temporary'],
    ['a rule written to a settings file', [rule('localSettings')], 'user_permanent'],
    ['both', [rule('session'), rule('localSettings')], 'user_permanent'],
    ['no rule', [], 'user_temporary'],
  ]
  test.each(cases)('%s', (_name, updatedPermissions, label) => {
    const run = remoteDialog()
    run.answer({ behavior: 'allow', updatedPermissions })
    // The decision is delivered without waiting for the save.
    expect([run.decisions.map(d => d.behavior), run.record()]).toEqual([['allow'], label])
  })
})
