#!/usr/bin/env bun
/**
 * What the lossless summarizer (CLAUDIN_TOOL_RESULT_LOSSLESS) would have sent
 * in place of every cut the summarizer made in real sessions. Reads
 * transcripts only; spends nothing.
 *
 * A production build saves the original of each cut beside the transcript and
 * names it in the marker's `source=` (toolResultStorage.ts,
 * makeReversibleIfElided), so each one can be replayed through the current
 * rule with its tool's persistence line (`keepWholeUnderLine`, then the cut):
 * shipped as it came, regrouped (Grep, Glob), or cut after all because even
 * regrouped it would pass that line. A json-structural
 * cut saved its rows as JSON lines rather than the raw output, so it is
 * counted and not replayed; so is a cut whose file is gone.
 *
 * Run it with the test preload, which stubs what the imports reach outside
 * the bundle, and NODE_ENV=test, which lets getGlobalConfig() run outside the
 * app's boot:
 *
 *   NODE_ENV=test bun --preload ./src/stubs/test-preload.ts \
 *     scripts/bench/tokens/summarizer-lossless-replay.ts [--days=14] [--with-benches]
 *
 * `--with-benches` keeps the /tmp projects the A/B benches run in, left out by
 * default.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { existsSync, readFileSync } from 'fs'
import { basename } from 'path'
import { maybeSummarizeToolResult } from 'src/agent/tools/toolResultSummarizer.js'
import { getPersistenceThreshold, keepWholeUnderLine } from 'src/agent/tools/toolResultStorage.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { pad, padLeft, pct, projectDirs, toolCalls, transcriptFiles } from './transcriptCorpus'

const argv = process.argv.slice(2)
const days = Number(argv.find(a => a.startsWith('--days='))?.slice('--days='.length) ?? 14)
const withBenches = argv.includes('--with-benches')

/** Each summarized tool's declared maxResultSizeChars (its tool file). */
const DECLARED: Record<string, number> = {
  [BASH_TOOL_NAME]: 30_000,
  [GREP_TOOL_NAME]: 20_000,
  [GLOB_TOOL_NAME]: 100_000,
  [WEB_FETCH_TOOL_NAME]: 50_000,
  [AGENT_TOOL_NAME]: 100_000,
  [LEGACY_AGENT_TOOL_NAME]: 100_000,
}
const declaredFor = (tool: string) => DECLARED[tool] ?? (tool.startsWith('mcp__') ? 100_000 : null)
const isArrayTool = (tool: string) =>
  tool === AGENT_TOOL_NAME || tool === LEGACY_AGENT_TOOL_NAME || tool.startsWith('mcp__')

type Row = {
  cuts: number
  replayed: number
  notReplayed: number
  whole: number
  compacted: number
  stillCut: number
  oldChars: number
  newChars: number
}
const rows = new Map<string, Row>()
const addedBySession = new Map<string, number>()
const row = (tool: string): Row => {
  let r = rows.get(tool)
  if (!r) {
    r = { cuts: 0, replayed: 0, notReplayed: 0, whole: 0, compacted: 0, stillCut: 0, oldChars: 0, newChars: 0 }
    rows.set(tool, r)
  }
  return r
}

const dirs = projectDirs().filter(d => withBenches || !basename(d).startsWith('-tmp-'))
const files = transcriptFiles(dirs, days)

for (const call of toolCalls(files)) {
  if (!call.text.startsWith('<tool-result-summary')) continue
  const declared = declaredFor(call.tool)
  if (declared === null) continue
  const tool = call.tool.startsWith('mcp__') ? 'mcp__*' : call.tool
  const r = row(tool)
  r.cuts++
  const source = /^<tool-result-summary[^>]* source="([^"]+)"/.exec(call.text)?.[1]
  if (!source || call.text.includes('strategy="json-structural"') || !existsSync(source)) {
    r.notReplayed++
    continue
  }
  const original = readFileSync(source, 'utf8')
  const block: ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: 'toolu_replay',
    content: isArrayTool(call.tool) ? [{ type: 'text', text: original }] : original,
  }
  // processPreMappedToolResultBlock's chain, less the reversibility step,
  // which only adds `source=` to a cut: keep the two in step.
  const out =
    keepWholeUnderLine(block, call.tool, getPersistenceThreshold(declared)) ??
    maybeSummarizeToolResult(block, call.tool)
  const shipped = typeof out.content === 'string' ? out.content : original
  r.replayed++
  if (out === block) r.whole++
  else if (shipped.startsWith('<tool-result-compacted')) r.compacted++
  else r.stillCut++
  r.oldChars += call.chars
  r.newChars += shipped.length
  addedBySession.set(call.file, (addedBySession.get(call.file) ?? 0) + shipped.length - call.chars)
}

const kchars = (n: number) => `${(n / 1000).toFixed(1)}k`
console.log(`summarizer cuts over the last ${days} days: ${files.length} transcripts${withBenches ? '' : ' (benches left out)'}`)
console.log(
  [pad('tool', 12), padLeft('cuts', 6), padLeft('replayed', 9), padLeft('whole', 7), padLeft('compact', 8), padLeft('cut', 6), padLeft('chars before', 13), padLeft('after', 9), padLeft('Δ', 7)].join(' '),
)
const total: Row = { cuts: 0, replayed: 0, notReplayed: 0, whole: 0, compacted: 0, stillCut: 0, oldChars: 0, newChars: 0 }
for (const [tool, r] of [...rows].sort((a, b) => b[1].cuts - a[1].cuts)) {
  for (const k of Object.keys(total) as (keyof Row)[]) total[k] += r[k]
  console.log(
    [pad(tool, 12), padLeft(String(r.cuts), 6), padLeft(String(r.replayed), 9), padLeft(String(r.whole), 7), padLeft(String(r.compacted), 8), padLeft(String(r.stillCut), 6), padLeft(kchars(r.oldChars), 13), padLeft(kchars(r.newChars), 9), padLeft(pct(r.newChars - r.oldChars, r.oldChars), 7)].join(' '),
  )
}
console.log(
  [pad('all', 12), padLeft(String(total.cuts), 6), padLeft(String(total.replayed), 9), padLeft(String(total.whole), 7), padLeft(String(total.compacted), 8), padLeft(String(total.stillCut), 6), padLeft(kchars(total.oldChars), 13), padLeft(kchars(total.newChars), 9), padLeft(pct(total.newChars - total.oldChars, total.oldChars), 7)].join(' '),
)
const added = [...addedBySession.values()].sort((a, b) => a - b)
const at = (q: number) => added[Math.min(added.length - 1, Math.floor(q * added.length))] ?? 0
console.log(
  `\nsessions with a replayed cut: ${added.length}; chars added per session median ${kchars(at(0.5))}, p90 ${kchars(at(0.9))}, max ${kchars(added.at(-1) ?? 0)} (≈ chars/4 tokens, written once and read from cache after)`,
)
