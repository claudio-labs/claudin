/**
 * Cross-import audit for lazy-tool-registry candidates (ROADMAP 5.9).
 *
 * Static guard. For each candidate tool, scans the repo for VALUE imports
 * (i.e. `import { X }` — not `import type { X }`) and asserts the importer
 * set matches the recorded baseline.
 *
 * Why this exists:
 *   Lazy-gating a tool inside `src/tools.ts` only saves heap if NO other
 *   eagerly-loaded module also value-imports the tool. The previous review
 *   pass found that ~half the candidates are pulled into the boot path by
 *   `PermissionRequest.tsx` / `messages.ts` / `main.tsx` / `REPL.tsx` etc.,
 *   which silently defeats any `tools.ts` cleanup.
 *
 * How to use:
 *   1. Run the test. If it fails, look at the diff: a NEW importer means
 *      someone re-eagered a tool we worked to lazy-gate. Reject the change
 *      or migrate the new importer to a NAME constant first.
 *   2. When you de-eager a candidate (e.g. swap a value import for a NAME
 *      constant), update the baseline below to drop the now-clean importer.
 *   3. The `goal` field documents the post-refactor target. When `current`
 *      equals `goal`, that candidate is fully de-eagered.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SRC = resolve(REPO_ROOT, 'src')

type Candidate = {
  /** The module file (without extension) that exports the tool. */
  modulePath: string
  /** Files known to value-import this module today. Sorted. Excludes the tool's
   *  own subdirectory and any *.test.ts(x) / __tests__ paths. */
  current: string[]
  /** Post-refactor target: the only file that should value-import this
   *  module. For most candidates this is `src/tools.ts` (the registry). */
  goal: string[]
}

