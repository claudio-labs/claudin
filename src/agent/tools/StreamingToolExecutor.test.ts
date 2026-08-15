import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'

import type { Tool, Tools, ToolUseContext } from 'src/Tool.js'
import type { AssistantMessage } from 'src/types/message.js'

// Boundary mock: replace runToolUse so executeTool's real wiring (per-tool
// child controller + bubble-up listener) can be exercised without dragging
// in hooks/permissions/app-state. The fake hangs until its per-tool
// controller aborts — exactly like a Bash subprocess from a failed streaming
// attempt — and exposes that controller so tests can drive the two abort
// directions (discard vs permission rejection).
let capturedToolAbortController: AbortController | undefined
const realToolExecution = await import('src/agent/tools/toolExecution.js')
mock.module('./toolExecution.js', () => ({
  ...realToolExecution,
  runToolUse: async function* (
    _block: ToolUseBlock,
    _assistantMessage: AssistantMessage,
    _canUseTool: never,
    toolUseContext: ToolUseContext,
  ) {
    capturedToolAbortController = toolUseContext.abortController
    await new Promise<void>(resolve => {
      if (toolUseContext.abortController.signal.aborted) return resolve()
      toolUseContext.abortController.signal.addEventListener(
        'abort',
        () => resolve(),
        { once: true },
      )
    })
  },
}))
const { StreamingToolExecutor } = await import('src/agent/tools/StreamingToolExecutor.js')

// Re-pin the mocked module to its captured real namespace. Bun's
// `mock.module` is process-global and `mock.restore()` does not undo it, so
// without this every later test file would inherit this file's stub.
afterAll(() => {
  mock.module('./toolExecution.js', () => realToolExecution)
})

const canUseToolStub = (() =>
  Promise.resolve({ behavior: 'allow' })) as never

const fakeTool = {
  name: 'FakeHangingTool',
  inputSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
  isConcurrencySafe: () => true,
} as unknown as Tool

function makeContext(abortController: AbortController): ToolUseContext {
  return {
    abortController,
    options: { tools: [fakeTool] },
    setInProgressToolUseIDs: () => {},
    setHasInterruptibleToolInProgress: () => {},
  } as unknown as ToolUseContext
}

function makeToolUse(id: string): ToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name: 'FakeHangingTool',
    input: {},
    caller: { type: 'direct' },
  }
}

function makeAssistantMessage(): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000001',
    message: { id: 'msg_test', content: [] },
  } as unknown as AssistantMessage
}

/** Start the executor with one in-flight tool so executeTool registers the
 *  real bubble-up listener on the per-tool child controller. */
function makeExecutorWithInFlightTool(queryAbortController: AbortController) {
  capturedToolAbortController = undefined
  const executor = new StreamingToolExecutor(
    [fakeTool] as unknown as Tools,
    canUseToolStub,
    makeContext(queryAbortController),
  )
  executor.addTool(makeToolUse('toolu_inflight'), makeAssistantMessage())
  // executeTool runs synchronously up to runToolUse's first await, so the
  // listener is registered and the fake tool captured its controller.
  expect(capturedToolAbortController).toBeDefined()
  return executor
}

describe('StreamingToolExecutor.discard', () => {
  test('aborts the sibling controller so in-flight subprocesses die', () => {
    // Regression guard for the mid-stream retry duplicate-execution bug:
    // discard() must abort siblingAbortController (the parent of every
    // per-tool controller), not just set the discarded flag — a flag-only
    // discard lets a Bash subprocess from the failed attempt run to
    // completion while the retried stream re-issues the same tool.
    const queryAbortController = new AbortController()
    const executor = new StreamingToolExecutor(
      [],
      canUseToolStub,
      makeContext(queryAbortController),
    )
    const sibling = (
      executor as unknown as { siblingAbortController: AbortController }
    ).siblingAbortController

    expect(sibling.signal.aborted).toBe(false)
    executor.discard()
    expect(sibling.signal.aborted).toBe(true)
    expect(sibling.signal.reason).toBe('streaming_fallback')
  })

  test('does not abort the query controller while a tool is in flight (turn must continue)', () => {
    // The retry/fallback that triggered the discard still needs the turn
    // alive. With a tool actually executing, executeTool has registered the
    // bubble-up listener on the per-tool child controller — discard()'s
    // sibling abort propagates down to it, and only the `discarded` check in
    // that listener stops the abort from reaching the query controller.
    // (An executor with zero tools never registers the listener, so this
    // assertion would pass vacuously without addTool.)
    const queryAbortController = new AbortController()
    makeExecutorWithInFlightTool(queryAbortController).discard()

    // The per-tool controller WAS aborted (the in-flight tool died)...
    expect(capturedToolAbortController!.signal.aborted).toBe(true)
    expect(capturedToolAbortController!.signal.reason).toBe(
      'streaming_fallback',
    )
    // ...but the abort must not bubble up and end the turn.
    expect(queryAbortController.signal.aborted).toBe(false)
  })

  test('releases inProgressToolUseIDs for its tools (results are never yielded)', () => {
    // getCompletedResults/getRemainingResults return early once discarded,
    // so the markToolUseAsComplete that normally removes these ids never
    // runs — discard() must release them itself or the failed attempt's
    // spinner rows leak for the rest of the turn.
    const inProgress = new Set<string>(['toolu_other'])
    const queryAbortController = new AbortController()
    const executor = new StreamingToolExecutor(
      [fakeTool] as unknown as Tools,
      canUseToolStub,
      {
        abortController: queryAbortController,
        options: { tools: [fakeTool] },
        setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => {
          const next = f(inProgress)
          inProgress.clear()
          for (const id of next) inProgress.add(id)
        },
        setHasInterruptibleToolInProgress: () => {},
      } as unknown as ToolUseContext,
    )
    executor.addTool(makeToolUse('toolu_inflight'), makeAssistantMessage())
    expect(inProgress.has('toolu_inflight')).toBe(true)

    executor.discard()
    expect(inProgress.has('toolu_inflight')).toBe(false)
    // Ids owned by other executors (the retry's) are untouched.
    expect(inProgress.has('toolu_other')).toBe(true)
  })
})

describe('StreamingToolExecutor bubble-up listener', () => {
  test('permission-style abort on the per-tool controller still ends the turn', () => {
    // Positive control for the discard test above, and regression guard for
    // #21056: PermissionContext's cancelAndAbort aborts the per-tool
    // controller directly (reason ≠ sibling_error, executor not discarded) —
    // that abort MUST bubble up to the query controller so the query loop's
    // post-tool abort check ends the turn instead of sending REJECT_MESSAGE
    // to the model.
    const queryAbortController = new AbortController()
    makeExecutorWithInFlightTool(queryAbortController)

    capturedToolAbortController!.abort('user_rejected')
    expect(queryAbortController.signal.aborted).toBe(true)
    expect(queryAbortController.signal.reason).toBe('user_rejected')
  })
})
