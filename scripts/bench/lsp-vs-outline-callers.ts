#!/usr/bin/env bun
/**
 * Mini-bench: tracejar callers cross-file via outline+symbol vs LSP-hint vs nada.
 *
 * Variantes:
 *   A = baseline (main puro, sem playbook)
 *   B = playbook FileReadTool shipped (sem hint LSP)
 *   D = playbook + hint LSP no LSPTool (variante dropada de T6.6)
 *
 * Pergunta: o hint do LSPTool move o agente para findReferences/outgoingCalls,
 * ou outline+symbol ja resolve igual? Funcao vitima escolhida pra forcar
 * rastreamento cross-file: `getSmallFastModel` em openclaude (12 callers).
 *
 * Roda intercalado A,B,D,A,B,D... e mede input tokens, tool counts, LSP ops.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const BASELINE_A = join(REPO_ROOT, 'dist', 'baseline-a', 'cli.mjs')
const FEATURE_B = join(REPO_ROOT, 'dist', 'feature-b-shipped', 'cli.mjs')
const FEATURE_D = join(REPO_ROOT, 'dist', 'feature-b', 'cli.mjs')
const RUNS_PER_PROMPT = Number(process.env.CLAUDIN_BENCH_RUNS ?? '2')
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
const TARGET_CWD =
  process.env.CLAUDIN_BENCH_TARGET_CWD ?? resolve(REPO_ROOT, '..', 'openclaude')

type Variant = 'A' | 'B' | 'D'
const VARIANTS: { id: Variant; label: string; entry: string }[] = [
  { id: 'A', label: 'baseline',           entry: BASELINE_A },
  { id: 'B', label: 'playbook-only',      entry: FEATURE_B },
  { id: 'D', label: 'playbook+lsp-hint',  entry: FEATURE_D },
]

const PROMPTS = [
  {
    id: 'trace-callers',
    text: 'Liste todos os callers da funcao `getSmallFastModel` no codebase, com arquivo:linha de cada call site. Para cada caller, descreva em 1 frase o que ele faz com o resultado (qual prop ele passa, qual decisao ele toma). Nao edite nada.',
  },
  {
    id: 'refactor-impact',
    text: 'Quero adicionar um parametro opcional `signal?: AbortSignal` a `getSmallFastModel` (ja existente em src/providers/presets/providerModels.ts). Sem editar nenhum arquivo, liste cada call site cross-file (arquivo:linha) que precisaria ser atualizado se o parametro fosse obrigatorio, com 1 linha de contexto descrevendo o que aquele site faz. Para cada um, diga se ele teria acesso natural a um AbortSignal ou nao.',
  },
]

interface ReadModeCounts { outline: number; symbol: number; range: number; full: number; viewFull: number }
interface LspOpCounts { [op: string]: number }
interface RunResult {
  promptId: string
  variant: Variant
  runIdx: number
  ok: boolean
  durationMs: number
  totalCostUsd: number
  numTurns: number
  sessionId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalInputCostTokens: number
  toolCounts: Record<string, number>
  readModes: ReadModeCounts
  lspOps: LspOpCounts
  resultText: string
}

function projectDirForCwd(cwd: string): string { return cwd.replace(/[\/]/g, '-') }

function classifyReadInput(input: any): keyof ReadModeCounts {
  if (typeof input?.symbol === 'string' && input.symbol.length > 0) return 'symbol'
  if (input?.view === 'outline') return 'outline'
  if (input?.view === 'full') return 'viewFull'
  if (typeof input?.offset === 'number' || typeof input?.limit === 'number') return 'range'
  return 'full'
}

function extractFromSession(sessionId: string, cwd: string) {
  const path = join(homedir(), '.claudin', 'projects', projectDirForCwd(cwd), `${sessionId}.jsonl`)
  const toolCounts: Record<string, number> = {}
  const readModes: ReadModeCounts = { outline: 0, symbol: 0, range: 0, full: 0, viewFull: 0 }
  const lspOps: LspOpCounts = {}
  if (!existsSync(path)) return { toolCounts, readModes, lspOps }
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    try {
      const obj = JSON.parse(line)
      const content = obj?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block?.name === 'string') {
          toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1
          if (block.name === 'Read') readModes[classifyReadInput(block.input)] += 1
          else if (block.name === 'LSP') {
            const op = typeof block.input?.operation === 'string' ? block.input.operation : 'unknown'
            lspOps[op] = (lspOps[op] ?? 0) + 1
          }
        }
      }
    } catch {}
  }
  return { toolCounts, readModes, lspOps }
}

function runOnce(variant: Variant, entry: string, prompt: { id: string; text: string }, runIdx: number): Promise<RunResult> {
  const label = VARIANTS.find((v) => v.id === variant)?.label ?? variant
  process.stdout.write(`  [${variant}/${label}] ${prompt.id} run#${runIdx + 1} ... `)
  const start = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn('node', [entry, '-p', prompt.text, '--model', MODEL, '--output-format', 'json'], {
      cwd: TARGET_CWD,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdoutBuf = ''
    let stderrBuf = ''
    child.stdout.on('data', (c) => { stdoutBuf += c.toString() })
    child.stderr.on('data', (c) => { stderrBuf += c.toString() })
    child.on('close', (code) => {
      const wall = Date.now() - start
      let parsed: any = null
      try { parsed = JSON.parse(stdoutBuf.trim().split('\n').filter(Boolean).pop() ?? '{}') } catch {}
      const ok = code === 0 && parsed?.type === 'result' && parsed?.subtype === 'success'
      if (!ok) process.stdout.write(`FAIL (exit=${code}) ${stderrBuf.slice(0, 100)}\n`)
      const sessionId: string = parsed?.session_id ?? ''
      const usage: any = Object.values(parsed?.modelUsage ?? {})[0] ?? {}
      const inputTokens = usage?.inputTokens ?? 0
      const outputTokens = usage?.outputTokens ?? 0
      const cacheReadTokens = usage?.cacheReadInputTokens ?? 0
      const cacheCreationTokens = usage?.cacheCreationInputTokens ?? 0
      const totalInputCostTokens = inputTokens + cacheReadTokens + cacheCreationTokens
      const ex = sessionId ? extractFromSession(sessionId, TARGET_CWD) : { toolCounts: {}, readModes: { outline: 0, symbol: 0, range: 0, full: 0, viewFull: 0 }, lspOps: {} }
      if (ok) {
        const rm = ex.readModes
        const lspTotal = Object.values(ex.lspOps).reduce((a, b) => a + b, 0)
        process.stdout.write(`OK ${(parsed.duration_ms / 1000).toFixed(1)}s tokens=${totalInputCostTokens} read[o=${rm.outline} s=${rm.symbol} r=${rm.range} f=${rm.full}] LSP=${lspTotal}\n`)
      }
      resolvePromise({
        promptId: prompt.id, variant, runIdx, ok,
        durationMs: parsed?.duration_ms ?? wall,
        totalCostUsd: parsed?.total_cost_usd ?? 0,
        numTurns: parsed?.num_turns ?? 0,
        sessionId,
        inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalInputCostTokens,
        toolCounts: ex.toolCounts, readModes: ex.readModes, lspOps: ex.lspOps,
        resultText: typeof parsed?.result === 'string' ? parsed.result : '',
      })
    })
  })
}

function fmtTools(c: Record<string, number>): string {
  const known = ['Grep', 'LSP', 'Read', 'Glob']
  const parts: string[] = []
  for (const k of known) parts.push(`${k}=${c[k] ?? 0}`)
  const other = Object.entries(c).filter(([k]) => !known.includes(k)).reduce((a, [, v]) => a + v, 0)
  if (other > 0) parts.push(`other=${other}`)
  return parts.join(' ')
}
function fmtRead(r: ReadModeCounts): string { return `outline=${r.outline} symbol=${r.symbol} range=${r.range} full=${r.full} view-full=${r.viewFull}` }
function fmtLsp(o: LspOpCounts): string {
  const e = Object.entries(o).sort((a, b) => b[1] - a[1])
  return e.length === 0 ? '-' : e.map(([op, n]) => `${op}=${n}`).join(' ')
}

function summarize(results: RunResult[], v: Variant) {
  const rs = results.filter((r) => r.variant === v && r.ok)
  if (rs.length === 0) return null
  const sum = (s: (r: RunResult) => number) => rs.reduce((a, r) => a + s(r), 0)
  const avg = (s: (r: RunResult) => number) => sum(s) / rs.length
  const tc: Record<string, number> = {}
  const rm: ReadModeCounts = { outline: 0, symbol: 0, range: 0, full: 0, viewFull: 0 }
  const lo: LspOpCounts = {}
  for (const r of rs) {
    for (const [k, n] of Object.entries(r.toolCounts)) tc[k] = (tc[k] ?? 0) + n
    rm.outline += r.readModes.outline; rm.symbol += r.readModes.symbol; rm.range += r.readModes.range; rm.full += r.readModes.full; rm.viewFull += r.readModes.viewFull
    for (const [op, n] of Object.entries(r.lspOps)) lo[op] = (lo[op] ?? 0) + n
  }
  return {
    n: rs.length,
    avgDurationMs: avg((r) => r.durationMs),
    avgTotalInputCostTokens: avg((r) => r.totalInputCostTokens),
    avgInputTokens: avg((r) => r.inputTokens),
    avgCacheReadTokens: avg((r) => r.cacheReadTokens),
    avgCacheCreationTokens: avg((r) => r.cacheCreationTokens),
    avgOutputTokens: avg((r) => r.outputTokens),
    totalCost: sum((r) => r.totalCostUsd),
    avgTurns: avg((r) => r.numTurns),
    tc, rm, lo,
  }
}

async function main() {
  for (const v of VARIANTS) {
    if (!existsSync(v.entry)) { console.error(`Missing snapshot: ${v.entry}`); process.exit(1) }
  }
  const total = PROMPTS.length * RUNS_PER_PROMPT * VARIANTS.length
  console.log(`Mini-bench LSP-vs-outline: ${PROMPTS.length} prompts x ${RUNS_PER_PROMPT} runs x ${VARIANTS.length} variants = ${total} invocations`)
  for (const v of VARIANTS) console.log(`  ${v.id} (${v.label}): ${v.entry}`)
  console.log(`  Model: ${MODEL}`)
  console.log(`  Target cwd: ${TARGET_CWD}`)
  console.log('')

  const results: RunResult[] = []
  for (let i = 0; i < RUNS_PER_PROMPT; i++) {
    for (const p of PROMPTS) {
      for (const v of VARIANTS) results.push(await runOnce(v.id, v.entry, p, i))
    }
  }

  const summaries = VARIANTS.map((v) => ({ ...v, summary: summarize(results, v.id) }))
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(REPO_ROOT, 'scripts', 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `lsp-vs-outline-callers-${ts}.md`)

  let md = `# Mini-bench — LSP vs outline+symbol em callers cross-file\n\n`
  md += `- Timestamp: ${new Date().toISOString()}\n`
  md += `- Model: \`${MODEL}\`\n`
  md += `- Target cwd: \`${TARGET_CWD}\`\n`
  md += `- Funcao vitima: \`getSmallFastModel\` (12 callers cross-file no openclaude)\n`
  md += `- Runs por prompt: ${RUNS_PER_PROMPT}\n\n`

  md += `## Tabela por invocacao\n\n`
  md += `| Prompt | V | Run | OK | input+cache | cost $ | wall s | turns | tools | read modes | LSP ops |\n`
  md += `|---|---|---:|:-:|---:|---:|---:|---:|---|---|---|\n`
  for (const r of results) {
    md += `| ${r.promptId} | ${r.variant} | ${r.runIdx + 1} | ${r.ok ? 'Y' : 'N'} | ${r.totalInputCostTokens} | ${r.totalCostUsd.toFixed(4)} | ${(r.durationMs / 1000).toFixed(1)} | ${r.numTurns} | ${fmtTools(r.toolCounts)} | ${fmtRead(r.readModes)} | ${fmtLsp(r.lspOps)} |\n`
  }

  md += `\n## Sumario por variante\n\n`
  for (const v of summaries) {
    const s = v.summary
    if (!s) { md += `### ${v.id} (${v.label})\n\nSem runs validas.\n\n`; continue }
    md += `### ${v.id} (${v.label}) — n=${s.n}\n\n`
    md += `- Avg total input cost tokens: **${s.avgTotalInputCostTokens.toFixed(0)}**\n`
    md += `- Avg cache_read: ${s.avgCacheReadTokens.toFixed(0)}; cache_creation: ${s.avgCacheCreationTokens.toFixed(0)}; raw input: ${s.avgInputTokens.toFixed(0)}\n`
    md += `- Avg output tokens: ${s.avgOutputTokens.toFixed(0)}\n`
    md += `- Avg duration: ${(s.avgDurationMs / 1000).toFixed(2)}s\n`
    md += `- Avg turns: ${s.avgTurns.toFixed(1)}\n`
    md += `- Total cost: $${s.totalCost.toFixed(4)}\n`
    md += `- Tool totals: ${fmtTools(s.tc)}\n`
    md += `- Read mode totals: ${fmtRead(s.rm)}\n`
    md += `- LSP op totals: ${fmtLsp(s.lo)}\n\n`
  }

  const sA = summaries.find((s) => s.id === 'A')?.summary
  const sB = summaries.find((s) => s.id === 'B')?.summary
  const sD = summaries.find((s) => s.id === 'D')?.summary
  if (sA && sB && sD) {
    md += `## Deltas vs A (baseline)\n\n`
    md += `| Variant | Δ tokens | Δ wall | Δ cost | Δ turns | LSP calls total |\n`
    md += `|---|---:|---:|---:|---:|---:|\n`
    for (const [label, s] of [['B', sB], ['D', sD]] as const) {
      const dTok = ((s.avgTotalInputCostTokens - sA.avgTotalInputCostTokens) / sA.avgTotalInputCostTokens) * 100
      const dWall = ((s.avgDurationMs - sA.avgDurationMs) / sA.avgDurationMs) * 100
      const dCost = ((s.totalCost - sA.totalCost) / sA.totalCost) * 100
      const dTurns = ((s.avgTurns - sA.avgTurns) / sA.avgTurns) * 100
      const lspTotal = Object.values(s.lo).reduce((a, b) => a + b, 0)
      md += `| ${label} | ${dTok.toFixed(1)}% | ${dWall.toFixed(1)}% | ${dCost.toFixed(1)}% | ${dTurns.toFixed(1)}% | ${lspTotal} |\n`
    }
    md += `\n### Pergunta de pesquisa\n\nLSP-hint move o agente para usar findReferences/outgoingCalls em vez de outline+symbol+Grep?\n\n`
    md += `- Se LSP calls > 0 em D mas = 0 em B → hint funciona.\n`
    md += `- Se D ≈ B em LSP calls → hint inerte (consistente com bench T6.6 completo).\n`
    md += `- Se D tem menos tokens que B → LSP economiza vs outline+symbol cross-file.\n\n`
  }

  md += `## Outputs por prompt\n\n`
  for (const p of PROMPTS) {
    md += `### ${p.id}\n\n> ${p.text}\n\n`
    for (const v of VARIANTS) {
      const rs = results.filter((r) => r.promptId === p.id && r.variant === v.id && r.ok)
      for (const r of rs) {
        md += `**Variant ${v.id} run#${r.runIdx + 1}:**\n\n\`\`\`\n${r.resultText.slice(0, 1500)}${r.resultText.length > 1500 ? '\n...[truncado]' : ''}\n\`\`\`\n\n`
      }
    }
  }

  writeFileSync(outPath, md)
  console.log('')
  console.log(`Report: ${outPath}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
