import { describe, expect, test } from 'bun:test'

import { FORK_WORDING, runFork } from 'src/commands/fork/fork.ts'
import { SUBTASK_WORDING } from 'src/commands/fork/subtask.ts'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import type { ForkFromDirectiveResult } from 'src/tools/AgentTool/forkFromDirective.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

type Done = { result?: string; options?: Parameters<LocalJSXCommandOnDone>[1] }

function run(args: string, result: ForkFromDirectiveResult, wording = FORK_WORDING) {
  const done: Done[] = []
  const directives: string[] = []
  const onDone = ((r, options) => {
    done.push({ result: r, options })
  }) as LocalJSXCommandOnDone
  const context = { canUseTool: async () => ({}) } as unknown as ToolUseContext & LocalJSXCommandContext
  const spawn = (async (directive: string) => {
    directives.push(directive)
    return result
  }) as never
  return runFork(onDone, context, args, wording, spawn).then(() => ({ done, directives }))
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
    expect((await run('go', { kind: 'no-turn' })).done[0]!.result).toBe('Cannot fork before the first conversation turn')
    expect((await run('go', { kind: 'coordinator' })).done[0]!.result).toBe(
      'Forking is not available in coordinator sessions. Use /branch instead.',
    )
  })
})

test('/subtask uses its own wording', async () => {
  expect((await run('', { kind: 'no-turn' }, SUBTASK_WORDING)).done[0]!.result).toBe('Usage: /subtask \\<task\\>')
  expect((await run('go', { kind: 'no-turn' }, SUBTASK_WORDING)).done[0]!.result).toBe(
    'Cannot start a subtask before the first conversation turn',
  )
  expect((await run('go', { kind: 'spawned', name: 'go', agentId: 'xyz9876' }, SUBTASK_WORDING)).done[0]!.result).toBe(
    '⑂ forked go (9876)',
  )
})
