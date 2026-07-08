import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, statSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Point the store at an isolated temp dir (bypasses the project-local paths
// resolver and its gitignore side effect).
const RUNS_DIR = mkdtempSync(join(tmpdir(), 'wf-runs-'))
mock.module('./paths.js', () => ({
  getWorkflowsDir: () => RUNS_DIR,
  getWorkflowRunsDir: () => RUNS_DIR,
}))

const { createRun, readRun, writeRun, listRuns, deleteRun, exportRunSummary } =
  await import('./runStore.js')

afterAll(async () => {
  mock.restore()
  await rm(RUNS_DIR, { recursive: true, force: true })
})

describe('runStore', () => {
  test('createRun persists and readRun round-trips', async () => {
    const run = await createRun({ workflow: 'dev-flow', task: 'do the thing', firstStep: 'development' })
    expect(run.runId).toHaveLength(12)
    const read = await readRun(run.runId)
    expect(read).not.toBeNull()
    expect(read!.workflow).toBe('dev-flow')
    expect(read!.currentStep).toBe('development')
    expect(read!.status).toBe('running')
  })

  test('writeRun overwrites and readRun sees the update', async () => {
    const run = await createRun({ workflow: 'w', task: 't', firstStep: 's' })
    await writeRun({ ...run, status: 'done', artifact: 'final' })
    const read = await readRun(run.runId)
    expect(read!.status).toBe('done')
    expect(read!.artifact).toBe('final')
  })

  test('readRun returns null for a missing run', async () => {
    expect(await readRun('nope123456ab')).toBeNull()
  })

  test('listRuns returns all runs newest-first', async () => {
    // Self-contained: create two runs with explicit timestamps and assert the
    // newer one sorts first, independent of runs written by sibling tests.
    const older = await createRun({ workflow: 'w', task: 't', firstStep: 's' })
    const newer = await createRun({ workflow: 'w', task: 't', firstStep: 's' })
    const base = Date.now()
    await writeRun({ ...older, updatedAt: base })
    await writeRun({ ...newer, updatedAt: base + 10_000 })
    const runs = await listRuns()
    const oi = runs.findIndex(r => r.runId === older.runId)
    const ni = runs.findIndex(r => r.runId === newer.runId)
    expect(ni).toBeGreaterThanOrEqual(0)
    expect(ni).toBeLessThan(oi) // newer appears before older
  })

  test('runId is charset-constrained: traversal ids read/delete as no-ops', async () => {
    // A model-supplied runId (WorkflowStatusTool) must not escape .runs/.
    expect(await readRun('../../etc/passwd')).toBeNull()
    expect(await readRun('a/b')).toBeNull()
    await deleteRun('../evil') // must not throw
  })

  test('run files are written 0600', async () => {
    const run = await createRun({ workflow: 'w', task: 'secret task', firstStep: 's' })
    const mode = statSync(join(RUNS_DIR, `${run.runId}.json`)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('deleteRun removes the run', async () => {
    const run = await createRun({ workflow: 'w', task: 't', firstStep: 's' })
    await deleteRun(run.runId)
    expect(await readRun(run.runId)).toBeNull()
  })

  test('exportRunSummary renders status, phases and artifact', () => {
    const now = Date.now()
    const md = exportRunSummary({
      runId: 'abc123def456',
      workflow: 'dev-flow',
      description: '',
      task: 'ship it',
      currentStep: 'done',
      status: 'done',
      artifact: 'the final result',
      history: [
        {
          step: 'development',
          stepIndex: 0,
          agents: [{ label: 'coder', model: 'Opus 4.8', tokens: 100, tools: 2, ms: 1500, output: 'x', failed: false }],
          synthesis: 'wrote it',
          decision: { decision: 'advance', notes: 'ok' },
          at: now,
        },
      ],
      transitions: 1,
      refineCounts: {},
      totalTokens: 100,
      agentsInPhase: 0,
      agentsDone: 0,
      startedAt: now,
      updatedAt: now + 1500,
    })
    expect(md).toContain('# Workflow run: dev-flow')
    expect(md).toContain('**done**')
    expect(md).toContain('## Phase: development')
    expect(md).toContain('coder')
    expect(md).toContain('the final result')
    expect(md).toContain('✔ `coder`')
    expect(md).toContain('**Decision:** advance — ok')
  })

  test('exportRunSummary marks failed agents, handback targets, and omits an empty artifact', () => {
    const now = Date.now()
    const md = exportRunSummary({
      runId: 'zzz999yyy888',
      workflow: 'dev-flow',
      description: '',
      task: 't',
      currentStep: 'development',
      status: 'running',
      artifact: '',
      history: [
        {
          step: 'code-review',
          stepIndex: 1,
          agents: [
            { label: 'reviewer', model: 'Opus 4.8', tokens: 10, tools: 0, ms: 200, output: '', failed: true },
          ],
          synthesis: 'needs work',
          decision: { decision: 'handback', target: 'development', notes: 'redo it' },
          at: now,
        },
      ],
      transitions: 2,
      refineCounts: {},
      totalTokens: 10,
      agentsInPhase: 0,
      agentsDone: 0,
      startedAt: now,
      updatedAt: now + 200,
    })
    expect(md).toContain('✗ `reviewer`')
    expect(md).toContain('**Decision:** handback → development — redo it')
    expect(md).toContain('needs work')
    // Empty artifact must not emit a Final artifact heading.
    expect(md).not.toContain('## Final artifact')
  })
})
