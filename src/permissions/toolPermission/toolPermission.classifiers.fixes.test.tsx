/**
 * Finding 8 of the toolPermission spec, fixed: the dialog shows the
 * classifier indicator only when a classification will run. The indicator
 * exists only with BASH_CLASSIFIER, so under the plain runner this file
 * starts itself again in a child `bun test` with the flag.
 */
// The decision module must load before the classifier modules: with the
// flags on, loading the classifier first trips an import cycle.
import 'src/permissions/permissions.js'
import { feature } from 'bun:bundle'
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'

const FLAGS_ON = feature('BASH_CLASSIFIER') ? true : false

if (!FLAGS_ON) {
  test('with the classifier build flags on, the indicator fix holds', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--feature=BASH_CLASSIFIER', '--feature=TRANSCRIPT_CLASSIFIER', import.meta.path],
      { cwd: resolve(import.meta.dir, '..', '..', '..'), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    )
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const report = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '-1')
    if (code !== 0 || failed !== 0 || passed < 7) {
      throw new Error(`the flag-on run failed (exit ${code}, ${passed} passed):\n${report.slice(-8_000)}`)
    }
  }, 120_000)
} else {
  // The model boundary: unanswered unless a case sets `answer`.
  const realSideQuery = { ...(await import('src/agent/sideQuery.js')) }
  let asked = 0
  let answer: (() => Promise<unknown>) | null = null
  mock.module('src/agent/sideQuery.js', () => ({
    ...realSideQuery,
    sideQuery: () => {
      asked++
      return answer ? answer() : new Promise(() => {})
    },
  }))
  afterAll(() => {
    mock.module('src/agent/sideQuery.js', () => realSideQuery)
  })

  const approvals = await import('src/permissions/classifierApprovals.js')
  const { standIn } = await import('src/permissions/__testutils__/decisionWorld.js')
  const { handleInteractivePermission } = await import('src/permissions/toolPermission/handlers/interactiveHandler.js')
  const { createPermissionContext, createPermissionQueueOps } = await import('src/permissions/toolPermission/PermissionContext.js')
  const route = await import('src/permissions/toolPermission/__testutils__/routeWorld.js')
  type Tool = import('src/tools/Tool.js').Tool

  const ID = 'toolu_indicator'
  const check = { command: 'npm test', cwd: '/', descriptions: ['run the test suite'] }

  function open(toolName: string, opts: { check?: typeof check; awaitChecks?: boolean }) {
    const queue = route.dialogQueue()
    const ctx = createPermissionContext(
      standIn({ name: toolName }) as unknown as Tool,
      { command: 'npm test' },
      route.openSession(),
      route.TURN,
      ID,
      () => {},
      createPermissionQueueOps(queue.set),
    )
    handleInteractivePermission(
      {
        ctx,
        description: 'd',
        result: { behavior: 'ask', message: 'm', ...(opts.check ? { pendingClassifierCheck: opts.check } : {}) },
        awaitAutomatedChecksBeforeDialog: opts.awaitChecks,
      },
      () => {},
    )
    return queue
  }

  describe('finding 8: the indicator means a classification is running', () => {
    const cases: Array<[string, string, { check?: typeof check; awaitChecks?: boolean }, boolean]> = [
      ['a Bash call with a pending check', 'Bash', { check }, true],
      ['another tool with a pending check', 'Scribe', { check }, false],
      ['a Bash call with no pending check', 'Bash', {}, false],
      ['a Bash call whose checks were already awaited', 'Bash', { check, awaitChecks: true }, false],
    ]
    test.each(cases)('%s', async (_name, toolName, opts, shown) => {
      approvals.clearClassifierApprovals()
      asked = 0
      const queue = open(toolName, opts)
      await Bun.sleep(10)
      expect([queue.only().classifierCheckInProgress, approvals.isClassifierChecking(ID), asked > 0]).toEqual([shown, shown, shown])
    })
  })

  // Not a finding: guards the characterization suite does not reach.
  describe('the classifier step', () => {
    test('a model failure on a turn already aborted is no decision', async () => {
      const { getMainLoopModelOverride, setMainLoopModelOverride } = await import('src/platform/bootstrap/state.js')
      const savedModel = getMainLoopModelOverride()
      setMainLoopModelOverride('claude-sonnet-4-5')
      const abort = new AbortController()
      answer = async () => {
        abort.abort()
        throw new Error('stream torn down')
      }
      try {
        const ctx = createPermissionContext(standIn({ name: 'Bash' }) as unknown as Tool, { command: 'npm test' }, route.openSession({ abort }), route.TURN, ID, () => {})
        expect(await ctx.tryClassifier?.(check, undefined)).toBeNull()
      } finally {
        answer = null
        setMainLoopModelOverride(savedModel as never)
      }
    })
  })

  describe('the gate', () => {
    test('a deny from a classifier other than auto mode is neither listed nor announced', async () => {
      const { getAutoModeDenials } = await import('src/permissions/autoModeDenials.js')
      const before = getAutoModeDenials().length
      const queue = route.dialogQueue()
      const router = await route.mountRouter(queue.set, route.contextSink().set)
      try {
        const tool = standIn({ name: 'Bash' }) as unknown as Tool
        const session = route.openSession({ tools: [tool], notify: true })
        await router.canUseTool()(tool, { command: 'rm -rf /' }, session, route.TURN, ID, {
          behavior: 'deny',
          message: 'no',
          decisionReason: { type: 'classifier', classifier: 'bash_deny', reason: 'dangerous' },
        })
        expect([getAutoModeDenials().length, session.notices]).toEqual([before, []])
      } finally {
        router.close()
      }
    })

    test('a classification running for the same command never allows a tool other than Bash', async () => {
      const { startSpeculativeClassifierCheck, clearSpeculativeChecks } = await import('src/tools/BashTool/bashPermissions.js')
      const { permissionContext } = await import('src/permissions/__testutils__/decisionWorld.js')
      const { getMainLoopModelOverride, setMainLoopModelOverride } = await import('src/platform/bootstrap/state.js')
      const savedModel = getMainLoopModelOverride()
      setMainLoopModelOverride('claude-sonnet-4-5')
      clearSpeculativeChecks()
      answer = async () => ({
        id: 'msg_cls',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'toolu_match', name: 'classify_match', input: { matchedIndex: 0, confidence: 'high', reason: 'r' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      })
      const rules = permissionContext({ alwaysAllowRules: { session: ['Bash(prompt: run the test suite)'] } })
      expect(startSpeculativeClassifierCheck('npm test', rules, new AbortController().signal, false)).toBe(true)
      const queue = route.dialogQueue()
      const router = await route.mountRouter(queue.set, route.contextSink().set)
      try {
        const tool = standIn({ name: 'Scribe', verdict: { behavior: 'ask', message: 'm', pendingClassifierCheck: check } as never }) as unknown as Tool
        let settled = 'pending'
        void router.canUseTool()(tool, { command: 'npm test' }, route.openSession({ tools: [tool] }), route.TURN, ID).then(d => {
          settled = d.behavior
        })
        await route.until(() => queue.items().length === 1)
        expect(settled).toBe('pending')
      } finally {
        router.close()
        clearSpeculativeChecks()
        answer = null
        setMainLoopModelOverride(savedModel as never)
      }
    })
  })
}
