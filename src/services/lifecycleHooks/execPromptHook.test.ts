import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from 'src/Tool.js'
import type { PromptHook } from 'src/services/settings/types.js'
import { markStopConditionJudge } from 'src/services/lifecycleHooks/stopConditionJudge.js'

// Boundary mock: replace the model query so the judge's response parsing can
// be exercised without network. Captures the request for prompt assertions.
type CapturedQuery = {
  messages: unknown[]
  systemPrompt: unknown
  options: {
    toolChoice?: { type?: string }
    outputFormat?: {
      schema?: { required?: string[]; properties?: Record<string, unknown> }
    }
  }
}
let nextResponseText = '{"ok": true}'
let lastQuery: CapturedQuery | undefined

const realClaude = await import('src/services/api/claude.js')
mock.module('src/services/api/claude.js', () => ({
  ...realClaude,
  queryModelWithoutStreaming: async (query: CapturedQuery) => {
    lastQuery = query
    return {
      message: {
        content: [{ type: 'text', text: nextResponseText }],
      },
    }
  },
}))

const { execPromptHook, buildStopConditionJudgePrompt } = await import(
  'src/services/lifecycleHooks/execPromptHook.js'
)

// Re-pin the mocked module to its captured real namespace. Bun's
// `mock.module` is process-global and `mock.restore()` does not undo it, so
// without this every later test file would inherit this file's stub.
afterAll(() => {
  mock.module('src/services/api/claude.js', () => realClaude)
})

function makeToolUseContext(): ToolUseContext {
  return {
    options: { tools: [] },
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    setResponseLength: (_f: (n: number) => number) => {},
    agentId: undefined,
  } as unknown as ToolUseContext
}

function makeHook(prompt: string): PromptHook {
  // Explicit model avoids getSmallFastModel() config resolution in tests
  return { type: 'prompt', prompt, model: 'claude-3-5-haiku-20241022' }
}

/** The /goal judge hook — same shape, branded with the session-only marker. */
function makeJudgeHook(prompt: string): PromptHook {
  return markStopConditionJudge(makeHook(prompt))
}

async function runHook(
  hook: PromptHook,
  hookEvent: 'Stop' | 'SubagentStop' | 'PreToolUse',
  responseText: string,
  jsonInput = '{}',
) {
  nextResponseText = responseText
  return execPromptHook(
    hook,
    'Stop',
    hookEvent,
    jsonInput,
    new AbortController().signal,
    makeToolUseContext(),
  )
}

function lastUserMessageContent(): string {
  const userMsg = lastQuery!.messages.at(-1) as {
    message: { content: string }
  }
  return userMsg.message.content
}

beforeEach(() => {
  lastQuery = undefined
})

describe('stop-condition judge (marked goal hook)', () => {
  test('ok:false blocks with [condition]: reason and allows continuation', async () => {
    const result = await runHook(
      makeJudgeHook('tests pass'),
      'Stop',
      '{"ok": false, "reason": "3 tests still failing"}',
    )
    expect(result.outcome).toBe('blocking')
    expect(result.blockingError).toEqual({
      blockingError: '[tests pass]: 3 tests still failing',
      command: 'tests pass',
    })
    // The judge must NOT prevent continuation — blocking feedback forces
    // the model to keep working instead of halting the session.
    expect(result.preventContinuation).toBe(false)
    expect(result.stopReason).toBe('3 tests still failing')
  })

  test('ok:true is success with the judge reason as stopReason', async () => {
    const result = await runHook(
      makeJudgeHook('tests pass'),
      'Stop',
      '{"ok": true, "reason": "transcript shows all tests passed"}',
    )
    expect(result.outcome).toBe('success')
    expect(result.stopReason).toBe('transcript shows all tests passed')
    expect(result.impossible).toBeUndefined()
  })

  test('impossible verdict is success-with-impossible (stop allowed)', async () => {
    const result = await runHook(
      makeJudgeHook('tests pass'),
      'Stop',
      '{"ok": false, "impossible": true, "reason": "requires network access that is unavailable"}',
    )
    expect(result.outcome).toBe('success')
    expect(result.impossible).toBe(true)
    expect(result.stopReason).toBe(
      'requires network access that is unavailable',
    )
    expect(result.blockingError).toBeUndefined()
  })

  test('wraps the condition in the transcript-evidence prompt and requires reason', async () => {
    await runHook(
      makeJudgeHook('lint is clean'),
      'Stop',
      '{"ok": true, "reason": "done"}',
    )
    expect(lastQuery).toBeDefined()
    expect(lastUserMessageContent()).toBe(
      buildStopConditionJudgePrompt('lint is clean'),
    )
    expect(lastUserMessageContent()).toContain('Condition: lint is clean')
    expect(lastQuery!.options.outputFormat?.schema?.required).toEqual([
      'ok',
      'reason',
    ])
    expect(lastQuery!.options.outputFormat?.schema?.properties).toHaveProperty(
      'impossible',
    )
  })

  test('non-JSON response is a non-blocking error (goal stays active)', async () => {
    const result = await runHook(
      makeJudgeHook('tests pass'),
      'Stop',
      'I think the condition is met!',
    )
    expect(result.outcome).toBe('non_blocking_error')
    expect(result.blockingError).toBeUndefined()
  })

  test('judge forbids tool calls via tool_choice none; legacy hooks do not', async () => {
    // Regression (live e2e): without tool_choice:none the evaluator model
    // sometimes answers a stop-condition check by calling Read/Bash to
    // "verify" the condition — the response then has no text content and the
    // judge run degrades to a spurious "JSON validation failed" error.
    await runHook(
      makeJudgeHook('lint is clean'),
      'Stop',
      '{"ok": true, "reason": "x"}',
    )
    expect(lastQuery!.options.toolChoice).toEqual({ type: 'none' })

    await runHook(makeHook('check $ARGUMENTS'), 'Stop', '{"ok": true}')
    expect(lastQuery!.options.toolChoice).toBeUndefined()
  })
})

