/**
 * Characterization of TaskOutput, the deprecated tool that reads a background
 * task's output: what `call` returns for each task type, blocking and not,
 * how it waits, what the model receives, and how the transcript renders it.
 *
 * Output files are real files at the path the task framework assigns; the
 * app state is a plain store the test owns.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as React from 'react'
import { TaskOutputTool } from 'src/tools/TaskOutputTool/TaskOutputTool.js'
import { TASK_OUTPUT_TOOL_NAME } from 'src/tools/TaskOutputTool/constants.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import { TaskOutput } from 'src/agent/tasks/TaskOutput.js'
import { AbortError } from 'src/shared/errors.js'
import { withInk } from 'src/agent/ui/__testutils__/inkMount.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const TIMEOUT = 30_000
let savedConfigDir: string | undefined
let configDir = ''

// Only the config dir is redirected: the task output directory is fixed for
// the process at its first use (see isolateTaskEnv in the tasks harness).
beforeAll(() => {
  savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'task-output-cfg-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
})
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
  for (const path of spooled) rmSync(path, { force: true })
})

let serial = 0
const freshId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(serial++).toString(36)}`

const spooled: string[] = []

/** Writes what a task spooled to its output file. */
function spool(id: string, text: string): void {
  const path = getTaskOutputPath(id)
  spooled.push(path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

type Row = Record<string, unknown> & { id: string; status: string }

function context(tasks: Record<string, Row>, abort = new AbortController()) {
  let state = { tasks } as { tasks: Record<string, Row> }
  return {
    ctx: {
      abortController: abort,
      getAppState: () => state,
      setAppState: (update: (prev: typeof state) => typeof state) => {
        state = update(state)
      },
      options: {},
    } as never,
    tasks: () => state.tasks,
    replace: (id: string, row: Row) => {
      state = { ...state, tasks: { ...state.tasks, [id]: row } }
    },
    drop: (id: string) => {
      const { [id]: _gone, ...rest } = state.tasks
      state = { ...state, tasks: rest }
    },
  }
}

async function run(input: Record<string, unknown>, ctx: unknown, onProgress?: (p: unknown) => void) {
  const parsed = TaskOutputTool.inputSchema.parse(input)
  const { data } = await TaskOutputTool.call(parsed as never, ctx as never, undefined as never, undefined as never, onProgress as never)
  return data
}

describe('static surface', () => {
  test('identity, flags and prompt', async () => {
    expect(TaskOutputTool.name).toBe(TASK_OUTPUT_TOOL_NAME)
    expect(TaskOutputTool.userFacingName({} as never)).toBe('Task Output')
    expect(await TaskOutputTool.description({} as never, {} as never)).toBe('[Deprecated] — prefer Read on the task output file path')
    expect(TaskOutputTool.isConcurrencySafe({} as never)).toBe(true)
    expect(TaskOutputTool.toAutoClassifierInput({ task_id: 'b123', block: true, timeout: 1 } as never)).toBe('b123')
    expect(TaskOutputTool.maxResultSizeChars).toBe(100_000)
    expect(TaskOutputTool.shouldDefer).toBe(true)
    const prompt = await TaskOutputTool.prompt({} as never)
    expect(prompt.startsWith('DEPRECATED: Prefer using the Read tool')).toBe(true)
    expect(prompt).toContain('Use block=false for non-blocking check of current status')
  })

  test('block accepts the string forms of a boolean', () => {
    const cases: Array<[unknown, boolean]> = [
      ['false', false],
      ['true', true],
      [false, false],
    ]
    for (const [block, expected] of cases) {
      expect(TaskOutputTool.inputSchema.parse({ task_id: 'x', block }).block, String(block)).toBe(expected)
    }
    expect(TaskOutputTool.inputSchema.safeParse({ task_id: 'x', extra: 1 }).success).toBe(false)
  })
})

describe('call: reading without waiting', () => {
  test('a finished shell reports its live stdout and stderr, exit code and command, and is marked notified', async () => {
    const id = freshId('b')
    const out = new TaskOutput(id, null)
    out.writeStdout('built 3 targets\n')
    out.writeStderr('warning: slow disk')
    const c = context({
      [id]: { id, type: 'local_bash', status: 'completed', description: 'build', command: 'make all', result: { code: 0 }, shellCommand: { taskOutput: out }, notified: false },
    })
    const data = await run({ task_id: id, block: false }, c.ctx)
    expect(data).toEqual({
      retrieval_status: 'success',
      task: {
        task_id: id,
        task_type: 'local_bash',
        status: 'completed',
        description: 'build',
        output: 'built 3 targets\n\nwarning: slow disk',
        exitCode: 0,
        command: 'make all',
      },
    })
    expect(c.tasks()[id]!.notified).toBe(true)
  })

  test('a shell without a live command is read from its output file, and has a null exit code until it has a result', async () => {
    const id = freshId('b')
    spool(id, 'from disk\n')
    const c = context({ [id]: { id, type: 'local_bash', status: 'running', description: 'serve', command: 'npm start', shellCommand: null } })
    const data = await run({ task_id: id, block: false }, c.ctx)
    expect(data.retrieval_status).toBe('not_ready')
    expect(data.task).toMatchObject({ output: 'from disk\n', exitCode: null, command: 'npm start', status: 'running' })
    expect(c.tasks()[id]!.notified).toBeUndefined()
  })

  test('a pending task is not ready either', async () => {
    const id = freshId('d')
    const c = context({ [id]: { id, type: 'dream', status: 'pending', description: 'dream' } })
    expect((await run({ task_id: id, block: false }, c.ctx)).retrieval_status).toBe('not_ready')
  })

  test('an agent prefers the text of its final answer over the transcript on disk', async () => {
    const id = freshId('a')
    spool(id, '{"type":"assistant"}\n{"type":"user"}\n')
    const c = context({
      [id]: {
        id,
        type: 'local_agent',
        status: 'completed',
        description: 'audit',
        prompt: 'Audit the parser',
        error: undefined,
        result: { content: [{ type: 'text', text: 'Found two bugs.' }, { type: 'tool_use', id: 't', name: 'x', input: {} }, { type: 'text', text: 'Both fixed.' }] },
      },
    })
    const data = await run({ task_id: id, block: false }, c.ctx)
    expect(data.task).toEqual({
      task_id: id,
      task_type: 'local_agent',
      status: 'completed',
      description: 'audit',
      output: 'Found two bugs.\nBoth fixed.',
      result: 'Found two bugs.\nBoth fixed.',
      prompt: 'Audit the parser',
      error: undefined,
    })
  })

  test('an agent without a usable answer falls back to its output file and carries its error', async () => {
    const cases: Array<[string, unknown]> = [
      ['no result', undefined],
      ['no text in the result', { content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }],
    ]
    for (const [name, result] of cases) {
      const id = freshId('a')
      spool(id, 'transcript tail')
      const c = context({ [id]: { id, type: 'local_agent', status: 'failed', description: 'audit', prompt: 'p', error: 'rate limited', result } })
      const task = (await run({ task_id: id, block: false }, c.ctx)).task!
      expect([task.output, task.result, task.error], name).toEqual(['transcript tail', 'transcript tail', 'rate limited'])
    }
  })

  test('any other task type gets the common fields only, and an empty output when nothing was spooled', async () => {
    const id = freshId('d')
    const c = context({ [id]: { id, type: 'dream', status: 'completed', description: 'dreaming' } })
    expect((await run({ task_id: id, block: false }, c.ctx)).task).toEqual({
      task_id: id,
      task_type: 'dream',
      status: 'completed',
      description: 'dreaming',
      output: '',
    })
  })

  test('an unknown id throws', async () => {
    await expect(run({ task_id: 'gone', block: false }, context({}).ctx)).rejects.toThrow('No task found with ID: gone')
    await expect(run({ task_id: 'gone' }, context({}).ctx)).rejects.toThrow('No task found with ID: gone')
  })
})

describe('call: waiting for the task', () => {
  test('waits until the task leaves running, then reports success and marks it notified', async () => {
    const id = freshId('d')
    const c = context({ [id]: { id, type: 'dream', status: 'running', description: 'nap' } })
    const progress: unknown[] = []
    setTimeout(() => c.replace(id, { ...c.tasks()[id]!, status: 'completed' }), 250)
    const started = Date.now()
    const data = await run({ task_id: id, timeout: 5_000 }, c.ctx, p => progress.push(p))
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(data.retrieval_status).toBe('success')
    expect(data.task!.status).toBe('completed')
    expect(c.tasks()[id]!.notified).toBe(true)
    expect(progress).toEqual([{ toolUseID: expect.stringMatching(/^task-output-waiting-\d+$/), data: { type: 'waiting_for_task', taskDescription: 'nap', taskType: 'dream' } }])
  })

  test('a task that is already done returns at once', async () => {
    const id = freshId('d')
    const c = context({ [id]: { id, type: 'dream', status: 'killed', description: 'nap' } })
    const started = Date.now()
    expect((await run({ task_id: id }, c.ctx)).retrieval_status).toBe('success')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('running past the timeout reports timeout with the current state', async () => {
    const id = freshId('d')
    const c = context({ [id]: { id, type: 'dream', status: 'running', description: 'long nap' } })
    const data = await run({ task_id: id, timeout: 150 }, c.ctx)
    expect(data.retrieval_status).toBe('timeout')
    expect(data.task).toMatchObject({ task_id: id, status: 'running' })
    expect(c.tasks()[id]!.notified).toBeUndefined()
  })

  test('a task that disappears while waited on gives timeout with no task', async () => {
    const id = freshId('d')
    const c = context({ [id]: { id, type: 'dream', status: 'running', description: 'vanishing' } })
    setTimeout(() => c.drop(id), 150)
    expect(await run({ task_id: id, timeout: 5_000 }, c.ctx)).toEqual({ retrieval_status: 'timeout', task: null })
  })

  test('a zero timeout reads the state once and reports timeout', async () => {
    const id = freshId('d')
    const c = context({ [id]: { id, type: 'dream', status: 'running', description: 'x' } })
    const data = await run({ task_id: id, timeout: 0 }, c.ctx)
    expect(data.retrieval_status).toBe('timeout')
    expect(data.task).toMatchObject({ task_id: id, status: 'running' })
  })

  test('aborting the turn stops the wait with an abort error', async () => {
    const id = freshId('d')
    const abort = new AbortController()
    const c = context({ [id]: { id, type: 'dream', status: 'running', description: 'x' } }, abort)
    setTimeout(() => abort.abort(), 120)
    await expect(run({ task_id: id, timeout: 5_000 }, c.ctx)).rejects.toBeInstanceOf(AbortError)
  })
})

describe('what the model receives', () => {
  function block(data: unknown): string {
    const result = TaskOutputTool.mapToolResultToToolResultBlockParam(data as never, 'toolu_9')
    expect(result.tool_use_id).toBe('toolu_9')
    expect(result.type).toBe('tool_result')
    return result.content as string
  }

  test('sections in order, separated by blank lines', () => {
    const content = block({
      retrieval_status: 'success',
      task: { task_id: 'a1', task_type: 'local_agent', status: 'failed', description: 'd', output: 'partial answer\n\n', error: 'boom' },
    })
    expect(content).toBe(
      ['<retrieval_status>success</retrieval_status>', '<task_id>a1</task_id>', '<task_type>local_agent</task_type>', '<status>failed</status>', '<output>\npartial answer\n</output>', '<error>boom</error>'].join('\n\n'),
    )
  })

  test('the exit code is shown when known, including zero', () => {
    const cases: Array<[unknown, boolean]> = [
      [0, true],
      [2, true],
      [null, false],
      [undefined, false],
    ]
    for (const [exitCode, shown] of cases) {
      const content = block({ retrieval_status: 'success', task: { task_id: 'b', task_type: 'dream', status: 'completed', description: '', output: '', exitCode } })
      expect(content.includes(`<exit_code>${String(exitCode)}</exit_code>`), String(exitCode)).toBe(shown)
    }
  })

  test('blank output gives no output section', () => {
    const content = block({ retrieval_status: 'not_ready', task: { task_id: 'b', task_type: 'dream', status: 'running', description: '', output: '  \n ' } })
    expect(content).toBe('<retrieval_status>not_ready</retrieval_status>\n\n<task_id>b</task_id>\n\n<task_type>dream</task_type>\n\n<status>running</status>')
  })

  test('no task gives the status alone', () => {
    expect(block({ retrieval_status: 'timeout', task: null })).toBe('<retrieval_status>timeout</retrieval_status>')
  })
})

describe('transcript rendering', () => {
  const render = (node: React.ReactNode, wait: string | ((f: string) => boolean)) =>
    withInk(<AppStateProvider>{node}</AppStateProvider>, ui => ui.waitFor(wait), 100)

  test(
    'tool-use line: blocking says nothing, non-blocking says so; the tag shows the id',
    async () => {
      expect(TaskOutputTool.renderToolUseMessage({ task_id: 'x' } as never, {} as never)).toBe('')
      expect(TaskOutputTool.renderToolUseMessage({ task_id: 'x', block: true } as never, {} as never)).toBe('')
      expect(TaskOutputTool.renderToolUseMessage({ task_id: 'x', block: false } as never, {} as never)).toBe('non-blocking')
      expect(TaskOutputTool.renderToolUseTag!({} as never)).toBeNull()
      const frame = await render(TaskOutputTool.renderToolUseTag!({ task_id: 'b77' } as never), 'b77')
      expect(frame.trim()).toBe('b77')
    },
    TIMEOUT,
  )

  test(
    'progress shows the task description over a waiting line',
    async () => {
      const node = TaskOutputTool.renderToolUseProgressMessage!([{ data: { taskDescription: 'nightly build', taskType: 'local_bash' } }] as never, {} as never)
      const frame = await render(node, 'Waiting for task')
      const lines = frame.split('\n').map(l => l.trim()).filter(Boolean)
      expect(lines).toEqual(['nightly build', 'Waiting for task (esc to give additional instructions)'])
      const bare = await render(TaskOutputTool.renderToolUseProgressMessage!([] as never, {} as never), 'Waiting for task')
      expect(bare).not.toContain('nightly')
    },
    TIMEOUT,
  )

  const resultCases: Array<{ name: string; content: unknown; verbose?: boolean; shows: string[]; hides?: string[] }> = [
    { name: 'no task', content: { retrieval_status: 'timeout', task: null }, shows: ['No task output available'] },
    {
      name: 'no task, as JSON text',
      content: JSON.stringify({ retrieval_status: 'timeout', task: null }),
      shows: ['No task output available'],
    },
    {
      name: 'a shell shows its output like a Bash result',
      content: { retrieval_status: 'success', task: { task_id: 'b', task_type: 'local_bash', status: 'completed', description: 'd', output: 'compiled ok' } },
      shows: ['compiled ok'],
    },
    {
      name: 'a finished agent, collapsed',
      content: { retrieval_status: 'success', task: { task_id: 'a', task_type: 'local_agent', status: 'completed', description: 'audit', output: 'x', result: 'line one\nline two' } },
      shows: ['Read output (ctrl+o to expand)'],
      hides: ['line one'],
    },
    {
      name: 'a finished agent, verbose',
      verbose: true,
      content: {
        retrieval_status: 'success',
        task: { task_id: 'a', task_type: 'local_agent', status: 'failed', description: 'audit', output: 'x', result: 'line one\nline two', prompt: 'Audit the parser', error: 'ran out of turns' },
      },
      shows: ['audit (2 lines)', 'Audit the parser', 'line one', 'line two', 'Error:', 'ran out of turns'],
    },
    {
      name: 'a verbose agent with nothing to show',
      verbose: true,
      content: { retrieval_status: 'success', task: { task_id: 'a', task_type: 'local_agent', status: 'completed', description: 'quiet', output: '' } },
      shows: ['quiet (0 lines)'],
      hides: ['Error:'],
    },
    {
      name: 'an agent still running',
      content: { retrieval_status: 'timeout', task: { task_id: 'a', task_type: 'local_agent', status: 'running', description: 'audit', output: '' } },
      shows: ['Task is still running…'],
    },
    {
      name: 'an agent not ready',
      content: { retrieval_status: 'not_ready', task: { task_id: 'a', task_type: 'local_agent', status: 'pending', description: 'audit', output: '' } },
      shows: ['Task is still running…'],
    },
    {
      name: 'an agent whose read failed otherwise',
      content: { retrieval_status: 'error', task: { task_id: 'a', task_type: 'local_agent', status: 'failed', description: 'audit', output: '' } },
      shows: ['Task not ready'],
    },
    {
      name: 'another task type shows description, status and the start of its output',
      content: { retrieval_status: 'success', task: { task_id: 'd', task_type: 'dream', status: 'completed', description: 'dreaming', output: `${'z'.repeat(500)}TAIL` } },
      shows: ['dreaming [completed]', 'zzzz'],
      hides: ['TAIL'],
    },
    {
      name: 'another task type with no output',
      content: { retrieval_status: 'success', task: { task_id: 'd', task_type: 'dream', status: 'killed', description: 'dreaming', output: '' } },
      shows: ['dreaming [killed]'],
    },
  ]
  for (const c of resultCases) {
    test(
      `result: ${c.name}`,
      async () => {
        const node = TaskOutputTool.renderToolResultMessage!(c.content as never, [] as never, { verbose: c.verbose ?? false, theme: 'dark' } as never)
        const frame = await render(node, c.shows[0]!)
        const flat = frame.replace(/\s+/g, ' ')
        for (const text of c.shows) expect(flat, `${c.name}: ${text}`).toContain(text.replace(/\s+/g, ' '))
        for (const text of c.hides ?? []) expect(flat, `${c.name}: ${text}`).not.toContain(text)
      },
      TIMEOUT,
    )
  }

  test(
    'rejected and error results use the generic fallbacks',
    async () => {
      const rejected = await render(TaskOutputTool.renderToolUseRejectedMessage!({} as never, {} as never), f => f.trim() !== '')
      expect(rejected.trim().length).toBeGreaterThan(0)
      const failed = await render(TaskOutputTool.renderToolUseErrorMessage!('<tool_use_error>it broke</tool_use_error>' as never, { verbose: true } as never), 'it broke')
      expect(failed).toContain('it broke')
    },
    TIMEOUT,
  )
})
