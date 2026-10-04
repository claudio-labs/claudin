/**
 * Pins the interactive (main-agent) permission flow.
 *
 * The handler is driven the way useCanUseTool drives it: a real permission
 * context from createPermissionContext, backed by a queue held in a plain
 * array the way React state would hold it. The stand-ins are `runHooks`, the
 * seam that would spawn the user's PermissionRequest hook commands (real
 * hooks are driven in PermissionContext.characterization.test.ts and through
 * useCanUseTool), and the bridge callbacks, the network boundary to the web
 * app that answers the same request remotely.
 *
 * Not pinned here: the async Bash classifier, which sits behind a build flag
 * that is off under `bun test`; see
 * src/permissions/toolPermission/toolPermission.classifiers.characterization.test.tsx.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { z } from 'zod/v4'

import { handleInteractivePermission } from 'src/permissions/toolPermission/handlers/interactiveHandler.js'
import {
  createPermissionContext,
  createPermissionQueueOps,
} from 'src/permissions/toolPermission/PermissionContext.js'
import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from 'src/agent/messages/constants.js'
import type { PermissionDecision, PermissionResult } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { BridgePermissionCallbacks, BridgePermissionResponse } from 'src/platform/bridge/bridgePermissionCallbacks.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'

type AskResult = PermissionDecision & { behavior: 'ask' }

type Setup = {
  result?: Partial<AskResult>
  awaitAutomatedChecksBeforeDialog?: boolean
  mode?: ToolPermissionContext['mode']
  hook?: () => Promise<PermissionDecision | null>
  /** Inputs the tool calls equivalent; undefined leaves inputsEquivalent off. */
  equivalent?: (a: unknown, b: unknown) => boolean
  /** Connects a remote end that can answer the same request. */
  bridge?: boolean
}

/** The web app's side of the bridge: what it was sent, and a way to answer. */
type Remote = {
  callbacks: BridgePermissionCallbacks
  calls: unknown[][]
  answer(response: BridgePermissionResponse): void
  unsubscribed(): number
}

function remoteEnd(): Remote {
  const calls: unknown[][] = []
  let handler: ((response: BridgePermissionResponse) => void) | undefined
  let unsubscribed = 0
  return {
    calls,
    callbacks: {
      sendRequest: (...args) => void calls.push(['sendRequest', ...args]),
      sendResponse: (...args) => void calls.push(['sendResponse', ...args]),
      cancelRequest: (...args) => void calls.push(['cancelRequest', ...args]),
      onResponse(requestId, next) {
        calls.push(['onResponse', requestId])
        handler = next
        return () => {
          unsubscribed++
        }
      },
    },
    answer: response => handler?.(response),
    unsubscribed: () => unsubscribed,
  }
}

const TOOL_USE_ID = 'toolu_char_interactive'
const ORIGINAL_INPUT = { target: 'original' }

/**
 * One handler call with everything a caller can observe afterwards: the
 * dialog queue, the decisions delivered, the decision record on the context,
 * the permission contexts pushed back to the app, and the hook calls.
 */
function open(setup: Setup = {}) {
  let queue: ToolUseConfirm[] = []
  const setQueue = (next: ToolUseConfirm[] | ((q: ToolUseConfirm[]) => ToolUseConfirm[])) => {
    queue = typeof next === 'function' ? next(queue) : next
  }
  const appliedContexts: { context: ToolPermissionContext; preserveMode?: boolean }[] = []
  let toolAnswer: PermissionResult = { behavior: 'ask', message: 'still asking' }
  let toolChecks = 0

  const toolPermissionContext: ToolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: setup.mode ?? 'default',
  }
  const toolUseContext = {
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false, tools: [] },
    getAppState: () => ({ toolPermissionContext }),
    setAppState() {},
  } as unknown as ToolUseContext

  const tool = {
    name: 'CharTool',
    inputSchema: z.object({ target: z.string() }),
    async checkPermissions() {
      toolChecks++
      return toolAnswer
    },
    isReadOnly: () => false,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    inputsEquivalent: setup.equivalent,
    userFacingName: () => 'CharTool',
    async description() {
      return 'char tool'
    },
    async call() {
      throw new Error('never called here')
    },
  } as unknown as Tool

  const hookCalls: unknown[][] = []
  const real = createPermissionContext(
    tool,
    ORIGINAL_INPUT,
    toolUseContext,
    { message: { id: 'msg_char' } } as never,
    TOOL_USE_ID,
    (context, options) => appliedContexts.push({ context, preserveMode: options?.preserveMode }),
    createPermissionQueueOps(setQueue as never),
  )
  const ctx = {
    ...real,
    runHooks: (...args: unknown[]) => {
      hookCalls.push(args)
      return setup.hook ? setup.hook() : Promise.resolve(null)
    },
  }

  const result: AskResult = { behavior: 'ask', message: 'needs approval', ...setup.result } as AskResult
  const decisions: PermissionDecision[] = []
  const before = Date.now()
  const remote = setup.bridge ? remoteEnd() : undefined
  handleInteractivePermission(
    {
      ctx: ctx as never,
      description: 'run the char tool',
      result,
      awaitAutomatedChecksBeforeDialog: setup.awaitAutomatedChecksBeforeDialog,
      bridgeCallbacks: remote?.callbacks,
    },
    decision => decisions.push(decision),
  )

  return {
    before,
    result,
    remote,
    decisions,
    hookCalls,
    appliedContexts,
    toolUseContext,
    queue: () => queue,
    entry: () => {
      const only = queue[0]
      if (!only) throw new Error('the dialog queue is empty')
      return only
    },
    recorded: () => toolUseContext.toolDecisions?.get(TOOL_USE_ID),
    answerFromTool: (answer: PermissionResult) => {
      toolAnswer = answer
    },
    toolChecks: () => toolChecks,
  }
}

