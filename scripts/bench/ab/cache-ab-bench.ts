#!/usr/bin/env bun
// Cache A/B bench: claudin vs claude (Claude Code), SAME prompt, SAME 12 files,
// SAME model (claude-sonnet-4-6 by default — cheap), main-loop only (no subagents).
//
// WHY: in real sessions claudin shows cache_write ≈ cache_read (the cached prefix
// is being REWRITTEN every turn) while Claude Code shows cache_read ≫ cache_write
// (the prefix is REUSED). cache_write costs 1.25× input; cache_read costs 0.1× —
// so rewriting instead of reading is ~12× more expensive per token. This harness
// runs an identical multi-turn workload against both CLIs and prints the per-turn
// cache timeline + the write:read ratio so we can see WHERE the cache breaks.
//
// Workload: read 12 files across 3 sequential rounds (4 files/round, one round per
// turn). Each turn re-sends the growing context; a healthy cache READS the prior
// prefix instead of re-CREATING it. 3 turns is enough to expose a per-turn rewrite.
//
// Auth: uses your ACTIVE claudin profile, just pinning the model via ANTHROPIC_MODEL
// + --model (does NOT touch ~/.claudin/settings.json). Claude Code uses its own auth.
//
// Harness fixes (2026-06-08):
//   1. Per-turn rows are DELTAS, not cumulative. We dedupe assistant `usage` events
//      by message-id (stream-json emits the same id repeatedly during streaming, only
//      the last carries the final per-request totals) and treat each unique
//      assistant message as one row. cR/cW/out are reported as the value of THAT
//      message's `usage` block — that IS the per-turn delta because Anthropic emits
//      one `usage` per API request, not cumulative.
//   2. Totals are derived from the same per-message stream (sum of per-row deltas)
//      instead of recursively walking every `usage`-shaped object. The previous
//      walker double-counted because stream-json emits multiple partial assistant
//      events PLUS a final `result` event that itself contains a `usage` summary
//      of the last request only — summing them produced inflated cR/cW.
//   3. When a side exits non-zero, the script now prints `BLOCKED — exit=N` + the
//      captured stderr (truncated) instead of silently rendering a fake table.
//   4. --runs=N runs each side N times sequentially; median + min/max of cR/cW/
//      r:w/$ are printed. The per-turn delta table uses the MEDIAN run only.
//   5. --skip-claude lets you run claudin-only N≥3 without manually flipping flags.
//
// Usage:
//   bun run scripts/bench/ab/cache-ab-bench.ts                 # full A/B
//   bun run scripts/bench/ab/cache-ab-bench.ts --only=claudin  # one side
//   bun run scripts/bench/ab/cache-ab-bench.ts --runs=3        # median over 3 runs
//   bun run scripts/bench/ab/cache-ab-bench.ts --skip-claude   # claudin only
//   bun run scripts/bench/ab/cache-ab-bench.ts --model=claude-opus-4-7
//   bun run scripts/bench/ab/cache-ab-bench.ts --a=claude --b=claudindev
//   bun run scripts/bench/ab/cache-ab-bench.ts --json

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { join, resolve } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'

// 50 files, mixed sizes (small <500B, medium 5-30KB, large 50KB+) to exercise
// both small-pair walk-back and fat-tail short-circuit branches. NOTE: with
// --revisits>0 the FULL list is used and --turns is ignored.
const TWELVE_FILES = [
  // large (provider/runtime guts)
  'src/providers/transport/client.ts',
  'src/providers/presets/providerConfig.ts',
  'src/agent/QueryEngine.ts',
  'src/commands/commands.ts',
  'src/tools/Tool.ts',
  // medium
  'src/agent/messages/messages.ts',
  'src/platform/config/config.ts',
  'src/providers/transport/withRetry.ts',
  'src/providers/transport/errors.ts',
  'src/mcp/client.ts',
  'src/providers/model/model.ts',
  'src/providers/presets/providerModels.ts',
  'src/agent/context.ts',
  'src/agent/query.ts',
  'src/shared/errors.ts',
  'src/shared/log.ts',
  'src/shared/fs/path.ts',
  'src/shared/envUtils.ts',
  'src/shared/proc/Shell.ts',
  'src/platform/bootstrap/state.ts',
  // small (constants / tiny utils)
  'src/agent/prompts/messages.ts',
  'src/shared/constants/keys.ts',
  'src/terminal/ink/constants.ts',
  'src/shared/data/array.ts',
  'src/shared/withResolvers.ts',
  'src/shared/data/lazySchema.ts',
  'src/shared/data/yaml.ts',
  'src/agent/compact/snipCompact.ts',
  'src/shared/data/objectGroupBy.ts',
  // 50-file extension (mixed sizes) for longer-session workloads
  'src/providers/shims/openaiShim.ts',
  'src/providers/shims/codexShim.ts',
  'src/agent/repl/REPL.tsx',
  'src/providers/shims/claude/streaming.ts',
  'src/providers/shims/claude/paramBuilders.ts',
  'src/agent/messages/normalize.ts',
  'src/agent/compact/stableStubState.ts',
  'src/agent/compact/microCompact.ts',
  'src/agent/cache/cacheProfile.ts',
  'src/agent/cost-tracker.ts',
  'src/providers/usage/modelCost.ts',
  'src/providers/model/modelAllowlist.ts',
  'src/providers/cache/promptCacheBreakDetection.ts',
  'src/agent/compact/autoCompact.ts',
  'src/providers/transport/api.ts',
  'src/providers/transport/betas.ts',
  'src/providers/presets/activeProvider.ts',
  'src/agent/context/thinking.ts',
  'src/shared/debug.ts',
  'src/shared/data/json.ts',
]

