// Deterministic, headless driver for a single workflow run (R3).
//
// This is the run primitive behind `claudin workflow run`. It does NOT go
// through the model-driven `-p` query loop: it builds a headless ToolUseContext
// directly (mirroring src/entrypoints/mcp.ts, which executes real tools outside
// the REPL) and calls runWorkflow() itself, so the dispatch is code — not a
// model turn. Determinism (exit code, report) comes from the returned RunState.
//
// Optionally runs inside an isolated agent worktree (createAgentWorktree +
// chdir) and opens a PR from the resulting branch. The worktree is the safe
// default for the watcher, which runs while the user works in the same repo.

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppState } from 'src/state/AppStateStore.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getKnownAgentTypes } from 'src/tools/AgentWorkflow/agentTypes.js'
import { runWorkflow } from 'src/tools/AgentWorkflow/engine.js'
import {
  loadWorkflowDef,
  validateWorkflowAgents,
  validateWorkflowStructure,
} from 'src/tools/AgentWorkflow/loadWorkflows.js'
import { exportRunSummary } from 'src/tools/AgentWorkflow/runStore.js'
import { getTools } from 'src/tools.js'
import { createAbortController } from 'src/utils/abortController.js'
import { getCwd } from 'src/utils/cwd.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { logError } from 'src/utils/log.js'
import { ensureModelStringsInitialized } from 'src/utils/model/modelStrings.js'
import { getMainLoopModel } from 'src/utils/model/model.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { setCwd } from 'src/utils/Shell.js'
import {
  createAgentWorktree,
  removeAgentWorktree,
} from 'src/utils/worktree.js'

import {
  commitAllChanges,
  createPullRequest,
  getDefaultBranch,
  hasUncommittedChanges,
  pushBranch,
} from './githubSource.js'

export type RunWorkflowHeadlessOptions = {
  workflow: string
  task: string
  /** Run inside an isolated agent worktree (branch worktree-<slug>). */
  worktree: boolean
  /** After a successful run, commit + push the branch and open a PR. */
  pr: boolean
  /** PR base branch. Defaults to the remote default branch. */
  base?: string
  /** Where to write the markdown report. Defaults to a tmp file. */
  report?: string
}

const SLUG_SANITIZE_RE = /[^a-zA-Z0-9._-]+/g
const READ_FILE_STATE_CACHE_SIZE = 100
const READ_FILE_STATE_CACHE_BYTES = 25 * 1024 * 1024

/**
 * Run one workflow to completion. Returns a process exit code: 0 when the run
 * reaches `done`, non-zero otherwise (2 = bad/invalid workflow, 1 = run did
 * not finish `done`). Never throws for expected failures.
 */
