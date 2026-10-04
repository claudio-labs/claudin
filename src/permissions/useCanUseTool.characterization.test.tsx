/**
 * useCanUseTool: the REPL's permission gate. It takes the permission
 * decision for a tool call and routes whatever is left to ask to whoever
 * answers it: the coordinator's automated checks, the swarm leader, or the
 * user's dialog.
 *
 * The hook is mounted in a real Ink tree over a fake terminal. The decision
 * runs as shipped (real rules, real PermissionRequest hook commands, a real
 * team on disk for the swarm route); the dialog queue it pushes to is a
 * plain array, the boundary the REPL renders from. The classifier and bridge
 * branches exist only with their build flags, and are pinned in
 * src/permissions/toolPermission/toolPermission.classifiers.characterization.test.tsx.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

import { clearAllPendingCallbacks, processMailboxPermissionResponse } from 'src/agent/coordinator/hooks/useSwarmPermissionPoller.js'
import { REJECT_MESSAGE, SUBAGENT_REJECT_MESSAGE } from 'src/agent/messages/constants.js'
import { standIn, useDecisionWorld } from 'src/permissions/__testutils__/decisionWorld.js'
import type { PermissionDecision, PermissionResult } from 'src/permissions/PermissionResult.js'
import {
  contextSink,
  dialogQueue,
  hookSays,
  joinCrew,
  mountRouter,
  openSession,
  TURN,
  until,
  type Crew,
  type MountedRouter,
  type SessionSpec,
} from 'src/permissions/toolPermission/__testutils__/routeWorld.js'
import { AbortError } from 'src/shared/errors.js'
import type { Tool } from 'src/tools/Tool.js'

const world = useDecisionWorld()
const ID = 'toolu_gate'
const INPUT = { command: 'make release' }

const mounted: MountedRouter[] = []
let crew: Crew | undefined
afterEach(() => {
  while (mounted.length) mounted.pop()?.close()
  crew?.leave()
  crew = undefined
  clearAllPendingCallbacks()
})

const asking: PermissionResult = { behavior: 'ask', message: 'the tool wants a yes' }

async function gate(tool: Tool, spec: SessionSpec = {}, force?: PermissionDecision) {
  const queue = dialogQueue()
  const sink = contextSink()
  const router = await mountRouter(queue.set, sink.set)
  mounted.push(router)
  const session = openSession({ tools: [tool], ...spec })
  let settled: PermissionDecision | 'pending' = 'pending'
  const decision = router.canUseTool()(tool, INPUT, session, TURN, ID, force)
  void decision.then(d => {
    settled = d
  })
  return { decision, session, queue, sink, router, settled: () => settled }
}

/** A tool that answers its own check with `verdict` and describes itself. */
function scribe(verdict: Parameters<typeof standIn>[0]['verdict'], extra: Record<string, unknown> = {}): Tool {
  return { ...standIn({ name: 'Scribe', verdict }), ...extra } as unknown as Tool
}

describe('decisions that need nobody', () => {
  test('a call the rules allow runs at once, with the reason, and no dialog', async () => {
    const run = await gate(scribe(asking), { permissions: { alwaysAllowRules: { session: ['Scribe'] } } })
    const got = await run.decision
    expect(got).toEqual({
      behavior: 'allow',
      updatedInput: INPUT,
      userModified: false,
      decisionReason: { type: 'rule', rule: { source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'Scribe' } } },
    })
    expect(run.queue.items()).toEqual([])
    expect(run.session.toolDecisions?.get(ID)).toMatchObject({ decision: 'accept', source: 'config' })
  })

  test("an allow carries the input the tool's check rewrote", async () => {
    const run = await gate(scribe({ behavior: 'allow', updatedInput: { command: 'make release --sign' } }))
    expect(((await run.decision) as { updatedInput?: unknown }).updatedInput).toEqual({ command: 'make release --sign' })
  })

  test('a call the rules deny is refused as decided, and recorded', async () => {
    const run = await gate(scribe(asking), { permissions: { alwaysDenyRules: { session: ['Scribe'] } }, notify: true })
    const got = await run.decision
    expect([got.behavior, got.decisionReason?.type]).toEqual(['deny', 'rule'])
    expect(run.session.toolDecisions?.get(ID)).toMatchObject({ decision: 'reject', source: 'config' })
    expect(run.queue.items()).toEqual([])
    expect(run.session.notices).toEqual([])
  })

  test('a forced decision is used instead of the checks', async () => {
    const tool = standIn({ name: 'Scribe', verdict: asking })
    const run = await gate(tool, {}, { behavior: 'allow', updatedInput: { command: 'forced' } })
    expect(await run.decision).toEqual({ behavior: 'allow', updatedInput: { command: 'forced' }, userModified: false })
    expect(tool.seenModes).toEqual([])
  })

  test('a forced ask still goes to the dialog', async () => {
    const run = await gate(scribe({ behavior: 'allow' }), {}, { behavior: 'ask', message: 'forced ask' })
    await until(() => run.queue.items().length === 1)
    expect(run.queue.only().permissionResult).toEqual({ behavior: 'ask', message: 'forced ask' })
  })
})

