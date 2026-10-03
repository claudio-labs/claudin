/**
 * Auto mode in the permission decision: what reaches the auto-mode
 * classifier, what is let through without it, and what each of its answers
 * turns into.
 *
 * Auto mode only exists in a build with TRANSCRIPT_CLASSIFIER (and its Bash
 * companion BASH_CLASSIFIER), which the shipped build turns on and plain
 * `bun test` leaves off. So under the plain runner this file only starts
 * itself again in a child `bun test` with both flags, and fails if the child
 * does. The checks below run in that child.
 *
 * The one thing replaced is the model call (`sideQuery`). The classifier's
 * own prompt building and response parsing run as shipped; the stub answers
 * the way the API would.
 */
// The decision module must load before the classifier modules: with the
// flag on, loading the classifier first trips an import cycle (see the spec).
import {
  createPermissionRequestMessage,
  hasPermissionsToUseTool,
} from 'src/permissions/permissions.js'
import { feature } from 'bun:bundle'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'

import {
  ASSISTANT_TURN,
  makeCtx,
  messageOf,
  standIn,
  useDecisionWorld,
  type ContextSpec,
  type StandIn,
} from 'src/permissions/__testutils__/decisionWorld.js'

const CLASSIFIER_BUILD = feature('TRANSCRIPT_CLASSIFIER') ? true : false