export async function runWorkflowHeadless(
  opts: RunWorkflowHeadlessOptions,
): Promise<number> {
  // Normalize cwd — subcommands don't call setup(), so getCwd() may be unset.
  setCwd(process.cwd())
  const originalCwd = getCwd()

  // Validate + load before any side effect (worktree, chdir).
  const def = await loadWorkflowDef(opts.workflow)
  if (!def) {
    process.stderr.write(`Workflow "${opts.workflow}" not found.\n`)
    return 2
  }
  const known = await getKnownAgentTypes(originalCwd)
  const errors = [
    ...validateWorkflowStructure(def),
    ...validateWorkflowAgents(def, known),
  ]
  if (errors.length > 0) {
    process.stderr.write(
      `Workflow "${def.name}" is invalid:\n- ${errors.join('\n- ')}\n`,
    )
    return 2
  }

  let worktree: Awaited<ReturnType<typeof createAgentWorktree>> | null = null
  if (opts.worktree) {
    const slug = `wf-${opts.workflow.replace(SLUG_SANITIZE_RE, '-')}-${Date.now().toString(36)}`
    try {
      worktree = await createAgentWorktree(slug)
      setCwd(worktree.worktreePath)
      process.chdir(worktree.worktreePath)
    } catch (e) {
      logError(
        `failed to create agent worktree: ${e instanceof Error ? e.message : String(e)}`,
      )
      process.stderr.write(
        `Failed to create worktree: ${e instanceof Error ? e.message : String(e)}\n`,
      )
      // If create succeeded but chdir threw, the worktree exists and the outer
      // finally never runs — clean it up here so it doesn't orphan.
      if (worktree) {
        setCwd(originalCwd)
        try {
          process.chdir(originalCwd)
        } catch {}
        await removeAgentWorktree(
          worktree.worktreePath,
          worktree.worktreeBranch,
          worktree.gitRoot,
          worktree.hookBased,
        )
      }
      return 2
    }
  }

  try {
    await ensureModelStringsInitialized()
    const { toolUseContext, canUseTool } = buildHeadlessContext()
    const final = await runWorkflow({
      def,
      task: opts.task,
      toolUseContext,
      canUseTool,
      signal: toolUseContext.abortController.signal,
    })

    const reportPath =
      opts.report ?? join(tmpdir(), `claudin-workflow-${final.runId}.md`)
    await writeFile(reportPath, exportRunSummary(final), 'utf8')
    process.stdout.write(`workflow ${final.runId} ${final.status}\n`)

    if (opts.pr && final.status === 'done') {
      await openPullRequest(def.name, opts, reportPath, worktree)
    }

    return final.status === 'done' ? 0 : 1
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    logError(`workflow run failed: ${detail}`)
    process.stderr.write(`Workflow run failed: ${detail}\n`)
    return 1
  } finally {
    if (worktree) {
      // chdir out before removing the worktree we're standing in.
      setCwd(originalCwd)
      process.chdir(originalCwd)
      await removeAgentWorktree(
        worktree.worktreePath,
        worktree.worktreeBranch,
        worktree.gitRoot,
        worktree.hookBased,
      )
    }
  }
}

function buildHeadlessContext(): {
  toolUseContext: ToolUseContext
  canUseTool: typeof hasPermissionsToUseTool
} {
  // Background agents run unattended and can't answer a permission prompt, so
  // the session runs in bypassPermissions. Workers still clamp down per their
  // own agent definition (engine's clampMode).
  const toolPermissionContext: ToolPermissionContext = {
    mode: 'bypassPermissions',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
    shouldAvoidPermissionPrompts: true,
  }
  const tools = getTools(toolPermissionContext)
  const appState: AppState = { ...getDefaultAppState(), toolPermissionContext }

  const toolUseContext: ToolUseContext = {
    abortController: createAbortController(),
    options: {
      commands: [],
      tools,
      mainLoopModel: getMainLoopModel(),
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
      READ_FILE_STATE_CACHE_BYTES,
    ),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }

  return { toolUseContext, canUseTool: hasPermissionsToUseTool }
}

async function openPullRequest(
  workflowName: string,
  opts: RunWorkflowHeadlessOptions,
  reportPath: string,
  worktree: Awaited<ReturnType<typeof createAgentWorktree>> | null,
): Promise<void> {
  const branch = worktree?.worktreeBranch ?? (await currentBranch())
  if (!branch) {
    logError('cannot open PR: no branch to push')
    return
  }
  const taskSummary = opts.task.replace(/\s+/g, ' ').trim()
  if (await hasUncommittedChanges()) {
    if (worktree) {
      // Inside an isolated worktree the whole tree is ours to commit.
      if (!(await commitAllChanges(`${workflowName}: ${taskSummary}`))) return
    } else {
      // On the user's live branch, never `git add -A` their working tree —
      // push only what's already committed and warn about the rest.
      process.stderr.write(
        'Uncommitted changes are not included in the PR (running without --worktree). Commit them or use --worktree.\n',
      )
    }
  }
  if (!(await pushBranch(branch))) return
  const base = opts.base ?? (await getDefaultBranch())
  const title = `[claudin] ${workflowName}: ${truncate(taskSummary, 60)}`
  const url = await createPullRequest({
    base,
    head: branch,
    title,
    bodyFile: reportPath,
  })
  if (url) process.stdout.write(`PR: ${url}\n`)
}

async function currentBranch(): Promise<string | null> {
  const { execFileNoThrow } = await import('src/utils/execFileNoThrow.js')
  const { stdout, code } = await execFileNoThrow('git', [
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ])
  if (code !== 0) return null
  const branch = stdout.trim()
  return branch && branch !== 'HEAD' ? branch : null
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}
