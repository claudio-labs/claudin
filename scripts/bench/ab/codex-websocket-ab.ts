#!/usr/bin/env bun
/**
 * Is Claudin faster on the Codex backend over WebSocket than over HTTP?
 *
 * Three arms on the same ChatGPT account, interleaved run by run: `http`
 * (CLAUDIN_CODEX_WEBSOCKET=0), `http-placebo` (the same, so the table shows
 * the noise between two identical arms), and `ws` (the default). Each run is
 * one `-p` session in a throwaway repo that reads N small files one at a time
 * and sums them — N sequential tool calls, the shape OpenAI's "up to ~40%
 * faster with 20+ tool calls" is about. No proxy in the path: mitmdump would
 * distort the timing (codex-wire-capture.ts is the wire check).
 *
 *   bun scripts/bench/ab/codex-websocket-ab.ts [--n=3] [--files=22]
 *     [--model=gpt-5.6-terra] [--claudin=claudindev] [--out=<dir>]
 *
 * Per run it records the wall time, the result event's duration_ms and
 * duration_api_ms, the tool calls and whether the sum was right; the table
 * gives each arm's median and range. Needs a Codex CLI logged in with a
 * ChatGPT account (~/.codex/auth.json) and a fresh Claudin build.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { freshRepo, run, writeCodexProfileConfig } from './codex-wire-capture'

export type RunResult = {
  arm: string
  wallMs: number
  durationMs?: number
  apiMs?: number
  toolCalls: number
  correct: boolean
  exit: number
}

const ARMS: Array<[string, Record<string, string>]> = [
  ['http', { CLAUDIN_CODEX_WEBSOCKET: '0' }],
  ['http-placebo', { CLAUDIN_CODEX_WEBSOCKET: '0' }],
  ['ws', { CLAUDIN_CODEX_WEBSOCKET: '1' }],
]

export function files(count: number): { files: Record<string, string>; sum: number } {
  const out: Record<string, string> = {}
  let sum = 0
  for (let i = 1; i <= count; i++) {
    const value = (i * 37) % 101
    sum += value
    out[`f${String(i).padStart(2, '0')}.txt`] = `value: ${value}\n`
  }
  return { files: out, sum }
}

export function prompt(count: number): string {
  const last = `f${String(count).padStart(2, '0')}.txt`
  return `Read the files f01.txt through ${last} one at a time, in order: one Read call per file, never two in the same turn. Then answer with only the sum of their values, as a bare number.`
}

/**
 * The stream-json transcript of one run: tool calls (assistant events are
 * printed twice, so they are deduplicated by uuid), the result's timings and
 * whether its text is the expected sum.
 */
export function parseRun(stdout: string, expected: number): Pick<RunResult, 'durationMs' | 'apiMs' | 'toolCalls' | 'correct'> {
  const seen = new Set<string>()
  let toolCalls = 0
  let durationMs: number | undefined
  let apiMs: number | undefined
  let correct = false
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type === 'assistant') {
      const uuid = typeof event.uuid === 'string' ? event.uuid : undefined
      if (uuid && seen.has(uuid)) continue
      if (uuid) seen.add(uuid)
      const content = (event.message as { content?: Array<{ type?: string }> } | undefined)?.content ?? []
      toolCalls += content.filter(block => block.type === 'tool_use').length
    }
    if (event.type === 'result') {
      durationMs = typeof event.duration_ms === 'number' ? event.duration_ms : undefined
      apiMs = typeof event.duration_api_ms === 'number' ? event.duration_api_ms : undefined
      correct = String(event.result ?? '').replace(/[^0-9]/g, '') === String(expected)
    }
  }
  return { durationMs, apiMs, toolCalls, correct }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return Number.NaN
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function formatTable(results: RunResult[]): string {
  const rows = [['arm', 'runs', 'correct', 'tool calls', 'wall p50 (min–max)', 'api p50 (min–max)']]
  for (const [arm] of ARMS) {
    const mine = results.filter(r => r.arm === arm)
    if (mine.length === 0) continue
    const span = (values: number[]) => values.length
      ? `${(median(values) / 1000).toFixed(1)}s (${(Math.min(...values) / 1000).toFixed(1)}–${(Math.max(...values) / 1000).toFixed(1)})`
      : '—'
    rows.push([
      arm,
      String(mine.length),
      `${mine.filter(r => r.correct).length}/${mine.length}`,
      mine.map(r => r.toolCalls).join(' '),
      span(mine.map(r => r.wallMs)),
      span(mine.flatMap(r => (r.apiMs === undefined ? [] : [r.apiMs]))),
    ])
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(row => row[i]!.length)))
  return rows.map(row => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n')
}

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

async function main(): Promise<void> {
  const n = Number(argValue('n', '3'))
  const count = Number(argValue('files', '22'))
  const model = argValue('model', 'gpt-5.6-terra')
  const claudinBin = argValue('claudin', 'claudindev')
  const out = argValue('out', join(process.cwd(), `codex-ws-ab-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`))
  const authJson = join(homedir(), '.codex', 'auth.json')
  if (!existsSync(authJson)) throw new Error(`missing ${authJson}`)
  mkdirSync(out, { recursive: true })
  const { files: repoFiles, sum } = files(count)
  const results: RunResult[] = []
  for (let round = 1; round <= n; round++) {
    // Rotate the order each round so no arm always runs first.
    const order = ARMS.map((_, i) => ARMS[(i + round) % ARMS.length]!)
    for (const [arm, env] of order) {
      const cfg = join(out, `cfg-${arm}-${round}`)
      writeCodexProfileConfig(cfg, model, authJson)
      const repo = join(out, `repo-${arm}-${round}`)
      freshRepo(repo, repoFiles)
      const transcript = join(out, `${arm}-${round}.jsonl`)
      const started = Date.now()
      const exit = await run(
        claudinBin,
        ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', prompt(count)],
        repo,
        { CLAUDIN_CONFIG_DIR: cfg, ...env },
        transcript,
      )
      const result: RunResult = { arm, wallMs: Date.now() - started, exit, ...parseRun(readFileSync(transcript, 'utf8'), sum) }
      results.push(result)
      console.log(`round ${round} ${arm}: exit ${exit}, ${(result.wallMs / 1000).toFixed(1)}s, ${result.toolCalls} tool calls, ${result.correct ? 'correct' : 'WRONG'}`)
    }
  }
  const table = formatTable(results)
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1))
  writeFileSync(join(out, 'table.txt'), `${table}\n`)
  console.log(`\n${table}\n\nruns: ${out}`)
}

if (import.meta.main) await main()
