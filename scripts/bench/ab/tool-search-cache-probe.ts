#!/usr/bin/env bun
// ToolSearch discovery cache probe: does loading a deferred tool via
// ToolSearch rewrite the cached prompt prefix?
//
// One headless `-p` run per rep drives a fixed script — Bash, Bash,
// ToolSearch(select:EnterPlanMode,ExitPlanMode), Bash, "done" — and reports
// cache_read / cache_creation per API call. The call that matters is the one
// right AFTER the ToolSearch result lands: on a healthy prefix its cache_read
// is >= the previous call's; a drop (or a fall to 0) means the discovery
// mutated the prefix and the whole history was rewritten.
//
// Measured 2026-09-03 before the fix (send only discovered deferred tools):
//   Bash        cr=30890 cc=0
//   ToolSearch  cr=30890 cc=0
//   Bash        cr=25770 cc=5213   <- system+tools grew +93 tokens; history rewritten
//
// Runs in a throwaway cwd so the project's rules/memory don't inflate the
// prefix, and never `-c` (headless resume is keyed by project dir).
//
// Usage:
//   bun run scripts/bench/ab/tool-search-cache-probe.ts --bin=claudindev --reps=3
//   bun run scripts/bench/ab/tool-search-cache-probe.ts --bin=claudin --reps=1 --model=claude-opus-5

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT =
  "Do these in order, one tool call per step. Step 1: Bash 'echo a'. " +
  "Step 2: Bash 'echo b'. Step 3: ToolSearch with query select:EnterPlanMode,ExitPlanMode " +
  "(never call EnterPlanMode). Step 4: Bash 'echo c'. Step 5: reply with the single word done."

type Args = { bin: string; reps: number; model?: string; timeoutMs: number }
function parseArgs(argv: string[]): Args {
  const a: Args = { bin: 'claudindev', reps: 3, timeoutMs: 300_000 }
  for (const s of argv) {
    if (s.startsWith('--bin=')) a.bin = s.slice(6)
    else if (s.startsWith('--reps=')) a.reps = Number(s.slice(7))
    else if (s.startsWith('--model=')) a.model = s.slice(8)
    else if (s.startsWith('--timeout=')) a.timeoutMs = Number(s.slice(10))
  }
  return a
}

type Call = { id: string; tool: string; cr: number; cc: number; in: number }

async function runOnce(args: Args, cwd: string): Promise<Call[]> {
  const cli = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    ...(args.model ? ['--model', args.model] : []),
    SCRIPT,
  ]
  const child = spawn(args.bin, cli, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const calls = new Map<string, Call>()
  const order: string[] = []
  let buf = ''
  child.stdout!.on('data', d => {
    buf += String(d)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      let v: Record<string, unknown>
      try { v = JSON.parse(line) } catch { continue }
      if (v.type !== 'assistant') continue
      const m = (v.message ?? {}) as Record<string, unknown>
      const id = String(m.id ?? '')
      if (!id) continue
      const u = (m.usage ?? {}) as Record<string, number>
      const content = (m.content ?? []) as Array<Record<string, unknown>>
      const tool = content.find(b => b.type === 'tool_use')
      const prev = calls.get(id)
      if (!prev) order.push(id)
      calls.set(id, {
        id,
        tool: tool ? String(tool.name) : prev?.tool ?? 'text',
        cr: u.cache_read_input_tokens ?? prev?.cr ?? 0,
        cc: u.cache_creation_input_tokens ?? prev?.cc ?? 0,
        in: u.input_tokens ?? prev?.in ?? 0,
      })
    }
  })
  const stderr: string[] = []
  child.stderr!.on('data', d => stderr.push(String(d)))
  const timer = setTimeout(() => child.kill(), args.timeoutMs)
  await new Promise<void>(res => child.on('close', () => res()))
  clearTimeout(timer)
  if (order.length === 0) {
    console.error('no assistant messages; stderr head:', stderr.join('').slice(0, 400))
  }
  return order.map(id => calls.get(id)!)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cwd = mkdtempSync(join(tmpdir(), 'tool-search-cache-probe-'))
  let breaks = 0
  let reps = 0
  for (let rep = 1; rep <= args.reps; rep++) {
    const calls = await runOnce(args, cwd)
    if (calls.length === 0) continue
    reps++
    console.log(`\n=== rep ${rep} bin=${args.bin} calls=${calls.length} ===`)
    let afterToolSearch = false
    let prevCr = 0
    let repBroke = false
    for (const c of calls) {
      let flag = ''
      if (afterToolSearch) {
        flag = c.cr >= prevCr ? '  <- post-discovery: prefix kept' : '  <- post-discovery: PREFIX REWRITTEN'
        if (c.cr < prevCr) repBroke = true
        afterToolSearch = false
      }
      console.log(`${c.tool.padEnd(12)} in=${String(c.in).padStart(6)} cr=${String(c.cr).padStart(7)} cc=${String(c.cc).padStart(7)}${flag}`)
      if (c.tool === 'ToolSearch') afterToolSearch = true
      prevCr = c.cr
    }
    if (repBroke) breaks++
  }
  console.log(`\n=== TOOL SEARCH CACHE PROBE bin=${args.bin} reps=${reps} discoveryBreaks=${breaks} ===`)
  process.exit(breaks > 0 ? 1 : 0)
}

main()
