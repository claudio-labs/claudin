#!/usr/bin/env bun
/**
 * Bench A/B: compara duas variantes das tool descriptions LSPTool/GrepTool.
 *
 * Roda os mesmos prompts simbolicos em dois entrypoints (baseline vs feature),
 * em ordem intercalada, e mede tokens / cost / tempo / contagem de tool calls
 * por tool (especialmente Grep vs LSP).
 *
 * Uso:
 *   bun run scripts/bench/ab/lsp-grep-descriptions-ab.ts
 *
 * Variaveis de ambiente:
 *   ANTHROPIC_MODEL=claude-sonnet-4-6  (default)
 *   CLAUDIN_BENCH_RUNS=2               (runs por prompt por variante)
 *   CLAUDIN_BENCH_BASELINE=dist/baseline/cli.mjs
 *   CLAUDIN_BENCH_FEATURE=dist/cli.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'

const BASELINE = process.env.CLAUDIN_BENCH_BASELINE ?? join(REPO_ROOT, 'dist', 'baseline', 'cli.mjs')
const FEATURE = process.env.CLAUDIN_BENCH_FEATURE ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const RUNS_PER_PROMPT = Number(process.env.CLAUDIN_BENCH_RUNS ?? '2')
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
const TARGET_CWD = process.env.CLAUDIN_BENCH_TARGET_CWD ?? REPO_ROOT

const PROMPTS: { id: string; text: string }[] = [
  {
    id: 'cross-file-callers',
    text: 'Listar todos os call sites de getGlobalConfig() no codebase (apenas chamadas reais da funcao, ignorar comentarios, strings e definicoes). Devolver arquivo:linha de cada call site, agrupado por diretorio top-level (src/utils, src/services, etc.).',
  },
  {
    id: 'type-impact-analysis',
    text: 'Estou pensando em renomear o tipo SDKMessage para AgentSdkEvent. Quais arquivos precisarao ser editados? Liste cada arquivo afetado e quantas ocorrencias dentro dele (apenas usos do tipo, nao strings nem comentarios).',
  },
]

interface RunResult {
  promptId: string
  variant: 'A' | 'B'
  runIdx: number
  ok: boolean
  errorReason?: string
  durationMs: number
  durationApiMs: number
  totalCostUsd: number
  numTurns: number
  sessionId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  toolCounts: Record<string, number>
  resultText: string
}

function projectDirForCwd(cwd: string): string {
  return cwd.replace(/[\/]/g, '-')
}

function readToolCountsFromSession(sessionId: string, cwd: string): Record<string, number> {
  const projectDir = projectDirForCwd(cwd)
  const path = join(homedir(), '.claudin', 'projects', projectDir, `${sessionId}.jsonl`)
  if (!existsSync(path)) return {}
  const counts: Record<string, number> = {}
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const content = obj?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block?.name === 'string') {
          counts[block.name] = (counts[block.name] ?? 0) + 1
        }
      }
    } catch {
      // ignore non-json lines
    }
  }
  return counts
}

function runOnce(variant: 'A' | 'B', entryPath: string, prompt: { id: string; text: string }, runIdx: number): Promise<RunResult> {
  const variantLabel = variant === 'A' ? 'baseline' : 'feature'
  process.stdout.write(`  [${variant}/${variantLabel}] ${prompt.id} run#${runIdx + 1} ... `)
  const start = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn('node', [entryPath, '-p', prompt.text, '--model', MODEL, '--output-format', 'json'], {
      cwd: TARGET_CWD,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdoutBuf = ''
    let stderrBuf = ''
    child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })
    child.on('close', (code) => {
      const wall = Date.now() - start
      let parsed: any = null
      try {
        parsed = JSON.parse(stdoutBuf.trim().split('\n').filter(Boolean).pop() ?? '{}')
      } catch {
        // parse error
      }
      const ok = code === 0 && parsed?.type === 'result' && parsed?.subtype === 'success'
      if (!ok) {
        process.stdout.write(`FAIL (exit=${code})\n`)
      }
      const sessionId: string = parsed?.session_id ?? ''
      const usageRecord = parsed?.modelUsage ?? {}
      const usageEntry: any = Object.values(usageRecord)[0] ?? {}
      const toolCounts = sessionId ? readToolCountsFromSession(sessionId, TARGET_CWD) : {}
      if (ok) {
        const grepN = toolCounts['Grep'] ?? 0
        const lspN = toolCounts['LSP'] ?? 0
        process.stdout.write(`OK ${(parsed.duration_ms / 1000).toFixed(1)}s grep=${grepN} lsp=${lspN}\n`)
      }
      resolvePromise({
        promptId: prompt.id,
        variant,
        runIdx,
        ok,
        errorReason: ok ? undefined : `exit=${code} stderr=${stderrBuf.slice(0, 200)}`,
        durationMs: parsed?.duration_ms ?? wall,
        durationApiMs: parsed?.duration_api_ms ?? 0,
        totalCostUsd: parsed?.total_cost_usd ?? 0,
        numTurns: parsed?.num_turns ?? 0,
        sessionId,
        inputTokens: usageEntry?.inputTokens ?? 0,
        outputTokens: usageEntry?.outputTokens ?? 0,
        cacheReadTokens: usageEntry?.cacheReadInputTokens ?? 0,
        cacheCreationTokens: usageEntry?.cacheCreationInputTokens ?? 0,
        toolCounts,
        resultText: typeof parsed?.result === 'string' ? parsed.result : '',
      })
    })
  })
}

function formatToolCounts(counts: Record<string, number>): string {
  const known = ['Grep', 'LSP', 'Read', 'Glob']
  const parts: string[] = []
  for (const k of known) parts.push(`${k}=${counts[k] ?? 0}`)
  const other = Object.entries(counts)
    .filter(([k]) => !known.includes(k))
    .reduce((acc, [, v]) => acc + v, 0)
  if (other > 0) parts.push(`other=${other}`)
  return parts.join(' ')
}

function summarize(results: RunResult[], variant: 'A' | 'B') {
  const v = results.filter((r) => r.variant === variant && r.ok)
  if (v.length === 0) return null
  const sum = (sel: (r: RunResult) => number) => v.reduce((a, r) => a + sel(r), 0)
  const avg = (sel: (r: RunResult) => number) => sum(sel) / v.length
  const totalToolCounts: Record<string, number> = {}
  for (const r of v) {
    for (const [name, n] of Object.entries(r.toolCounts)) {
      totalToolCounts[name] = (totalToolCounts[name] ?? 0) + n
    }
  }
  return {
    n: v.length,
    avgDurationMs: avg((r) => r.durationMs),
    avgInputTokens: avg((r) => r.inputTokens),
    avgOutputTokens: avg((r) => r.outputTokens),
    avgCacheReadTokens: avg((r) => r.cacheReadTokens),
    totalCost: sum((r) => r.totalCostUsd),
    avgTurns: avg((r) => r.numTurns),
    totalToolCounts,
  }
}

async function main() {
  if (!existsSync(BASELINE)) {
    console.error(`Baseline entry not found: ${BASELINE}`)
    console.error(`Build baseline first and snapshot it to dist/baseline/cli.mjs (see plan).`)
    process.exit(1)
  }
  if (!existsSync(FEATURE)) {
    console.error(`Feature entry not found: ${FEATURE}`)
    process.exit(1)
  }

  console.log(`Bench: ${PROMPTS.length} prompts x ${RUNS_PER_PROMPT} runs x 2 variants = ${PROMPTS.length * RUNS_PER_PROMPT * 2} invocations`)
  console.log(`  Baseline (A): ${BASELINE}`)
  console.log(`  Feature  (B): ${FEATURE}`)
  console.log(`  Model:        ${MODEL}`)
  console.log('')

  const results: RunResult[] = []
  for (let runIdx = 0; runIdx < RUNS_PER_PROMPT; runIdx++) {
    for (const prompt of PROMPTS) {
      // intercalado A,B para diluir efeitos de cache externo
      results.push(await runOnce('A', BASELINE, prompt, runIdx))
      results.push(await runOnce('B', FEATURE, prompt, runIdx))
    }
  }

  const summaryA = summarize(results, 'A')
  const summaryB = summarize(results, 'B')

  // Markdown report
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(REPO_ROOT, 'scripts', 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `lsp-grep-ab-${ts}.md`)

  let md = `# Bench A/B — LSPTool/GrepTool descriptions\n\n`
  md += `- Timestamp: ${new Date().toISOString()}\n`
  md += `- Model: \`${MODEL}\`\n`
  md += `- Baseline: \`${BASELINE}\`\n`
  md += `- Feature:  \`${FEATURE}\`\n`
  md += `- Runs por prompt: ${RUNS_PER_PROMPT}\n\n`

  md += `## Tabela por invocacao\n\n`
  md += `| Prompt | V | Run | OK | Tokens in/out/cache_read | Cost $ | Wall (s) | Turns | Tool calls | Session |\n`
  md += `|---|---|---:|:-:|---|---:|---:|---:|---|---|\n`
  for (const r of results) {
    md += `| ${r.promptId} | ${r.variant} | ${r.runIdx + 1} | ${r.ok ? 'Y' : 'N'} `
    md += `| ${r.inputTokens}/${r.outputTokens}/${r.cacheReadTokens} `
    md += `| ${r.totalCostUsd.toFixed(4)} `
    md += `| ${(r.durationMs / 1000).toFixed(1)} `
    md += `| ${r.numTurns} `
    md += `| ${formatToolCounts(r.toolCounts)} `
    md += `| ${r.sessionId.slice(0, 8)} |\n`
  }

  md += `\n## Sumario\n\n`
  for (const [name, s] of [['A (baseline)', summaryA], ['B (feature)', summaryB]] as const) {
    if (!s) { md += `### ${name}\n\nSem runs validas.\n\n`; continue }
    md += `### ${name} (n=${s.n})\n\n`
    md += `- Avg duration: ${(s.avgDurationMs / 1000).toFixed(2)}s\n`
    md += `- Avg input tokens: ${s.avgInputTokens.toFixed(0)}\n`
    md += `- Avg output tokens: ${s.avgOutputTokens.toFixed(0)}\n`
    md += `- Avg cache-read tokens: ${s.avgCacheReadTokens.toFixed(0)}\n`
    md += `- Total cost: $${s.totalCost.toFixed(4)}\n`
    md += `- Avg turns: ${s.avgTurns.toFixed(1)}\n`
    md += `- Tool call totals: ${formatToolCounts(s.totalToolCounts)}\n\n`
  }

  if (summaryA && summaryB) {
    const grepA = summaryA.totalToolCounts['Grep'] ?? 0
    const grepB = summaryB.totalToolCounts['Grep'] ?? 0
    const lspA = summaryA.totalToolCounts['LSP'] ?? 0
    const lspB = summaryB.totalToolCounts['LSP'] ?? 0
    md += `### Delta\n\n`
    md += `- LSP calls: ${lspA} -> ${lspB} (delta ${lspB - lspA})\n`
    md += `- Grep calls: ${grepA} -> ${grepB} (delta ${grepB - grepA})\n`
    const tokDelta = summaryA.avgInputTokens === 0 ? 0 : ((summaryB.avgInputTokens - summaryA.avgInputTokens) / summaryA.avgInputTokens) * 100
    const wallDelta = summaryA.avgDurationMs === 0 ? 0 : ((summaryB.avgDurationMs - summaryA.avgDurationMs) / summaryA.avgDurationMs) * 100
    md += `- Avg input tokens delta: ${tokDelta.toFixed(1)}%\n`
    md += `- Avg wall-clock delta: ${wallDelta.toFixed(1)}%\n\n`

    md += `### Kill criteria (do roadmap)\n\n`
    md += `- GO se B mostra >=5% mais LSP calls que A E nenhum delta > +10% em tokens/wall.\n`
    md += `- LSP delta: ${lspA === 0 ? (lspB > 0 ? 'inf%' : '0%') : (((lspB - lspA) / lspA) * 100).toFixed(1) + '%'}\n`
    md += `- Tokens delta: ${tokDelta.toFixed(1)}% (limite +10%)\n`
    md += `- Wall delta: ${wallDelta.toFixed(1)}% (limite +10%)\n\n`
  }

  md += `## Outputs (resultText) lado a lado\n\n`
  for (const prompt of PROMPTS) {
    md += `### ${prompt.id}\n\n> ${prompt.text}\n\n`
    for (const variant of ['A', 'B'] as const) {
      const rs = results.filter((r) => r.promptId === prompt.id && r.variant === variant && r.ok)
      for (const r of rs) {
        md += `**Variant ${variant} run#${r.runIdx + 1}:**\n\n\`\`\`\n${r.resultText.slice(0, 1500)}${r.resultText.length > 1500 ? '\n...[truncado]' : ''}\n\`\`\`\n\n`
      }
    }
  }

  writeFileSync(outPath, md)
  console.log('')
  console.log(`Report: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
