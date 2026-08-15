#!/usr/bin/env bun
// Cold-start retained heap bench.
//
// Measures the "floor" of memory: how much heap is permanently retained
// just by importing each subsystem, before any user turn runs. Each subsystem
// is loaded in a fresh subprocess so module deps don't bleed across rows.
//
// Used to validate the assumptions behind ROADMAP 5.9 (lazy tools registry)
// and 5.10 (lazy bash parser). If a subsystem here costs <5 MB at idle,
// making it lazy is cosmetic; if it costs >20 MB, it's a real win in
// --print/plan-mode/MCP-only sessions that never invoke it.
//
// Usage:
//   bun --expose-gc run scripts/profile/cold-start-retained-bench.ts
//   bun --expose-gc run scripts/profile/cold-start-retained-bench.ts --json

import { spawnSync } from 'node:child_process'

type Probe = {
  name: string
  importExpr: string
  description: string
}

// Each probe is a single dynamic import. We run a baseline (no import) first,
// then each probe in its own process; the delta is the retained cost.
const PROBES: Probe[] = [
  {
    name: 'baseline',
    importExpr: '',
    description: 'Just the empty Bun runtime + GC + measurement.',
  },
  {
    name: 'react',
    importExpr: `await import('react')`,
    description: 'React only.',
  },
  {
    name: 'ink',
    importExpr: `await import('ink')`,
    description: 'Ink TUI runtime (pulls React + reconciler).',
  },
  {
    name: 'zod/v4',
    importExpr: `await import('zod/v4')`,
    description: 'Zod schema validator (pulled by every Tool).',
  },
  {
    name: '@anthropic-ai/sdk',
    importExpr: `await import('@anthropic-ai/sdk')`,
    description: 'Anthropic SDK.',
  },
  {
    name: 'cli-highlight',
    importExpr: `await import('cli-highlight')`,
    description: 'Syntax highlighter (pulled by Markdown).',
  },
  {
    name: 'Tool.ts',
    importExpr: `await import('./src/Tool.ts')`,
    description: 'Tool type module — what every tool re-exports.',
  },
  {
    name: 'src/shared/log.ts',
    importExpr: `await import('./src/shared/log.ts')`,
    description: 'Logger.',
  },
  {
    name: 'src/agent/tools/toolResultCache',
    importExpr: `await import('./src/agent/tools/toolResultCache.ts')`,
    description: 'Imported directly by Tool.ts.',
  },
  {
    name: 'tools.ts (full registry)',
    importExpr: `await import('./src/tools.ts')`,
    description: '~30 statically-imported tools.',
  },
  {
    name: 'bash parser (utils/bash/*)',
    importExpr: `await import('./src/platform/bash/bashParser.ts')`,
    description: '~12.3k LoC: bashParser + ast + heredoc + treeSitter.',
  },
  {
    name: 'BashTool',
    importExpr: `await import('./src/tools/BashTool/BashTool.tsx')`,
    description: 'BashTool + UI + transitive deps.',
  },
  {
    name: 'FileReadTool',
    importExpr: `await import('./src/tools/FileReadTool/FileReadTool.tsx')`,
    description: 'Smaller tool — reference for "what one tool costs".',
  },
  // Per-candidate probes for ROADMAP 5.9. Each measures the retained heap
  // cost of a tool that the lazy registry would defer in --print / plan-mode
  // / MCP-only sessions. Compare Δheap vs baseline to estimate the upper
  // bound of savings if the tool is fully de-eagered (i.e. lazy-gate in
  // tools.ts AND no other eager importer). For tools with cross-importers
  // (see lazyToolImports.test.ts), real savings are smaller until those
  // cleanups land.
  {
    name: 'cand: NotebookEditTool',
    importExpr: `await import('./src/tools/NotebookEditTool/NotebookEditTool.ts')`,
    description: 'Lazy candidate — only used for .ipynb edits.',
  },
  {
    name: 'cand: WebFetchTool',
    importExpr: `await import('./src/tools/WebFetchTool/WebFetchTool.ts')`,
    description: 'Lazy candidate — model-invoked, ~1.5k LoC.',
  },
  {
    name: 'cand: WebSearchTool',
    importExpr: `await import('./src/tools/WebSearchTool/WebSearchTool.ts')`,
    description: 'Lazy candidate — biggest among non-hot tools (~3k LoC).',
  },
  {
    name: 'cand: SkillTool',
    importExpr: `await import('./src/tools/SkillTool/SkillTool.ts')`,
    description: 'Lazy candidate — only when /skill invoked.',
  },
  {
    name: 'cand: AskUserQuestionTool',
    importExpr: `await import('./src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx')`,
    description: 'Lazy candidate — power-use only.',
  },
  {
    name: 'cand: BriefTool',
    importExpr: `await import('./src/tools/BriefTool/BriefTool.ts')`,
    description: 'Lazy candidate — coordinator-mode primary channel.',
  },
  {
    name: 'cand: ToolSearchTool',
    importExpr: `await import('./src/tools/ToolSearchTool/ToolSearchTool.ts')`,
    description: 'Lazy candidate — gated by isToolSearchEnabledOptimistic.',
  },
  {
    name: 'cand: EnterPlanModeTool',
    importExpr: `await import('./src/tools/EnterPlanModeTool/EnterPlanModeTool.ts')`,
    description: 'Lazy candidate — plan-mode entry only.',
  },
  {
    name: 'cand: ExitPlanModeV2Tool',
    importExpr: `await import('./src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts')`,
    description: 'Lazy candidate — plan-mode exit only.',
  },
  {
    name: 'cand: EnterWorktreeTool',
    importExpr: `await import('./src/tools/EnterWorktreeTool/EnterWorktreeTool.ts')`,
    description: 'Lazy candidate — gated by isWorktreeModeEnabled().',
  },
  {
    name: 'cand: ExitWorktreeTool',
    importExpr: `await import('./src/tools/ExitWorktreeTool/ExitWorktreeTool.ts')`,
    description: 'Lazy candidate — gated by isWorktreeModeEnabled().',
  },
  {
    name: 'cand: TaskCreateTool',
    importExpr: `await import('./src/tools/TaskCreateTool/TaskCreateTool.ts')`,
    description: 'Lazy candidate — todoV2 family (one of 4).',
  },
  {
    name: 'cand: ListMcpResourcesTool',
    importExpr: `await import('./src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts')`,
    description: 'Lazy candidate — MCP resources only.',
  },
  {
    name: 'cand: AgentTool',
    importExpr: `await import('./src/tools/AgentTool/AgentTool.tsx')`,
    description: 'Lazy candidate (fronteira) — ~6.6k LoC, sub-agent driver.',
  },
  {
    name: 'openaiShim',
    importExpr: `await import('./src/services/api/openaiShim.ts')`,
    description: 'OpenAI-compatible translator (~2.2k LoC).',
  },
  {
    name: 'Markdown',
    importExpr: `await import('./src/terminal/markdown/Markdown.tsx')`,
    description: 'Streaming markdown renderer.',
  },
  {
    name: 'QueryEngine',
    importExpr: `await import('./src/agent/QueryEngine.ts')`,
    description: 'Core agent loop driver.',
  },
]

