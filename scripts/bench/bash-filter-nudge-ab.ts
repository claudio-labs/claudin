#!/usr/bin/env bun
/**
 * Bench A/B: mede se um bullet novo na description do BashTool sobre o
 * output filter / pipe-bypass reduz a frequencia de comandos compostos
 * (pipe, &&, ;, &) emitidos pelo modelo.
 *
 * Variante A = baseline (description atual), Variante B = description com
 * o nudge sobre filtro. KPI primario: % de Bash tool_use com command
 * composto. KPI secundario: tokens / cost.
 *
 * Uso:
 *   bun run scripts/bench/bash-filter-nudge-ab.ts
 *
 * Variaveis de ambiente:
 *   ANTHROPIC_MODEL=claude-sonnet-4-6  (default)
 *   CLAUDIO_BENCH_RUNS=5               (runs por prompt por variante)
 *   CLAUDIO_BENCH_BASELINE=dist/baseline/cli.mjs
 *   CLAUDIO_BENCH_FEATURE=dist/cli.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const BASELINE = process.env.CLAUDIO_BENCH_BASELINE ?? join(REPO_ROOT, 'dist', 'baseline', 'cli.mjs')
const FEATURE = process.env.CLAUDIO_BENCH_FEATURE ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const RUNS_PER_PROMPT = Number(process.env.CLAUDIO_BENCH_RUNS ?? '5')
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
const TARGET_CWD = process.env.CLAUDIO_BENCH_TARGET_CWD ?? REPO_ROOT

const PROMPTS: { id: string; text: string }[] = [
  {
    id: 'build-output-inspect',
    text: 'Rode `bun run build` neste repositorio e me diga se houve algum warning ou aviso durante a compilacao. Responda sim/nao e cite os warnings se houver.',
  },
  {
    id: 'test-failure-triage',
    text: 'Rode `bun test src/utils/log.test.ts` e me resuma o resultado: quantos testes passaram, quantos falharam, e qual o tempo total.',
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
  bashCommands: string[]
  bashAtomic: number
  bashCompound: number
  resultText: string
}

function projectDirForCwd(cwd: string): string {
  return cwd.replace(/[\/]/g, '-')
}

/**
 * Heuristica leve (alinhada com src/outputFilter/Bash/pipeline.ts:hasCompound):
 * marca como composto qualquer comando com pipe nao-quotado, &&, ||, ; ou & top-level.
 * Quote-aware basico para single/double quotes; nao tenta lidar com subshells/heredocs
 * (esses tambem sao compostos no filtro real, entao a classificacao casa).
 */
function isCompoundCommand(cmd: string): boolean {
  let inS = false
  let inD = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (escaped) { escaped = false; continue }
    if (c === '\\') { escaped = true; continue }
    if (!inD && c === "'") { inS = !inS; continue }
    if (!inS && c === '"') { inD = !inD; continue }
    if (inS || inD) continue
    if (c === '|') return true            // pipe (cobre || tambem)
    if (c === ';') return true            // separador sequencial
    if (c === '&') return true            // && ou background &
    if (c === '$' && cmd[i + 1] === '(') return true   // subshell
    if (c === '`') return true            // backtick
    if (c === '<' && cmd[i + 1] === '(') return true   // process sub
    if (c === '>' && cmd[i + 1] === '(') return true
  }
  return false
}

interface SessionAnalysis {
  toolCounts: Record<string, number>
  bashCommands: string[]
}

