/**
 * The permission context every route works through, and the decision record
 * it leaves on the tool-use context.
 *
 * createPermissionContext is driven with real settings files under a temp
 * config home and project, and with real PermissionRequest hook commands.
 * The dialog queue is a plain array, the way the REPL keeps it in state.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
} from 'src/agent/messages/constants.js'
import { standIn, useDecisionWorld } from 'src/permissions/__testutils__/decisionWorld.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import {
  createPermissionContext,
  createPermissionQueueOps,
  createResolveOnce,
} from 'src/permissions/toolPermission/PermissionContext.js'
import { logPermissionDecision } from 'src/permissions/toolPermission/permissionLogging.js'
import {
  contextSink,
  dialogQueue,
  hookSays,
  openSession,
  TURN,
  type SessionSpec,
} from 'src/permissions/toolPermission/__testutils__/routeWorld.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { Tool } from 'src/tools/Tool.js'

const world = useDecisionWorld()
const ID = 'toolu_ctx'
const INPUT = { file_path: '/repo/a.txt' }

function build(spec: SessionSpec & { tool?: Tool; withQueue?: boolean } = {}) {
  const session = openSession(spec)
  const sink = contextSink()
  const queue = dialogQueue()
  const tool = spec.tool ?? standIn({ name: 'Scribe' })
  const ctx = createPermissionContext(
    tool,
    INPUT,
    session,
    TURN,
    ID,
    sink.set,
    spec.withQueue === false ? undefined : createPermissionQueueOps(queue.set),
  )
  return { ctx, session, sink, queue, record: () => session.toolDecisions?.get(ID) }
}

const sessionRule: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Scribe' }], behavior: 'allow', destination: 'session' }
const localRule: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Scribe' }], behavior: 'allow', destination: 'localSettings' }
const toPlan: PermissionUpdate = { type: 'setMode', mode: 'plan', destination: 'session' }

describe('what the context carries', () => {
  test('the call it was made for, and the message id of the turn', () => {
    const { ctx, session } = build()
    expect([ctx.input, ctx.toolUseContext, ctx.assistantMessage, ctx.messageId, ctx.toolUseID, ctx.tool.name]).toEqual([
      INPUT,
      session,
      TURN,
      'msg_route_suite',
      ID,
      'Scribe',
    ])
  })

  test('is frozen, and has no classifier step when the Bash classifier is not built', () => {
    const { ctx } = build()
    expect(Object.isFrozen(ctx)).toBe(true)
    expect('tryClassifier' in ctx).toBe(false)
  })
})

describe('decisions it builds', () => {
  const reason = { type: 'other' as const, reason: 'r' }
  const blocks = [{ type: 'text' as const, text: 'b' }]
  const allows: Array<[string, Parameters<ReturnType<typeof build>['ctx']['buildAllow']>[1], Record<string, unknown>]> = [
    ['bare', undefined, {}],
    ['marked as edited', { userModified: true }, { userModified: true }],
    ['with a reason', { decisionReason: reason }, { decisionReason: reason }],
    ['with feedback', { acceptFeedback: 'ok' }, { acceptFeedback: 'ok' }],
    ['with empty feedback', { acceptFeedback: '' }, {}],
    ['with blocks', { contentBlocks: blocks }, { contentBlocks: blocks }],
    ['with no blocks', { contentBlocks: [] }, {}],
  ]
  test.each(allows)('an allow, %s', (_name, opts, extra) => {
    const { ctx } = build()
    expect(ctx.buildAllow({ x: 1 }, opts)).toEqual({ behavior: 'allow', updatedInput: { x: 1 }, userModified: false, ...extra })
  })

  test('a deny carries its message and reason as given', () => {
    const { ctx } = build()
    expect(ctx.buildDeny('no', reason)).toEqual({ behavior: 'deny', message: 'no', decisionReason: reason })
  })
})

describe('cancelling', () => {
  const blocks = [{ type: 'text' as const, text: 'pic' }]
  const cases: Array<{ name: string; agentId?: string; feedback?: string; abort?: boolean; blocks?: typeof blocks; message: string; aborted: boolean }> = [
    { name: 'main agent, nothing said', message: REJECT_MESSAGE, aborted: true },
    { name: 'main agent, feedback', feedback: 'try b', message: `${REJECT_MESSAGE_WITH_REASON_PREFIX}try b`, aborted: false },
    { name: 'main agent, blocks only', blocks, message: REJECT_MESSAGE, aborted: false },
    { name: 'main agent, feedback and an abort', feedback: 'stop', abort: true, message: `${REJECT_MESSAGE_WITH_REASON_PREFIX}stop`, aborted: true },
    { name: 'sub-agent, nothing said', agentId: 'agent-1', message: SUBAGENT_REJECT_MESSAGE, aborted: false },
    { name: 'sub-agent, feedback', agentId: 'agent-1', feedback: 'no', message: `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}no`, aborted: false },
    { name: 'sub-agent, an abort', agentId: 'agent-1', abort: true, message: SUBAGENT_REJECT_MESSAGE, aborted: true },
  ]
  test.each(cases)('$name', c => {
    const { ctx, session } = build({ agentId: c.agentId })
    const got = ctx.cancelAndAbort(c.feedback, c.abort, c.blocks)
    expect(got).toEqual({ behavior: 'ask', message: c.message, contentBlocks: c.blocks })
    expect(session.abortController.signal.aborted).toBe(c.aborted)
  })

  test('an aborted turn is answered with a cancel; a live one is left alone', () => {
    const live = build()
    const seen: PermissionDecision[] = []
    expect(live.ctx.resolveIfAborted(d => seen.push(d))).toBe(false)
    const dead = new AbortController()
    dead.abort()
    const gone = build({ abort: dead })
    expect(gone.ctx.resolveIfAborted(d => seen.push(d))).toBe(true)
    expect(seen).toEqual([{ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined }])
  })
})

describe('saving rule updates', () => {
  test('no updates: nothing saved, nothing applied', async () => {
    const { ctx, sink } = build()
    expect(await ctx.persistPermissions([])).toBe(false)
    expect(sink.pushed).toEqual([])
  })

  test('a session rule applies to the session, keeps the mode, and does not count as saved', async () => {
    const { ctx, sink } = build({ permissions: { mode: 'acceptEdits' } })
    expect(await ctx.persistPermissions([sessionRule])).toBe(false)
    expect(sink.pushed.map(p => [p.preserveMode, p.context.mode, p.context.alwaysAllowRules.session])).toEqual([
      [true, 'acceptEdits', ['Scribe']],
    ])
  })

  test('a settings rule is written to that file and counts as saved', async () => {
    const { ctx, sink } = build()
    expect(await ctx.persistPermissions([localRule])).toBe(true)
    const file = world().settingsPath('local')
    expect(JSON.parse(readFileSync(file, 'utf8')).permissions.allow).toEqual(['Scribe'])
    expect(sink.pushed[0]?.context.alwaysAllowRules.localSettings).toEqual(['Scribe'])
  })

  test('only a mode update may move the mode', async () => {
    const { ctx, sink } = build()
    await ctx.persistPermissions([toPlan])
    expect(sink.pushed.map(p => [p.preserveMode, p.context.mode])).toEqual([[false, 'plan']])
  })
})

describe('allowing on behalf of the user or a hook', () => {
  test('a user allow saves rules, trims feedback and records how it was given', async () => {
    const tool = { ...standIn({ name: 'Scribe' }), inputsEquivalent: () => false } as unknown as Tool
    const { ctx, record } = build({ tool })
    const reason = { type: 'other' as const, reason: 'asked' }
    const blocks = [{ type: 'text' as const, text: 'x' }]
    const got = await ctx.handleUserAllow({ file_path: '/b' }, [localRule], '  sure  ', 5, blocks, reason)
    expect(got).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/b' },
      userModified: true,
      decisionReason: reason,
      acceptFeedback: 'sure',
      contentBlocks: blocks,
    })
    expect(record()).toMatchObject({ decision: 'accept', source: 'user_permanent' })
  })

  const edits: Array<[string, Tool, boolean]> = [
    ['a tool with no equivalence check never counts as edited', standIn({ name: 'Scribe' }), false],
    ['an equivalent input is not an edit', { ...standIn({ name: 'Scribe' }), inputsEquivalent: () => true } as unknown as Tool, false],
  ]
  test.each(edits)('%s', async (_name, tool, modified) => {
    const { ctx, record } = build({ tool })
    const got = await ctx.handleUserAllow({ file_path: '/c' }, [], '   ')
    expect(got).toEqual({ behavior: 'allow', updatedInput: { file_path: '/c' }, userModified: modified })
    expect(record()?.source).toBe('user_temporary')
  })

  test('a hook allow names the hook and records it as one', async () => {
    const { ctx, record } = build()
    const got = await ctx.handleHookAllow({ file_path: '/h' }, [sessionRule])
    expect(got).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/h' },
      userModified: false,
      decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
    })
    expect(record()).toMatchObject({ decision: 'accept', source: 'hook' })
  })
})

describe('PermissionRequest hooks', () => {
  test('with no hook configured there is no decision', async () => {
    const { ctx } = build()
    expect(await ctx.runHooks('default', undefined)).toBeNull()
  })

  test('a hook with nothing to say, or a broken one, gives no decision', async () => {
    const got = []
    for (const body of ['true', 'exit 1', `printf 'nonsense'`]) {
      const { ctx } = build({ hooks: [world().script(body)] })
      got.push(await ctx.runHooks('default', undefined))
    }
    expect(got).toEqual([null, null, null])
  })

  const inputs: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>]> = [
    ["the hook's own input wins", { behavior: 'allow', updatedInput: { file_path: '/hook' } }, { file_path: '/checks' }, { file_path: '/hook' }],
    ['then the input the checks rewrote', { behavior: 'allow' }, { file_path: '/checks' }, { file_path: '/checks' }],
    ['then the call as made', { behavior: 'allow' }, undefined, INPUT],
  ]
  test.each(inputs)('an allow runs with an input: %s', async (_name, said, rewritten, expected) => {
    const { ctx, record } = build({ hooks: [world().script(hookSays(said))] })
    const got = await ctx.runHooks('default', undefined, rewritten)
    expect(got).toEqual({
      behavior: 'allow',
      updatedInput: expected,
      userModified: false,
      decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
    })
    expect(record()?.source).toBe('hook')
  })

  test("an allow saves the hook's rule updates", async () => {
    const { ctx, sink } = build({ hooks: [world().script(hookSays({ behavior: 'allow', updatedPermissions: [localRule] }))] })
    await ctx.runHooks('default', undefined)
    expect(existsSync(world().settingsPath('local'))).toBe(true)
    expect(sink.pushed).toHaveLength(1)
  })

  test('a deny refuses with the hook message, or a stock one, and keeps the turn', async () => {
    const got = []
    for (const said of [{ behavior: 'deny', message: 'not today' }, { behavior: 'deny' }]) {
      const { ctx, record, session } = build({ hooks: [world().script(hookSays(said))] })
      got.push([await ctx.runHooks('default', undefined), record()?.source, session.abortController.signal.aborted])
    }
    expect(got).toEqual([
      [{ behavior: 'deny', message: 'not today', decisionReason: { type: 'hook', hookName: 'PermissionRequest', reason: 'not today' } }, 'hook', false],
      [{ behavior: 'deny', message: 'Permission denied by hook', decisionReason: { type: 'hook', hookName: 'PermissionRequest' } }, 'hook', false],
    ])
  })

  test('a deny that interrupts stops the turn', async () => {
    const { ctx, session } = build({ hooks: [world().script(hookSays({ behavior: 'deny', message: 'halt', interrupt: true }))] })
    const got = await ctx.runHooks('default', undefined)
    expect([got?.behavior, session.abortController.signal.aborted]).toEqual(['deny', true])
  })

  test('the hook sees the call as made, the mode and the suggestions', async () => {
    const w = world()
    const log = `${w.root}/seen.json`
    const { ctx } = build({ hooks: [w.script(`printf '%s' "$input" > '${log}'`)] })
    await ctx.runHooks('acceptEdits', [sessionRule], { file_path: '/rewritten' })
    const seen = JSON.parse(readFileSync(log, 'utf8'))
    expect([seen.hook_event_name, seen.tool_name, seen.tool_input, seen.permission_mode, seen.permission_suggestions]).toEqual([
      'PermissionRequest',
      'Scribe',
      INPUT,
      'acceptEdits',
      [sessionRule],
    ])
  })
})

describe('the dialog queue', () => {
  const entry = (toolUseID: string, description: string) => ({ toolUseID, description }) as unknown as ToolUseConfirm

  test('the context pushes, patches and removes its own entry only', () => {
    const { ctx, queue } = build()
    queue.set([entry('other', 'theirs')])
    ctx.pushToQueue(entry(ID, 'mine'))
    ctx.updateQueueItem({ description: 'patched' })
    expect(queue.items().map(i => [i.toolUseID, i.description])).toEqual([
      ['other', 'theirs'],
      [ID, 'patched'],
    ])
    ctx.removeFromQueue()
    expect(queue.items().map(i => i.toolUseID)).toEqual(['other'])
  })

  test('without a queue the queue calls do nothing', () => {
    const { ctx } = build({ withQueue: false })
    expect(() => {
      ctx.pushToQueue(entry(ID, 'x'))
      ctx.updateQueueItem({ description: 'y' })
      ctx.removeFromQueue()
    }).not.toThrow()
  })
})

describe('resolve-once', () => {
  const runs: Array<[string, (once: ReturnType<typeof createResolveOnce<string>>) => unknown[], string[], unknown[]]> = [
    ['the first value is the only one delivered', o => [o.resolve('a'), o.resolve('b')], ['a'], [undefined, undefined]],
    ['a claim wins once', o => [o.claim(), o.claim(), o.isResolved()], [], [true, false, true]],
    ['a claim does not deliver, the claimer still can', o => [o.claim(), o.resolve('mine'), o.resolve('again')], ['mine'], [true, undefined, undefined]],
    ['after a delivery nobody can claim', o => [o.resolve('x'), o.claim(), o.isResolved()], ['x'], [undefined, false, true]],
    ['fresh, nothing is resolved', o => [o.isResolved()], [], [false]],
  ]
  test.each(runs)('%s', (_name, act, delivered, returns) => {
    const got: string[] = []
    const once = createResolveOnce<string>(v => got.push(v))
    expect(act(once)).toEqual(returns)
    expect(got).toEqual(delivered)
  })
})

describe('the decision record', () => {
  const sources: Array<[Parameters<typeof logPermissionDecision>[1], string]> = [
    [{ decision: 'accept', source: 'config' }, 'config'],
    [{ decision: 'reject', source: 'config' }, 'config'],
    [{ decision: 'accept', source: { type: 'hook' } }, 'hook'],
    [{ decision: 'reject', source: { type: 'hook' } }, 'hook'],
    [{ decision: 'accept', source: { type: 'user', permanent: true } }, 'user_permanent'],
    [{ decision: 'accept', source: { type: 'user', permanent: false } }, 'user_temporary'],
    [{ decision: 'reject', source: { type: 'user_abort' } }, 'user_abort'],
    [{ decision: 'reject', source: { type: 'user_reject', hasFeedback: true } }, 'user_reject'],
    // Without either classifier build, a classifier source has no name.
    [{ decision: 'accept', source: { type: 'classifier' } }, 'unknown'],
  ]
  test.each(sources)('%o is recorded as %s', (args, label) => {
    const session = openSession()
    const before = Date.now()
    logPermissionDecision({ tool: standIn({ name: 'Scribe' }), input: {}, toolUseContext: session, messageId: 'm', toolUseID: 'u1' }, args)
    const got = session.toolDecisions?.get('u1')
    expect([got?.source, got?.decision]).toEqual([label, args.decision])
    expect(got?.timestamp).toBeGreaterThanOrEqual(before)
  })

  test('one entry per call, the latest decision winning, beside the others', () => {
    const session = openSession()
    const log = (id: string, args: Parameters<typeof logPermissionDecision>[1]) =>
      logPermissionDecision({ tool: standIn({ name: 'Scribe' }), input: {}, toolUseContext: session, messageId: 'm', toolUseID: id }, args)
    log('u1', { decision: 'reject', source: { type: 'hook' } })
    log('u2', { decision: 'accept', source: 'config' })
    log('u1', { decision: 'accept', source: { type: 'user', permanent: false } })
    expect([...(session.toolDecisions ?? new Map()).entries()].map(([id, v]) => [id, v.decision, v.source])).toEqual([
      ['u1', 'accept', 'user_temporary'],
      ['u2', 'accept', 'config'],
    ])
  })
})