type Result = {
  name: string
  description: string
  rssBytes: number
  heapUsedBytes: number
  externalBytes: number
  importMs: number
}

function runProbe(probe: Probe): Result {
  // Each probe runs in a fresh bun subprocess so module graphs don't leak
  // across rows. The probe's stdout is JSON with the post-import memoryUsage.
  const child = `
    import { performance } from 'node:perf_hooks'
    function gc() { try { (globalThis).gc?.() } catch {} }
    gc(); gc()
    const t0 = performance.now()
    ${probe.importExpr}
    const importMs = performance.now() - t0
    gc(); gc()
    await new Promise(r => setTimeout(r, 50))
    gc()
    const m = process.memoryUsage()
    process.stdout.write(JSON.stringify({
      rssBytes: m.rss,
      heapUsedBytes: m.heapUsed,
      externalBytes: m.external,
      importMs,
    }))
  `
  const r = spawnSync('bun', ['--expose-gc', '-e', child], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 60_000,
  })
  if (r.status !== 0) {
    return {
      name: probe.name,
      description: probe.description,
      rssBytes: NaN,
      heapUsedBytes: NaN,
      externalBytes: NaN,
      importMs: NaN,
    }
  }
  const data = JSON.parse(r.stdout.trim()) as {
    rssBytes: number
    heapUsedBytes: number
    externalBytes: number
    importMs: number
  }
  return { name: probe.name, description: probe.description, ...data }
}

function fmt(n: number): string {
  if (Number.isNaN(n)) return '   ERR'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function main(): void {
  const json = process.argv.includes('--json')
  const results: Result[] = []
  for (const probe of PROBES) {
    if (!json) process.stderr.write(`probing ${probe.name}...\n`)
    results.push(runProbe(probe))
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  const baseline = results[0]!
  console.log(
    'subsystem'.padEnd(40) +
      ' ' +
      'rss'.padStart(9) +
      ' ' +
      'Δrss'.padStart(9) +
      ' ' +
      'heap'.padStart(9) +
      ' ' +
      'Δheap'.padStart(9) +
      ' ' +
      'external'.padStart(9) +
      ' ' +
      'import'.padStart(8),
  )
  console.log('-'.repeat(40 + 1 + 9 * 5 + 5 + 8))
  for (const r of results) {
    const dRss = r.rssBytes - baseline.rssBytes
    const dHeap = r.heapUsedBytes - baseline.heapUsedBytes
    console.log(
      r.name.padEnd(40) +
        ' ' +
        fmt(r.rssBytes).padStart(9) +
        ' ' +
        fmt(dRss).padStart(9) +
        ' ' +
        fmt(r.heapUsedBytes).padStart(9) +
        ' ' +
        fmt(dHeap).padStart(9) +
        ' ' +
        fmt(r.externalBytes).padStart(9) +
        ' ' +
        (Number.isNaN(r.importMs) ? '   ERR' : `${r.importMs.toFixed(0)} ms`).padStart(8),
    )
  }
  console.log('')
  console.log('Δrss / Δheap = retained cost vs baseline.')
  console.log('Each probe runs in a fresh subprocess — no cross-contamination.')
}

main()