function analyzeSession(sessionId: string, cwd: string): SessionAnalysis {
  const projectDir = projectDirForCwd(cwd)
  const path = join(homedir(), '.claudio', 'projects', projectDir, `${sessionId}.jsonl`)
  if (!existsSync(path)) return { toolCounts: {}, bashCommands: [] }
  const counts: Record<string, number> = {}
  const bashCommands: string[] = []
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const content = obj?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block?.name === 'string') {
          counts[block.name] = (counts[block.name] ?? 0) + 1
          if (block.name === 'Bash' && typeof block?.input?.command === 'string') {
            bashCommands.push(block.input.command)
          }
        }
      }
    } catch {
      // ignore non-json
    }
  }
  return { toolCounts: counts, bashCommands }
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
      const analysis = sessionId ? analyzeSession(sessionId, TARGET_CWD) : { toolCounts: {}, bashCommands: [] }
      let bashAtomic = 0
      let bashCompound = 0
      for (const c of analysis.bashCommands) {
        if (isCompoundCommand(c)) bashCompound++
        else bashAtomic++
      }
      if (ok) {
        const bashN = analysis.toolCounts['Bash'] ?? 0
        process.stdout.write(`OK ${(parsed.duration_ms / 1000).toFixed(1)}s bash=${bashN} compound=${bashCompound}/${bashN}\n`)
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
        toolCounts: analysis.toolCounts,
        bashCommands: analysis.bashCommands,
        bashAtomic,
        bashCompound,
        resultText: typeof parsed?.result === 'string' ? parsed.result : '',
      })
    })
  })
}

function formatToolCounts(counts: Record<string, number>): string {
  const known = ['Bash', 'Read', 'Grep', 'Glob']
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
  const totalBashAtomic = sum((r) => r.bashAtomic)
  const totalBashCompound = sum((r) => r.bashCompound)
  const totalBash = totalBashAtomic + totalBashCompound
  return {
    n: v.length,
    avgDurationMs: avg((r) => r.durationMs),
    avgInputTokens: avg((r) => r.inputTokens),
    avgOutputTokens: avg((r) => r.outputTokens),
    avgCacheReadTokens: avg((r) => r.cacheReadTokens),
    avgCacheCreationTokens: avg((r) => r.cacheCreationTokens),
    totalCost: sum((r) => r.totalCostUsd),
    avgCost: avg((r) => r.totalCostUsd),
    avgTurns: avg((r) => r.numTurns),
    totalToolCounts,
    totalBash,
    totalBashAtomic,
    totalBashCompound,
    pctCompound: totalBash === 0 ? 0 : (totalBashCompound / totalBash) * 100,
  }
}