// Order: lowest-friction wins first (only tools.ts imports them today —
// the lazy-gate flips them to "fully clean" the moment we ship 5.9).
// Then progressively dirtier candidates that need cleanup PRs first.
const CANDIDATES: Candidate[] = [
  {
    modulePath: 'src/tools/TaskCreateTool/TaskCreateTool',
    current: ['src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/TaskGetTool/TaskGetTool',
    current: ['src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/TaskUpdateTool/TaskUpdateTool',
    current: ['src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/TaskListTool/TaskListTool',
    current: ['src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/EnterWorktreeTool/EnterWorktreeTool',
    current: ['src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/ExitWorktreeTool/ExitWorktreeTool',
    current: ['src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  // One extra value importer (ToolSelector). Easy refactor — name-constant swap.
  {
    modulePath: 'src/tools/TaskOutputTool/TaskOutputTool',
    current: ['src/components/agents/ToolSelector.tsx', 'src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/TaskStopTool/TaskStopTool',
    current: ['src/components/agents/ToolSelector.tsx', 'src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/WebSearchTool/WebSearchTool',
    current: ['src/components/agents/ToolSelector.tsx', 'src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  // ToolSearch is pulled by compact.ts as a value import — needs audit.
  {
    modulePath: 'src/tools/ToolSearchTool/ToolSearchTool',
    current: ['src/services/compact/compact.ts', 'src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/BriefTool/BriefTool',
    current: ['src/commands/brief.ts', 'src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  // AgentTool: only one cross-importer beyond tools.ts — REPLTool's
  // primitiveTools (REPL VM exposes Agent for inline calls).
  {
    modulePath: 'src/tools/AgentTool/AgentTool',
    current: ['src/tools.ts', 'src/tools/REPLTool/primitiveTools.ts'],
    goal: ['src/tools.ts'],
  },
  // Permission-request candidates: PermissionRequest.tsx uses identity-
  // checks (`case WebFetchTool:`). Pre-req PR: convert to name-based
  // switch. Sibling PermissionRequest components (e.g. WebFetchPermission
  // Request itself) also import the value — they only use `.name` /
  // `userFacingName` and could swap to NAME constants too.
  {
    modulePath: 'src/tools/WebFetchTool/WebFetchTool',
    current: [
      'src/components/agents/ToolSelector.tsx',
      'src/components/permissions/PermissionRequest.tsx',
      'src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx',
      'src/components/permissions/rules/PermissionRuleInput.tsx',
      'src/tools.ts',
    ],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/NotebookEditTool/NotebookEditTool',
    current: [
      'src/components/agents/ToolSelector.tsx',
      'src/components/permissions/NotebookEditPermissionRequest/NotebookEditPermissionRequest.tsx',
      'src/components/permissions/PermissionRequest.tsx',
      'src/tools.ts',
      'src/tools/REPLTool/primitiveTools.ts',
    ],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/SkillTool/SkillTool',
    current: [
      'src/components/permissions/PermissionRequest.tsx',
      'src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx',
      'src/tools.ts',
    ],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/AskUserQuestionTool/AskUserQuestionTool',
    current: [
      'src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx',
      'src/components/permissions/PermissionRequest.tsx',
      'src/tools.ts',
    ],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/EnterPlanModeTool/EnterPlanModeTool',
    current: ['src/components/permissions/PermissionRequest.tsx', 'src/tools.ts'],
    goal: ['src/tools.ts'],
  },
  // ExitPlanModeV2Tool — `ToolSelector.tsx` and `messages.ts` use
  // `${X.name}` only; both could swap to EXIT_PLAN_MODE_V2_TOOL_NAME.
  {
    modulePath: 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool',
    current: [
      'src/components/agents/ToolSelector.tsx',
      'src/components/permissions/PermissionRequest.tsx',
      'src/tools.ts',
      'src/utils/messages.ts',
    ],
    goal: ['src/tools.ts'],
  },
  // MCP listing — pulled by mcp/client.ts and ToolSelector.tsx.
  {
    modulePath: 'src/tools/ListMcpResourcesTool/ListMcpResourcesTool',
    current: [
      'src/components/agents/ToolSelector.tsx',
      'src/services/mcp/client.ts',
      'src/tools.ts',
    ],
    goal: ['src/tools.ts'],
  },
  {
    modulePath: 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool',
    current: [
      'src/components/agents/ToolSelector.tsx',
      'src/services/mcp/client.ts',
      'src/tools.ts',
    ],
    goal: ['src/tools.ts'],
  },
]

/**
 * Walk a directory recursively, returning all .ts/.tsx files. Skips:
 *  - directories named `node_modules`, `dist`, `coverage`, `__tests__`
 *  - files matching `*.test.ts(x)` (own-tests don't count as eager importers)
 *  - the candidate's own subdirectory (a tool importing itself is fine)
 */
function* walk(dir: string, skipDir?: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue
      if (entry === '__tests__') continue
      if (skipDir && full === skipDir) continue
      yield* walk(full, skipDir)
      continue
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue
    yield full
  }
}

/**
 * Find files that VALUE-import the given module. Distinguishes:
 *  - `import { X } from '...path...'`  → value import (counted)
 *  - `import type { X } from '...'`    → type import (NOT counted — erased)
 *  - `import { type X } from '...'`    → mixed: counted only if a non-type
 *                                        binding exists in the same braces
 *
 * Match is by suffix on the module path (so `'../../tools/X/X.js'` and
 * `'src/tools/X/X.js'` both hit). Strips trailing `.js` since TS rewrites
 * `.ts` → `.js` in import paths.
 */
function findValueImporters(modulePath: string): string[] {
  const moduleBasename = modulePath.split('/').pop()!
  const ownDir = resolve(REPO_ROOT, modulePath, '..')
  const importers: string[] = []

  // Regex: an import statement (multi-line tolerant) that ends with a from
  // clause whose path ends in our module path (with optional `.js`).
  // Matches both single- and double-quoted strings.
  const importRe = new RegExp(
    String.raw`import\s+(type\s+)?(\{[^}]*\}|[A-Za-z_$][\w$]*|\*\s+as\s+\w+)\s+from\s+['"]([^'"]*\/)?` +
      moduleBasename +
      String.raw`(\.js)?['"]`,
    'g',
  )

  for (const file of walk(SRC, ownDir)) {
    const text = readFileSync(file, 'utf-8')
    if (!text.includes(moduleBasename)) continue // fast reject

    let m: RegExpExecArray | null
    importRe.lastIndex = 0
    while ((m = importRe.exec(text))) {
      const isTypeOnly = m[1] === 'type '
      if (isTypeOnly) continue

      // Mixed-import case: `import { type Foo, Bar }` — value import IFF at
      // least one binding inside the braces lacks the `type` modifier.
      const bindings = m[2] ?? ''
      if (bindings.startsWith('{')) {
        const inside = bindings.slice(1, -1)
        const parts = inside.split(',').map(s => s.trim()).filter(Boolean)
        const hasValueBinding = parts.some(p => !p.startsWith('type '))
        if (!hasValueBinding) continue
      }

      importers.push(relative(REPO_ROOT, file).replaceAll('\\', '/'))
      break // one hit per file is enough
    }
  }

  return importers.sort()
}

describe('lazy-tool cross-import audit', () => {
  for (const candidate of CANDIDATES) {
    test(`${candidate.modulePath} — current importers match baseline`, () => {
      const actual = findValueImporters(candidate.modulePath)
      expect(actual).toEqual(candidate.current)
    })
  }

  test('candidates whose `current` already equals `goal` are fully de-eagered', () => {
    const cleanList = CANDIDATES.filter(
      c => JSON.stringify(c.current) === JSON.stringify(c.goal),
    ).map(c => c.modulePath)

    // After ROADMAP 5.9 ships, ALL candidates should appear in this list.
    // Today, only the candidates whose only value-importer is tools.ts
    // qualify — these are the safest bets for the first migration PR
    // because lazy-gating them in tools.ts saves heap immediately, with
    // zero pre-work elsewhere.
    expect(cleanList).toContain('src/tools/TaskCreateTool/TaskCreateTool')
    expect(cleanList).toContain('src/tools/TaskGetTool/TaskGetTool')
    expect(cleanList).toContain('src/tools/TaskUpdateTool/TaskUpdateTool')
    expect(cleanList).toContain('src/tools/TaskListTool/TaskListTool')
    expect(cleanList).toContain('src/tools/EnterWorktreeTool/EnterWorktreeTool')
    expect(cleanList).toContain('src/tools/ExitWorktreeTool/ExitWorktreeTool')
  })
})