// Revisit set for --revisits=N: files re-read a second time AFTER the full
// 30-file pass. This is where context-clipping strategies pay a real price
// (the earlier tool_result was stubbed, so the re-read re-bills the file)
// while keep-everything strategies may still hold the bytes in context.
// Spread across size classes: 2 large, 4 medium, 2 small.
const REVISIT_FILES = [
  'src/providers/transport/client.ts',      // large
  'src/agent/QueryEngine.ts',              // large
  'src/agent/messages/messages.ts',           // medium
  'src/platform/config/config.ts',             // medium
  'src/providers/transport/withRetry.ts',   // medium
  'src/providers/model/model.ts',        // medium
  'src/shared/constants/keys.ts',           // small
  'src/shared/data/array.ts',              // small
]

const SENTINEL = 'BENCH_DONE'

type Args = {
  model: string
  only: 'a' | 'b' | 'claudin' | 'claude' | null
  a: string
  b: string
  json: boolean
  help: boolean
  timeoutMs: number
  sequential: boolean
  turns: number
  runs: number
  skipClaude: boolean
  revisits: number
  // Cycle mode: read the first `files` entries `passes` times each (one Read
  // per turn, so turns = files * passes). Unlike --revisits (one extra pass
  // over a fixed list), this drives the SAME (file, range) back through Read
  // repeatedly, which is what the clip → re-read loop needs: a clipped
  // tool_result is only re-billed when the model asks for that exact range
  // again. 0/1 leaves the original behavior untouched.
  files: number
  passes: number
  // Override the file pool. The default list is size-diverse, which is the
  // wrong shape for clip-loop work: files ≥250 lines AND ≥10k chars are
  // intercepted by AUTO_OUTLINE_ON_ELISION, so the Read never returns a body
  // to clip and the stand-down can never fire (the outline marks the
  // readFileState entry isPartialView, which disqualifies dedup outright).
  fileList: string[]
  // Per-side extra env (e.g. CLAUDIN_TOOL_RESULT_JSON_COMPRESSION=1) so the
  // SAME binary can be A/B'd with a feature flag toggled. KEY=VAL form.
  aEnv: Record<string, string>
  bEnv: Record<string, string>
  // 'files' = the file-reading workload; 'json' = run the big-json fixture each
  // turn (exercises TOOL_RESULT_JSON_COMPRESSION) with a few source Read-backs;
  // 'prose' = repo-grounded explanation questions that elicit paragraphs
  // (exercises VERBOSITY_STEERING — the lever is OUTPUT tokens, not cache).
  workload: 'files' | 'json' | 'prose'
}

function parseKeyVal(s: string): Record<string, string> {
  const eq = s.indexOf('=')
  if (eq === -1) return {}
  return { [s.slice(0, eq)]: s.slice(eq + 1) }
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    model: 'claude-sonnet-4-6',
    only: null,
    a: 'claude',
    b: 'claudindev',
    json: false,
    help: false,
    timeoutMs: 600_000,
    sequential: false,
    turns: 8,
    runs: 1,
    skipClaude: false,
    revisits: 0,
    files: 0,
    passes: 1,
    fileList: [],
    aEnv: {},
    bEnv: {},
    workload: 'files',
  }
  for (const x of argv) {
    if (x === '--help' || x === '-h') a.help = true
    else if (x === '--json') a.json = true
    else if (x === '--sequential') a.sequential = true
    else if (x === '--skip-claude') a.skipClaude = true
    else if (x.startsWith('--runs=')) a.runs = Math.max(1, Number(x.slice('--runs='.length)))
    else if (x.startsWith('--turns=')) a.turns = Number(x.slice('--turns='.length))
    else if (x.startsWith('--revisits=')) a.revisits = Math.max(0, Math.min(REVISIT_FILES.length, Number(x.slice('--revisits='.length)) || 0))
    else if (x.startsWith('--files=')) a.files = Math.max(0, Number(x.slice('--files='.length)) || 0)
    else if (x.startsWith('--passes=')) a.passes = Math.max(1, Number(x.slice('--passes='.length)) || 1)
    else if (x.startsWith('--file-list=')) a.fileList = x.slice('--file-list='.length).split(',').map(s => s.trim()).filter(Boolean)
    else if (x.startsWith('--model=')) a.model = x.slice('--model='.length)
    else if (x.startsWith('--a-env=')) Object.assign(a.aEnv, parseKeyVal(x.slice('--a-env='.length)))
    else if (x.startsWith('--b-env=')) Object.assign(a.bEnv, parseKeyVal(x.slice('--b-env='.length)))
    else if (x.startsWith('--a=')) a.a = x.slice('--a='.length)
    else if (x.startsWith('--b=')) a.b = x.slice('--b='.length)
    else if (x.startsWith('--workload=')) {
      const w = x.slice('--workload='.length)
      a.workload = w === 'json' ? 'json' : w === 'prose' ? 'prose' : 'files'
    }
    else if (x.startsWith('--timeout=')) a.timeoutMs = Number(x.slice('--timeout='.length))
    else if (x.startsWith('--only=')) a.only = x.slice('--only='.length) as Args['only']
  }
  return a
}