describe('the dialog', () => {
  test('an ask opens one dialog, described by the tool, and the user answers it', async () => {
    const described: unknown[] = []
    const tool = scribe(asking, {
      async description(input: unknown, opts: Record<string, unknown>) {
        described.push([input, opts.isNonInteractiveSession, (opts.toolPermissionContext as { mode: string }).mode, (opts.tools as Tool[]).length])
        return 'release the build'
      },
    })
    const run = await gate(tool, { permissions: { mode: 'acceptEdits' } })
    await until(() => run.queue.items().length === 1)
    const entry = run.queue.only()
    expect([entry.description, entry.input, entry.toolUseID, entry.permissionResult.behavior]).toEqual(['release the build', INPUT, ID, 'ask'])
    expect(described).toEqual([[INPUT, false, 'acceptEdits', 1]])
    entry.onAllow(INPUT, [])
    expect(await run.decision).toEqual({ behavior: 'allow', updatedInput: INPUT, userModified: false })
    expect(run.session.toolDecisions?.get(ID)?.source).toBe('user_temporary')
  })

  test('a PermissionRequest hook races the open dialog and can answer it', async () => {
    const run = await gate(scribe(asking), { hooks: [world().script(hookSays({ behavior: 'deny', message: 'hook says no' }))] })
    const got = await run.decision
    expect([got.behavior, (got as { message?: string }).message]).toEqual(['deny', 'hook says no'])
    expect(run.queue.items()).toEqual([])
  })

  test('a reject from a sub-agent session is phrased for a sub-agent and keeps its turn', async () => {
    const run = await gate(scribe(asking), { agentId: 'helper-1' })
    await until(() => run.queue.items().length === 1)
    run.queue.only().onReject()
    expect(await run.decision).toEqual({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE, contentBlocks: undefined })
    expect(run.session.abortController.signal.aborted).toBe(false)
  })
})

describe('the coordinator route', () => {
  const coordinator = { permissions: { awaitAutomatedChecksBeforeDialog: true } }

  test('a hook decision is awaited before any dialog, and answers the call', async () => {
    const run = await gate(scribe(asking), { ...coordinator, hooks: [world().script(hookSays({ behavior: 'allow' }))] })
    const got = await run.decision
    expect([got.behavior, got.decisionReason]).toEqual(['allow', { type: 'hook', hookName: 'PermissionRequest' }])
    expect(run.queue.items()).toEqual([])
  })

  test('with no decision the dialog opens, and the hooks are not run a second time', async () => {
    const w = world()
    const log = `${w.root}/runs.log`
    const run = await gate(scribe(asking), { ...coordinator, hooks: [w.script(`echo run >> '${log}'`)] })
    await until(() => run.queue.items().length === 1)
    await Bun.sleep(150)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['run'])
    expect(run.settled()).toBe('pending')
  })
})

