import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/shared/types/message.js'
import {
  type ChainCall,
  createResponseChain,
  describeCall,
  isFailedResult,
  isSkippedAfterFailure,
  skippedCallText,
} from 'src/agent/tools/responseChain.js'

function call(name: string, readOnly = false, id = `toolu_${name}`): ChainCall {
  return { id, name, readOnly, description: `${name}(x)` }
}

function result(
  id: string,
  opts: { isError?: boolean; data?: unknown } = {},
): Message {
  return {
    type: 'user',
    uuid: `u-${id}`,
    timestamp: '2026-09-24T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: 'out',
          ...(opts.isError ? { is_error: true } : {}),
        },
      ],
    },
    toolUseResult: opts.data,
  } as Message
}

describe('isSkippedAfterFailure', () => {
  test('commands that write, and every check, are skipped', () => {
    for (const name of ['Bash', 'PowerShell', 'Git']) {
      expect(isSkippedAfterFailure(call(name, false))).toBe(true)
    }
    for (const name of ['RunTests', 'Typecheck', 'Build']) {
      expect(isSkippedAfterFailure(call(name, false))).toBe(true)
      expect(isSkippedAfterFailure(call(name, true))).toBe(true)
    }
  })

  test('read-only commands still run', () => {
    for (const name of ['Bash', 'PowerShell', 'Git']) {
      expect(isSkippedAfterFailure(call(name, true))).toBe(false)
    }
  })

  test('reads, edits, agents and MCP calls still run', () => {
    for (const name of ['Read', 'Grep', 'Edit', 'Write', 'Patch', 'NotebookEdit', 'Agent', 'mcp__srv__do']) {
      expect(isSkippedAfterFailure(call(name, false))).toBe(false)
    }
  })
})

describe('isFailedResult', () => {
  test('an is_error result of this call is a failure', () => {
    const c = call('Edit')
    expect(isFailedResult(c, result(c.id, { isError: true }))).toBe(true)
  })

  test('a success, another call\'s error, or no message is not', () => {
    const c = call('Edit')
    expect(isFailedResult(c, result(c.id))).toBe(false)
    expect(isFailedResult(c, result('toolu_other', { isError: true }))).toBe(false)
    expect(isFailedResult(c, undefined)).toBe(false)
  })

  test('a read-only call never breaks the chain, even on an error', () => {
    const c = call('Bash', true)
    expect(isFailedResult(c, result(c.id, { isError: true }))).toBe(false)
  })

  test('a check reports a red run through exitCode, without is_error', () => {
    for (const name of ['RunTests', 'Typecheck', 'Build']) {
      const c = call(name)
      expect(isFailedResult(c, result(c.id, { data: { exitCode: 1 } }))).toBe(true)
      expect(isFailedResult(c, result(c.id, { data: { exitCode: 0 } }))).toBe(false)
    }
  })

  test('exitCode means nothing on a tool that is not a check', () => {
    const c = call('Edit')
    expect(isFailedResult(c, result(c.id, { data: { exitCode: 1 } }))).toBe(false)
  })

  test('a Bash whose stripped `| tail` hid a non-zero exit is a failure', () => {
    const c = call('Bash')
    expect(isFailedResult(c, result(c.id, { data: { stdout: '', reducedExitCode: 1 } }))).toBe(true)
    expect(isFailedResult(c, result(c.id, { data: { stdout: '' } }))).toBe(false)
  })

  test('a Patch or Edit whose `then` check failed is a failure; a skipped one after it is not the cause', () => {
    const red = { then: [{ command: 'bun test', ran: true, exitCode: 1, output: '' }] }
    const interrupted = { then: [{ command: 'bun test', ran: true, exitCode: null, output: '' }] }
    const green = {
      then: [
        { command: 'bun test', ran: true, exitCode: 0, output: '' },
        { command: 'tsc', ran: false, exitCode: null, output: '' },
      ],
    }
    for (const name of ['Patch', 'Edit']) {
      const c = call(name)
      expect(isFailedResult(c, result(c.id, { data: red }))).toBe(true)
      expect(isFailedResult(c, result(c.id, { data: interrupted }))).toBe(true)
      expect(isFailedResult(c, result(c.id, { data: green }))).toBe(false)
      expect(isFailedResult(c, result(c.id, { data: { files: [] } }))).toBe(false)
    }
    // Another tool's `then` field means nothing.
    const other = call('Write')
    expect(isFailedResult(other, result(other.id, { data: red }))).toBe(false)
  })

  test('a user message with string content is not a result', () => {
    const c = call('Edit')
    const text = { ...result(c.id), message: { role: 'user', content: 'hi' } } as Message
    expect(isFailedResult(c, text)).toBe(false)
  })
})