// JSON workload: a numbered list of `turns` identical fixture runs, one per
// turn. The enumerated list (not a prose "do N turns") is what reliably forces
// the model to take exactly N turns — same shape as buildSequentialPrompt,
// whose compliance is proven. Same fixture every turn → the cached prefix
// should be READ, not rewritten; a per-turn cW spike means the feature broke
// the cache. On a few turns the model also Reads back the omitted rows from the
// cited source= path (when present) so the measurement captures the NET cost
// (compression minus retrieval), not just best-case.
function buildJsonWorkloadPrompt(turns: number): string {
  const fixture = 'scripts/bench/perf/fixtures/big-json.sh'
  const readbackTurns = new Set(
    [Math.floor(turns / 3), Math.floor((2 * turns) / 3), turns].filter(n => n > 1),
  )
  const steps = Array.from({ length: turns }, (_, i) => {
    const n = i + 1
    if (readbackTurns.has(n)) {
      return `  ${n}. Run \`bash ${fixture}\`. If the result envelope shows a source="…" ` +
        `path, Read that file with offset=200 limit=5 and print row 200's "number"; ` +
        `otherwise print how many rows the result reported.`
    }
    return `  ${n}. Run \`bash ${fixture}\` and print ONE line: how many rows it reported.`
  })
  return [
    `Run a fixed ${turns}-step benchmark, ONE Bash (or Read) tool call PER MESSAGE TURN.`,
    `STRICT RULES — the benchmark is INVALID if you break any of them:`,
    `- Exactly ONE tool call per assistant message. NEVER batch/parallelize/read-ahead.`,
    `- Do the steps strictly in order, one per turn. Do NOT stop early.`,
    `- Do NOT print the end token until AFTER step ${turns}.`,
    `Steps:`,
    ...steps,
    ``,
    `After step ${turns}, end your final message with the exact token ${SENTINEL}.`,
  ].join('\n')
}

// Prose workload: repo-grounded explanation questions. Each elicits real
// paragraphs (so VERBOSITY_STEERING has something to cut) AND has a verifiable
// core — a named file/function/flag the concise arm MUST still surface, so a
// quality regression (dropped answer) is detectable by reading the dumps.
// The prompt itself says nothing about length: the ONLY difference between the
// A and B arms is the CLAUDIN_VERBOSITY_STEERING env, so the output-token delta
// is attributable to the steering block alone.
const PROSE_QUESTIONS: readonly string[] = [
  'Explain what `getSystemPrompt()` in src/agent/prompts/prompts.ts does, and name the boundary marker it inserts between the cacheable and dynamic sections.',
  'Describe how the Bash output filter decides what to strip from a command\u2019s output. Which file implements the filter pipeline?',
  'Walk me through how the active model provider is resolved at runtime. What is the central resolver function and which file is it in?',
  'Explain the tool-result JSON compression: how are omitted rows still retrievable afterward, and what is the build flag that gates it?',
  'How are feature() flags processed at build time? What does a `feature(\u2019X\u2019)` call get replaced with, and in which script?',
  'Describe the agent loop at a high level: which file drives the model and tool dispatch?',
  'Explain what the prompt-cache clip-frontier strategy is for and where the cache_control marker is placed relative to message growth.',
]

// Free-paced on purpose: `-p` is single-shot (no real user turns), so a
// "one question per turn" instruction can't create turns — it only makes the
// model emit fragmented interleaved text across tool-call rounds, which is
// noisy to measure and harder to capture. Asking for one comprehensive answer
// yields a single clean final assistant message per arm (verified: stdout text
// == transcript text), so the A/B output-token delta is a like-for-like
// comparison of the SAME answer set with steering off vs on.
function buildProseWorkloadPrompt(turns: number): string {
  const qs = PROSE_QUESTIONS.slice(0, Math.max(1, Math.min(PROSE_QUESTIONS.length, turns)))
  const steps = qs.map((q, i) => `  ${i + 1}. ${q}`)
  return [
    `Answer these ${qs.length} questions about THIS repository. Use Read / Grep / Glob to ground each`,
    `answer in the actual code, then explain it in your own words and name the specific file(s) you cite.`,
    `Pace yourself however you like \u2014 there is no required number of turns.`,
    `Questions:`,
    ...steps,
    ``,
    `When you have answered all ${qs.length}, end your final message with the exact token ${SENTINEL}.`,
  ].join('\n')
}

