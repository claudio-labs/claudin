#!/usr/bin/env bun
// Dump claudin's system prompt as plain text, for diffing against Claude Code's.
// No network.
//
//   # source-side, every feature() folded OFF (see the warning below)
//   bun --preload ./src/stubs/test-preload.ts scripts/profile/dump-system-prompt.ts
//
//   # the prompt the built binary actually sends — needs `bun run build` first
//   bun scripts/profile/dump-system-prompt.ts --flags=ship [--model=claude-opus-5]
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
// shipped sections as missing; that has already happened once
// (docs/tech/prompt-parity-vs-claude-code.md §0). The header line names the mode
// so a dump can never be quoted without its provenance.
//
// One difference between the modes beyond the flags: the source mode renders
// with the full tool registry (`getAllBaseTools()`), the bundle's
// `--dump-system-prompt` fast path renders with an empty one. Tool-dependent
// sections (MCP instructions) differ accordingly.

import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { loadShippedFeatureFlags } from '../parseFeatureFlags'

;(globalThis as any).MACRO ??= new Proxy({}, { get: (_t, p) => `<MACRO.${String(p)}>` })

const MODEL_ARG_PREFIX = '--model='
const REPO_ROOT = join(import.meta.dir, '..', '..')
const BUNDLE = join(REPO_ROOT, 'dist/cli.mjs')

const args = process.argv.slice(2)
const wantsShipFlags = args.includes('--flags=ship')
const modelArg = args.find(a => a.startsWith(MODEL_ARG_PREFIX))?.slice(MODEL_ARG_PREFIX.length)

function dumpFromBundle(): number {
  if (!existsSync(BUNDLE)) {
    console.error(`--flags=ship needs the bundle: ${BUNDLE} does not exist. Run \`bun run build\`.`)
    return 1
  }
  // A dump older than the prompt source is the same trap in a new shape.
  const builtAt = statSync(BUNDLE).mtimeMs
  const sources = ['src/constants/prompts.ts', 'scripts/build.ts'].map(p => join(REPO_ROOT, p))
  const stale = sources.filter(p => existsSync(p) && statSync(p).mtimeMs > builtAt)
  if (stale.length > 0) {
    console.error(`warning: dist/cli.mjs predates ${stale.join(', ')} — run \`bun run build\` for a current dump.`)
  }

  console.log(
    `# flags=ship source=dist/cli.mjs built=${new Date(builtAt).toISOString()} model=${modelArg ?? '<session default>'} tools=none`,
  )
  const { exitCode } = Bun.spawnSync({
    cmd: [
      'node',
      BUNDLE,
      '--dump-system-prompt',
      ...(modelArg !== undefined ? ['--model', modelArg] : []),
    ],
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  return exitCode ?? 1
}

async function dumpFromSource(): Promise<void> {
  const { getAllBaseTools } = await import('../../src/tools.js')
  const { getSystemPrompt } = await import('../../src/constants/prompts.js')
  const { enableConfigs } = await import('../../src/utils/config.js')
  try { enableConfigs() } catch {}
  process.env.NODE_ENV = 'production'
  const model = modelArg ?? 'claude-sonnet-4-6'

  const foldedOff = Object.entries(loadShippedFeatureFlags())
    .filter(([, on]) => on)
    .map(([name]) => name)
  console.log(`# flags=off source=src model=${model} tools=all`)
  console.log(`# MISSING vs the shipped build (${foldedOff.length} flags read false here): ${foldedOff.join(', ')}`)

  const blocks = await getSystemPrompt(getAllBaseTools(), model)
  blocks.forEach((b, i) => {
    console.log(`\n┌── BLOCK ${i} ${'─'.repeat(50)}`)
    console.log(b)
  })
}

if (wantsShipFlags) {
  process.exit(dumpFromBundle())
}
dumpFromSource().catch(e => { console.error(e); process.exit(1) })