/** Lets the handler's fire-and-forget promises settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
  setSystemTime()
})

describe('the dialog entry', () => {
  const inputCases = [
    { name: 'shows the input the checks rewrote', updatedInput: { target: 'rewritten' }, shown: { target: 'rewritten' } },
    { name: 'falls back to the tool call input', updatedInput: undefined, shown: ORIGINAL_INPUT },
  ]
  for (const { name, updatedInput, shown } of inputCases) {
    test(name, () => {
      const run = open({ result: { updatedInput } })
      expect(run.queue()).toHaveLength(1)
      const entry = run.entry()
      expect({
        description: entry.description,
        input: entry.input,
        toolUseID: entry.toolUseID,
        tool: entry.tool.name,
        permissionResult: entry.permissionResult,
        classifierFlagPresent: 'classifierCheckInProgress' in entry,
      }).toEqual({
        description: 'run the char tool',
        input: shown,
        toolUseID: TOOL_USE_ID,
        tool: 'CharTool',
        permissionResult: run.result,
        classifierFlagPresent: false,
      })
      expect(entry.toolUseContext).toBe(run.toolUseContext)
      expect(entry.permissionPromptStartTimeMs).toBeGreaterThanOrEqual(run.before)
      expect(entry.permissionPromptStartTimeMs).toBeLessThanOrEqual(Date.now())
      expect(run.decisions).toEqual([])
    })
  }
})

describe('answers from the dialog', () => {
  test('allow delivers the edited input, the trimmed feedback and the blocks, once', async () => {
    const reason = { type: 'other' as const, reason: 'asked by rule' }
    const run = open({ result: { decisionReason: reason }, equivalent: () => false })
    const blocks = [{ type: 'text' as const, text: 'see attached' }]

    run.entry().onAllow({ target: 'edited' }, [], '  looks fine  ', blocks)
    run.entry().onReject('too late')
    run.entry().onAbort()
    await settle()

    expect(run.decisions).toEqual([
      {
        behavior: 'allow',
        updatedInput: { target: 'edited' },
        userModified: true,
        decisionReason: reason,
        acceptFeedback: 'looks fine',
        contentBlocks: blocks,
      },
    ])
    expect(run.recorded()).toMatchObject({ decision: 'accept', source: 'user_temporary' })
    expect(run.toolUseContext.abortController.signal.aborted).toBe(false)
  })

  test('allow with rules applies them to the session without touching the mode', async () => {
    const run = open({ equivalent: () => true })
    const rule: PermissionUpdate = {
      type: 'addRules',
      rules: [{ toolName: 'CharTool' }],
      behavior: 'allow',
      destination: 'session',
    }

    run.entry().onAllow(ORIGINAL_INPUT, [rule], '   ')
    await settle()

    expect(run.decisions).toEqual([
      { behavior: 'allow', updatedInput: ORIGINAL_INPUT, userModified: false },
    ])
    expect(run.appliedContexts).toHaveLength(1)
    expect(run.appliedContexts[0]?.preserveMode).toBe(true)
    expect(run.appliedContexts[0]?.context.alwaysAllowRules.session).toEqual(['CharTool'])
    // A session rule does not persist, so the record says temporary.
    expect(run.recorded()).toMatchObject({ decision: 'accept', source: 'user_temporary' })
  })

  const rejectCases = [
    {
      name: 'reject with feedback hands the feedback to the model and keeps the turn',
      act: (entry: ToolUseConfirm) => entry.onReject('use the other file'),
      message: `${REJECT_MESSAGE_WITH_REASON_PREFIX}use the other file`,
      aborted: false,
      source: 'user_reject',
    },
    {
      name: 'reject without feedback stops the turn',
      act: (entry: ToolUseConfirm) => entry.onReject(),
      message: REJECT_MESSAGE,
      aborted: true,
      source: 'user_reject',
    },
    {
      name: 'abort stops the turn',
      act: (entry: ToolUseConfirm) => entry.onAbort(),
      message: REJECT_MESSAGE,
      aborted: true,
      source: 'user_abort',
    },
  ]
  for (const { name, act, message, aborted, source } of rejectCases) {
    test(name, async () => {
      const run = open()
      act(run.entry())
      run.entry().onAllow(ORIGINAL_INPUT, [])
      await settle()

      expect(run.decisions).toEqual([{ behavior: 'ask', message, contentBlocks: undefined }])
      expect(run.toolUseContext.abortController.signal.aborted).toBe(aborted)
      expect(run.recorded()).toMatchObject({ decision: 'reject', source })
    })
  }

  test('reject carries content blocks along with the feedback', async () => {
    const run = open()
    const blocks = [{ type: 'text' as const, text: 'screenshot' }]
    run.entry().onReject(undefined, blocks)
    await settle()
    expect(run.decisions).toEqual([{ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: blocks }])
    // Blocks count as feedback: the turn goes on.
    expect(run.toolUseContext.abortController.signal.aborted).toBe(false)
  })
})

describe('PermissionRequest hooks', () => {
  test('run in the background with the mode, the suggestions and the rewritten input', async () => {
    const suggestions: PermissionUpdate[] = [
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]
    const run = open({
      mode: 'plan',
      result: { suggestions, updatedInput: { target: 'rewritten' } },
    })
    await settle()

    expect(run.hookCalls).toHaveLength(1)
    const [mode, passedSuggestions, passedInput, startedAt] = run.hookCalls[0] ?? []
    expect({ mode, passedSuggestions, passedInput }).toEqual({
      mode: 'plan',
      passedSuggestions: suggestions,
      passedInput: { target: 'rewritten' },
    })
    expect(startedAt).toBe(run.entry().permissionPromptStartTimeMs)
    // A hook with nothing to say leaves the dialog up.
    expect(run.decisions).toEqual([])
    expect(run.queue()).toHaveLength(1)
  })

  test("a hook's decision wins over a dialog nobody answered, and closes it", async () => {
    const hookDecision: PermissionDecision = {
      behavior: 'deny',
      message: 'blocked by hook',
      decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
    }
    const run = open({ hook: async () => hookDecision })
    await settle()

    expect(run.decisions).toEqual([hookDecision])
    expect(run.queue()).toEqual([])
  })

  test('a user answer after the hook decided changes nothing', async () => {
    const hookDecision: PermissionDecision = { behavior: 'allow', updatedInput: ORIGINAL_INPUT }
    const run = open({ hook: async () => hookDecision })
    const entry = run.entry()
    await settle()
    entry.onReject('too late')
    entry.onAllow({ target: 'other' }, [])
    await settle()
    expect(run.decisions).toEqual([hookDecision])
    expect(run.toolUseContext.abortController.signal.aborted).toBe(false)
  })

  test("the user's answer wins over a hook that answers later", async () => {
    let release: (value: PermissionDecision | null) => void = () => {}
    const run = open({
      hook: () => new Promise(resolve => (release = resolve)),
    })
    run.entry().onReject('no')
    release({ behavior: 'allow', updatedInput: ORIGINAL_INPUT })
    await settle()

    expect(run.decisions.map(d => d.behavior)).toEqual(['ask'])
    // The late hook does not take the dialog down either.
    expect(run.queue()).toHaveLength(1)
  })

  test('are skipped when the caller already awaited them before the dialog', async () => {
    const run = open({ awaitAutomatedChecksBeforeDialog: true })
    await settle()
    expect(run.hookCalls).toEqual([])
    expect(run.queue()).toHaveLength(1)
  })
})

describe('re-checking while the dialog is up', () => {
  test('a rule that now allows the call resolves it and closes the dialog', async () => {
    const run = open()
    run.answerFromTool({ behavior: 'allow', updatedInput: { target: 'from-recheck' } })
    await run.entry().recheckPermission()

    expect(run.decisions).toEqual([
      { behavior: 'allow', updatedInput: { target: 'from-recheck' }, userModified: false },
    ])
    expect(run.queue()).toEqual([])
    expect(run.recorded()).toMatchObject({ decision: 'accept', source: 'config' })
  })

  test('an allow without a rewritten input keeps the original one', async () => {
    const run = open()
    run.answerFromTool({ behavior: 'allow' } as PermissionResult)
    await run.entry().recheckPermission()
    expect(run.decisions).toEqual([
      { behavior: 'allow', updatedInput: ORIGINAL_INPUT, userModified: false },
    ])
  })

  test('a call that still needs asking leaves the dialog alone', async () => {
    const run = open()
    await run.entry().recheckPermission()
    expect(run.toolChecks()).toBe(1)
    expect(run.decisions).toEqual([])
    expect(run.queue()).toHaveLength(1)
  })

  test('nothing is re-checked once the dialog was answered', async () => {
    const run = open()
    const entry = run.entry()
    entry.onAbort()
    run.answerFromTool({ behavior: 'allow' } as PermissionResult)
    await entry.recheckPermission()
    expect(run.toolChecks()).toBe(0)
    expect(run.decisions.map(d => d.behavior)).toEqual(['ask'])
  })

  test('an answer that lands during the re-check wins over it', async () => {
    const run = open()
    const entry = run.entry()
    run.answerFromTool({ behavior: 'allow' } as PermissionResult)
    const recheck = entry.recheckPermission()
    entry.onReject('changed my mind')
    await recheck
    expect(run.decisions.map(d => d.behavior)).toEqual(['ask'])
    expect(run.queue()).toHaveLength(1)
  })
})

describe('user interaction with the dialog', () => {
  // What a keypress cancels is the classifier race, which is behind a build
  // flag that bun test runs off. Without it, interaction decides nothing.
  const gestures = [
    { name: 'an early keypress', elapsedMs: 50, act: (e: ToolUseConfirm) => e.onUserInteraction() },
    { name: 'a later keypress', elapsedMs: 500, act: (e: ToolUseConfirm) => e.onUserInteraction() },
    { name: 'dismissing a checkmark never shown', elapsedMs: 0, act: (e: ToolUseConfirm) => e.onDismissCheckmark?.() },
  ]
  for (const { name, elapsedMs, act } of gestures) {
    test(`${name} leaves the dialog up and undecided`, async () => {
      const start = new Date('2026-10-02T12:00:00.000Z')
      setSystemTime(start)
      const run = open()
      setSystemTime(new Date(start.getTime() + elapsedMs))
      act(run.entry())
      await settle()
      expect(run.decisions).toEqual([])
      expect(run.queue()).toHaveLength(1)
    })
  }
})

describe('the remote end (the bridge)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'CharTool' }], behavior: 'allow', destination: 'session' }]

  /** The request id the remote end was given, and the calls after the opening two. */
  const opened = (run: ReturnType<typeof open>) => {
    const calls = run.remote?.calls ?? []
    const id = calls[0]?.[1] as string
    return { id, later: calls.slice(2) }
  }

  test('is sent the request as the dialog shows it, and listens for its answer under the same id', () => {
    const run = open({ bridge: true, result: { updatedInput: { target: 'rewritten' }, suggestions, blockedPath: '/etc/passwd' } })
    const [send, listen] = run.remote?.calls ?? []
    expect(send).toEqual(['sendRequest', expect.stringMatching(UUID), 'CharTool', { target: 'rewritten' }, TOOL_USE_ID, 'run the char tool', suggestions, '/etc/passwd'])
    expect(listen).toEqual(['onResponse', send?.[1]])
    expect(run.queue()).toHaveLength(1)
  })

  test('each request gets its own id', () => {
    const a = opened(open({ bridge: true })).id
    const b = opened(open({ bridge: true })).id
    expect(a).not.toBe(b)
  })

  test('a remote allow runs the call with its input, saves its rules and closes the dialog', async () => {
    const run = open({ bridge: true, equivalent: () => false })
    run.remote?.answer({ behavior: 'allow', updatedInput: { target: 'remote' }, updatedPermissions: suggestions })
    await settle()
    expect(run.decisions).toEqual([{ behavior: 'allow', updatedInput: { target: 'remote' }, userModified: false }])
    expect(run.queue()).toEqual([])
    expect(run.appliedContexts[0]?.context.alwaysAllowRules.session).toEqual(['CharTool'])
    // A session rule is not written to any file, so the allow stays temporary.
    expect(run.recorded()).toMatchObject({ decision: 'accept', source: 'user_temporary' })
    expect(opened(run).later).toEqual([])
  })

  test('a remote allow without input runs the input the dialog showed', async () => {
    const run = open({ bridge: true, result: { updatedInput: { target: 'rewritten' } } })
    run.remote?.answer({ behavior: 'allow' })
    await settle()
    expect(run.decisions).toEqual([{ behavior: 'allow', updatedInput: { target: 'rewritten' }, userModified: false }])
    expect(run.appliedContexts).toEqual([])
    expect(run.recorded()?.source).toBe('user_temporary')
  })

  const denials = [
    { name: 'with a message hands it to the model and keeps the turn', message: 'not that file', expected: `${REJECT_MESSAGE_WITH_REASON_PREFIX}not that file`, aborted: false },
    { name: 'without a message stops the turn', message: undefined, expected: REJECT_MESSAGE, aborted: true },
  ]
  for (const { name, message, expected, aborted } of denials) {
    test(`a remote deny ${name}`, async () => {
      const run = open({ bridge: true })
      run.remote?.answer({ behavior: 'deny', message })
      await settle()
      expect(run.decisions).toEqual([{ behavior: 'ask', message: expected, contentBlocks: undefined }])
      expect(run.queue()).toEqual([])
      expect(run.toolUseContext.abortController.signal.aborted).toBe(aborted)
      expect(run.recorded()).toMatchObject({ decision: 'reject', source: 'user_reject' })
    })
  }

  const localAnswers = [
    {
      name: 'an allow',
      act: (e: ToolUseConfirm) => e.onAllow({ target: 'edited' }, suggestions),
      told: { behavior: 'allow', updatedInput: { target: 'edited' }, updatedPermissions: suggestions },
    },
    { name: 'a reject with feedback', act: (e: ToolUseConfirm) => e.onReject('nope'), told: { behavior: 'deny', message: 'nope' } },
    { name: 'a bare reject', act: (e: ToolUseConfirm) => e.onReject(), told: { behavior: 'deny', message: 'User denied permission' } },
    { name: 'an abort', act: (e: ToolUseConfirm) => e.onAbort(), told: { behavior: 'deny', message: 'User aborted' } },
  ]
  for (const { name, act, told } of localAnswers) {
    test(`${name} in the terminal is reported to the remote end, then its prompt is withdrawn`, async () => {
      const run = open({ bridge: true })
      act(run.entry())
      await settle()
      const { id, later } = opened(run)
      expect(later).toEqual([
        ['sendResponse', id, told],
        ['cancelRequest', id],
      ])
      // The remote end answering afterwards changes nothing.
      run.remote?.answer({ behavior: told.behavior === 'allow' ? 'deny' : 'allow' })
      await settle()
      expect(run.decisions).toHaveLength(1)
    })
  }

  test('a hook decision withdraws the remote prompt without answering it', async () => {
    const run = open({ bridge: true, hook: async () => ({ behavior: 'allow', updatedInput: ORIGINAL_INPUT }) })
    await settle()
    const { id, later } = opened(run)
    expect(later).toEqual([['cancelRequest', id]])
  })

  test('an allow found on re-check withdraws the remote prompt', async () => {
    const run = open({ bridge: true })
    run.answerFromTool({ behavior: 'allow' } as PermissionResult)
    await run.entry().recheckPermission()
    const { id, later } = opened(run)
    expect(later).toEqual([['cancelRequest', id]])
  })

  test('a remote answer after the terminal answered is ignored', async () => {
    const run = open({ bridge: true })
    run.entry().onReject('local first')
    run.remote?.answer({ behavior: 'allow', updatedInput: { target: 'remote' } })
    await settle()
    expect(run.decisions.map(d => d.behavior)).toEqual(['ask'])
    // Nor does it touch the dialog or the record.
    expect([run.queue().length, run.recorded()?.source]).toEqual([1, 'user_reject'])
  })

  test('an abort of the turn stops listening for the remote answer', () => {
    const run = open({ bridge: true })
    expect(run.remote?.unsubscribed()).toBe(0)
    run.toolUseContext.abortController.abort()
    expect(run.remote?.unsubscribed()).toBe(1)
  })

  test('with no remote end connected nothing is sent anywhere', async () => {
    const run = open()
    run.entry().onAllow(ORIGINAL_INPUT, [])
    await settle()
    expect(run.remote).toBeUndefined()
    expect(run.decisions.map(d => d.behavior)).toEqual(['allow'])
  })
})
