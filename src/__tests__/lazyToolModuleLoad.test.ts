/**
 * Module-load assertion for the tool registry (ROADMAP 5.9).
 *
 * Spawns a fresh `bun` subprocess that:
 *   1. Registers a Bun plugin which records every `onResolve` call.
 *   2. Imports `getAllBaseTools` from `src/tools.ts` and calls it.
 *   3. Reports back the set of `tools/<Subdir>/` paths the resolver saw.
 *
 * The set is the empirical answer to "which tool modules does building the
 * registry actually pull in?" — the direct heap-leverage signal that the
 * static cross-import audit (lazyToolImports.test.ts) cannot give.
 *
 * Two assertions:
 *   - Current baseline: the loaded set today MUST equal the recorded
 *     baseline. If a NEW subdir appears, somebody re-eagered a tool and the
 *     test fails fast. If a subdir DISAPPEARS, lazy-gating worked — update
 *     the baseline downward.
 *   - Hot-path floor: a small subset (Bash, File IO, Glob, Grep, TodoWrite,
 *     Agent) MUST always be in the loaded set. This stays stable after the
 *     refactor.
 *
 * Why a subprocess? Bun's `plugin()` is process-global — registering it in
 * the test runner would intercept all other tests' imports too. Subprocess
 * isolation also gives us a clean module graph (no test runner state).
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const TOOLS_TS = resolve(REPO_ROOT, 'src', 'tools.ts')

/**
 * The probe that runs in the child subprocess. Returns JSON on stdout.
 * Inline (template-literal) so the test file is single-source — no extra
 * fixture file that can drift from the test.
 */
const PROBE_SOURCE = `
import { plugin } from 'bun'
const subdirs = new Set()
plugin({
  name: 'capture-loads',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const m = args.path.match(/(?:^|\\/)tools\\/([A-Z][A-Za-z0-9]+)\\//)
      if (m) subdirs.add(m[1])
      return null
    })
  },
})
const { getAllBaseTools } = await import(${JSON.stringify(TOOLS_TS)})
const tools = getAllBaseTools()
process.stdout.write(JSON.stringify({
  toolCount: tools.length,
  loadedSubdirs: [...subdirs].sort(),
}))
`

function probeLoadedSubdirs(): { toolCount: number; loadedSubdirs: string[] } {
  const r = spawnSync('bun', ['--preload', './src/stubs/test-preload.ts', '-e', PROBE_SOURCE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', NODE_NO_WARNINGS: '1' },
    timeout: 60_000,
  })
  if (r.status !== 0) {
    throw new Error(
      `probe subprocess failed (exit ${r.status})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    )
  }
  return JSON.parse(r.stdout.trim())
}

/**
 * Hot-path tools — always loaded by `getAllBaseTools()` regardless of any
 * lazy-gating, because they're either statically used by other modules in
 * the registry construction OR they're the canonical "you always need these"
 * tools (Bash, file IO, search). The lazy refactor MUST keep these loaded.
 */
const HOT_PATH_FLOOR = [
  'AgentTool',
  'BashTool',
  'FileEditTool',
  'FileReadTool',
  'FileWriteTool',
  'GlobTool',
  'GrepTool',
  'TodoWriteTool',
] as const

/**
 * Current baseline (ROADMAP 5.9 NOT YET IMPLEMENTED). Captured by running
 * the probe against the unrefactored `tools.ts`. After the refactor, this
 * list MUST shrink. The candidates from `lazyToolImports.test.ts` should
 * drop out of this set as they're lazy-gated.
 *
 * To regenerate after a refactor:
 *   bun test src/__tests__/lazyToolModuleLoad.test.ts -t baseline 2>&1 \\
 *     | grep -A 100 'loadedSubdirs:'
 */
const CURRENT_BASELINE = [
  'AgentTool',
  'AgentWorkflow',
  'ApplyPatchTool',
  'AskUserQuestionTool',
  'BashTool',
  'BriefTool',
  'EnterPlanModeTool',
  'EnterWorktreeTool',
  'ExitPlanModeTool',
  'ExitWorktreeTool',
  'FileEditTool',
  'FileReadTool',
  'FileWriteTool',
  'GlobTool',
  'GrepTool',
  'LSPTool',
  'ListMcpResourcesTool',
  'MCPTool',
  'McpAuthTool',
  'MonitorTool',
  'NotebookEditTool',
  'PowerShellTool',
  'REPLTool',
  'ReadMcpResourceTool',
  'ReportFindingsTool',
  'RunTestsTool',
  'ScheduleCronTool',
  'ScheduleWakeupTool',
  'SendMessageTool',
  'SkillTool',
  'SleepTool',
  'SyntheticOutputTool',
  'TaskCreateTool',
  'TaskGetTool',
  'TaskListTool',
  'TaskOutputTool',
  'TaskStopTool',
  'TaskUpdateTool',
  'TeamCreateTool',
  'TeamDeleteTool',
  'TodoWriteTool',
  'ToolSearchTool',
  'VerifyPlanExecutionTool',
  'WebFetchTool',
  'WebSearchTool',
  'WorkflowTool',
]

describe('tool registry module-load measurement', () => {
  test('getAllBaseTools resolves the recorded baseline of tool subdirs', () => {
    const { toolCount, loadedSubdirs } = probeLoadedSubdirs()
    expect(toolCount).toBeGreaterThan(0)
    expect(loadedSubdirs).toEqual(CURRENT_BASELINE)
  })

  test('hot-path floor is loaded (post-refactor invariant)', () => {
    const { loadedSubdirs } = probeLoadedSubdirs()
    for (const required of HOT_PATH_FLOOR) {
      expect(loadedSubdirs).toContain(required)
    }
  })

  // After ROADMAP 5.9, the candidates from `lazyToolImports.test.ts` should
  // NO LONGER appear in the loaded set unless their identity is invoked.
  // That assertion is intentionally NOT enforced today — it's the "after"
  // measurement that validates the refactor landed. Uncomment + run when
  // the lazy registry ships.
  test.skip('FUTURE: lazy candidates are not loaded by mere registry construction', () => {
    const { loadedSubdirs } = probeLoadedSubdirs()
    const shouldBeLazy = [
      'EnterWorktreeTool',
      'ExitWorktreeTool',
      'ListMcpResourcesTool',
      'NotebookEditTool',
      'ReadMcpResourceTool',
      'TaskCreateTool',
      'TaskGetTool',
      'TaskListTool',
      'TaskOutputTool',
      'TaskStopTool',
      'TaskUpdateTool',
      'ToolSearchTool',
      'WebFetchTool',
      'WebSearchTool',
    ]
    for (const lazy of shouldBeLazy) {
      expect(loadedSubdirs).not.toContain(lazy)
    }
  })
})
