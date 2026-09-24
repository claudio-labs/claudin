#!/usr/bin/env bun
/**
 * What each CLI's model thought about, turn by turn, from a session-cache-ab run
 * recorded with `--proxy-display=summarized` (wire-proxy.ts keeps each
 * response's thinking text beside its request).
 *
 * The thinking TEXT is the API's summary of the reasoning, not the reasoning
 * itself; the token count beside it is the real one. So read the summaries for
 * what the model weighed, and the counts for how much. The topic tally is a
 * keyword count over the summaries — a pointer to which turns to read, not a
 * measurement.
 *
 * Usage:
 *   bun scripts/bench/ab/thinking-diff.ts <run dir> [--arms=claude,claudindev] [--out=<file.md>]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { readProxyRecords, type ProxyRecord } from './wire-proxy'

type Json = Record<string, unknown>

const TOPICS: ReadonlyArray<[string, RegExp]> = [
  ['tests / verification', /\b(tests?|verif\w*|regression|failing|passes|pass(ed)?|assert\w*)\b/gi],
  ['reading / exploring', /\b(read(ing)?|look(ing)? at|inspect\w*|explor\w*|understand\w*|structure|layout)\b/gi],
  ['tool choice', /\b(RunTests|Typecheck|apply_patch|Edit tool|Bash|Git tool|Grep|Glob|ToolSearch|heredoc|python)\b/g],
  ['memory / rules / .claudin', /\b(memory|MEMORY\.md|\.claudin|rules?\b|search-strategy)/gi],
  ['git / commit', /\b(git|commit\w*|stag(e|ing)|trailer|co-author\w*)\b/gi],
  ['instructions', /\b(instruction\w*|guideline\w*|system prompt|I('m| am) (told|asked|supposed)|conventions?|the user (wants|asked|said))\b/gi],
  ['planning', /\b(plan\w*|approach|step\w*|first|then|next)\b/gi],
  ['edge cases / correctness', /\b(edge case\w*|rounding|boundary|off-by-one|correct\w*|careful\w*|double-check\w*)\b/gi],
]

function parseArgs(argv: string[]): { runDir: string; arms: string[]; out: string | null } {
  let runDir = ''
  let arms = ['claude', 'claudindev']
  let out: string | null = null
  for (const a of argv) {
    if (a.startsWith('--arms=')) arms = a.slice(7).split(',').filter(Boolean)
    else if (a.startsWith('--out=')) out = a.slice(6)
    else runDir = a
  }
  if (!runDir) {
    console.error('usage: bun scripts/bench/ab/thinking-diff.ts <run dir> [--arms=a,b] [--out=file.md]')
    process.exit(2)
  }
  return { runDir, arms, out }
}

type Turn = { label: string; n: number; think: number; blocks: string[]; text: string }

/** The main thread's requests under a label: the ones that carry tools, in order. */
function turnsOf(proxyDir: string, label: string): Turn[] {
  const out: Turn[] = []
  for (const r of readProxyRecords(proxyDir, label)) {
    if (!isMainThread(proxyDir, label, r)) continue
    const file = join(proxyDir, label, `resp-${String(r.n).padStart(3, '0')}.thinking.txt`)
    out.push({
      label,
      n: r.n,
      think: r.response?.thinkingTokens ?? 0,
      blocks: r.response?.blocks ?? [],
      text: existsSync(file) ? readFileSync(file, 'utf8').trim() : '',
    })
  }
  return out
}

function isMainThread(proxyDir: string, label: string, r: ProxyRecord): boolean {
  if (!r.reqFile || !r.response || r.status >= 400) return false
  const body = JSON.parse(gunzipSync(readFileSync(join(proxyDir, label, r.reqFile))).toString('utf8')) as Json
  return Array.isArray(body.tools) && body.tools.length > 0
}

function tally(text: string): Record<string, number> {
  return Object.fromEntries(TOPICS.map(([name, re]) => [name, (text.match(re) ?? []).length]))
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

function main(): void {
  const { runDir, arms, out } = parseArgs(process.argv.slice(2))
  const proxyDir = join(runDir, 'proxy')
  const labels = readdirSync(proxyDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
  const reps = [...new Set(labels.map(l => /-r(\d+)\.p\d$/.exec(l)?.[1]).filter(Boolean))].map(Number).sort((a, b) => a - b)
  const lines: string[] = [`# thinking-diff — ${runDir}`, '']

  // Per arm: totals and the topic tally, per session then median.
  const perArm = new Map<string, { think: number[]; chars: number[]; turns: number[]; thinkingTurns: number[]; topics: Record<string, number[]> }>()
  const sessions = new Map<string, Turn[]>()
  for (const arm of arms) {
    const acc = { think: [] as number[], chars: [] as number[], turns: [] as number[], thinkingTurns: [] as number[], topics: {} as Record<string, number[]> }
    for (const rep of reps) {
      const turns = [1, 2].flatMap(p => turnsOf(proxyDir, `${arm}-r${rep}.p${p}`))
      if (!turns.length) continue
      sessions.set(`${arm} r${rep}`, turns)
      acc.think.push(turns.reduce((a, t) => a + t.think, 0))
      acc.chars.push(turns.reduce((a, t) => a + t.text.length, 0))
      acc.turns.push(turns.length)
      acc.thinkingTurns.push(turns.filter(t => t.think > 50).length)
      const all = tally(turns.map(t => t.text).join('\n'))
      for (const [k, v] of Object.entries(all)) (acc.topics[k] ??= []).push(v)
    }
    perArm.set(arm, acc)
  }

  lines.push('## Per session (median over reps)', '')
  lines.push(`| | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---|').join('')}`)
  const row = (name: string, pick: (a: NonNullable<ReturnType<typeof perArm.get>>) => number[]) =>
    lines.push(`| ${name} | ${arms.map(a => Math.round(median(pick(perArm.get(a)!)))).join(' | ')} |`)
  row('thinking tokens', a => a.think)
  row('summary chars', a => a.chars)
  row('main-thread requests', a => a.turns)
  row('requests that thought (>50 tokens)', a => a.thinkingTurns)
  for (const [name] of TOPICS) row(`mentions: ${name}`, a => a.topics[name] ?? [])
  lines.push('')

  // The turns themselves, heaviest first per session, then in order.
  for (const [key, turns] of sessions) {
    const total = turns.reduce((a, t) => a + t.think, 0)
    lines.push(`## ${key} — ${turns.length} requests, ${total} thinking tokens`, '')
    for (const t of turns) {
      if (!t.text && t.think <= 50) continue
      lines.push(`### ${t.label} #${t.n} — ${t.think} tokens → ${t.blocks.join(', ') || '(no blocks)'}`, '')
      lines.push(t.text ? t.text.split('\n').map(l => `> ${l}`).join('\n') : '> (no summary text)', '')
    }
  }

  const text = lines.join('\n')
  if (out) {
    writeFileSync(out, text)
    console.log(`thinking-diff → ${out}`)
  } else {
    console.log(text)
  }
}

main()