async function main() {
  if (!existsSync(BASELINE)) {
    console.error(`Baseline entry not found: ${BASELINE}`)
    console.error(`Build baseline first and snapshot it to dist/baseline/cli.mjs.`)
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
      results.push(await runOnce('A', BASELINE, prompt, runIdx))
      results.push(await runOnce('B', FEATURE, prompt, runIdx))
    }
  }

  const summaryA = summarize(results, 'A')
  const summaryB = summarize(results, 'B')

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(REPO_ROOT, 'scripts', 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const safeModel = MODEL.replace(/[^a-z0-9-]/gi, '_')
  const outPath = join(outDir, `bash-filter-nudge-ab-${safeModel}-${ts}.md`)

  let md = `# Bench A/B — BashTool output-filter nudge\n\n`
  md += `- Timestamp: ${new Date().toISOString()}\n`
  md += `- Model: \`${MODEL}\`\n`
  md += `- Baseline: \`${BASELINE}\`\n`
  md += `- Feature:  \`${FEATURE}\`\n`
  md += `- Runs por prompt: ${RUNS_PER_PROMPT}\n\n`

  md += `## Tabela por invocacao\n\n`
  md += `| Prompt | V | Run | OK | Tokens in/out/cache_read | Cost $ | Wall (s) | Turns | Tool calls | Bash atom/comp | Session |\n`
  md += `|---|---|---:|:-:|---|---:|---:|---:|---|---|---|\n`
  for (const r of results) {
    md += `| ${r.promptId} | ${r.variant} | ${r.runIdx + 1} | ${r.ok ? 'Y' : 'N'} `
    md += `| ${r.inputTokens}/${r.outputTokens}/${r.cacheReadTokens} `
    md += `| ${r.totalCostUsd.toFixed(4)} `
    md += `| ${(r.durationMs / 1000).toFixed(1)} `
    md += `| ${r.numTurns} `
    md += `| ${formatToolCounts(r.toolCounts)} `
    md += `| ${r.bashAtomic}/${r.bashCompound} `
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
    md += `- Avg cache-creation tokens: ${s.avgCacheCreationTokens.toFixed(0)}\n`
    md += `- Avg cost: $${s.avgCost.toFixed(4)} (total $${s.totalCost.toFixed(4)})\n`
    md += `- Avg turns: ${s.avgTurns.toFixed(1)}\n`
    md += `- Tool call totals: ${formatToolCounts(s.totalToolCounts)}\n`
    md += `- Bash totals: ${s.totalBash} (atomic=${s.totalBashAtomic}, compound=${s.totalBashCompound}, ${s.pctCompound.toFixed(1)}% composto)\n\n`
  }

  if (summaryA && summaryB) {
    const pctDeltaAbs = summaryB.pctCompound - summaryA.pctCompound
    const pctDeltaRel = summaryA.pctCompound === 0 ? 0 : ((summaryB.pctCompound - summaryA.pctCompound) / summaryA.pctCompound) * 100
    const costDelta = summaryA.avgCost === 0 ? 0 : ((summaryB.avgCost - summaryA.avgCost) / summaryA.avgCost) * 100
    const tokDelta = summaryA.avgInputTokens === 0 ? 0 : ((summaryB.avgInputTokens - summaryA.avgInputTokens) / summaryA.avgInputTokens) * 100
    md += `### Delta\n\n`
    md += `- % composto: ${summaryA.pctCompound.toFixed(1)}% -> ${summaryB.pctCompound.toFixed(1)}% (abs ${pctDeltaAbs.toFixed(1)}pp, rel ${pctDeltaRel.toFixed(1)}%)\n`
    md += `- Bash compound: ${summaryA.totalBashCompound} -> ${summaryB.totalBashCompound}\n`
    md += `- Avg input tokens delta: ${tokDelta.toFixed(1)}%\n`
    md += `- Avg cost delta: ${costDelta.toFixed(1)}%\n\n`

    md += `### Kill criteria\n\n`
    md += `- SHIP se B reduz % composto em >=15% rel E avg cost nao piora (<+5%).\n`
    md += `- KILL se B reduz % composto <15% rel (nudge inerte).\n`
    md += `- KILL se cost piora >+5% mesmo com menos compostos (nudge causou regressao em outro lugar).\n\n`

    const compoundOk = pctDeltaRel <= -15
    const costOk = costDelta <= 5
    const verdict = compoundOk && costOk ? 'SHIP candidate' : (compoundOk ? 'INVESTIGAR (compoundOK mas cost piorou)' : 'INERT/REVERT')
    md += `- Veredito: **${verdict}**\n`
    md += `  - compound delta rel: ${pctDeltaRel.toFixed(1)}% (${compoundOk ? 'OK' : 'fail'})\n`
    md += `  - cost delta: ${costDelta.toFixed(1)}% (${costOk ? 'OK' : 'fail'})\n\n`
  }

  md += `## Comandos Bash observados\n\n`
  for (const variant of ['A', 'B'] as const) {
    md += `### Variante ${variant}\n\n`
    const rs = results.filter((r) => r.variant === variant && r.ok)
    for (const r of rs) {
      if (r.bashCommands.length === 0) continue
      md += `**${r.promptId} run#${r.runIdx + 1}** (atomic=${r.bashAtomic}, compound=${r.bashCompound}):\n\n`
      for (const c of r.bashCommands) {
        const flag = isCompoundCommand(c) ? '[C]' : '[A]'
        md += `- ${flag} \`${c.slice(0, 200)}${c.length > 200 ? '…' : ''}\`\n`
      }
      md += `\n`
    }
  }

  md += `## Outputs (resultText) lado a lado\n\n`
  for (const prompt of PROMPTS) {
    md += `### ${prompt.id}\n\n> ${prompt.text}\n\n`
    for (const variant of ['A', 'B'] as const) {
      const rs = results.filter((r) => r.promptId === prompt.id && r.variant === variant && r.ok)
      for (const r of rs) {
        md += `**Variant ${variant} run#${r.runIdx + 1}:**\n\n\`\`\`\n${r.resultText.slice(0, 1000)}${r.resultText.length > 1000 ? '\n…[truncado]' : ''}\n\`\`\`\n\n`
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
