import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePlanTasks, seedTasksFromPlan } from './planTasks.js'
import { listTasks } from './tasks.js'

describe('parsePlanTasks', () => {
  test('parses checkbox items with nested file/note lines into description', () => {
    const plan = `# Plan

## Tasks
- [ ] Add the parser module
  - files: src/utils/planTasks.ts
  - module-level regex
- [ ] Wire it into ExitPlanMode
  - files: src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts

## Verification
- run tests`

    expect(parsePlanTasks(plan)).toEqual([
      {
        subject: 'Add the parser module',
        description: '- files: src/utils/planTasks.ts\n- module-level regex',
      },
      {
        subject: 'Wire it into ExitPlanMode',
        description: '- files: src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts',
      },
    ])
  })

  test('supports numbered and plain-bullet items', () => {
    const plan = `## Tasks
1. First step
* Second step
- Third step`

    expect(parsePlanTasks(plan).map(t => t.subject)).toEqual([
      'First step',
      'Second step',
      'Third step',
    ])
  })

  test('matches a heading with a trailing parenthetical', () => {
    const plan = `## Tasks (implementation checklist)
- [ ] Only task`

    expect(parsePlanTasks(plan)).toEqual([
      { subject: 'Only task', description: '' },
    ])
  })

  test('stops at the next heading', () => {
    const plan = `## Tasks
- [ ] Task one

## Notes
- [ ] not a task`

    expect(parsePlanTasks(plan).map(t => t.subject)).toEqual(['Task one'])
  })

  test('returns [] when there is no Tasks section', () => {
    const plan = `# Plan

## Approach
- do the thing`

    expect(parsePlanTasks(plan)).toEqual([])
  })

  test('returns [] when the Tasks section has no items', () => {
    const plan = `## Tasks

(to be filled)

## Verification`

    // "(to be filled)" is not a list item, so no tasks.
    expect(parsePlanTasks(plan)).toEqual([])
  })

  test('ignores an example Tasks heading inside a fenced code block', () => {
    const plan = `## Format

\`\`\`
## Tasks
- [ ] <placeholder subject>
\`\`\`

## Tasks
- [ ] Real task`

    expect(parsePlanTasks(plan)).toEqual([
      { subject: 'Real task', description: '' },
    ])
  })

  test('is case-insensitive on the heading', () => {
    const plan = `### tasks
- [x] done-style checkbox still parses`

    expect(parsePlanTasks(plan)).toEqual([
      { subject: 'done-style checkbox still parses', description: '' },
    ])
  })

  test('handles CRLF line endings (Windows-authored plans)', () => {
    const plan =
      '## Tasks\r\n- [ ] First\r\n  - files: a.ts\r\n- [ ] Second\r\n'

    expect(parsePlanTasks(plan)).toEqual([
      { subject: 'First', description: '- files: a.ts' },
      { subject: 'Second', description: '' },
    ])
  })

  test('ignores non-indented prose between the heading and items', () => {
    const plan = `## Tasks
Here is an intro sentence that is not a task.
- [ ] Real task
Another stray line at column zero.
- [ ] Second task`

    expect(parsePlanTasks(plan)).toEqual([
      { subject: 'Real task', description: '' },
      { subject: 'Second task', description: '' },
    ])
  })
})

describe('seedTasksFromPlan', () => {
  const TASK_LIST_ID = 'plantasks-test'
  const PLAN = `## Tasks
- [ ] First task
  - files: a.ts
- [ ] Second task`

  let tmp: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of [
      'CLAUDIN_CONFIG_DIR',
      'CLAUDE_CODE_ENABLE_TASKS',
      'CLAUDE_CODE_TASK_LIST_ID',
    ]) {
      saved[k] = process.env[k]
    }
    tmp = mkdtempSync(join(tmpdir(), 'plantasks-'))
    process.env.CLAUDIN_CONFIG_DIR = tmp
    process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
    process.env.CLAUDE_CODE_TASK_LIST_ID = TASK_LIST_ID
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  test('seeds one pending task per item with source metadata', async () => {
    const n = await seedTasksFromPlan(PLAN)
    expect(n).toBe(2)

    const tasks = await listTasks(TASK_LIST_ID)
    expect(tasks.map(t => t.subject).sort()).toEqual([
      'First task',
      'Second task',
    ])
    expect(tasks.every(t => t.status === 'pending')).toBe(true)
    expect(tasks.every(t => t.metadata?.source === 'plan')).toBe(true)
  })

  test('dedups by subject on re-approval, adding only new items', async () => {
    expect(await seedTasksFromPlan(PLAN)).toBe(2)
    // Re-approving the same plan creates nothing new.
    expect(await seedTasksFromPlan(PLAN)).toBe(0)
    expect((await listTasks(TASK_LIST_ID)).length).toBe(2)

    // A refined plan only adds the genuinely new item.
    expect(await seedTasksFromPlan(`${PLAN}\n- [ ] Third task`)).toBe(1)
    expect((await listTasks(TASK_LIST_ID)).length).toBe(3)
  })

  test('returns 0 when the plan has no Tasks section', async () => {
    expect(await seedTasksFromPlan('# Plan\n\nno tasks here')).toBe(0)
    expect(await listTasks(TASK_LIST_ID)).toEqual([])
  })

  test('returns 0 (no-op) when TodoV2 is disabled', async () => {
    process.env.CLAUDE_CODE_ENABLE_TASKS = '0'
    // Non-interactive test session + disabled env → isTodoV2Enabled() false.
    expect(await seedTasksFromPlan(PLAN)).toBe(0)
  })
})