// Sequential mode forces ONE Read per turn over N files → both CLIs do ~N turns,
// so per-turn cache_write is directly comparable (the original 3-round prompt let
// claude batch to 5 turns and claudin to 13, which is apples-to-oranges).
//
// With revisits > 0, the workload is the FULL 30-file list plus `revisits`
// files repeated a second time at the end (REVISIT_FILES order). The repeats
// are intentional: a clip-based context strategy already stubbed the first
// read, so the second read re-bills the file; a keep-everything strategy may
// still hold it in context — this is the fidelity case for real sessions
// where files get revisited.
function buildSequentialWorkload(
  files: string[],
  turns: number,
  revisits: number,
  fileCount = 0,
  passes = 1,
): string[] {
  // Cycle mode wins when asked for: N distinct files, each read `passes` times.
  if (passes > 1 && fileCount > 0) {
    const cycle = files.slice(0, fileCount)
    return Array.from({ length: passes }, () => cycle).flat()
  }
  if (revisits > 0) return [...files, ...REVISIT_FILES.slice(0, revisits)]
  return files.slice(0, turns)
}

function buildSequentialPrompt(workload: string[], revisits: number): string {
  const seen = new Map<string, number>()
  const lines = workload.map((f, i) => {
    const n = (seen.get(f) ?? 0) + 1
    seen.set(f, n)
    return `  ${i + 1}. ${f}${n > 1 ? `   (read #${n} of this file — Read it AGAIN in full)` : ''}`
  })
  const hasRepeats = [...seen.values()].some(n => n > 1)
  return [
    `Read these ${workload.length} files using the Read tool, ONE FILE PER MESSAGE TURN.`,
    `STRICT RULES — the benchmark is INVALID if you break any of them:`,
    `- Exactly ONE Read tool call per assistant message. NEVER two or more.`,
    `- NEVER use parallel/batched tool calls. Do not read ahead.`,
    `- After each Read, print a one-line summary of that file, then Read the next`,
    `  file in your NEXT message.`,
    ...(revisits > 0 || hasRepeats
      ? [
          `- Files repeat in the list on purpose. Every time a file comes up again`,
          `  you MUST call Read on it again, with NO offset/limit — do NOT answer`,
          `  from memory of the earlier read, and do NOT skip it as redundant.`,
        ]
      : []),
    `Process them strictly in this order:`,
    ...lines,
    ``,
    `After the last file, end your final message with the exact token ${SENTINEL}.`,
  ].join('\n')
}

function buildPrompt(files: string[]): string {
  const lines: string[] = [
    `Read these ${files.length} files using the Read tool, then print a one-line summary for each.`,
    `Pace yourself however you want — no specific number of turns or rounds.`,
    ``,
    `Files:`,
    ...files.map(f => `- ${f}`),
    ``,
    `When you're done summarizing all ${files.length}, end your final message with the exact token ${SENTINEL}.`,
  ]
  return lines.join('\n')
}

type TimelineRow = { in: number; out: number; cR: number; cW: number; role: string }

type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number | null
  numTurns: number | null
  wallMs: number
  exitCode: number
  rawLen: number
  stderr: string
  timeline: TimelineRow[]
  // Concatenated assistant prose for this run (text content blocks only, in
  // order, deduped by message id). Used by the prose workload to dump each
  // arm's answers for manual quality review.
  finalText: string
}

// Stream-json shape (verified against both binaries on 2026-06-08):
//   - `assistant` events carry `message.usage` for one API request. The same
//     `message.id` can appear in multiple consecutive `assistant` events while
//     content streams in; the FINAL event for that id carries the request's
//     final `usage` block. We dedupe by id and keep the last seen usage.
//   - `result` events contain a summary `usage` that mirrors the last request
//     only (NOT the cumulative across turns), plus `total_cost_usd` and
//     `num_turns` — we use those scalars but NOT the result.usage tokens.
//   - `usage` on per-message is per-request: cache_read_input_tokens is what was
//     re-read this request, cache_creation_input_tokens is what was newly cached
//     this request. Each row IS the per-turn delta; we do not subtract anything.
function extractTimeline(text: string): TimelineRow[] {
  const lastUsageByMsgId = new Map<string, TimelineRow & { order: number }>()
  let order = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const u = msg.usage as Record<string, unknown> | undefined
    if (!u) continue
    const id = String(msg.id ?? `__anon_${order}`)
    const row: TimelineRow & { order: number } = {
      in: Number(u.input_tokens ?? 0),
      out: Number(u.output_tokens ?? 0),
      cR: Number(u.cache_read_input_tokens ?? 0),
      cW: Number(u.cache_creation_input_tokens ?? 0),
      role: String(v.type),
      order: lastUsageByMsgId.get(id)?.order ?? order++,
    }
    lastUsageByMsgId.set(id, row)
  }
  return [...lastUsageByMsgId.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _o, ...r }) => r)
}