describe('the swarm-worker route', () => {
  test("a worker's ask goes to the leader instead of a dialog, and the leader's answer is the decision", async () => {
    crew = joinCrew(world().configDir)
    const run = await gate(scribe(asking))
    await until(() => (crew?.leaderInbox().length ?? 0) === 1)
    const request = crew.leaderInbox()[0] ?? {}
    expect([request.tool_name, request.description, run.queue.items()]).toEqual(['Scribe', 'Scribe', []])
    processMailboxPermissionResponse({ requestId: String(request.request_id), decision: 'approved' })
    expect(await run.decision).toEqual({ behavior: 'allow', updatedInput: INPUT, userModified: false })
  })

  test('a coordinator worker runs its hooks first, and only then asks the leader', async () => {
    crew = joinCrew(world().configDir)
    const w = world()
    const log = `${w.root}/order.log`
    const run = await gate(scribe(asking), { permissions: { awaitAutomatedChecksBeforeDialog: true }, hooks: [w.script(`echo hook >> '${log}'`)] })
    await until(() => (crew?.leaderInbox().length ?? 0) === 1)
    expect([existsSync(log), run.queue.items()]).toEqual([true, []])
  })
})

describe('an aborted or failing check', () => {
  test('a turn aborted before the call is cancelled without checking', async () => {
    const abort = new AbortController()
    abort.abort()
    const tool = standIn({ name: 'Scribe', verdict: { behavior: 'allow' } })
    const run = await gate(tool, { abort })
    expect(await run.decision).toEqual({ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined })
    expect(tool.seenModes).toEqual([])
  })

  test('a turn aborted before a forced decision is cancelled without describing the call or recording anything', async () => {
    const abort = new AbortController()
    abort.abort()
    let described = 0
    const tool = scribe(asking, {
      async description() {
        described++
        return 'never needed'
      },
    })
    const run = await gate(tool, { abort }, { behavior: 'deny', message: 'forced', decisionReason: { type: 'other', reason: 'x' } })
    expect(await run.decision).toEqual({ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined })
    expect([described, run.session.toolDecisions]).toEqual([0, undefined])
  })

  const lateAborts: Array<[string, (abort: AbortController) => Tool]> = [
    [
      'during the check, an allow becomes a cancel',
      abort =>
        scribe(() => {
          abort.abort()
          return { behavior: 'allow' } as PermissionResult
        }),
    ],
    [
      'while describing the call, an ask becomes a cancel',
      abort =>
        scribe(asking, {
          async description() {
            abort.abort()
            return 'late'
          },
        }),
    ],
  ]
  test.each(lateAborts)('an abort %s', async (_name, make) => {
    const abort = new AbortController()
    const run = await gate(make(abort), { abort })
    expect(await run.decision).toEqual({ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined })
    expect(run.queue.items()).toEqual([])
  })

  const failures: Array<[string, Tool]> = [
    [
      'a check that throws an abort',
      scribe(() => {
        throw new AbortError('gone')
      }),
    ],
    [
      'a description that throws',
      scribe(asking, {
        async description() {
          throw new Error('cannot describe')
        },
      }),
    ],
  ]
  test.each(failures)('%s cancels the call and stops the turn', async (_name, tool) => {
    const run = await gate(tool)
    expect(await run.decision).toEqual({ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined })
    expect(run.session.abortController.signal.aborted).toBe(true)
    expect(run.queue.items()).toEqual([])
  })
})

describe('the function the hook returns', () => {
  test('is the same across renders with the same setters, and new when a setter changes', async () => {
    const queue = dialogQueue()
    const sink = contextSink()
    const router = await mountRouter(queue.set, sink.set)
    mounted.push(router)
    const first = router.canUseTool()
    await router.redraw(queue.set, sink.set)
    const same = router.canUseTool()
    await router.redraw(dialogQueue().set, sink.set)
    const changed = router.canUseTool()
    await router.redraw(dialogQueue().set, contextSink().set)
    expect([same === first, changed === first, router.canUseTool() === changed]).toEqual([true, false, false])
  })

  test('saves rules the user picks through the setter it was given', async () => {
    const run = await gate(scribe(asking))
    await until(() => run.queue.items().length === 1)
    run.queue.only().onAllow(INPUT, [{ type: 'addRules', rules: [{ toolName: 'Scribe' }], behavior: 'allow', destination: 'session' }])
    await run.decision
    expect(run.sink.pushed.map(p => p.context.alwaysAllowRules.session)).toEqual([['Scribe']])
  })
})