if (!CLASSIFIER_BUILD) {
  test('with the auto-mode build flags on, the auto-mode checks hold', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', '--feature=BASH_CLASSIFIER', import.meta.path],
      { cwd: resolve(import.meta.dir, '..', '..'), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const report = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '-1')
    if (code !== 0 || failed !== 0 || passed < 50) {
      throw new Error(`the auto-mode run failed (exit ${code}, ${passed} passed):\n${report.slice(-8_000)}`)
    }
  }, 180_000)
} else {
  useDecisionWorld()

  // ---- the model boundary -------------------------------------------------
  const realSideQueryModule = { ...(await import('src/agent/sideQuery.js')) }
  type SideQuery = typeof realSideQueryModule.sideQuery
  type Request = Parameters<SideQuery>[0]
  let answer: ((request: Request) => Promise<unknown>) | null = null
  const requests: Request[] = []
  mock.module('src/agent/sideQuery.js', () => ({
    ...realSideQueryModule,
    sideQuery: (request: Request) => {
      if (answer === null) return realSideQueryModule.sideQuery(request)
      requests.push(request)
      return answer(request)
    },
  }))
  afterAll(() => {
    mock.module('src/agent/sideQuery.js', () => realSideQueryModule)
  })

  const { APIError } = await import('@anthropic-ai/sdk')
  const { buildClassifierUnavailableMessage, buildYoloRejectionMessage, DONT_ASK_REJECT_MESSAGE } = await import(
    'src/agent/messages/messages.js'
  )
  const { isClassifierChecking, clearClassifierApprovals } = await import('src/permissions/classifierApprovals.js')
  const autoModeState = await import('src/permissions/autoModeState.js')
  const state = await import('src/platform/bootstrap/state.js')
  const { AbortError } = await import('src/shared/errors.js')

  const MODEL = 'claude-sonnet-4-5'
  let savedModel: unknown

  beforeAll(() => {
    savedModel = state.getMainLoopModelOverride()
  })
  afterAll(() => {
    state.setMainLoopModelOverride(savedModel as never)
  })
  beforeEach(() => {
    state.setMainLoopModelOverride(MODEL)
    autoModeState._resetForTesting()
    clearClassifierApprovals()
    state.resetTurnClassifierDuration()
    requests.length = 0
    answer = null
  })
  afterEach(() => {
    autoModeState._resetForTesting()
    answer = null
  })

  // ---- what the model can answer -----------------------------------------
  const verdict = (shouldBlock: boolean, reason: string) => async () => ({
    id: 'msg_classifier',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'tool_use', id: 'toolu_verdict', name: 'classify_result', input: { thinking: 'considered', shouldBlock, reason } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  const failure = (error: unknown) => async () => {
    throw error
  }
  const apiStatus = (status: number) =>
    APIError.generate(status, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, `${status} bad`, new Headers())
  const hang = () => (request: Request) =>
    new Promise<never>((_, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted by budget')), { once: true })
    })

  // ---- driving the decision -----------------------------------------------
  const AUTO = { mode: 'auto' as const }
  const HEADLESS_AUTO = { mode: 'auto' as const, shouldAvoidPermissionPrompts: true }
  const askVerdict = { behavior: 'ask' as const, message: 'the tool wants a yes' }

  /** A tool whose own check asks, so the call is one auto mode has to settle. */
  const asking = (name: string, extra: Partial<Parameters<typeof standIn>[0]> = {}) =>
    standIn({ name, verdict: askVerdict, classifierText: input => `${name} ${String(input.command ?? input.file_path ?? '')}`, ...extra })

  const run = async (tool: StandIn, input: Record<string, unknown>, spec: ContextSpec = {}, id = 'toolu_auto') => {
    const ctx = makeCtx({ tools: [tool], ...spec })
    const decision = await hasPermissionsToUseTool(tool, input, ctx, ASSISTANT_TURN, id)
    return { decision, ctx }
  }
  const sentText = () => JSON.stringify(requests.map(r => r.messages))

  // =========================================================================
  describe('the classifier decides what auto mode would otherwise ask', () => {
    test('an allow lets the call run with its input, and names the classifier', async () => {
      answer = verdict(false, 'routine build step')
      const { decision } = await run(asking('Bash'), { command: 'npm run build' }, { permissions: AUTO })
      expect(decision).toEqual({
        behavior: 'allow',
        updatedInput: { command: 'npm run build' },
        decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: 'routine build step' },
      })
      expect(requests).toHaveLength(1)
      expect(sentText()).toContain('npm run build')
    })

    test('a block refuses the call and tells the model why', async () => {
      answer = verdict(true, 'deletes the home directory')
      const { decision, ctx } = await run(asking('Bash'), { command: 'rm -rf ~' }, { permissions: AUTO })
      expect(decision).toEqual({
        behavior: 'deny',
        decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: 'deletes the home directory' },
        message: buildYoloRejectionMessage('deletes the home directory'),
      })
      expect(ctx.state().denialTracking).toEqual({ consecutiveDenials: 1, totalDenials: 1 })
    })

    test('the call is marked as being checked while the classifier runs, and unmarked after', async () => {
      const seen: boolean[] = []
      const allow = verdict(false, 'ok')
      answer = async request => {
        seen.push(isClassifierChecking('toolu_watch'))
        return allow()
      }
      await run(asking('Bash'), { command: 'ls' }, { permissions: AUTO }, 'toolu_watch')
      expect([seen, isClassifierChecking('toolu_watch')]).toEqual([[true], false])
    })

    test('the mark is cleared when the classifier fails too', async () => {
      answer = failure(new Error('socket hang up'))
      await run(asking('Bash'), { command: 'ls' }, { permissions: AUTO }, 'toolu_fail')
      expect(isClassifierChecking('toolu_fail')).toBe(false)
    })

    test("each verdict adds to the turn's classifier tally, and an outage does not", async () => {
      const tally: number[] = []
      for (const next of [verdict(false, 'ok'), failure(new Error('down')), verdict(true, 'no')]) {
        answer = next
        await run(asking('Bash'), { command: 'ls' }, { permissions: AUTO })
        tally.push(state.getTurnClassifierCount())
      }
      expect(tally).toEqual([1, 1, 2])
    })

    test('a call that declares nothing worth classifying is let through without a model call', async () => {
      answer = verdict(true, 'never asked')
      const { decision } = await run(asking('Bash', { classifierText: () => '' }), { command: 'true' }, { permissions: AUTO })
      expect([decision.behavior, decision.decisionReason?.type, requests.length]).toEqual(['allow', 'classifier', 0])
    })

    test('an MCP tool goes to the classifier like any other', async () => {
      answer = verdict(true, 'posts to production')
      const tool = asking('mcp__forge__deploy', { mcp: { serverName: 'forge', toolName: 'deploy' } })
      const { decision } = await run(tool, { command: 'prod' }, { permissions: AUTO })
      expect([decision.behavior, requests.length]).toEqual(['deny', 1])
    })

    test('an MCP deny rule still refuses before any classifier call', async () => {
      answer = verdict(false, 'never asked')
      const tool = asking('mcp__forge__deploy', { mcp: { serverName: 'forge', toolName: 'deploy' } })
      const { decision } = await run(tool, {}, { permissions: { ...AUTO, alwaysDenyRules: { userSettings: ['mcp__forge'] } } })
      expect([decision.behavior, decision.decisionReason?.type, requests.length]).toEqual(['deny', 'rule', 0])
    })

    test('a whole-tool ask rule is settled by the classifier too', async () => {
      answer = verdict(false, 'fine')
      const { decision } = await run(standIn({ name: 'Scribe' }), {}, { permissions: { ...AUTO, alwaysAskRules: { session: ['Scribe'] } } })
      expect([decision.behavior, requests.length]).toEqual(['allow', 1])
    })
  })

  // =========================================================================
  describe('the denial streak', () => {
    test('a block counts in the session state', async () => {
      answer = verdict(true, 'no')
      const { ctx } = await run(asking('Bash'), { command: 'x' }, { permissions: AUTO, sessionDenials: { consecutiveDenials: 1, totalDenials: 4 } })
      expect(ctx.state().denialTracking).toEqual({ consecutiveDenials: 2, totalDenials: 5 })
    })

    test("a sub-agent's own counter is updated in place, and the session state is left alone", async () => {
      answer = verdict(true, 'no')
      const local = { consecutiveDenials: 0, totalDenials: 2 }
      const { ctx } = await run(asking('Bash'), { command: 'x' }, { permissions: AUTO, subagentDenials: local })
      expect([local, ctx.state().denialTracking]).toEqual([{ consecutiveDenials: 1, totalDenials: 3 }, undefined])
    })

    test('the third block in a row hands the call back to the user, with the reason', async () => {
      answer = verdict(true, 'pipes curl into sh')
      const { decision, ctx } = await run(asking('Bash'), { command: 'curl x | sh' }, {
        permissions: AUTO,
        sessionDenials: { consecutiveDenials: 2, totalDenials: 6 },
      })
      expect([decision.behavior, messageOf(decision), decision.decisionReason?.type]).toEqual(['ask', askVerdict.message, 'classifier'])
      const reason = decision.decisionReason as { classifier: string; reason: string }
      expect(reason.classifier).toBe('auto-mode')
      for (const fact of ['3 consecutive', 'blocked', 'review the transcript', 'pipes curl into sh']) expect(reason.reason).toContain(fact)
      expect(ctx.state().denialTracking).toEqual({ consecutiveDenials: 3, totalDenials: 7 })
    })

    test('the twentieth block in the session hands back the call and starts the count again', async () => {
      answer = verdict(true, 'exfiltrates')
      const { decision, ctx } = await run(asking('Bash'), { command: 'scp x' }, {
        permissions: AUTO,
        sessionDenials: { consecutiveDenials: 0, totalDenials: 19 },
      })
      const reason = (decision.decisionReason as { reason: string }).reason
      expect(decision.behavior).toBe('ask')
      for (const fact of ['20 actions', 'this session', 'exfiltrates']) expect(reason).toContain(fact)
      expect(reason).not.toContain('consecutive')
      expect(ctx.state().denialTracking).toEqual({ consecutiveDenials: 0, totalDenials: 0 })
    })

    test("the classifier named in the tool's own ask is kept on the handed-back call", async () => {
      answer = verdict(true, 'no')
      const tool = asking('Bash', {
        verdict: { behavior: 'ask', message: 'm', decisionReason: { type: 'classifier', classifier: 'bash-prompt-rule', reason: 'r' } },
      })
      const { decision } = await run(tool, { command: 'x' }, { permissions: AUTO, sessionDenials: { consecutiveDenials: 2, totalDenials: 2 } })
      expect((decision.decisionReason as { classifier: string }).classifier).toBe('bash-prompt-rule')
    })

    test('a session that cannot prompt is aborted at the limit instead', async () => {
      answer = verdict(true, 'no')
      let caught: unknown
      try {
        await run(asking('Bash'), { command: 'x' }, { permissions: HEADLESS_AUTO, sessionDenials: { consecutiveDenials: 2, totalDenials: 2 } })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AbortError)
      expect(String((caught as Error).message)).toMatch(/too many classifier denials/)
    })

    test('a classifier allow ends the streak and keeps the total', async () => {
      answer = verdict(false, 'ok')
      const { ctx } = await run(asking('Bash'), { command: 'ls' }, { permissions: AUTO, sessionDenials: { consecutiveDenials: 2, totalDenials: 9 } })
      expect(ctx.state().denialTracking).toEqual({ consecutiveDenials: 0, totalDenials: 9 })
    })

    test('an allow by rule ends the streak in auto mode only', async () => {
      const got = []
      for (const mode of ['auto', 'default', 'acceptEdits'] as const) {
        const { ctx } = await run(standIn({ name: 'Scribe' }), {}, {
          permissions: { mode, alwaysAllowRules: { session: ['Scribe'] } },
          sessionDenials: { consecutiveDenials: 2, totalDenials: 5 },
        })
        got.push([mode, ctx.state().denialTracking])
      }
      expect(got).toEqual([
        ['auto', { consecutiveDenials: 0, totalDenials: 5 }],
        ['default', { consecutiveDenials: 2, totalDenials: 5 }],
        ['acceptEdits', { consecutiveDenials: 2, totalDenials: 5 }],
      ])
    })

    test("an allow in auto mode ends a sub-agent's own streak in place", async () => {
      const local = { consecutiveDenials: 2, totalDenials: 5 }
      const { ctx } = await run(standIn({ name: 'Scribe' }), {}, {
        permissions: { ...AUTO, alwaysAllowRules: { session: ['Scribe'] } },
        subagentDenials: local,
        sessionDenials: { consecutiveDenials: 1, totalDenials: 1 },
      })
      expect([local, ctx.state().denialTracking]).toEqual([
        { consecutiveDenials: 0, totalDenials: 5 },
        { consecutiveDenials: 1, totalDenials: 1 },
      ])
    })
  })

  // =========================================================================
  describe('when the classifier cannot answer', () => {
    test('an outage refuses the call, says the classifier is unavailable, and counts no denial', async () => {
      answer = failure(new Error('socket hang up'))
      const { decision, ctx } = await run(asking('Bash'), { command: 'ls' }, { permissions: AUTO, sessionDenials: { consecutiveDenials: 1, totalDenials: 1 } })
      expect(decision).toEqual({
        behavior: 'deny',
        decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: 'Classifier unavailable' },
        message: buildClassifierUnavailableMessage('Bash', MODEL),
      })
      expect(ctx.state().denialTracking).toEqual({ consecutiveDenials: 1, totalDenials: 1 })
    })

    test('a transient API status is an outage too', async () => {
      answer = failure(apiStatus(429))
      const { decision } = await run(asking('Bash'), { command: 'ls' }, { permissions: AUTO })
      expect(decision.decisionReason).toEqual({ type: 'classifier', classifier: 'auto-mode', reason: 'Classifier unavailable' })
    })

    const permanent: Array<[string, () => unknown, string[]]> = [
      ['a request the API rejects for good', () => apiStatus(400), ['deterministic error']],
      ['a transcript too long for the classifier', () => new Error('prompt is too long: 250000 tokens > 200000 maximum'), ['context window']],
    ]

    test.each(permanent)('%s falls back to asking the user', async (_what, error, facts) => {
      answer = failure(error())
      const { decision, ctx } = await run(asking('Bash'), { command: 'ls' }, { permissions: AUTO })
      expect([decision.behavior, messageOf(decision), decision.decisionReason?.type]).toEqual(['ask', askVerdict.message, 'other'])
      const reason = (decision.decisionReason as { reason: string }).reason
      for (const fact of ['Auto mode classifier', 'manual approval', ...facts]) expect(reason).toContain(fact)
      expect(ctx.state().denialTracking).toBeUndefined()
    })

    test.each(permanent)('%s aborts a session that cannot prompt', async (_what, error, facts) => {
      answer = failure(error())
      let caught: unknown
      try {
        await run(asking('Bash'), { command: 'ls' }, { permissions: HEADLESS_AUTO })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AbortError)
      for (const fact of ['auto mode classifier', 'headless', ...facts]) expect(String((caught as Error).message)).toContain(fact)
    })

    test('a classifier that runs out of time falls back to asking the user', async () => {
      process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS = '40'
      answer = hang()
      const { decision } = await run(asking('Bash'), { command: 'sleep 1' }, { permissions: AUTO })
      expect([decision.behavior, decision.decisionReason?.type]).toEqual(['ask', 'other'])
      expect((decision.decisionReason as { reason: string }).reason).toContain('time budget')
    })

    test('a session that cannot prompt treats running out of time as an outage, and retries later', async () => {
      process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS = '40'
      answer = hang()
      const { decision } = await run(asking('Bash'), { command: 'sleep 1' }, { permissions: HEADLESS_AUTO })
      expect([decision.behavior, decision.decisionReason]).toEqual([
        'deny',
        { type: 'classifier', classifier: 'auto-mode', reason: 'Classifier unavailable' },
      ])
    })
  })

  // =========================================================================
  describe('what never reaches the classifier', () => {
    const SAFE = [
      'Read',
      'Grep',
      'Glob',
      'ToolSearch',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
      'TodoWrite',
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'TaskStop',
      'TaskOutput',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'TeamCreate',
      'TeamDelete',
      'SendMessage',
      'ListAgents',
      'Sleep',
      'classify_result',
    ]

    test('the safe tools are let through as auto mode, with no model call', async () => {
      answer = verdict(true, 'never asked')
      const got = []
      for (const name of SAFE) {
        const { decision } = await run(asking(name), { file_path: '/x' }, { permissions: AUTO })
        got.push([name, decision.behavior, decision.decisionReason])
      }
      expect(got).toEqual(SAFE.map(name => [name, 'allow', { type: 'mode', mode: 'auto' }]))
      expect(requests).toHaveLength(0)
    })

    test('a safe tool ends the denial streak', async () => {
      const { ctx } = await run(asking('Grep'), {}, { permissions: AUTO, sessionDenials: { consecutiveDenials: 2, totalDenials: 2 } })
      expect(ctx.state().denialTracking).toEqual({ consecutiveDenials: 0, totalDenials: 2 })
    })

    test('the tools that are not on the list go to the classifier', async () => {
      answer = verdict(false, 'ok')
      const others = ['Bash', 'Write', 'Edit', 'WebFetch', 'NotebookEdit', 'mcp__forge__deploy', 'read', 'Agent']
      for (const name of others) await run(asking(name), { command: 'x' }, { permissions: AUTO })
      expect(requests).toHaveLength(others.length)
    })

    test('Git skips the classifier only when the call reads', async () => {
      answer = verdict(false, 'ok')
      const git = (readOnly: boolean | (() => boolean)) => asking('Git', { readOnly: readOnly as never })
      const reads = await run(git(true), { command: 'status' }, { permissions: AUTO })
      const before = requests.length
      await run(git(false), { command: 'push' }, { permissions: AUTO })
      await run(git(() => { throw new Error('cannot tell') }), { command: '?' }, { permissions: AUTO })
      expect([reads.decision.decisionReason, before, requests.length]).toEqual([{ type: 'mode', mode: 'auto' }, 0, 2])
    })

    describe('a call acceptEdits mode would allow', () => {
      const editor = (allowed: Record<string, unknown> | null) =>
        standIn({
          name: 'Edit',
          verdict: (_input, mode) =>
            mode === 'acceptEdits'
              ? ({ behavior: 'allow', ...(allowed ? { updatedInput: allowed } : {}) } as never)
              : askVerdict,
        })

      test('is allowed as auto mode without a model call, with the input acceptEdits gave', async () => {
        answer = verdict(true, 'never asked')
        const tool = editor({ file_path: '/project/a.ts', normalized: true })
        const { decision } = await run(tool, { file_path: 'a.ts' }, { permissions: AUTO })
        expect(decision).toEqual({
          behavior: 'allow',
          updatedInput: { file_path: '/project/a.ts', normalized: true },
          decisionReason: { type: 'mode', mode: 'auto' },
        })
        expect([tool.seenModes, requests.length]).toEqual([['auto', 'acceptEdits'], 0])
      })

      test('keeps the original input when acceptEdits gives none, and ends the streak', async () => {
        const { decision, ctx } = await run(editor(null), { file_path: 'a.ts' }, {
          permissions: AUTO,
          sessionDenials: { consecutiveDenials: 1, totalDenials: 3 },
        })
        expect([decision.behavior, (decision as { updatedInput: unknown }).updatedInput, ctx.state().denialTracking]).toEqual([
          'allow',
          { file_path: 'a.ts' },
          { consecutiveDenials: 0, totalDenials: 3 },
        ])
      })

      test('is not asked of the Agent tool, which goes to the classifier', async () => {
        answer = verdict(false, 'ok')
        const agent = standIn({ name: 'Agent', verdict: (_i, mode) => (mode === 'acceptEdits' ? { behavior: 'allow' } as never : askVerdict) })
        const { decision } = await run(agent, { prompt: 'go' }, { permissions: AUTO })
        expect([agent.seenModes, requests.length, decision.decisionReason?.type]).toEqual([['auto'], 1, 'classifier'])
      })

      test('goes to the classifier when that second check fails', async () => {
        answer = verdict(false, 'ok')
        let first = true
        const flaky = standIn({
          name: 'Edit',
          verdict: () => {
            if (first) {
              first = false
              return askVerdict
            }
            throw new Error('second look failed')
          },
        })
        await run(flaky, { file_path: 'a.ts' }, { permissions: AUTO })
        expect(requests).toHaveLength(1)
      })

      test('aborts the decision when that second check is aborted', async () => {
        let first = true
        const aborting = standIn({
          name: 'Edit',
          verdict: () => {
            if (first) {
              first = false
              return askVerdict
            }
            throw new AbortError('escape')
          },
        })
        await expect(run(aborting, { file_path: 'a.ts' }, { permissions: AUTO })).rejects.toBeInstanceOf(AbortError)
      })
    })

    describe('a safety check', () => {
      const safety = (classifierApprovable: boolean) =>
        standIn({
          name: 'Write',
          verdict: { behavior: 'ask', message: 'writes .git/hooks', decisionReason: { type: 'safetyCheck', reason: 'git hooks', classifierApprovable } },
        })

      test('that only a person may approve is asked, untouched', async () => {
        answer = verdict(false, 'never asked')
        const tool = safety(false)
        const { decision } = await run(tool, { file_path: '.git/hooks/pre-commit' }, { permissions: AUTO })
        expect([decision.behavior, messageOf(decision), decision.decisionReason?.type, requests.length, tool.seenModes]).toEqual([
          'ask',
          'writes .git/hooks',
          'safetyCheck',
          0,
          ['auto'],
        ])
      })

      test('that only a person may approve is refused where no one can be asked', async () => {
        const { decision } = await run(safety(false), { file_path: '.git/hooks/pre-commit' }, { permissions: HEADLESS_AUTO })
        expect([decision.behavior, messageOf(decision), decision.decisionReason?.type]).toEqual(['deny', 'writes .git/hooks', 'asyncAgent'])
        expect((decision.decisionReason as { reason: string }).reason).toContain('interactive approval')
      })

      test('that the classifier may approve goes to it', async () => {
        answer = verdict(false, 'expected config edit')
        const { decision } = await run(safety(true), { file_path: '.claudin/settings.json' }, { permissions: AUTO })
        expect([decision.behavior, requests.length]).toEqual(['allow', 1])
      })
    })

    test('a tool that needs the user is asked', async () => {
      answer = verdict(false, 'never asked')
      const { decision } = await run(asking('AskUser', { needsUser: true }), {}, { permissions: AUTO })
      expect([decision, requests.length]).toEqual([askVerdict, 0])
    })

    test('PowerShell is asked, never classified nor checked as acceptEdits', async () => {
      answer = verdict(false, 'never asked')
      const ps = asking('PowerShell')
      const { decision } = await run(ps, { command: 'Remove-Item x' }, { permissions: AUTO })
      expect([decision, requests.length, ps.seenModes]).toEqual([askVerdict, 0, ['auto']])
    })

    test('PowerShell is refused where no one can be asked', async () => {
      const { decision } = await run(asking('PowerShell'), { command: 'Remove-Item x' }, { permissions: HEADLESS_AUTO })
      expect([decision.behavior, decision.decisionReason?.type]).toEqual(['deny', 'asyncAgent'])
      expect(messageOf(decision)).toContain('PowerShell')
      expect(messageOf(decision)).toContain('interactive approval')
    })

    test('dontAsk mode still refuses, and the classifier is not asked', async () => {
      answer = verdict(false, 'never asked')
      const { decision } = await run(asking('Bash'), { command: 'ls' }, { permissions: { mode: 'dontAsk' } })
      expect([messageOf(decision), requests.length]).toEqual([DONT_ASK_REJECT_MESSAGE('Bash'), 0])
    })

    test('the default mode asks as before, and a session with no prompt refuses as before', async () => {
      answer = verdict(false, 'never asked')
      const asked = await run(asking('Bash'), { command: 'ls' })
      const refused = await run(asking('Bash'), { command: 'ls' }, { permissions: { shouldAvoidPermissionPrompts: true } })
      expect([asked.decision.behavior, refused.decision.decisionReason?.type, requests.length]).toEqual(['ask', 'asyncAgent', 0])
    })
  })

  // =========================================================================
  describe('plan mode with auto mode active', () => {
    const plan = { mode: 'plan' as const }

    test('a Bash write goes to the classifier instead of the plan refusal, without the acceptEdits shortcut', async () => {
      autoModeState.setAutoModeActive(true)
      answer = verdict(true, 'writes outside the plan')
      const bash = asking('Bash', { verdict: (_i, mode) => (mode === 'acceptEdits' ? { behavior: 'allow' } as never : askVerdict) })
      const { decision } = await run(bash, { command: 'rm -rf build' }, { permissions: plan })
      expect([decision.behavior, decision.decisionReason, bash.seenModes, requests.length]).toEqual([
        'deny',
        { type: 'classifier', classifier: 'auto-mode', reason: 'writes outside the plan' },
        ['plan'],
        1,
      ])
    })

    test('a Bash write the classifier allows runs', async () => {
      autoModeState.setAutoModeActive(true)
      answer = verdict(false, 'scratch script')
      const { decision } = await run(asking('Bash'), { command: 'bun scratch.ts' }, { permissions: plan })
      expect(decision.behavior).toBe('allow')
    })

    test('any other write is still refused by plan mode', async () => {
      autoModeState.setAutoModeActive(true)
      answer = verdict(false, 'never asked')
      const { decision } = await run(asking('Write'), { file_path: '/x' }, { permissions: plan })
      expect([decision.decisionReason, requests.length]).toEqual([{ type: 'mode', mode: 'plan' }, 0])
    })

    test('with auto mode inactive, Bash is refused by plan mode', async () => {
      answer = verdict(false, 'never asked')
      const { decision } = await run(asking('Bash'), { command: 'rm x' }, { permissions: plan })
      expect([decision.decisionReason, requests.length]).toEqual([{ type: 'mode', mode: 'plan' }, 0])
    })

    test('a read-only Bash call in plan mode with auto active goes to the classifier as well', async () => {
      autoModeState.setAutoModeActive(true)
      answer = verdict(false, 'ok')
      const { decision } = await run(asking('Bash', { readOnly: true }), { command: 'ls' }, { permissions: plan })
      expect([decision.behavior, requests.length]).toEqual(['allow', 1])
    })
  })

  // =========================================================================
  describe('wording with the classifier build', () => {
    test('a classifier reason names the classifier, the tool and the reason', () => {
      const message = createPermissionRequestMessage('Bash', { type: 'classifier', classifier: 'auto-mode', reason: 'touches prod' })
      for (const fact of ["Classifier 'auto-mode'", 'requires approval for this Bash command', ': touches prod']) {
        expect(message).toContain(fact)
      }
    })

    test('auto mode is named by its own title', () => {
      expect(createPermissionRequestMessage('Bash', { type: 'mode', mode: 'auto' })).toContain('(Auto mode)')
    })
  })
}