function extractSessionId(text: string): string | null {
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    if (v.type === 'system' && v.subtype === 'init' && typeof v.session_id === 'string') {
      return v.session_id
    }
  }
  return null
}

// Claudin's stream-json emits assistant events at content_block_stop, BEFORE
// message_delta delivers the request's final usage — the final values are
// written back into the in-memory message by mutation (streaming.ts), so the
// already-serialized stdout line carries zeros. The session transcript is
// flushed lazily AFTER that mutation and therefore has the real per-request
// usage. When the stream timeline is all-zero, fall back to parsing the
// transcript (same dedupe-by-message-id, last-wins rule).
function transcriptTimeline(sessionId: string): TimelineRow[] {
  const configDir = process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
  const projectsDir = join(configDir, 'projects')
  if (!existsSync(projectsDir)) return []
  let file: string | null = null
  for (const dir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) { file = candidate; break }
  }
  if (!file) return []
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const lastUsageByMsgId = new Map<string, TimelineRow & { order: number }>()
  let order = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const u = msg.usage as Record<string, unknown> | undefined
    if (!u) continue
    const id = String(msg.id ?? `__anon_${order}`)
    const row: TimelineRow & { order: number } = {
      in: Number(u.input_tokens ?? 0),
      out: Number(u.output_tokens ?? 0),
      cR: Number(u.cache_read_input_tokens ?? 0),
      cW: Number(u.cache_creation_input_tokens ?? 0),
      role: 'assistant',
      order: lastUsageByMsgId.get(id)?.order ?? order++,
    }
    // Last-wins: only the last yielded message object per request id gets the
    // final usage mutated in; earlier same-id blocks keep zeros. Prefer a row
    // with any nonzero counters over an all-zero one.
    const prev = lastUsageByMsgId.get(id)
    const rowHasData = row.in + row.out + row.cR + row.cW > 0
    const prevHasData = prev ? prev.in + prev.out + prev.cR + prev.cW > 0 : false
    if (!prev || rowHasData || !prevHasData) lastUsageByMsgId.set(id, row)
  }
  return [...lastUsageByMsgId.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _o, ...r }) => r)
}

// Totals: sum the deduped per-message timeline, then pull cost / num_turns from
// the `result` event (those are emitted exactly once per run).
function extractScalars(text: string): { costUsd: number | null; numTurns: number | null } {
  let costUsd: number | null = null
  let numTurns: number | null = null
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    if (v.type !== 'result') continue
    if (typeof v.total_cost_usd === 'number') costUsd = v.total_cost_usd as number
    if (typeof v.num_turns === 'number') numTurns = v.num_turns as number
  }
  return { costUsd, numTurns }
}

// Concatenate the assistant's text content blocks from the stream-json output.
// Same dedupe-by-message-id, last-wins rule as extractTimeline: content
// accumulates across streamed events sharing one message id, so the longest
// (final) text for each id is the real answer. Tool_use / thinking blocks are
// ignored — we only want prose, which is what VERBOSITY_STEERING moves.
function extractAssistantText(text: string): string {
  const lastByMsgId = new Map<string, { order: number; text: string }>()
  let order = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(s) as Record<string, unknown> } catch { continue }
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const content = msg.content
    if (!Array.isArray(content)) continue
    const txt = content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b &&
          typeof b === 'object' &&
          (b as { type?: string }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map(b => b.text)
      .join('')
    const id = String(msg.id ?? `__anon_${order}`)
    const prev = lastByMsgId.get(id)
    if (!prev) lastByMsgId.set(id, { order: order++, text: txt })
    else if (txt.length >= prev.text.length) lastByMsgId.set(id, { order: prev.order, text: txt })
  }
  return [...lastByMsgId.values()]
    .sort((a, b) => a.order - b.order)
    .map(r => r.text)
    .filter(Boolean)
    .join('\n\n')
}

function summarizeTimeline(timeline: TimelineRow[]) {
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0
  for (const r of timeline) {
    input += r.in
    output += r.out
    cacheRead += r.cR
    cacheCreation += r.cW
  }
  return { input, output, cacheRead, cacheCreation }
}

