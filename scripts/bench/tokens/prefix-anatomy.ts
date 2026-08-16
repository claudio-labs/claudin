#!/usr/bin/env bun
// Prefix anatomy: break down the CACHED prefix claudin sends every turn —
// system prompt (per block) + tool schemas (per tool) — in bytes and ~tokens.
// No network. This localizes the per-turn prefix cost (the offender behind a
// larger cached prefix vs upstream Claude Code).
//
// Run WITH the test preload so internal/stubbed deps resolve:
//   bun --preload ./src/stubs/test-preload.ts scripts/bench/tokens/prefix-anatomy.ts

// MACRO.* are build-time defines (inlined by scripts/build.ts). Running the
// source directly leaves them undefined, so polyfill before importing any module
// that reads them. A proxy returns a short placeholder for any field — byte sizes
// shift only trivially, which is fine for a prefix-size breakdown.
;(globalThis as any).MACRO ??= new Proxy({}, { get: (_t, p) => `<${String(p)}>` })

const MODEL = 'claude-sonnet-4-6'
const fmt = (n: number) => n.toLocaleString('en-US')

async function main() {
  // Dynamic imports AFTER the MACRO polyfill so module-eval-time reads succeed.
  const { getAllBaseTools } = await import('../../../src/tools/tools.js')
  const { getSystemPrompt } = await import('../../../src/agent/prompts/prompts.js')
  const { roughTokenCountEstimation } = await import('../../../src/shared/tokenEstimation.js')
  const { enableConfigs } = await import('../../../src/platform/config/config.js')
  const { measureToolSchemas } = await import('./measure-tool-schemas.ts')
  const tk = (s: string) => roughTokenCountEstimation(s)

  try { enableConfigs() } catch {}
  process.env.NODE_ENV = 'production'

  const tools = getAllBaseTools()
  const sysBlocks = await getSystemPrompt(tools, MODEL)

  // ---- system prompt ----
  let sysBytes = 0, sysTokens = 0
  const sysRows = sysBlocks.map((b, i) => {
    const bytes = Buffer.byteLength(b ?? '', 'utf8')
    const tokens = tk(b ?? '')
    sysBytes += bytes; sysTokens += tokens
    const head = (b ?? '').replace(/\s+/g, ' ').slice(0, 58)
    return { i, bytes, tokens, head }
  })

  console.log(`\n${'═'.repeat(74)}`)
  console.log(`PREFIX ANATOMY — claudin, model=${MODEL}`)
  console.log('═'.repeat(74))

  console.log(`\n■ SYSTEM PROMPT — ${sysBlocks.length} blocks, ${fmt(sysBytes)} bytes, ~${fmt(sysTokens)} tokens`)
  console.log(`  ${'#'.padStart(3)} ${'bytes'.padStart(8)} ${'~tok'.padStart(7)}  head`)
  for (const r of sysRows.sort((a, b) => b.tokens - a.tokens)) {
    console.log(`  ${String(r.i).padStart(3)} ${fmt(r.bytes).padStart(8)} ${fmt(r.tokens).padStart(7)}  "${r.head}"`)
  }

  // ---- tools ----
  const { rows, totalsByEngine } = await measureToolSchemas({ engines: ['anthropic'] })
  const toolTotals = totalsByEngine.get('anthropic')!
  console.log(`\n■ TOOL SCHEMAS — ${rows.length} tools, ${fmt(toolTotals.schemaBytes)} bytes, ~${fmt(toolTotals.tokens)} tokens`)

  // Tag which tools are claudin/coordinator extras vs a vanilla coding-agent set.
  const VANILLA = new Set(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit',
    'WebFetch', 'WebSearch', 'TodoWrite', 'Agent', 'ExitPlanMode', 'AskUserQuestion', 'Skill'])
  let extraTokens = 0
  console.log(`  ${'tool'.padEnd(16)} ${'~tok'.padStart(6)}  origin`)
  for (const r of rows) {
    const extra = !VANILLA.has(r.name)
    if (extra) extraTokens += r.tokens
    console.log(`  ${r.name.padEnd(16)} ${fmt(r.tokens).padStart(6)}  ${extra ? '★ claudin-extra' : 'core'}`)
  }

  // ---- totals ----
  const prefixTokens = sysTokens + toolTotals.tokens
  console.log(`\n${'─'.repeat(74)}`)
  console.log(`CACHED PREFIX TOTAL  ≈ ${fmt(prefixTokens)} tokens  (system ${fmt(sysTokens)} + tools ${fmt(toolTotals.tokens)})`)
  console.log(`  of which claudin-extra tools: ~${fmt(extraTokens)} tokens (${(100 * extraTokens / prefixTokens).toFixed(0)}% of prefix)`)
  console.log(`  measured per-turn cached read: claudin ~27.5k vs Claude Code ~17.1k (cache A/B bench)`)
  console.log(`  → every turn pays this prefix; trimming extras/system is a per-turn, per-subagent saving.`)
  console.log('─'.repeat(74) + '\n')
}

main().catch(e => { console.error(e); process.exit(1) })
