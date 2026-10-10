#!/usr/bin/env bun
/**
 * What the tool-result path sends today in place of every cut the old
 * summarizer made in real sessions. Reads transcripts only; spends nothing.
 *
 * Until 2026-10-10 a production build saved the original of each cut beside
 * the transcript and named it in the marker's `source=`, so each one can be
 * replayed through `processPreMappedToolResultBlock` with its tool's line:
 * shipped as it came, regrouped (Grep, Glob), or paged because even regrouped
 * it passes that line. A paged one is checked too: its page plus the saved
 * file from the pointer's line must give back the original. A json-structural
 * cut saved its rows as JSON lines rather than the raw output, so it is
 * counted and not replayed; so is a cut whose file is gone.
 *
 * The pages are saved under a throwaway config dir, never the real one. Run
 * it with the test preload, which stubs what the imports reach outside the
 * bundle, and NODE_ENV=test, which lets getGlobalConfig() run outside the
 * app's boot:
 *
 *   NODE_ENV=test bun --preload ./src/stubs/test-preload.ts \
 *     scripts/bench/tokens/former-cuts-replay.ts [--days=14] [--with-benches]
 *
 * `--with-benches` keeps the /tmp projects the A/B benches run in, left out by
 * default.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { processPreMappedToolResultBlock } from 'src/agent/tools/toolResultStorage.js'
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
  paged: number
  pageBroken: number
  oldChars: number
  newChars: number
}
const emptyRow = (): Row => ({ cuts: 0, replayed: 0, notReplayed: 0, whole: 0, compacted: 0, paged: 0, pageBroken: 0, oldChars: 0, newChars: 0 })
const rows = new Map<string, Row>()
const addedBySession = new Map<string, number>()
const row = (tool: string): Row => {
  let r = rows.get(tool)
  if (!r) rows.set(tool, (r = emptyRow()))
  return r
}

/** Whether a page and the file it points at give back `original`, line for line. */
function pageHolds(message: string, original: string): boolean {
  const shown = Number(/^Lines 1-(\d+) are below; Read the file with offset=\d+ and limit=\d+ for the next page\.$/m.exec(message)?.[1] ?? NaN)
  const path = /Full output saved to: (\S+)\n/.exec(message)?.[1]
  if (!Number.isFinite(shown) || !path) return false
  const page = message.slice(message.indexOf('\n\n') + 2, message.lastIndexOf('\n</persisted-output>'))
  const file = readFileSync(path, 'utf8')
  // The file holds what was paged: the regrouped envelope when the regroup ran.
  return page === file.split('\n').slice(0, shown).join('\n') && (file === original || file.includes('<tool-result-compacted'))
}

const dirs = projectDirs().filter(d => withBenches || !basename(d).startsWith('-tmp-'))
const files = transcriptFiles(dirs, days)
const scratch = mkdtempSync(join(tmpdir(), 'summarizer-replay-'))
const priorConfigDir = process.env.CLAUDIN_CONFIG_DIR
process.env.CLAUDIN_CONFIG_DIR = scratch
let nextId = 0

try {
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
      tool_use_id: `toolu_replay_${nextId++}`,
      content: isArrayTool(call.tool) ? [{ type: 'text', text: original }] : original,
    }
    const out = await processPreMappedToolResultBlock(block, { name: call.tool, maxResultSizeChars: declared })
    const shipped = typeof out.content === 'string' ? out.content : original
    r.replayed++
    if (out === block) r.whole++
    else if (shipped.startsWith('<tool-result-compacted')) r.compacted++
    else if (shipped.startsWith('<persisted-output>')) {
      r.paged++
      if (!pageHolds(shipped, original)) r.pageBroken++
    }
    r.oldChars += call.chars
    r.newChars += shipped.length
    addedBySession.set(call.file, (addedBySession.get(call.file) ?? 0) + shipped.length - call.chars)
  }
} finally {
  if (priorConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = priorConfigDir
  rmSync(scratch, { recursive: true, force: true })
}

const kchars = (n: number) => `${(n / 1000).toFixed(1)}k`
const line = (name: string, r: Row) =>
  [pad(name, 12), padLeft(String(r.cuts), 6), padLeft(String(r.replayed), 9), padLeft(String(r.whole), 7), padLeft(String(r.compacted), 8), padLeft(String(r.paged), 6), padLeft(String(r.pageBroken), 7), padLeft(kchars(r.oldChars), 13), padLeft(kchars(r.newChars), 9), padLeft(pct(r.newChars - r.oldChars, r.oldChars), 7)].join(' ')
console.log(`summarizer cuts over the last ${days} days: ${files.length} transcripts${withBenches ? '' : ' (benches left out)'}`)
console.log(
  [pad('tool', 12), padLeft('cuts', 6), padLeft('replayed', 9), padLeft('whole', 7), padLeft('compact', 8), padLeft('paged', 6), padLeft('broken', 7), padLeft('chars before', 13), padLeft('after', 9), padLeft('Δ', 7)].join(' '),
)
const total = emptyRow()
for (const [tool, r] of [...rows].sort((a, b) => b[1].cuts - a[1].cuts)) {
  for (const k of Object.keys(total) as (keyof Row)[]) total[k] += r[k]
  console.log(line(tool, r))
}
console.log(line('all', total))
const added = [...addedBySession.values()].sort((a, b) => a - b)
const at = (q: number) => added[Math.min(added.length - 1, Math.floor(q * added.length))] ?? 0
console.log(
  `\nsessions with a replayed cut: ${added.length}; chars added per session median ${kchars(at(0.5))}, p90 ${kchars(at(0.9))}, max ${kchars(added.at(-1) ?? 0)} (≈ chars/4 tokens, written once and read from cache after)`,
)