function run(
  bin: string,
  model: string,
  prompt: string,
  timeoutMs: number,
  allowedTools: string,
  extraEnv: Record<string, string>,
): Usage {
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    // Comma-separated form works for both `claude` and `claudin` (claude also
    // accepts space-separated via variadic, but with `-p` everything after a
    // bare `--allowedTools Read` may grab the next positional ambiguously).
    '--allowedTools', allowedTools,
  ]
  const t0 = performance.now()
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    cwd: REPO_ROOT,
    env: { ...process.env, ANTHROPIC_MODEL: model, ...extraEnv },
    // Explicitly close stdin. Without this, both `claude` and `claudin -p`
    // wait ~3s for stdin data on the open pipe before proceeding.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const wallMs = performance.now() - t0
  const stdout = res.stdout ?? ''
  const stderrText = res.stderr ?? ''
  let timeline = extractTimeline(stdout)
  // Stream usage all-zero (claudin emits assistant events before the final
  // usage arrives) → recover the per-request rows from the session transcript.
  const streamHasData = timeline.some(r => r.in + r.out + r.cR + r.cW > 0)
  if (!streamHasData) {
    const sid = extractSessionId(stdout)
    if (sid) {
      const fromTranscript = transcriptTimeline(sid)
      if (fromTranscript.some(r => r.in + r.out + r.cR + r.cW > 0)) {
        timeline = fromTranscript
      }
    }
  }
  const sums = summarizeTimeline(timeline)
  const scalars = extractScalars(stdout)
  return {
    ...sums,
    ...scalars,
    wallMs,
    exitCode: res.status ?? -1,
    rawLen: stdout.length + stderrText.length,
    stderr: stderrText,
    timeline,
    finalText: extractAssistantText(stdout),
  }
}