describe('non-judge prompt hooks keep legacy behavior on every event', () => {
  // M1 regression: judge semantics are keyed on hook identity (the marker),
  // not on the Stop/SubagentStop event. A user-defined prompt Stop hook from
  // settings.json or agent frontmatter must behave exactly as before /goal.
  test('Stop prompt hook still gets $ARGUMENTS substitution', async () => {
    const jsonInput = '{"stop_hook_active": false, "last_assistant_message": "hi"}'
    await runHook(
      makeHook('Check this input: $ARGUMENTS'),
      'Stop',
      '{"ok": true}',
      jsonInput,
    )
    expect(lastUserMessageContent()).toBe(`Check this input: ${jsonInput}`)
    expect(lastUserMessageContent()).not.toContain('$ARGUMENTS')
  })

  test('Stop prompt hook ok:false keeps legacy blocking + preventContinuation', async () => {
    const result = await runHook(
      makeHook('the answer is polite'),
      'Stop',
      '{"ok": false, "reason": "nope"}',
    )
    expect(result.outcome).toBe('blocking')
    expect(result.blockingError?.blockingError).toBe(
      'Prompt hook condition was not met: nope',
    )
    expect(result.preventContinuation).toBe(true)
  })

  test('Stop prompt hook keeps the lenient required list and no impossible field', async () => {
    await runHook(makeHook('a condition'), 'Stop', '{"ok": true}')
    expect(lastQuery!.options.outputFormat?.schema?.required).toEqual(['ok'])
    expect(
      lastQuery!.options.outputFormat?.schema?.properties,
    ).not.toHaveProperty('impossible')
  })

  test('SubagentStop prompt hook (agent frontmatter) keeps legacy semantics', async () => {
    const result = await runHook(
      makeHook('subagent finished cleanly'),
      'SubagentStop',
      '{"ok": false, "reason": "not done"}',
    )
    expect(result.outcome).toBe('blocking')
    expect(result.blockingError?.blockingError).toBe(
      'Prompt hook condition was not met: not done',
    )
    expect(result.preventContinuation).toBe(true)
  })

  test('non-Stop events keep legacy blocking + preventContinuation behavior', async () => {
    const result = await runHook(
      makeHook('tool use is safe'),
      'PreToolUse',
      '{"ok": false, "reason": "nope"}',
    )
    expect(result.outcome).toBe('blocking')
    expect(result.blockingError?.blockingError).toBe(
      'Prompt hook condition was not met: nope',
    )
    expect(result.preventContinuation).toBe(true)
  })

  test('impossible is ignored for non-judge hooks (still blocking)', async () => {
    const result = await runHook(
      makeHook('tests pass'),
      'Stop',
      '{"ok": false, "impossible": true, "reason": "nope"}',
    )
    expect(result.outcome).toBe('blocking')
    expect(result.impossible).toBeUndefined()
    expect(result.preventContinuation).toBe(true)
  })
})
