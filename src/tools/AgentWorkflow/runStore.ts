/**
 * Persistence for workflow runs — one JSON file per run under
 * `.claudin/workflows/.runs/<runId>.json`. Writes are atomic (temp file +
 * rename) so the board never observes a partial file; a run is single-writer
 * (its engine), so no cross-process lock is needed beyond that.
 */
import { randomUUID } from 'crypto'
import { readdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { isENOENT } from 'src/utils/errors.js'
import { logError } from 'src/utils/log.js'
import { getWorkflowRunsDir } from 'src/tools/AgentWorkflow/paths.js'
import { type RunState, RunStateSchema } from 'src/tools/AgentWorkflow/types.js'

// runIds are a 12-char slice of randomUUID() (hex + one hyphen). Constrain the
// charset so a model-supplied runId (WorkflowStatusTool) can never escape the
// .runs/ dir via `..`, `/`, or an absolute path.
const RUN_ID_RE = /^[a-f0-9-]{12}$/

function runPath(runId: string): string {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`invalid workflow runId: ${JSON.stringify(runId)}`)
  }
  return join(getWorkflowRunsDir(), `${runId}.json`)
}

async function atomicWrite(path: string, data: string): Promise<void> {
  // Include a random suffix so concurrent writers (per-worker progress persists
  // during a phase fan-out) never collide on the same tmp path within a ms.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
  // Run JSON can embed the user's task text and agent outputs — keep it 0600
  // rather than inheriting a permissive umask.
  await writeFile(tmp, data, { mode: 0o600 })
  await rename(tmp, path)
}

/** Create and persist a fresh run positioned at the workflow's first phase. */
export async function createRun(input: {
  workflow: string
  description?: string
  task: string
  firstStep: string
}): Promise<RunState> {
  const now = Date.now()
  const state: RunState = {
    runId: randomUUID().slice(0, 12),
    workflow: input.workflow,
    description: input.description ?? '',
    task: input.task,
    currentStep: input.firstStep,
    status: 'running',
    artifact: '',
    history: [],
    transitions: 0,
    refineCounts: {},
    totalTokens: 0,
    agentsInPhase: 0,
    agentsDone: 0,
    startedAt: now,
    updatedAt: now,
  }
  await writeRun(state)
  return state
}

export async function writeRun(state: RunState): Promise<void> {
  try {
    await atomicWrite(runPath(state.runId), JSON.stringify(state, null, 2))
  } catch (error) {
    logError(error)
    throw error
  }
}

export async function readRun(runId: string): Promise<RunState | null> {
  try {
    const raw = await readFile(runPath(runId), 'utf-8')
    const parsed = RunStateSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (isENOENT(error)) return null
    logError(error)
    return null
  }
}

/** All runs, newest first. Corrupt/partial files are skipped. */
export async function listRuns(): Promise<RunState[]> {
  let files: string[]
  try {
    files = await readdir(getWorkflowRunsDir())
  } catch (error) {
    if (isENOENT(error)) return []
    logError(error)
    return []
  }
  const runs: RunState[] = []
  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue
    const run = await readRun(file.slice(0, -'.json'.length))
    if (run) runs.push(run)
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt)
  return runs
}

export async function deleteRun(runId: string): Promise<void> {
  try {
    await unlink(runPath(runId))
  } catch (error) {
    if (isENOENT(error)) return
    logError(error)
  }
}

const DURATION = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`

/** Human-readable markdown summary of a run (the board's `s save` action). */
export function exportRunSummary(state: RunState): string {
  const lines: string[] = []
  lines.push(`# Workflow run: ${state.workflow}`)
  lines.push('')
  lines.push(`- Run: \`${state.runId}\``)
  lines.push(`- Status: **${state.status}**`)
  lines.push(`- Task: ${state.task}`)
  lines.push(
    `- ${state.history.length} phase(s) · ${state.transitions} transition(s) · ${state.totalTokens.toLocaleString()} tokens · ${DURATION(state.updatedAt - state.startedAt)}`,
  )
  lines.push('')
  for (const rec of state.history) {
    lines.push(`## Phase: ${rec.step}`)
    for (const a of rec.agents) {
      lines.push(
        `- ${a.failed ? '✗' : '✔'} \`${a.label}\` — ${a.model || 'model'} · ${a.tokens.toLocaleString()} tok · ${a.tools} tools · ${DURATION(a.ms)}`,
      )
    }
    if (rec.decision) {
      lines.push('')
      lines.push(
        `**Decision:** ${rec.decision.decision}${rec.decision.target ? ` → ${rec.decision.target}` : ''} — ${rec.decision.notes}`,
      )
    }
    if (rec.synthesis) {
      lines.push('')
      lines.push(rec.synthesis)
    }
    lines.push('')
  }
  if (state.artifact) {
    lines.push('## Final artifact')
    lines.push('')
    lines.push(state.artifact)
  }
  return lines.join('\n')
}
