/**
 * Not a real test — a runnable analysis. Maps claudin's per-turn context
 * overhead down to individual offenders so we know what to trim:
 *   1. built-in tool schemas, ranked by tokens (the "System tools" category)
 *   2. system-prompt sections, ranked by tokens
 *   3. (memory files come straight from `/context`, already per-file)
 *
 * Run: bun test scripts/bench/map-context-offenders.test.ts
 * It always passes; the value is the console output.
 */
import { test } from 'bun:test'
import { getAllBaseTools } from '../../src/tools/tools.js'
import { getSystemPrompt } from '../../src/agent/prompts/prompts.js'
import { roughTokenCountEstimation } from '../../src/shared/tokenEstimation.js'
import { measureToolSchemas } from '../measure-tool-schemas.ts'

const MODEL = 'claude-opus-4-7'
const tok = (s: string) => roughTokenCountEstimation(s)
const pad = (s: string, n: number) => s.padEnd(n)
const padN = (n: number, w: number) => String(n).padStart(w)

function bar(value: number, max: number, width = 24): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0
  return '█'.repeat(filled) + '·'.repeat(width - filled)
}

test('map context offenders', async () => {
  // ---- 1. Built-in tool schemas (anthropic engine) ----
  const { rows } = await measureToolSchemas({ engines: ['anthropic'] })
  const toolRows = rows
    .filter(r => r.engine === 'anthropic' && !r.error)
    .sort((a, b) => b.tokens - a.tokens)
  const toolTotal = toolRows.reduce((s, r) => s + r.tokens, 0)
  const maxTool = toolRows[0]?.tokens ?? 1

  console.error(`\n=== TOOL SCHEMAS (anthropic) — total ≈ ${toolTotal} tok over ${toolRows.length} tools ===`)
  for (const r of toolRows) {
    console.error(
      `${padN(r.tokens, 6)}  ${bar(r.tokens, maxTool)}  ${pad(r.name, 28)} (${padN(r.descriptionBytes, 6)}B desc)`,
    )
  }

  // ---- 2. System-prompt sections ----
  // MACRO.* is build-inlined via `define`; under bun test it's undefined.
  // Stub it so getSystemPrompt's MACRO.ISSUES_EXPLAINER etc. resolve.
  ;(globalThis as Record<string, unknown>).MACRO ??= new Proxy(
    {},
    { get: (_t, k) => `«${String(k)}»` },
  )
  const tools = getAllBaseTools()
  const promptParts = await getSystemPrompt(tools, MODEL)
  const fullPrompt = promptParts.join('\n')
  const promptTotal = tok(fullPrompt)

  // Split on top-level "# Heading" lines; everything before the first is "intro".
  const lines = fullPrompt.split('\n')
  const sections: { title: string; body: string[] }[] = [{ title: '(intro)', body: [] }]
  for (const line of lines) {
    if (/^#{1,2} \S/.test(line)) sections.push({ title: line.replace(/^#+ /, ''), body: [line] })
    else sections[sections.length - 1]!.body.push(line)
  }
  const secRows = sections
    .map(s => ({ title: s.title, tokens: tok(s.body.join('\n')) }))
    .filter(s => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  const maxSec = secRows[0]?.tokens ?? 1

  console.error(`\n=== SYSTEM PROMPT SECTIONS — total ≈ ${promptTotal} tok (${promptParts.length} parts) ===`)
  for (const s of secRows) {
    console.error(`${padN(s.tokens, 6)}  ${bar(s.tokens, maxSec)}  ${s.title.slice(0, 60)}`)
  }

  console.error('')
})
