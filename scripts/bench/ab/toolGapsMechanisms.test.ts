import { describe, expect, test } from 'bun:test'
import { decide, respond } from './approver.ts'
import { dedicatedReadShare, mechanismsOf } from './toolGapsMechanisms.ts'

type Json = Record<string, unknown>
let seq = 0

/** An assistant record calling `name`, and the user record answering it. */
function call(name: string, input: Json, text: string, isError = false): Json[] {
  const id = `toolu_${++seq}`
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } },
  ]
}

const APPROVED = 'User has approved your plan. You can now start coding.'
const OUTLINE = "File '/ws/docs/SPEC.md' (205 lines) is large — showing a structural outline instead of the full contents."

describe('mechanismsOf — tasks after the plan', () => {
  test('a load and a TaskList before the first update are counted; calls before approval are not', () => {
    const m = mechanismsOf(
      [
        ...call('TaskList', {}, '#1 [pending] a'),
        ...call('ExitPlanMode', {}, APPROVED),
        ...call('ToolSearch', { query: 'select:TaskUpdate,TaskList' }, ''),
        ...call('TaskList', {}, '#1 [pending] a'),
        ...call('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1'),
        ...call('TaskList', {}, '#1 [in_progress] a'),
      ],
      [],
    )
    expect(m.taskToolSearchAfterPlan).toBe(1)
    expect(m.taskListBeforeFirstUpdate).toBe(1)
    expect(m.taskUpdates).toBe(1)
    expect(m.taskUpdateUnloadedOk).toBe(0)
  })

  test('a load that brings TaskStop along is a Task search, but not a task-only one', () => {
    const m = mechanismsOf(
      [
        ...call('ExitPlanMode', {}, APPROVED),
        ...call('ToolSearch', { query: 'select:TaskStop,TaskUpdate' }, ''),
        ...call('ToolSearch', { query: 'select:TaskUpdate,TaskList' }, ''),
      ],
      [],
    )
    expect(m.taskToolSearchAfterPlan).toBe(2)
    expect(m.taskOnlyToolSearchAfterPlan).toBe(1)
  })

  test('a TaskUpdate with no load counts as unloaded, by outcome', () => {
    const ok = mechanismsOf([...call('ExitPlanMode', {}, APPROVED), ...call('TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated')], [])
    expect(ok.taskUpdateUnloadedOk).toBe(1)
    const err = mechanismsOf(
      [...call('ExitPlanMode', {}, APPROVED), ...call('TaskUpdate', { taskId: '1' }, 'InputValidationError', true)],
      [],
    )
    expect(err.taskUpdateUnloadedErr).toBe(1)
  })

  test('a rejected plan opens no window', () => {
    const m = mechanismsOf([...call('ExitPlanMode', {}, 'The user rejected the plan', true), ...call('TaskList', {}, '')], [])
    expect(m.taskListBeforeFirstUpdate).toBe(0)
  })
})

describe('mechanismsOf — reads, processes, diffs, notes', () => {
  test('an outlined doc read again for its body counts once; code files do not count', () => {
    const m = mechanismsOf(
      [
        ...call('Read', { file_path: '/ws/docs/SPEC.md' }, OUTLINE),
        ...call('Read', { file_path: '/ws/docs/SPEC.md', offset: 1, limit: 205 }, '1→# Spec\n2→text'),
        ...call('Read', { file_path: '/ws/src/server.ts' }, "File '/ws/src/server.ts' (900 lines) is large — showing a structural outline"),
      ],
      [],
    )
    expect(m.docsOutlined).toBe(1)
    expect(m.docsOutlineThenBody).toBe(1)
  })

  test('process management by hand, TaskStop and the adoption note', () => {
    const m = mechanismsOf(
      [
        ...call('Bash', { command: 'sh scripts/start.sh' }, 'started\n(1 process left running — pid 9: bun src/server.ts — adopted as task b1)'),
        ...call('Bash', { command: 'kill 12345' }, ''),
        ...call('Bash', { command: 'pgrep -af "[b]un src/server"' }, ''),
        ...call('Bash', { command: 'ss -lntp | grep 4517' }, ''),
        ...call('Bash', { command: 'echo skill' }, ''),
        ...call('TaskStop', { task_id: 'b1' }, 'stopped'),
      ],
      [],
    )
    expect(m.processBash).toBe(3)
    expect(m.taskStops).toBe(1)
    expect(m.adoptedNotes).toBe(1)
  })

  test("a sub-agent's pivoted diff naming the Git tool, then a | cat re-run", () => {
    const m = mechanismsOf(
      [],
      [
        [
          ...call('Bash', { command: 'git diff main...feature/bulk' }, '7 files changed, +400/-20 (over 6000 chars — hunks omitted)\nAsk … Git({commands:["git diff -- <path>"]})'),
          ...call('Bash', { command: 'git diff main...feature/bulk -- src/bulk.ts | cat' }, 'diff …'),
        ],
      ],
    )
    expect(m.diffPivots).toBe(1)
    expect(m.diffPivotsNamingGitToBash).toBe(1)
    expect(m.diffCatReruns).toBe(1)
  })

  test('the file-tools note, followed or not, and the read share', () => {
    const note = '\n<system-reminder>\nThis command only reads or searches files, and Read/Grep do that without the shell:\n</system-reminder>'
    const m = mechanismsOf(
      [
        ...call('Bash', { command: 'cat src/a.ts' }, `x${note}`),
        ...call('Read', { file_path: '/ws/src/b.ts' }, '1→x'),
        ...call('Bash', { command: 'grep -n x src/a.ts' }, `x${note}`),
        ...call('Bash', { command: 'bun test' }, 'ok'),
      ],
      [],
    )
    expect(m.fileToolsNotes).toBe(2)
    expect(m.fileToolsNotesFollowed).toBe(1)
    expect(m.dedicatedReads).toBe(1)
    expect(m.bashReads).toBe(2)
    expect(dedicatedReadShare(m)).toBeCloseTo(100 / 3)
  })
})

describe('approver', () => {
  test('approves a plan, declines a question, allows the rest', () => {
    expect(decide('ExitPlanMode')).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(decide('AskUserQuestion').behavior).toBe('deny')
    expect(decide('Bash')).toEqual({ behavior: 'allow', updatedInput: {} })
  })

  test('speaks enough MCP to be listed and called', () => {
    expect(respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).toMatchObject({
      result: { capabilities: { tools: {} } },
    })
    expect(respond({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    const listed = respond({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } }
    expect(listed.result.tools.map(t => t.name)).toEqual(['allow'])
    const called = respond({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'allow', arguments: { tool_name: 'ExitPlanMode', input: {} } } }) as {
      result: { content: { text: string }[] }
    }
    expect(JSON.parse(called.result.content[0]!.text)).toEqual({ behavior: 'allow', updatedInput: {} })
  })
})
