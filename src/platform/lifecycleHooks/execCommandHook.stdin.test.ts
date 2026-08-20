import { describe, expect, test } from 'bun:test'
import { execCommandHook } from 'src/platform/lifecycleHooks/runners.js'
import type { PromptRequest, PromptResponse } from 'src/shared/types/hooks.js'

// The hook input is one JSON line; `input=$(cat)` is the shape every hook in
// the wild uses to read it, and it only returns on EOF.
const HOOK_INPUT = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
})

const ECHO_STDIN = 'input=$(cat); printf %s "$input"'

async function requestPrompt(request: PromptRequest): Promise<PromptResponse> {
  return {
    prompt_response: request.prompt,
    selected: request.options[0]?.key ?? '',
  }
}

function runHook(
  overrides: { interactive?: boolean },
  signal: AbortSignal,
): ReturnType<typeof execCommandHook> {
  return execCommandHook(
    // A 5s timeout so a regression fails fast instead of hanging the suite for
    // the 10 minute default.
    { type: 'command', command: ECHO_STDIN, timeout: 5, ...overrides },
    'PreToolUse',
    'PreToolUse:Bash',
    HOOK_INPUT,
    signal,
    'test-hook-id',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    requestPrompt,
  )
}

describe('execCommandHook stdin', () => {
  test('closes stdin for an ordinary hook, so reading to EOF returns', async () => {
    const startedAt = Date.now()
    const result = await runHook({}, new AbortController().signal)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"tool_name":"Bash"')
    // Before the fix this waited out the hook timeout with the tool it gates
    // blocked behind it.
    expect(Date.now() - startedAt).toBeLessThan(4_000)
  })

  test('keeps stdin open for a hook that opted into the prompt protocol', async () => {
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 500)
    const result = await runHook({ interactive: true }, controller.signal)
    clearTimeout(abortTimer)

    // Still waiting for the prompt response it declared it wants, so `cat`
    // never saw EOF and nothing was echoed back.
    expect(result.stdout).not.toContain('"tool_name":"Bash"')
  })
})