describe('createResponseChain', () => {
  test('nothing is skipped before a failure', () => {
    const chain = createResponseChain()
    chain.observe(call('Edit'), result('toolu_Edit'))
    expect(chain.failure).toBeNull()
    expect(chain.skipText(call('Bash'))).toBeNull()
    expect(chain.skipText(call('RunTests'))).toBeNull()
  })

  test('after a failed edit, the test run is skipped and the text names the edit', () => {
    const chain = createResponseChain()
    const edit = { ...call('Patch'), description: 'Patch' }
    chain.observe(edit, result(edit.id, { isError: true }))
    const skip = chain.skipText(call('Bash'))
    expect(skip).toBe(skippedCallText(call('Bash'), 'Patch'))
    expect(skip).toContain('Skipped: Patch failed earlier in this response')
    expect(skip).toContain('this Bash call did not run')
  })

  test('after a failure, edits, reads and read-only git still run; a commit does not', () => {
    const chain = createResponseChain()
    chain.observe(call('Edit'), result('toolu_Edit', { isError: true }))
    expect(chain.skipText(call('Edit', false, 'toolu_2'))).toBeNull()
    expect(chain.skipText(call('Read', true))).toBeNull()
    expect(chain.skipText(call('Git', true))).toBeNull()
    expect(chain.skipText(call('Git', false))).not.toBeNull()
  })

  test('the first failure sticks', () => {
    const chain = createResponseChain()
    const first = { ...call('Edit', false, 'toolu_1'), description: 'Edit(a.ts)' }
    const second = { ...call('Bash', false, 'toolu_2'), description: 'Bash(exit 1)' }
    chain.observe(first, result('toolu_1', { isError: true }))
    chain.observe(second, result('toolu_2', { isError: true }))
    expect(chain.failure).toBe('Edit(a.ts)')
  })

  test('a failed read breaks nothing', () => {
    const chain = createResponseChain()
    chain.observe(call('Bash', true), result('toolu_Bash', { isError: true }))
    expect(chain.failure).toBeNull()
    expect(chain.skipText(call('RunTests'))).toBeNull()
  })
})

describe('describeCall', () => {
  test('names the command, the first git command, the path or the pattern', () => {
    expect(describeCall('Bash', { command: 'bun test' })).toBe('Bash(bun test)')
    expect(describeCall('Git', { commands: ['git add a.ts', 'git commit -m x'] })).toBe('Git(git add a.ts)')
    expect(describeCall('Edit', { file_path: '/r/a.ts', old_string: 'a' })).toBe('Edit(/r/a.ts)')
    expect(describeCall('Grep', { pattern: 'foo' })).toBe('Grep(foo)')
  })

  test('cuts a long summary at 40 characters', () => {
    const long = 'x'.repeat(50)
    expect(describeCall('Bash', { command: long })).toBe(`Bash(${'x'.repeat(40)}\u2026)`)
  })

  test('falls back to the bare name', () => {
    expect(describeCall('Patch', { patchText: '*** Begin Patch' })).toBe('Patch')
    expect(describeCall('RunTests', {})).toBe('RunTests')
    expect(describeCall('RunTests', undefined)).toBe('RunTests')
  })

  test('a command wins over a path or a pattern', () => {
    // RunTests takes both a `command` and a `pattern`; the label names what ran.
    expect(describeCall('RunTests', { command: 'bun test', pattern: 'cart' })).toBe('RunTests(bun test)')
    expect(describeCall('Grep', { file_path: '/r/a.ts', pattern: 'foo' })).toBe('Grep(/r/a.ts)')
  })
})
