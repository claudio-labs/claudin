import { describe, expect, test } from 'bun:test'

import { call as forkCall, FORK_WORDING, runFork } from 'src/commands/fork/fork.ts'
import { call as subtaskCall, SUBTASK_WORDING } from 'src/commands/fork/subtask.ts'
import { hasPermissionsToUseTool } from 'src/permissions/permissions.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import type { ForkFromDirectiveResult } from 'src/tools/AgentTool/forkFromDirective.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

type Done = { result?: string; options?: Parameters<LocalJSXCommandOnDone>[1] }

const commandCanUseTool = async () => ({})

function run(
  args: string,
  result: ForkFromDirectiveResult,
  wording = FORK_WORDING,
  canUseTool: unknown = commandCanUseTool,
) {
  const done: Done[] = []
  const directives: string[] = []
  const permissions: unknown[] = []
  const onDone = ((r, options) => {
    done.push({ result: r, options })
  }) as LocalJSXCommandOnDone
  const context = { canUseTool } as unknown as ToolUseContext & LocalJSXCommandContext
  const spawn = (async (directive: string, _context: unknown, permission: unknown) => {
    directives.push(directive)
    permissions.push(permission)
    return result
  }) as never
  return runFork(onDone, context, args, wording, spawn).then(() => ({ done, directives, permissions }))
}

describe('/fork', () => {
  test('confirms the fork with its name and the last four characters of its id', async () => {
    const { done, directives } = await run('  check the CI logs  ', {
      kind: 'spawned',
      name: 'check-the-ci',
      agentId: 'a1b2c3d4e5f6',
    })
    expect(directives).toEqual(['check the CI logs'])
    expect(done).toEqual([{ result: '⑂ forked check-the-ci (e5f6)', options: { display: 'system' } }])
  })

  test('prints the usage without a directive, and spawns nothing', async () => {
    const { done, directives } = await run('   ', { kind: 'no-turn' })
    expect(directives).toEqual([])
    expect(done[0]!.result).toBe('Usage: /fork \\<directive\\>')
  })

  test("names why it could not fork, in Claude Code's words", async () => {
    expect((await run('go', { kind: 'no-turn' })).done).toEqual([
      { result: 'Cannot fork before the first conversation turn', options: { display: 'system' } },
    ])
    expect((await run('go', { kind: 'coordinator' })).done).toEqual([
      { result: 'Forking is not available in coordinator sessions. Use /branch instead.', options: { display: 'system' } },
    ])
    expect((await run('', { kind: 'no-turn' })).done[0]!.options).toEqual({ display: 'system' })
  })

  test("asks the command's permission check, or the default one when the command has none", async () => {
    expect((await run('go', { kind: 'no-turn' })).permissions).toEqual([commandCanUseTool])
    const [fallback] = (await run('go', { kind: 'no-turn' }, FORK_WORDING, null)).permissions
    expect(fallback).toBe(hasPermissionsToUseTool)
  })
})

test('/subtask uses its own wording', async () => {
  expect((await run('', { kind: 'no-turn' }, SUBTASK_WORDING)).done[0]!.result).toBe('Usage: /subtask \\<task\\>')
  expect((await run('go', { kind: 'no-turn' }, SUBTASK_WORDING)).done[0]!.result).toBe(
    'Cannot start a subtask before the first conversation turn',
  )
  expect((await run('go', { kind: 'coordinator' }, SUBTASK_WORDING)).done[0]!.result).toBe(
    'Subtasks are not available in coordinator sessions. Use /branch instead.',
  )
  expect((await run('go', { kind: 'spawned', name: 'go', agentId: 'xyz9876' }, SUBTASK_WORDING)).done[0]!.result).toBe(
    '⑂ forked go (9876)',
  )
})

test('each command answers with its own wording', async () => {
  const said: string[] = []
  const onDone = (r => {
    if (r !== undefined) said.push(r)
  }) as LocalJSXCommandOnDone
  const context = {} as ToolUseContext & LocalJSXCommandContext
  await forkCall(onDone, context, '  ')
  await subtaskCall(onDone, context, '')
  expect(said).toEqual([FORK_WORDING.usage, SUBTASK_WORDING.usage])
})