function resolveBin(name: string): string {
  // 'claude' / 'claudin' / 'claudindev' on PATH, or an absolute path.
  if (name.includes('/')) return name
  return name
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'm'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function printTimeline(label: string, u: Usage) {
  console.log(`\n  ${label} — per-turn cache (cR=read, cW=write, each row = one assistant request):`)
  console.log(`    ${'turn'.padEnd(5)} ${'role'.padEnd(10)} ${'in'.padStart(8)} ${'cR(read)'.padStart(10)} ${'cW(write)'.padStart(11)} ${'out'.padStart(7)}`)
  u.timeline.forEach((r, i) => {
    console.log(`    ${String(i + 1).padEnd(5)} ${r.role.padEnd(10)} ${fmt(r.in).padStart(8)} ${fmt(r.cR).padStart(10)} ${fmt(r.cW).padStart(11)} ${fmt(r.out).padStart(7)}`)
  })
  // Sanity check: sum of per-row deltas must equal the printed totals.
  const sCR = u.timeline.reduce((a, r) => a + r.cR, 0)
  const sCW = u.timeline.reduce((a, r) => a + r.cW, 0)
  const sOut = u.timeline.reduce((a, r) => a + r.out, 0)
  if (sCR !== u.cacheRead || sCW !== u.cacheCreation || sOut !== u.output) {
    console.log(`    ! row-sum mismatch: rows cR=${sCR}/cW=${sCW}/out=${sOut} vs totals cR=${u.cacheRead}/cW=${u.cacheCreation}/out=${u.output}`)
  } else {
    console.log(`    (sum cR=${fmt(sCR)} cW=${fmt(sCW)} out=${fmt(sOut)} matches totals)`)
  }
}

function ratioOf(cacheRead: number, cacheCreation: number): string {
  if (cacheCreation === 0) return cacheRead > 0 ? '∞:1 (all read)' : 'n/a'
  return (cacheRead / cacheCreation).toFixed(2) + ':1'
}

function ratio(u: Usage): string {
  return ratioOf(u.cacheRead, u.cacheCreation)
}

function printBlocked(label: string, u: Usage) {
  console.log(`\n  ${label} — BLOCKED — exit=${u.exitCode}, see stderr below:`)
  const lines = (u.stderr || '(no stderr captured)').split('\n')
  const head = lines.slice(0, 30)
  for (const l of head) console.log(`    | ${l}`)
  if (lines.length > 30) console.log(`    | ... (${lines.length - 30} more lines truncated)`)
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

function pickMedianRun(runs: Usage[]): Usage {
  // Pick the run whose cacheRead is closest to the median cacheRead — that run's
  // timeline is then the one we render.
  const med = median(runs.map(r => r.cacheRead))
  let best = runs[0]
  let bestDist = Math.abs(best.cacheRead - med)
  for (const r of runs.slice(1)) {
    const d = Math.abs(r.cacheRead - med)
    if (d < bestDist) { best = r; bestDist = d }
  }
  return best
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('cache-ab-bench: claudin vs claude, same prompt/files/model, main-loop cache reuse.')
    console.log('  --model=<id> (default claude-sonnet-4-6)  --only=claude|claudin  --a=<bin> --b=<bin>  --json')
    console.log('  --runs=N (default 1; recommend 3 — reports median+min+max)  --skip-claude')
    console.log('  --files=N --passes=M (cycle: N distinct files read M times each, 1 Read/turn → N*M turns;')
    console.log('                        drives the clip → re-read loop, which needs the SAME range re-Read)')
    console.log('  --file-list=a.ts,b.ts (override the pool; keep every file under the auto-outline')
    console.log('                        threshold — 250 lines / 10k chars — or Reads return outlines, not bodies)')
    console.log('  --workload=files|json|prose (json: big-json fixture each turn — TOOL_RESULT_JSON_COMPRESSION;')
    console.log('                               prose: repo-grounded explanation Qs — VERBOSITY_STEERING, measures OUTPUT tokens + dumps answers)')
    console.log('  --a-env=KEY=VAL --b-env=KEY=VAL (per-side env so the SAME binary can be A/B\'d with a flag toggled)')
    console.log('  e.g. --a=claudindev --b=claudindev --workload=json --turns=20 --runs=3 \\')
    console.log('         --a-env=CLAUDIN_TOOL_RESULT_JSON_COMPRESSION=0 --b-env=CLAUDIN_TOOL_RESULT_JSON_COMPRESSION=1')
    console.log('  e.g. --a=claudindev --b=claudindev --workload=prose --runs=3 \\')
    console.log('         --a-env=CLAUDIN_VERBOSITY_STEERING=0 --b-env=CLAUDIN_VERBOSITY_STEERING=1')
    return
  }

  const isJson = args.workload === 'json'
  const isProse = args.workload === 'prose'
  const pool = args.fileList.length > 0 ? args.fileList : TWELVE_FILES
  const workload = buildSequentialWorkload(
    pool,
    args.turns,
    args.revisits,
    args.files,
    args.passes,
  )
  const prompt = isProse
    ? buildProseWorkloadPrompt(args.turns)
    : isJson
      ? buildJsonWorkloadPrompt(args.turns)
      : args.sequential
        ? buildSequentialPrompt(workload, args.revisits)
        : buildPrompt(pool)
  const allowedTools = isProse ? 'Read,Grep,Glob' : isJson ? 'Read,Bash' : 'Read'
  if (isProse) console.log(`(prose workload: ${Math.min(PROSE_QUESTIONS.length, args.turns)} repo-grounded explanation questions \u2014 measuring OUTPUT tokens; dumps written for quality review)`)
  else if (isJson) console.log(`(json workload: ${args.turns} turns running the big-json fixture + source= Read-backs)`)
  else if (args.sequential) console.log(`(sequential mode: 1 Read/turn, ${workload.length} reads${args.passes > 1 && args.files > 0 ? ` (${args.files} files × ${args.passes} passes)` : args.revisits > 0 ? ` (${TWELVE_FILES.length} files + ${args.revisits} revisits)` : ''} for a fair per-turn cache comparison)`)
  const sides: Array<{ label: string; bin: string; env: Record<string, string> }> = []
  const wantA = !args.skipClaude && (args.only === null || args.only === 'a' || args.only === 'claude')
  const wantB = args.only === null || args.only === 'b' || args.only === 'claudin'
  const envLabel = (e: Record<string, string>) =>
    Object.keys(e).length ? ` {${Object.entries(e).map(([k, v]) => `${k}=${v}`).join(',')}}` : ''
  if (wantA) sides.push({ label: `A (${args.a})${envLabel(args.aEnv)}`, bin: resolveBin(args.a), env: args.aEnv })
  if (wantB) sides.push({ label: `B (${args.b})${envLabel(args.bEnv)}`, bin: resolveBin(args.b), env: args.bEnv })

  console.log(`\nCache A/B bench — model=${args.model}, ${pool.length} files in pool, main-loop only, runs=${args.runs}`)
  console.log(`(auth: active profiles; model pinned via --model + ANTHROPIC_MODEL)\n`)

  type SideResult = { label: string; bin: string; runs: Usage[] }
  const results: SideResult[] = []
  for (const s of sides) {
    const sideRuns: Usage[] = []
    for (let i = 0; i < args.runs; i++) {
      process.stdout.write(`▶ running ${s.label} [${i + 1}/${args.runs}] ... `)
      const u = run(s.bin, args.model, prompt, args.timeoutMs, allowedTools, s.env)
      console.log(`done (exit ${u.exitCode}, ${(u.wallMs / 1000).toFixed(1)}s, cR=${fmt(u.cacheRead)} cW=${fmt(u.cacheCreation)})`)
      sideRuns.push(u)
    }
    results.push({ label: s.label, bin: s.bin, runs: sideRuns })
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  console.log('\n' + '─'.repeat(96))
  console.log(`TOTALS (median of ${args.runs} run${args.runs === 1 ? '' : 's'}, min/max in brackets)`)
  console.log(`  ${'side'.padEnd(22)} ${'cR(med)'.padStart(12)} ${'cW(med)'.padStart(12)} ${'r:w(med)'.padStart(14)} ${'out(med)'.padStart(10)} ${'$(med)'.padStart(10)} ${'turns'.padStart(6)}  ok/total`)
  const outMeds: Array<{ label: string; out: number; proseChars: number }> = []
  for (const { label, runs } of results) {
    const ok = runs.filter(r => r.exitCode === 0)
    const allFailed = ok.length === 0
    const pool = allFailed ? runs : ok
    const cRs = pool.map(r => r.cacheRead)
    const cWs = pool.map(r => r.cacheCreation)
    const costs = pool.map(r => r.costUsd ?? 0)
    const turns = pool.map(r => r.numTurns ?? 0)
    const cRmed = median(cRs), cWmed = median(cWs), costMed = median(costs), turnsMed = median(turns)
    const outMed = median(pool.map(r => r.output))
    const proseMed = median(pool.map(r => r.finalText.length))
    const cRmin = Math.min(...cRs), cRmax = Math.max(...cRs)
    const cWmin = Math.min(...cWs), cWmax = Math.max(...cWs)
    const costMin = Math.min(...costs), costMax = Math.max(...costs)
    const rw = ratioOf(cRmed, cWmed)
    const okN = ok.length
    outMeds.push({ label, out: outMed, proseChars: proseMed })
    console.log(`  ${label.padEnd(22)} ${fmt(cRmed).padStart(12)} ${fmt(cWmed).padStart(12)} ${rw.padStart(14)} ${fmt(outMed).padStart(10)} ${('$' + costMed.toFixed(4)).padStart(10)} ${String(turnsMed).padStart(6)}  ${okN}/${runs.length}`)
    if (runs.length > 1) {
      console.log(`  ${' '.repeat(22)} ${(`[${fmt(cRmin)}..${fmt(cRmax)}]`).padStart(12)} ${(`[${fmt(cWmin)}..${fmt(cWmax)}]`).padStart(12)} ${''.padStart(14)} ${''.padStart(10)} ${(`[$${costMin.toFixed(2)}..$${costMax.toFixed(2)}]`).padStart(10)}`)
    }
  }
  console.log('─'.repeat(96))
  console.log('  read:write — higher is better. >5:1 = healthy reuse; ~1:1 = prefix rewritten each turn.')
  // Output deltas — the lever verbosity steering moves. A is the baseline
  // (steering off); positive % means B (steering on) was lower.
  //  - "out tokens" is TOTAL output incl. tool_use JSON, so it's diluted by
  //    tool-exploration variance (turn count differs run-to-run).
  //  - "final prose chars" is the steering-specific signal: the length of the
  //    final assistant answer text only. Trust this one for the verbosity verdict.
  if (outMeds.length === 2 && outMeds[0].out > 0) {
    const [a, b] = outMeds
    const outPct = ((a.out - b.out) / a.out) * 100
    const prosePct = a.proseChars > 0 ? ((a.proseChars - b.proseChars) / a.proseChars) * 100 : 0
    const dir = (p: number) => (p >= 0 ? 'lower' : 'higher')
    console.log(
      `  out tokens (incl. tool_use) — A=${fmt(a.out)} \u2192 B=${fmt(b.out)}: B ${Math.abs(outPct).toFixed(1)}% ${dir(outPct)} (diluted by tool-call variance).`,
    )
    console.log(
      `  final prose chars (steering signal) — A=${fmt(a.proseChars)} \u2192 B=${fmt(b.proseChars)}: B ${Math.abs(prosePct).toFixed(1)}% ${dir(prosePct)}.`,
    )
  }

  for (const { label, runs } of results) {
    const ok = runs.filter(r => r.exitCode === 0)
    if (ok.length === 0) {
      // ALL runs failed. Show the failure mode loudly (first failed run's stderr).
      printBlocked(label, runs[0])
      continue
    }
    const medianRun = pickMedianRun(ok)
    printTimeline(`${label} (median run)`, medianRun)
    // If any other runs failed, still surface that fact so we don't silently hide
    // partial breakage.
    const failed = runs.filter(r => r.exitCode !== 0)
    if (failed.length > 0) {
      console.log(`    note: ${failed.length}/${runs.length} run(s) failed; first failure stderr:`)
      const lines = (failed[0].stderr || '(no stderr)').split('\n').slice(0, 10)
      for (const l of lines) console.log(`      | ${l}`)
    }
  }

  // Prose workload: dump each arm's median-run answers so the quality side of
  // the A/B (did the concise arm drop any answer?) can be reviewed by eye.
  if (isProse) {
    console.log('\n  prose dumps (median run per side, for manual quality review):')
    results.forEach((side, i) => {
      const ok = side.runs.filter(r => r.exitCode === 0)
      const pool = ok.length ? ok : side.runs
      const med = pickMedianRun(pool)
      const tag = i === 0 ? 'A' : 'B'
      const file = resolve(import.meta.dir, `verbosity-ab-${tag}.txt`)
      const body = med.finalText || '(no assistant text captured)'
      writeFileSync(file, `# ${side.label} (median run)\n# output tokens: ${med.output}\n\n${body}\n`)
      console.log(`    ${tag}: ${body.length} chars, ${med.output} output tokens \u2192 scripts/bench/ab/verbosity-ab-${tag}.txt`)
    })
  }
  console.log()
}

main()
