/**
 * The classifier and bridge paths of the permission routes, which exist only
 * in a build with BASH_CLASSIFIER, TRANSCRIPT_CLASSIFIER and BRIDGE_MODE. The
 * shipped build turns all three on; plain `bun test` leaves them off. So under
 * the plain runner this file only starts itself again in a child `bun test`
 * with the three flags, and fails if the child does.
 *
 * The one thing replaced is the model call (`sideQuery`): the Bash prompt-rule
 * classifier builds its request and reads the answer as shipped. The dialog
 * queue is a plain array (the UI boundary), and the bridge callbacks stand for
 * the web app at the other end of the network.
 */
// The decision module must load before the classifier modules: with the
// flags on, loading the classifier first trips an import cycle.
import 'src/permissions/permissions.js'
import { feature } from 'bun:bundle'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'

const FLAGS_ON = feature('BASH_CLASSIFIER') ? true : false

if (!FLAGS_ON) {
  test('with the classifier and bridge build flags on, the classifier routes hold', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        'test',
        '--feature=BASH_CLASSIFIER',
        '--feature=TRANSCRIPT_CLASSIFIER',
        '--feature=BRIDGE_MODE',
        import.meta.path,
      ],
      { cwd: resolve(import.meta.dir, '..', '..', '..'), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    )
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const report = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '-1')
    if (code !== 0 || failed !== 0 || passed < 40) {
      throw new Error(`the flag-on run failed (exit ${code}, ${passed} passed):\n${report.slice(-8_000)}`)
    }
  }, 180_000)
} else {
  // ---- the model boundary -------------------------------------------------
  const realSideQuery = { ...(await import('src/agent/sideQuery.js')) }
  type Request = Parameters<typeof realSideQuery.sideQuery>[0]
  let reply: ((request: Request) => Promise<unknown>) | null = null
  const asked: Request[] = []
  mock.module('src/agent/sideQuery.js', () => ({
    ...realSideQuery,
    sideQuery: (request: Request) => {
      asked.push(request)
      if (!reply) return Promise.reject(new Error('the model was not expected to be asked'))
      return reply(request)
    },
  }))
  afterAll(() => {
    mock.module('src/agent/sideQuery.js', () => realSideQuery)
  })

  const React = await import('react')
  const { REJECT_MESSAGE } = await import('src/agent/messages/constants.js')
  const { clearAllPendingCallbacks } = await import('src/agent/coordinator/hooks/useSwarmPermissionPoller.js')
  const approvals = await import('src/permissions/classifierApprovals.js')
  const { getAutoModeDenials } = await import('src/permissions/autoModeDenials.js')
  const { standIn, permissionContext, useDecisionWorld } = await import('src/permissions/__testutils__/decisionWorld.js')
  const { handleCoordinatorPermission } = await import('src/permissions/toolPermission/handlers/coordinatorHandler.js')
  const { handleInteractivePermission } = await import('src/permissions/toolPermission/handlers/interactiveHandler.js')
  const { handleSwarmWorkerPermission } = await import('src/permissions/toolPermission/handlers/swarmWorkerHandler.js')
  const { createPermissionContext, createPermissionQueueOps } = await import('src/permissions/toolPermission/PermissionContext.js')
  const { logPermissionDecision } = await import('src/permissions/toolPermission/permissionLogging.js')
  const route = await import('src/permissions/toolPermission/__testutils__/routeWorld.js')
  const state = await import('src/platform/bootstrap/state.js')
  const { renderToString } = await import('src/terminal/render/staticRender.js')
  const { setTerminalFocused } = await import('src/terminal/ink/terminal-focus-state.js')
  const { clearSpeculativeChecks, peekSpeculativeClassifierCheck, startSpeculativeClassifierCheck } = await import(
    'src/tools/BashTool/bashPermissions.js'
  )
  type PermissionDecision = import('src/permissions/PermissionResult.js').PermissionDecision
  type Tool = import('src/tools/Tool.js').Tool
  type BridgePermissionCallbacks = import('src/platform/bridge/bridgePermissionCallbacks.js').BridgePermissionCallbacks

  const world = useDecisionWorld()
  const MODEL = 'claude-sonnet-4-5'
  const ID = 'toolu_cls'
  const INPUT = { command: 'npm test' }
  const RULE = 'run the test suite'
  const ALLOWED = { type: 'classifier', classifier: 'bash_allow', reason: `Allowed by prompt rule: "${RULE}"` } as const
  const pending = () => ({ command: 'npm test', cwd: world().project, descriptions: ['lint the code', RULE] })

  let savedModel: unknown
  const mounted: Array<{ close(): void }> = []
  let crew: { leave(): void } | undefined
  beforeAll(() => {
    savedModel = state.getMainLoopModelOverride()
  })
  afterAll(() => {
    state.setMainLoopModelOverride(savedModel as never)
    setTerminalFocused(true)
  })
  beforeEach(() => {
    state.setMainLoopModelOverride(MODEL)
    approvals.clearClassifierApprovals()
    clearSpeculativeChecks()
    asked.length = 0
    reply = null
    setTerminalFocused(true)
  })
  afterEach(() => {
    while (mounted.length) mounted.pop()?.close()
    crew?.leave()
    crew = undefined
    clearAllPendingCallbacks()
    reply = null
  })

  // ---- what the model can answer ------------------------------------------
  const says = (matchedIndex: number | null, confidence: 'high' | 'medium' | 'low') => async () => ({
    id: 'msg_cls',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'tool_use', id: 'toolu_match', name: 'classify_match', input: { matchedIndex, confidence, reason: 'considered' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  /** A model answer held back until the test releases it. */
  const held = () => {
    let release: (answer: () => Promise<unknown>) => void = () => {}
    const gate = new Promise<() => Promise<unknown>>(r => (release = r))
    reply = async () => (await gate)()
    return { release: (answer: () => Promise<unknown>) => release(answer) }
  }
  const settle = () => Bun.sleep(20)

  const bash = (verdict: Record<string, unknown> = { behavior: 'ask', message: 'asks', pendingClassifierCheck: pending() }) =>
    standIn({ name: 'Bash', verdict: verdict as never }) as unknown as Tool

  function remoteEnd() {
    const calls: unknown[][] = []
    const callbacks: BridgePermissionCallbacks = {
      sendRequest: (...args) => void calls.push(['sendRequest', ...args]),
      sendResponse: (...args) => void calls.push(['sendResponse', ...args]),
      cancelRequest: (...args) => void calls.push(['cancelRequest', ...args]),
      onResponse: requestId => {
        calls.push(['onResponse', requestId])
        return () => {}
      },
    }
    return { callbacks, calls }
  }

  /** A context for direct use of the routes, over a real session. */
  function contextFor(tool: Tool, spec: Parameters<typeof route.openSession>[0] = {}) {
    const session = route.openSession(spec)
    const queue = route.dialogQueue()
    const ctx = createPermissionContext(tool, INPUT, session, route.TURN, ID, route.contextSink().set, createPermissionQueueOps(queue.set))
    return { ctx, session, queue }
  }

  /** Opens the interactive dialog directly, the way the gate does after its own checks. */
  function dialog(opts: {
    tool?: Tool
    check?: ReturnType<typeof pending> | undefined
    awaitChecks?: boolean
    updatedInput?: Record<string, unknown>
    bridge?: BridgePermissionCallbacks
    abort?: AbortController
  } = {}) {
    const { ctx, session, queue } = contextFor(opts.tool ?? bash(), { abort: opts.abort })
    const decisions: PermissionDecision[] = []
    handleInteractivePermission(
      {
        ctx,
        description: 'run the tests',
        result: {
          behavior: 'ask',
          message: 'asks',
          ...('check' in opts ? { pendingClassifierCheck: opts.check } : { pendingClassifierCheck: pending() }),
          ...(opts.updatedInput ? { updatedInput: opts.updatedInput } : {}),
        } as never,
        awaitAutomatedChecksBeforeDialog: opts.awaitChecks,
        bridgeCallbacks: opts.bridge,
      },
      d => decisions.push(d),
    )
    return { session, queue, decisions }
  }

  /** Mounts the gate and sends one call through it. */
  async function gate(tool: Tool, spec: Parameters<typeof route.openSession>[0] = {}, force?: PermissionDecision) {
    const queue = route.dialogQueue()
    const router = await route.mountRouter(queue.set, route.contextSink().set)
    mounted.push(router)
    const session = route.openSession({ tools: [tool], ...spec })
    let settled: PermissionDecision | 'pending' = 'pending'
    const decision = router.canUseTool()(tool, INPUT, session, route.TURN, ID, force)
    void decision.then(d => {
      settled = d
    })
    return { decision, queue, session, settled: () => settled }
  }

  const speculate = () =>
    startSpeculativeClassifierCheck(
      'npm test',
      permissionContext({ alwaysAllowRules: { session: ['Bash(prompt: lint the code)', `Bash(prompt: ${RULE})`] } }),
      new AbortController().signal,
      false,
    )

  // =========================================================================
  describe('the classifier step of the permission context', () => {
    test('allows a Bash call the model matches with high confidence, naming the rule', async () => {
      reply = says(1, 'high')
      const { ctx, session } = contextFor(bash())
      const got = await ctx.tryClassifier?.(pending(), undefined)
      expect(got).toEqual({ behavior: 'allow', updatedInput: INPUT, userModified: false, decisionReason: ALLOWED })
      expect(approvals.getClassifierApproval(ID)).toBe(RULE)
      expect(session.toolDecisions?.get(ID)?.source).toBe('classifier')
      const sent = JSON.stringify(asked[0]?.messages)
      expect([sent.includes('npm test'), sent.includes('[1] run the test suite')]).toEqual([true, true])
    })

    test('runs the rewritten input when the checks gave one', async () => {
      reply = says(1, 'high')
      const { ctx } = contextFor(bash())
      const got = await ctx.tryClassifier?.(pending(), { command: 'npm test -- --ci' })
      expect((got as { updatedInput?: unknown }).updatedInput).toEqual({ command: 'npm test -- --ci' })
    })

    const nothing: Array<[string, () => Promise<unknown>]> = [
      ['a medium-confidence match', says(1, 'medium')],
      ['a low-confidence match', says(0, 'low')],
      ['no match', says(null, 'high')],
      ['an index out of range', says(7, 'high')],
      ['an outage', async () => Promise.reject(new Error('503'))],
    ]
    test.each(nothing)('%s decides nothing', async (_name, answer) => {
      reply = answer
      const { ctx, session } = contextFor(bash())
      expect(await ctx.tryClassifier?.(pending(), undefined)).toBeNull()
      expect([approvals.getClassifierApproval(ID), session.toolDecisions?.get(ID)]).toEqual([undefined, undefined])
    })

    test('another tool, or a call with no pending check, is never classified', async () => {
      reply = says(1, 'high')
      const other = contextFor(standIn({ name: 'Scribe' }) as unknown as Tool)
      const noCheck = contextFor(bash())
      expect([await other.ctx.tryClassifier?.(pending(), undefined), await noCheck.ctx.tryClassifier?.(undefined, undefined), asked.length]).toEqual([
        null,
        null,
        0,
      ])
    })

    test('a check already running for the same command is used instead of a new one', async () => {
      reply = says(1, 'high')
      expect(speculate()).toBe(true)
      const { ctx } = contextFor(bash())
      expect((await ctx.tryClassifier?.(pending(), undefined))?.behavior).toBe('allow')
      expect([asked.length, peekSpeculativeClassifierCheck('npm test')]).toEqual([1, undefined])
    })

    test('a classifier source is recorded by name', () => {
      const session = route.openSession()
      logPermissionDecision({ tool: bash(), input: {}, toolUseContext: session, messageId: 'm', toolUseID: 'u' }, { decision: 'accept', source: { type: 'classifier' } })
      expect(session.toolDecisions?.get('u')?.source).toBe('classifier')
    })
  })

  // =========================================================================
  describe('the coordinator and swarm routes', () => {
    test('a coordinator asks the classifier when no hook decides', async () => {
      reply = says(1, 'high')
      const { ctx } = contextFor(bash())
      const got = await handleCoordinatorPermission({ ctx, pendingClassifierCheck: pending(), updatedInput: undefined, suggestions: undefined, permissionMode: 'default' })
      expect(got?.decisionReason).toEqual(ALLOWED)
    })

    test('a coordinator hook decision comes first, and the classifier is not asked', async () => {
      reply = says(1, 'high')
      const w = world()
      const { ctx } = contextFor(bash(), { hooks: [w.script(route.hookSays({ behavior: 'deny', message: 'hooked' }))] })
      const got = await handleCoordinatorPermission({ ctx, pendingClassifierCheck: pending(), updatedInput: undefined, suggestions: undefined, permissionMode: 'default' })
      expect([got?.behavior, asked.length]).toEqual(['deny', 0])
    })

    test('a coordinator falls through when the classifier does not match', async () => {
      reply = says(null, 'high')
      const { ctx } = contextFor(bash())
      expect(await handleCoordinatorPermission({ ctx, pendingClassifierCheck: pending(), updatedInput: undefined, suggestions: undefined, permissionMode: 'default' })).toBeNull()
    })

    test('a swarm worker lets the classifier allow before asking the leader', async () => {
      reply = says(1, 'high')
      const joined = route.joinCrew(world().configDir)
      crew = joined
      const { ctx } = contextFor(bash())
      const got = await handleSwarmWorkerPermission({ ctx, description: 'tests', pendingClassifierCheck: pending(), updatedInput: undefined, suggestions: undefined })
      expect(got?.decisionReason).toEqual(ALLOWED)
      await Bun.sleep(50)
      expect(joined.leaderInbox()).toEqual([])
    })

    test('a swarm worker asks the leader when the classifier does not match', async () => {
      reply = says(0, 'low')
      const joined = route.joinCrew(world().configDir)
      crew = joined
      const { ctx } = contextFor(bash())
      void handleSwarmWorkerPermission({ ctx, description: 'tests', pendingClassifierCheck: pending(), updatedInput: undefined, suggestions: undefined })
      await route.until(() => joined.leaderInbox().length === 1)
    })
  })

  // =========================================================================
  describe('the classifier racing the dialog', () => {
    test('the dialog says the classifier is running, and the call is marked as being checked', () => {
      held()
      const { queue } = dialog()
      expect([queue.only().classifierCheckInProgress, approvals.isClassifierChecking(ID)]).toEqual([true, true])
    })

    const quiet: Array<[string, Parameters<typeof dialog>[0]]> = [
      ['when the checks were already awaited', { awaitChecks: true }],
      ['when there is nothing to classify', { check: undefined }],
    ]
    test.each(quiet)('no classifier runs %s', async (_name, opts) => {
      reply = says(1, 'high')
      const { queue, decisions } = dialog(opts)
      await settle()
      expect([queue.only().classifierCheckInProgress, asked.length, decisions]).toEqual([false, 0, []])
    })

    test('another tool with a pending check shows the indicator, yet nothing is classified', async () => {
      reply = says(1, 'high')
      const { queue } = dialog({ tool: standIn({ name: 'Scribe' }) as unknown as Tool })
      await settle()
      expect([queue.only().classifierCheckInProgress, asked.length]).toEqual([true, 0])
    })

    test('a match allows the call as made, shows the checkmark, and records the rule', async () => {
      reply = says(1, 'high')
      const { queue, decisions, session } = dialog({ updatedInput: { command: 'npm test -- --ci' } })
      await route.until(() => decisions.length === 1)
      expect(decisions).toEqual([{ behavior: 'allow', updatedInput: INPUT, userModified: false, decisionReason: ALLOWED }])
      const entry = queue.only()
      expect([entry.classifierCheckInProgress, entry.classifierAutoApproved, entry.classifierMatchedRule]).toEqual([false, true, RULE])
      expect([approvals.getClassifierApproval(ID), approvals.isClassifierChecking(ID), session.toolDecisions?.get(ID)?.source]).toEqual([
        RULE,
        false,
        'classifier',
      ])
    })

    test('no match clears the indicator and leaves the dialog to the user', async () => {
      reply = says(null, 'high')
      const { queue, decisions } = dialog()
      await route.until(() => queue.only().classifierCheckInProgress === false)
      expect([decisions, approvals.isClassifierChecking(ID), queue.only().classifierAutoApproved]).toEqual([[], false, undefined])
    })

    test('a model failure after an abort is swallowed and clears the indicator', async () => {
      const abort = new AbortController()
      reply = async () => {
        abort.abort()
        throw new Error('stream torn down')
      }
      const { queue, decisions } = dialog({ abort })
      await route.until(() => queue.only().classifierCheckInProgress === false)
      expect(decisions).toEqual([])
    })

    test('the checkmark stays three seconds in a focused terminal, until dismissed', async () => {
      reply = says(1, 'high')
      const { queue, decisions } = dialog()
      await route.until(() => decisions.length === 1)
      await Bun.sleep(1_300)
      expect(queue.items()).toHaveLength(1)
      queue.only().onDismissCheckmark?.()
      expect(queue.items()).toEqual([])
    })

    test('the checkmark stays one second in a terminal without focus', async () => {
      setTerminalFocused(false)
      reply = says(1, 'high')
      const { queue, decisions } = dialog()
      await route.until(() => decisions.length === 1)
      await Bun.sleep(500)
      expect(queue.items()).toHaveLength(1)
      await Bun.sleep(800)
      expect(queue.items()).toEqual([])
    })

    test('an abort during the checkmark takes the dialog down, and a late dismiss is harmless', async () => {
      const abort = new AbortController()
      reply = says(1, 'high')
      const { queue, decisions } = dialog({ abort })
      await route.until(() => decisions.length === 1)
      const entry = queue.only()
      abort.abort()
      expect(queue.items()).toEqual([])
      entry.onDismissCheckmark?.()
      expect(decisions).toHaveLength(1)
    })

    test('a keypress in the first 200 ms does not stop the classifier', async () => {
      const answer = held()
      const { queue, decisions } = dialog()
      queue.only().onUserInteraction()
      answer.release(says(1, 'high'))
      await route.until(() => decisions.length === 1)
      expect(decisions[0]?.behavior).toBe('allow')
    })

    test('a later keypress hands the dialog to the user: the classifier can no longer allow', async () => {
      const answer = held()
      const { queue, decisions } = dialog()
      await Bun.sleep(230)
      queue.only().onUserInteraction()
      expect([queue.only().classifierCheckInProgress, approvals.isClassifierChecking(ID)]).toEqual([false, false])
      answer.release(says(1, 'high'))
      await Bun.sleep(50)
      expect(decisions).toEqual([])
    })

    const userFirst: Array<[string, (entry: ReturnType<ReturnType<typeof dialog>['queue']['only']>) => unknown, string, unknown]> = [
      ['a reject', e => e.onReject('no thanks'), 'ask', { behavior: 'deny', message: 'no thanks' }],
      ['an abort', e => e.onAbort(), 'ask', { behavior: 'deny', message: 'User aborted' }],
      ['an allow', e => e.onAllow({ command: 'npm test -- -u' }, []), 'allow', { behavior: 'allow', updatedInput: { command: 'npm test -- -u' }, updatedPermissions: [] }],
    ]
    test.each(userFirst)('%s from the user before the classifier wins, and is reported to the remote end', async (_name, act, behavior, told) => {
      const answer = held()
      const remote = remoteEnd()
      const { queue, decisions } = dialog({ bridge: remote.callbacks })
      act(queue.only())
      answer.release(says(1, 'high'))
      await Bun.sleep(50)
      const id = remote.calls[0]?.[1]
      expect([decisions.map(d => d.behavior), remote.calls.slice(2)] as unknown[]).toEqual([
        [behavior],
        [
          ['sendResponse', id, told],
          ['cancelRequest', id],
        ],
      ])
    })

    test('a rule that allows on re-check wins over a classifier still running', async () => {
      const answer = held()
      const tool = bash({ behavior: 'allow' })
      const { queue, decisions } = dialog({ tool })
      await queue.only().recheckPermission()
      answer.release(says(1, 'high'))
      await Bun.sleep(50)
      expect([decisions, queue.items()]).toEqual([[{ behavior: 'allow', updatedInput: INPUT, userModified: false }], []])
    })

    test('a PermissionRequest hook can answer while the classifier runs', async () => {
      held()
      const remote = remoteEnd()
      const session = route.openSession({ hooks: [world().script(route.hookSays({ behavior: 'deny', message: 'hook first' }))] })
      const queue = route.dialogQueue()
      const ctx = createPermissionContext(bash(), INPUT, session, route.TURN, ID, () => {}, createPermissionQueueOps(queue.set))
      const decisions: PermissionDecision[] = []
      handleInteractivePermission(
        { ctx, description: 'tests', result: { behavior: 'ask', message: 'm', pendingClassifierCheck: pending() } as never, awaitAutomatedChecksBeforeDialog: false, bridgeCallbacks: remote.callbacks },
        d => decisions.push(d),
      )
      await route.until(() => decisions.length === 1)
      expect([decisions[0]?.behavior, queue.items(), remote.calls.slice(2).map(c => c[0])]).toEqual(['deny', [], ['cancelRequest']])
    })

    test('a remote allow wins over a classifier still running', async () => {
      const answer = held()
      let respond: ((r: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }) => void) | undefined
      const callbacks: BridgePermissionCallbacks = {
        sendRequest() {},
        sendResponse() {},
        cancelRequest() {},
        onResponse(_id, next) {
          respond = next
          return () => {}
        },
      }
      const { queue, decisions } = dialog({ bridge: callbacks })
      respond?.({ behavior: 'allow' })
      answer.release(says(1, 'high'))
      await Bun.sleep(50)
      expect([decisions, queue.items(), approvals.getClassifierApproval(ID)]).toEqual([
        [{ behavior: 'allow', updatedInput: INPUT, userModified: false }],
        [],
        undefined,
      ])
    })

    test('a classifier allow withdraws the remote prompt', async () => {
      const remote = remoteEnd()
      reply = says(1, 'high')
      const { decisions } = dialog({ bridge: remote.callbacks })
      await route.until(() => decisions.length === 1)
      const id = remote.calls[0]?.[1]
      expect(remote.calls.slice(2)).toEqual([['cancelRequest', id]])
    })

    test('a remote answer clears the classifier indicator', async () => {
      held()
      let answer: ((r: { behavior: 'allow' | 'deny'; message?: string }) => void) | undefined
      const callbacks: BridgePermissionCallbacks = {
        sendRequest() {},
        sendResponse() {},
        cancelRequest() {},
        onResponse(_id, next) {
          answer = next
          return () => {}
        },
      }
      const { decisions } = dialog({ bridge: callbacks })
      answer?.({ behavior: 'deny', message: 'remote no' })
      expect([decisions.length, approvals.isClassifierChecking(ID)]).toEqual([1, false])
    })
  })

  // =========================================================================
  describe('the gate with the classifiers built', () => {
    test("an auto-mode allow is remembered with the classifier's reason", async () => {
      const run = await gate(bash(), {}, { behavior: 'allow', updatedInput: INPUT, decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: 'routine test run' } })
      await run.decision
      expect(approvals.getYoloClassifierApproval(ID)).toBe('routine test run')
    })

    test('an allow for any other reason is not', async () => {
      const run = await gate(bash(), {}, { behavior: 'allow', updatedInput: INPUT, decisionReason: { type: 'other', reason: 'x' } })
      await run.decision
      expect(approvals.getYoloClassifierApproval(ID)).toBeUndefined()
    })

    test('an auto-mode deny is listed in the recent denials and announced', async () => {
      const deny: PermissionDecision = {
        behavior: 'deny',
        message: 'blocked',
        decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: 'wipes the cache' },
      }
      const before = Date.now()
      const run = await gate(bash(), { notify: true }, deny)
      expect(await run.decision).toEqual(deny)
      const [latest] = getAutoModeDenials()
      expect(latest).toMatchObject({ toolName: 'Bash', display: 'Bash', reason: 'wipes the cache' })
      expect(latest?.timestamp).toBeGreaterThanOrEqual(before)
      const [notice] = run.session.notices
      expect([notice?.key, notice?.priority]).toEqual(['auto-mode-denied', 'immediate'])
      const text = await renderToString(React.createElement(React.Fragment, null, notice?.jsx as never), 80)
      expect(text).toContain('bash denied by auto mode')
      expect(text).toContain('/permissions')
    })

    test('an auto-mode deny with no reason is listed with an empty one, even with no notification sink', async () => {
      const run = await gate(bash(), {}, { behavior: 'deny', message: 'blocked', decisionReason: { type: 'classifier', classifier: 'auto-mode' } as never })
      await run.decision
      expect(getAutoModeDenials()[0]?.reason).toBe('')
    })

    test('a deny for any other reason is neither listed nor announced', async () => {
      const count = getAutoModeDenials().length
      const run = await gate(bash(), { notify: true }, { behavior: 'deny', message: 'no', decisionReason: { type: 'other', reason: 'x' } })
      await run.decision
      expect([getAutoModeDenials().length, run.session.notices]).toEqual([count, []])
    })

    test('a running check that matches allows the call before any dialog opens', async () => {
      reply = says(1, 'high')
      speculate()
      const run = await gate(bash())
      expect(await run.decision).toEqual({ behavior: 'allow', updatedInput: INPUT, userModified: false, decisionReason: ALLOWED })
      expect([run.queue.items(), approvals.getClassifierApproval(ID), peekSpeculativeClassifierCheck('npm test'), run.session.toolDecisions?.get(ID)?.source]).toEqual([
        [],
        RULE,
        undefined,
        'classifier',
      ])
    })

    test('a running check that does not match opens the dialog, which asks the model no more', async () => {
      reply = says(1, 'medium')
      speculate()
      const run = await gate(bash())
      await route.until(() => run.queue.items().length === 1)
      await settle()
      expect([asked.length, run.settled()]).toEqual([1, 'pending'])
    })

    test('a running check slower than two seconds is not waited for: the dialog opens, and it can still allow', async () => {
      const answer = held()
      speculate()
      const run = await gate(bash())
      await Bun.sleep(1_500)
      expect(run.queue.items()).toEqual([])
      await route.until(() => run.queue.items().length === 1, 2_000)
      answer.release(says(1, 'high'))
      expect((await run.decision).decisionReason).toEqual(ALLOWED)
      expect(run.queue.only().classifierAutoApproved).toBe(true)
    }, 10_000)

    test('with no running check the dialog opens at once and starts its own', async () => {
      reply = says(null, 'high')
      const run = await gate(bash())
      await route.until(() => run.queue.items().length === 1, 500)
      await route.until(() => asked.length === 1)
    })

    test('a coordinator classifies before its dialog, and its dialog does not classify again', async () => {
      reply = says(null, 'high')
      const run = await gate(bash(), { permissions: { awaitAutomatedChecksBeforeDialog: true } })
      await route.until(() => run.queue.items().length === 1)
      await settle()
      expect([asked.length, run.queue.only().classifierCheckInProgress]).toEqual([1, false])
    })

    test('a coordinator whose classifier matches is allowed without a dialog', async () => {
      reply = says(1, 'high')
      speculate()
      const run = await gate(bash(), { permissions: { awaitAutomatedChecksBeforeDialog: true } })
      expect((await run.decision).decisionReason).toEqual(ALLOWED)
      expect(run.queue.items()).toEqual([])
    })

    test('a swarm worker whose classifier matches never troubles the leader', async () => {
      reply = says(1, 'high')
      const joined = route.joinCrew(world().configDir)
      crew = joined
      const run = await gate(bash())
      expect((await run.decision).decisionReason).toEqual(ALLOWED)
      expect(joined.leaderInbox()).toEqual([])
    })

    test('the checking mark set when the dialog opens is cleared once the gate has handed over', async () => {
      held()
      const run = await gate(bash())
      await route.until(() => run.queue.items().length === 1)
      await settle()
      expect([run.queue.only().classifierCheckInProgress, approvals.isClassifierChecking(ID)]).toEqual([true, false])
    })

    test('the remote end connected to the session is sent the request', async () => {
      const remote = remoteEnd()
      const run = await gate(standIn({ name: 'Scribe', verdict: { behavior: 'ask', message: 'm' } }) as unknown as Tool, {
        state: { replBridgePermissionCallbacks: remote.callbacks },
      })
      await route.until(() => run.queue.items().length === 1)
      expect(remote.calls.map(c => c[0])).toEqual(['sendRequest', 'onResponse'])
    })

    test('a turn aborted on its way out is still cancelled', async () => {
      const abort = new AbortController()
      const tool = standIn({
        name: 'Bash',
        verdict: () => {
          abort.abort()
          return { behavior: 'ask', message: 'm' }
        },
      }) as unknown as Tool
      const run = await gate(tool, { abort })
      expect(await run.decision).toEqual({ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined })
    })
  })
}
