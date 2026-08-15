#!/usr/bin/env bun
// Dump claudin's system prompt as plain text, for diffing against Claude Code's.
//
//   # source-side, every feature() folded OFF (see the warning below)
//   bun --preload ./src/stubs/test-preload.ts scripts/profile/dump-system-prompt.ts
//
//   # the prompt the built binary actually sends — needs `bun run build` first
//   bun scripts/profile/dump-system-prompt.ts --flags=ship [--model=claude-opus-5]
//
// Both modes print TWO prompts: the main-session one (getSystemPrompt) and the
// sub-agent one (enhanceSystemPromptWithEnvDetails). They share almost nothing
// — the sub-agent `Notes:` block and its env section are assembled on a
// different path — so a parity pass that reads only the first reports
// sub-agent steering as missing. That is the same trap as the flag-off dump
// below, one layer down.
//
// Why two modes: `feature()` cannot be overridden at runtime. Bun ≥1.3.9
// resolves `bun:bundle` natively before any plugin or `mock.module` sees it —
// the `mock.module('bun:bundle', …)` in src/stubs/test-preload.ts is inert, and
// verified so (2026-08-12). Under `bun run`, every flag reads false. Only the
// build resolves them, by rewriting the source in place (scripts/build.ts), so
// the honest way to see the shipped prompt is to ask the built bundle for it.
//
// The default mode is therefore missing WORK_CONTRACT, ANTI_NARRATION,
// TOOL_BATCHING_NUDGE, LEAN_TOOL_PROMPTS and every other shipped flag — roughly
// 800 tokens of steering. A parity pass that reads it as ground truth reports
// shipped sections as missing; that has already happened once, on the parity
// pass against Claude Code that this mode was added for. The header line names
// the mode so a dump can never be quoted without its provenance.
//
// One difference between the modes beyond the flags: the source mode renders
// with the full tool registry (`getAllBaseTools()`), the bundle's
// `--dump-system-prompt` fast path renders with an empty one. Tool-dependent
// sections (MCP instructions) differ accordingly.
//
// Network: the source mode makes none. `--flags=ship` runs the real CLI, which
// fires two Grove prefetch GETs before the fast path when the active profile is
// on the anthropic transport (src/platform/entrypoints/cli.tsx) — nothing is sent, but
// it is not an offline command.

import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { loadShippedFeatureFlags } from '../parseFeatureFlags'

;(globalThis as any).MACRO ??= new Proxy({}, { get: (_t, p) => `<MACRO.${String(p)}>` })

const MODEL_ARG_PREFIX = '--model='
const REPO_ROOT = join(import.meta.dir, '..', '..')
const BUNDLE = join(REPO_ROOT, 'dist/cli.mjs')

// Everything whose edit changes a rendered prompt. Not just prompts.ts: the
// context blocks, the AGENTS.md/rules loader, every per-tool prompt and the
// sub-agent notices all land in one of the two dumps below.
const PROMPT_SOURCE_GLOBS = [
  'scripts/build.ts',
  'src/constants/**/*.ts',
  'src/agent/context.ts',
  'src/memory/instructions/claudemd.ts',
  'src/tools/*/prompt.ts',
  'src/tools/AgentTool/forkSubagent.ts',
]

const args = process.argv.slice(2)
const wantsShipFlags = args.includes('--flags=ship')
const modelArg = args.find(a => a.startsWith(MODEL_ARG_PREFIX))?.slice(MODEL_ARG_PREFIX.length)

function stalePromptSources(builtAt: number): string[] {
  const stale: string[] = []
  for (const pattern of PROMPT_SOURCE_GLOBS) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT, onlyFiles: true })) {
      if (statSync(join(REPO_ROOT, rel)).mtimeMs > builtAt) stale.push(rel)
    }
  }
  return stale.sort()
}

function spawnBundleDump(extraArgs: string[]): number {
  const { exitCode } = Bun.spawnSync({
    cmd: [
      'node',
      BUNDLE,
      '--dump-system-prompt',
      ...(modelArg !== undefined ? ['--model', modelArg] : []),
      ...extraArgs,
    ],
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  return exitCode ?? 1
}

function dumpFromBundle(): number {
  if (!existsSync(BUNDLE)) {
    console.error(`--flags=ship needs the bundle: ${BUNDLE} does not exist. Run \`bun run build\`.`)
    return 1
  }
  // A dump older than the prompt source is the same trap in a new shape. This
  // is an mtime comparison, so a branch switch or a fresh checkout rewrites
  // mtimes and reports staleness that is not real — it over-warns on purpose.
  const builtAt = statSync(BUNDLE).mtimeMs
  const stale = stalePromptSources(builtAt)
  if (stale.length > 0) {
    const shown = stale.slice(0, 5).join(', ')
    const rest = stale.length > 5 ? ` (+${stale.length - 5} more)` : ''
    console.error(
      `warning: dist/cli.mjs predates ${shown}${rest} — run \`bun run build\` for a current dump (mtime-based, so a branch switch false-positives).`,
    )
  }

  const provenance = `source=dist/cli.mjs built=${new Date(builtAt).toISOString()} model=${modelArg ?? '<session default>'} tools=none`
  console.log(`# flags=ship prompt=main ${provenance}`)
  const mainExit = spawnBundleDump([])
  if (mainExit !== 0) return mainExit

  console.log(`\n# flags=ship prompt=subagent ${provenance}`)
  return spawnBundleDump(['--subagent'])
}

async function dumpFromSource(): Promise<void> {
  const { getAllBaseTools } = await import('../../src/tools/tools.js')
  const { getSystemPrompt, enhanceSystemPromptWithEnvDetails, DEFAULT_AGENT_PROMPT } =
    await import('../../src/constants/prompts.js')
  const { enableConfigs } = await import('../../src/platform/config/config.js')
  try { enableConfigs() } catch {}
  process.env.NODE_ENV = 'production'
  const model = modelArg ?? 'claude-sonnet-4-6'

  const foldedOff = Object.entries(loadShippedFeatureFlags())
    .filter(([, on]) => on)
    .map(([name]) => name)
  console.log(`# flags=off source=src model=${model} tools=all`)
  console.log(`# MISSING vs the shipped build (${foldedOff.length} flags read false here): ${foldedOff.join(', ')}`)

  printBlocks('MAIN', await getSystemPrompt(getAllBaseTools(), model))
  printBlocks(
    'SUBAGENT',
    await enhanceSystemPromptWithEnvDetails([DEFAULT_AGENT_PROMPT], model),
  )
}

function printBlocks(label: string, blocks: string[]): void {
  console.log(`\n╔══ ${label} PROMPT ${'═'.repeat(40)}`)
  blocks.forEach((b, i) => {
    console.log(`\n┌── BLOCK ${i} ${'─'.repeat(50)}`)
    console.log(b)
  })
}

if (wantsShipFlags) {
  process.exit(dumpFromBundle())
}
dumpFromSource().catch(e => { console.error(e); process.exit(1) })
