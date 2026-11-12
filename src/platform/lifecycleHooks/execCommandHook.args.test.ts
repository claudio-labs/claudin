import { describe, expect, test } from 'bun:test'
import { execCommandHook } from 'src/platform/lifecycleHooks/runners.js'
import { HookCommandSchema } from 'src/shared/schemas/hooks.js'
import type { HookCommand } from 'src/shared/schemas/hooks.js'

// A command hook runs `command` as one shell line; there is no argv. A hook
// written for a tool that takes `{ command, args }` used to lose `args` to the
// schema and run the bare command — `sh` reading the hook's JSON input as a
// script.
const WITH_ARGS = {
  type: 'command',
  command: 'echo RAN',
  args: ['-c', 'echo other'],
  timeout: 5,
}

describe('a command hook that carries args', () => {
  test('keeps args through the schema so the runner can see them', () => {
    const parsed = HookCommandSchema().parse(WITH_ARGS) as Record<string, unknown>
    expect(parsed.args).toEqual(['-c', 'echo other'])
  })

  // A PreToolUse hook is a guard: a refusal that does not block would let the
  // tool through. Exit 2 is the only status that blocks there. Elsewhere it
  // means something else (a Stop hook's 2 keeps the model going), so other
  // events get a plain failure.
  test('blocks the tool call when it is a PreToolUse guard', async () => {
    const result = await execCommandHook(
      WITH_ARGS as HookCommand & { type: 'command' },
      'PreToolUse',
      'PreToolUse:Bash',
      '{}',
      new AbortController().signal,
      'args-hook-id',
    )

    expect(result.status).toBe(2)
    expect(result.stdout).not.toContain('RAN')
    expect(result.stderr).toContain('args')
  })

  test('fails without blocking on any other event', async () => {
    for (const event of ['PostToolUse', 'Stop', 'SessionStart'] as const) {
      const result = await execCommandHook(
        WITH_ARGS as HookCommand & { type: 'command' },
        event,
        `${event}:test`,
        '{}',
        new AbortController().signal,
        'args-hook-id',
      )
      expect([event, result.status, result.stdout.includes('RAN')]).toEqual([event, 1, false])
    }
  })

  test('a hook without args still runs', async () => {
    const result = await execCommandHook(
      { type: 'command', command: 'echo RAN', timeout: 5 },
      'PreToolUse',
      'PreToolUse:Bash',
      '{}',
      new AbortController().signal,
      'plain-hook-id',
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('RAN')
  })
})
