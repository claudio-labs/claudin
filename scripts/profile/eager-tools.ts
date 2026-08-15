#!/usr/bin/env bun
// Real eager-vs-deferred split: when ToolSearch deferral is active (default on
// genuine first-party Anthropic), only the EAGER tools carry a full schema in the
// cached prefix; deferred tools ship as tiny defer_loading stubs. This computes the
// ACTUAL eager prefix size using claudin's own isDeferredTool(), correcting the
// earlier "all 29 eager" over-count.
//
//   bun --preload ./src/stubs/test-preload.ts scripts/profile/eager-tools.ts

;(globalThis as any).MACRO ??= new Proxy({}, { get: (_t, p) => `<${String(p)}>` })
const fmt = (n: number) => n.toLocaleString('en-US')

async function main() {
  const { getAllBaseTools } = await import('../../src/tools.js')
  const { isDeferredTool } = await import('../../src/tools/ToolSearchTool/prompt.js')
  const { getToolSearchMode } = await import('../../src/services/tools/toolSearch.js')
  const { measureToolSchemas } = await import('../measure-tool-schemas.ts')
  const { enableConfigs } = await import('../../src/platform/config/config.js')
  try { enableConfigs() } catch {}
  process.env.NODE_ENV = 'production'

  let mode = 'unknown'
  try { mode = getToolSearchMode() } catch (e) { mode = 'err:' + (e as Error).message }
  console.log(`\ntool-search mode (default, ENABLE_TOOL_SEARCH unset): ${mode}`)
  console.log(`(on genuine first-party Anthropic + supported model, deferral is ACTIVE)\n`)

  const tools = getAllBaseTools()
  const { rows } = await measureToolSchemas({ engines: ['anthropic'] })
  const tok = new Map(rows.map(r => [r.name, r.tokens]))

  const eager: Array<[string, number]> = []
  const deferred: Array<[string, number]> = []
  for (const t of tools) {
    const tk = tok.get(t.name) ?? 0
    let d = false
    try { d = isDeferredTool(t as any) } catch {}
    ;(d ? deferred : eager).push([t.name, tk])
  }
  eager.sort((a, b) => b[1] - a[1])
  deferred.sort((a, b) => b[1] - a[1])
  const sum = (a: Array<[string, number]>) => a.reduce((n, [, t]) => n + t, 0)

  console.log(`■ EAGER (full schema in cached prefix) — ${eager.length} tools, ~${fmt(sum(eager))} tokens`)
  for (const [n, t] of eager) console.log(`   ${n.padEnd(18)} ${fmt(t).padStart(6)}`)
  console.log(`\n■ DEFERRED (defer_loading stub, NOT full schema) — ${deferred.length} tools, ~${fmt(sum(deferred))} tokens saved`)
  for (const [n, t] of deferred) console.log(`   ${n.padEnd(18)} ${fmt(t).padStart(6)}`)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Eager tool schemas in prefix:   ~${fmt(sum(eager))} tokens`)
  console.log(`Deferred (saved when active):   ~${fmt(sum(deferred))} tokens`)
  console.log(`If deferral were OFF (all eager): ~${fmt(sum(eager) + sum(deferred))} tokens`)
  console.log('─'.repeat(60) + '\n')
}
main().catch(e => { console.error(e); process.exit(1) })
