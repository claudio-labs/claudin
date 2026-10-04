/**
 * Route guards the characterization suites do not reach: the leader's answer
 * is final even against an abort that lands while it is being applied, and
 * the gate checks for an abort between the coordinator and the later routes.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { clearAllPendingCallbacks, processMailboxPermissionResponse } from 'src/agent/coordinator/hooks/useSwarmPermissionPoller.js'
import { REJECT_MESSAGE } from 'src/agent/messages/constants.js'
import { standIn, useDecisionWorld } from 'src/permissions/__testutils__/decisionWorld.js'
import { handleSwarmWorkerPermission } from 'src/permissions/toolPermission/handlers/swarmWorkerHandler.js'
import { createPermissionContext } from 'src/permissions/toolPermission/PermissionContext.js'
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
import type { Tool } from 'src/tools/Tool.js'

const world = useDecisionWorld()
const ID = 'toolu_routes'
const INPUT = { command: 'make ship' }

let crew: Crew | undefined
const mounted: MountedRouter[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.close()
  crew?.leave()
  crew = undefined
  clearAllPendingCallbacks()
})

describe('the swarm leader', () => {
  test('an approval being applied is not overturned by an abort that lands meanwhile', async () => {
    crew = joinCrew(world().configDir)
    const abort = new AbortController()
    const session = openSession({ abort })
    const ctx = createPermissionContext(standIn({ name: 'Bash' }), INPUT, session, TURN, ID, contextSink().set)
    const decision = handleSwarmWorkerPermission({ ctx, description: 'ship', updatedInput: undefined, suggestions: undefined })
    await until(() => (crew?.leaderInbox().length ?? 0) === 1)
    processMailboxPermissionResponse({ requestId: String(crew.leaderInbox()[0]?.request_id), decision: 'approved' })
    abort.abort()
    expect((await decision)?.behavior).toBe('allow')
  })
})

describe('the gate', () => {
  test('a turn aborted while a denied call is described is cancelled, not denied', async () => {
    const router = await mountRouter(dialogQueue().set, contextSink().set)
    mounted.push(router)
    const abort = new AbortController()
    const tool = {
      ...standIn({ name: 'Scribe' }),
      async description() {
        abort.abort()
        return 'late'
      },
    } as unknown as Tool
    const decision = router.canUseTool()(tool, INPUT, openSession({ tools: [tool], abort }), TURN, ID, {
      behavior: 'deny',
      message: 'no',
      decisionReason: { type: 'other', reason: 'x' },
    })
    expect(await decision).toEqual({ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined })
  })

  test('the returned function changes when only the permission-context setter does', async () => {
    const queue = dialogQueue()
    const router = await mountRouter(queue.set, contextSink().set)
    mounted.push(router)
    const first = router.canUseTool()
    await router.redraw(queue.set, contextSink().set)
    expect(router.canUseTool()).not.toBe(first)
  })

  test('a turn aborted while the coordinator checks run is cancelled before any other route', async () => {
    const queue = dialogQueue()
    const router = await mountRouter(queue.set, contextSink().set)
    mounted.push(router)
    const abort = new AbortController()
    const tool = standIn({ name: 'Scribe', verdict: { behavior: 'ask', message: 'asks' } }) as unknown as Tool
    const session = openSession({
      tools: [tool],
      abort,
      permissions: { awaitAutomatedChecksBeforeDialog: true },
      hooks: [world().script('sleep 0.3')],
    })
    const decision = router.canUseTool()(tool, INPUT, session, TURN, ID)
    setTimeout(() => abort.abort(), 50)
    expect(await decision).toEqual({ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined })
    expect(queue.items()).toEqual([])
  })
})
