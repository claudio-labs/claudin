#!/usr/bin/env bun
/**
 * Bench A/B: mede se os nudges (tool-description + system-reminder JIT)
 * empurram o modelo do padrao "Read serial + narracao" para Explore-agent
 * ou parallel-Read tool_use blocks.
 *
 * Forked de narration-prompt-ab.ts. Mantem os 3 prompts de exploracao,
 * adiciona duas metricas: parallelReadFraction e exploreInvocations.
 *
 * Variante A = baseline (sem feature flag), Variante B = feature on
 * (tool descriptions atualizadas + system-reminder JIT em Read).
 *
 * Ship/kill criteria:
 *   SHIP se narrationChars cai >=30% rel
 *        E (parallelReadFraction sobe >=0.15 abs OU exploreInvocations >=1
 *           em >=2/3 prompts)
 *        E answerChars nao cai >15%
 *        E cost nao sobe >+5%
 *        E wallMs nao sobe >+10%.
 *   KILL se narrationChars cai <20% rel OU wall time sobe >+15%.
 *
 * Uso:
 *   CLAUDIN_BENCH_BASELINE=dist-bench-baseline/cli.mjs \
 *   CLAUDIN_BENCH_FEATURE=dist/cli.mjs \
 *   ANTHROPIC_MODEL=claude-opus-4-8 \
 *   bun run scripts/bench/serial-read-nudge-ab.ts
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const BASELINE = process.env.CLAUDIN_BENCH_BASELINE ?? join(REPO_ROOT, 'dist-bench-baseline', 'cli.mjs')
const FEATURE = process.env.CLAUDIN_BENCH_FEATURE ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const RUNS_PER_PROMPT = Number(process.env.CLAUDIN_BENCH_RUNS ?? '3')
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const TARGET_CWD = process.env.CLAUDIN_BENCH_TARGET_CWD ?? REPO_ROOT
const MAX_PROMPTS = Number(process.env.CLAUDIN_BENCH_PROMPTS ?? '0')

const PROMPTS: { id: string; text: string }[] = [
  {
    id: 'explain-openai-shim',
    text: 'Explique como o openaiShim traduz tool calls do formato Anthropic para o formato OpenAI Chat Completions. Leia os arquivos relevantes em src/providers/shims/openaiShim/ e me de uma explicacao final coesa.',
  },
  {
    id: 'explain-auto-memory',
    text: 'Como funciona o sistema de auto-memory deste repositorio? Descreva o fluxo de ponta a ponta lendo o codigo relevante (src/memory/memdir, src/memory/extract, src/memory/session).',
  },
  {
    id: 'explain-provider-resolution',
    text: 'Como o Claudin resolve qual provider/SDK usar a partir do profile ativo? Leia src/providers/presets/activeProvider.ts e client.ts e explique o caminho de decisao.',
  },
]

interface RunResult {
  promptId: string
  variant: 'A' | 'B'
  runIdx: number
  ok: boolean
  errorReason?: string
  durationMs: number
  totalCostUsd: number
  numTurns: number
  sessionId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  toolCounts: Record<string, number>
  narrationBlocks: number
  narrationChars: number
  answerChars: number
  narrationSamples: string[]
  parallelReadFraction: number
  exploreInvocations: number
}

function projectDirForCwd(cwd: string): string {
  return cwd.replace(/[\/]/g, '-')
}

interface SessionAnalysis {
  toolCounts: Record<string, number>
  narrationBlocks: number
  narrationChars: number
  answerChars: number
  narrationSamples: string[]
  parallelReadFraction: number
  exploreInvocations: number
}

/**
 * Le o transcript .jsonl. Alem das metricas de narracao, conta:
 * - parallelReadFraction: # de mensagens assistant com >=2 Read tool_use
 *   dividido por # com qualquer Read (0 se denominador 0)
 * - exploreInvocations: # de tool_use Agent cujo input.subagent_type === 'Explore'
 */
function analyzeSession(sessionId: string, cwd: string): SessionAnalysis {
  const empty: SessionAnalysis = {
    toolCounts: {},
    narrationBlocks: 0,
    narrationChars: 0,
    answerChars: 0,
    narrationSamples: [],
    parallelReadFraction: 0,
    exploreInvocations: 0,
  }
  const projectDir = projectDirForCwd(cwd)
  const path = join(homedir(), '.claudin', 'projects', projectDir, `${sessionId}.jsonl`)
  if (!existsSync(path)) return empty

  const counts: Record<string, number> = {}
  interface AsstMsg { texts: string[]; hasToolUse: boolean; readCount: number }
  const asstMsgs: AsstMsg[] = []
  let exploreInvocations = 0

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const role = obj?.message?.role ?? obj?.type
    const content = obj?.message?.content
    if (role !== 'assistant' || !Array.isArray(content)) continue

    const texts: string[] = []
    let hasToolUse = false
    let readCount = 0
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block?.name === 'string') {
        hasToolUse = true
        counts[block.name] = (counts[block.name] ?? 0) + 1
        if (block.name === 'Read') readCount++
        if (block.name === 'Agent') {
          // input may be string or parsed object
          let input: any = block.input
          if (typeof input === 'string') {
            try { input = JSON.parse(input) } catch { input = null }
          }
          if (input && input.subagent_type === 'Explore') exploreInvocations++
        }
      } else if (block?.type === 'text' && typeof block?.text === 'string') {
        const t = block.text.trim()
        if (t.length > 0) texts.push(t)
      }
    }
    asstMsgs.push({ texts, hasToolUse, readCount })
  }

  let answerIdx = -1
  for (let i = asstMsgs.length - 1; i >= 0; i--) {
    if (!asstMsgs[i].hasToolUse && asstMsgs[i].texts.length > 0) {
      answerIdx = i
      break
    }
  }

  let narrationBlocks = 0
  let narrationChars = 0
  let answerChars = 0
  const narrationSamples: string[] = []
  let anyReadTurns = 0
  let parallelReadTurns = 0
  for (let i = 0; i < asstMsgs.length; i++) {
    const m = asstMsgs[i]
    if (m.readCount > 0) anyReadTurns++
    if (m.readCount >= 2) parallelReadTurns++
    if (i === answerIdx) {
      answerChars += m.texts.reduce((a, t) => a + t.length, 0)
      continue
    }
    for (const t of m.texts) {
      narrationBlocks++
      narrationChars += t.length
      if (narrationSamples.length < 12) narrationSamples.push(t.slice(0, 200))
    }
  }

  const parallelReadFraction = anyReadTurns === 0 ? 0 : parallelReadTurns / anyReadTurns

  return { toolCounts: counts, narrationBlocks, narrationChars, answerChars, narrationSamples, parallelReadFraction, exploreInvocations }
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
      if (!ok) process.stdout.write(`FAIL (exit=${code})\n`)
      const sessionId: string = parsed?.session_id ?? ''
      const usageRecord = parsed?.modelUsage ?? {}
      const usageEntry: any = Object.values(usageRecord)[0] ?? {}
      const a = sessionId ? analyzeSession(sessionId, TARGET_CWD) : {
        toolCounts: {}, narrationBlocks: 0, narrationChars: 0, answerChars: 0,
        narrationSamples: [], parallelReadFraction: 0, exploreInvocations: 0,
      }
      if (ok) {
        process.stdout.write(`OK ${(parsed.duration_ms / 1000).toFixed(1)}s narrChars=${a.narrationChars} parReadFrac=${a.parallelReadFraction.toFixed(2)} explore=${a.exploreInvocations}\n`)
      }
      resolvePromise({
        promptId: prompt.id,
        variant,
        runIdx,
        ok,
        errorReason: ok ? undefined : `exit=${code} stderr=${stderrBuf.slice(0, 200)}`,
        durationMs: parsed?.duration_ms ?? wall,
        totalCostUsd: parsed?.total_cost_usd ?? 0,
        numTurns: parsed?.num_turns ?? 0,
        sessionId,
        inputTokens: usageEntry?.inputTokens ?? 0,
        outputTokens: usageEntry?.outputTokens ?? 0,
        cacheReadTokens: usageEntry?.cacheReadInputTokens ?? 0,
        cacheCreationTokens: usageEntry?.cacheCreationInputTokens ?? 0,
        toolCounts: a.toolCounts,
        narrationBlocks: a.narrationBlocks,
        narrationChars: a.narrationChars,
        answerChars: a.answerChars,
        narrationSamples: a.narrationSamples,
        parallelReadFraction: a.parallelReadFraction,
        exploreInvocations: a.exploreInvocations,
      })
    })
  })
}

function formatToolCounts(counts: Record<string, number>): string {
  const known = ['Read', 'Grep', 'Glob', 'Bash', 'Agent']
  const parts: string[] = []
  for (const k of known) parts.push(`${k}=${counts[k] ?? 0}`)
  const other = Object.entries(counts).filter(([k]) => !known.includes(k)).reduce((acc, [, v]) => acc + v, 0)
  if (other > 0) parts.push(`other=${other}`)
  return parts.join(' ')
}

function summarize(results: RunResult[], variant: 'A' | 'B') {
  const v = results.filter((r) => r.variant === variant && r.ok)
  if (v.length === 0) return null
  const sum = (sel: (r: RunResult) => number) => v.reduce((a, r) => a + sel(r), 0)
  const avg = (sel: (r: RunResult) => number) => sum(sel) / v.length
  const totalToolCounts: Record<string, number> = {}
  for (const r of v) for (const [name, n] of Object.entries(r.toolCounts)) totalToolCounts[name] = (totalToolCounts[name] ?? 0) + n
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
    avgNarrationBlocks: avg((r) => r.narrationBlocks),
    avgNarrationChars: avg((r) => r.narrationChars),
    avgAnswerChars: avg((r) => r.answerChars),
    avgParallelReadFraction: avg((r) => r.parallelReadFraction),
    avgExploreInvocations: avg((r) => r.exploreInvocations),
    totalToolCounts,
  }
}

async function main() {
  if (!existsSync(BASELINE)) {
    console.error(`Baseline entry not found: ${BASELINE}`)
    process.exit(1)
  }
  if (!existsSync(FEATURE)) {
    console.error(`Feature entry not found: ${FEATURE}`)
    process.exit(1)
  }

  const activePrompts = MAX_PROMPTS > 0 ? PROMPTS.slice(0, MAX_PROMPTS) : PROMPTS
  console.log(`Bench serial-read-nudge: ${activePrompts.length} prompts x ${RUNS_PER_PROMPT} runs x 2 variants = ${activePrompts.length * RUNS_PER_PROMPT * 2} invocations`)
  console.log(`  Baseline (A): ${BASELINE}`)
  console.log(`  Feature  (B): ${FEATURE}`)
  console.log(`  Model:        ${MODEL}`)
  console.log(`  Target cwd:   ${TARGET_CWD}`)
  console.log('')

  const results: RunResult[] = []
  for (let runIdx = 0; runIdx < RUNS_PER_PROMPT; runIdx++) {
    for (const prompt of activePrompts) {
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
  const outPath = join(outDir, `serial-read-nudge-ab-${safeModel}-${ts}.md`)

  let md = `# Bench A/B — serial-read nudge (Explore + parallel Reads)\n\n`
  md += `- Timestamp: ${new Date().toISOString()}\n`
  md += `- Model: \`${MODEL}\`\n`
  md += `- Baseline (A): \`${BASELINE}\`\n`
  md += `- Feature  (B): \`${FEATURE}\`\n`
  md += `- Runs por prompt: ${RUNS_PER_PROMPT}\n`
  md += `- KPIs: narrationChars, parallelReadFraction, exploreInvocations\n\n`

  md += `## Tabela por invocacao\n\n`
  md += `| Prompt | V | Run | OK | narr chars | answer chars | parRead frac | explore | out tok | cost $ | wall(s) | turns | tools |\n`
  md += `|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n`
  for (const r of results) {
    md += `| ${r.promptId} | ${r.variant} | ${r.runIdx + 1} | ${r.ok ? 'Y' : 'N'} `
    md += `| ${r.narrationChars} | ${r.answerChars} | ${r.parallelReadFraction.toFixed(2)} | ${r.exploreInvocations} `
    md += `| ${r.outputTokens} | ${r.totalCostUsd.toFixed(4)} | ${(r.durationMs / 1000).toFixed(1)} | ${r.numTurns} `
    md += `| ${formatToolCounts(r.toolCounts)} |\n`
  }

  md += `\n## Sumario\n\n`
  for (const [name, s] of [['A (baseline)', summaryA], ['B (feature)', summaryB]] as const) {
    if (!s) { md += `### ${name}\n\nSem runs validas.\n\n`; continue }
    md += `### ${name} (n=${s.n})\n\n`
    md += `- Avg narration chars: ${s.avgNarrationChars.toFixed(0)}\n`
    md += `- Avg answer chars: ${s.avgAnswerChars.toFixed(0)}\n`
    md += `- Avg parallelReadFraction: ${s.avgParallelReadFraction.toFixed(3)}\n`
    md += `- Avg exploreInvocations: ${s.avgExploreInvocations.toFixed(2)}\n`
    md += `- Avg output tokens: ${s.avgOutputTokens.toFixed(0)}\n`
    md += `- Avg cost: $${s.avgCost.toFixed(4)} (total $${s.totalCost.toFixed(4)})\n`
    md += `- Avg wall: ${(s.avgDurationMs / 1000).toFixed(1)}s\n`
    md += `- Avg turns: ${s.avgTurns.toFixed(1)}\n`
    md += `- Tool totals: ${formatToolCounts(s.totalToolCounts)}\n\n`
  }

  if (summaryA && summaryB) {
    const rel = (a: number, b: number) => (a === 0 ? 0 : ((b - a) / a) * 100)
    const narrCharDelta = rel(summaryA.avgNarrationChars, summaryB.avgNarrationChars)
    const answerDelta = rel(summaryA.avgAnswerChars, summaryB.avgAnswerChars)
    const costDelta = rel(summaryA.avgCost, summaryB.avgCost)
    const wallDelta = rel(summaryA.avgDurationMs, summaryB.avgDurationMs)
    const parReadAbsDelta = summaryB.avgParallelReadFraction - summaryA.avgParallelReadFraction

    // explore >=1 in >=2/3 prompts? compute per prompt for B
    const promptIds = Array.from(new Set(results.map((r) => r.promptId)))
    let promptsWithExplore = 0
    for (const pid of promptIds) {
      const b = results.filter((r) => r.promptId === pid && r.variant === 'B' && r.ok)
      if (b.length === 0) continue
      const meanExplore = b.reduce((a, r) => a + r.exploreInvocations, 0) / b.length
      if (meanExplore >= 1) promptsWithExplore++
    }
    const exploreHitRate = promptsWithExplore / promptIds.length

    md += `### Delta\n\n`
    md += `- Narration chars: ${summaryA.avgNarrationChars.toFixed(0)} -> ${summaryB.avgNarrationChars.toFixed(0)} (rel ${narrCharDelta.toFixed(1)}%)\n`
    md += `- ParallelReadFraction: ${summaryA.avgParallelReadFraction.toFixed(3)} -> ${summaryB.avgParallelReadFraction.toFixed(3)} (abs ${parReadAbsDelta.toFixed(3)})\n`
    md += `- ExploreInvocations avg: ${summaryA.avgExploreInvocations.toFixed(2)} -> ${summaryB.avgExploreInvocations.toFixed(2)}\n`
    md += `- Prompts com explore>=1 em B: ${promptsWithExplore}/${promptIds.length}\n`
    md += `- Answer chars delta: ${answerDelta.toFixed(1)}%\n`
    md += `- Cost delta: ${costDelta.toFixed(1)}%\n`
    md += `- Wall delta: ${wallDelta.toFixed(1)}%\n\n`

    md += `### Kill criteria\n\n`
    md += `- SHIP se narrationChars cai >=30% rel E (parallelReadFraction sobe >=0.15 abs OU explore>=1 em >=2/3 prompts) E answerChars nao cai >15% E cost nao sobe >+5% E wall nao sobe >+10%.\n`
    md += `- KILL se narrationChars cai <20% rel OU wall sobe >+15%.\n\n`

    const narrShipOk = narrCharDelta <= -30
    const adoptionOk = parReadAbsDelta >= 0.15 || exploreHitRate >= 2 / 3
    const answerOk = answerDelta >= -15
    const costOk = costDelta <= 5
    const wallOk = wallDelta <= 10
    const ship = narrShipOk && adoptionOk && answerOk && costOk && wallOk
    const kill = narrCharDelta > -20 || wallDelta > 15
    const verdict = ship ? 'SHIP candidate' : (kill ? 'KILL' : 'INVESTIGAR')
    md += `- Veredito: **${verdict}**\n`
    md += `  - narrationChars: ${narrCharDelta.toFixed(1)}% (ship>=−30 ${narrShipOk ? 'OK' : 'fail'})\n`
    md += `  - adoption (parallel >=0.15 abs OR explore>=1 em 2/3 prompts): par=${parReadAbsDelta.toFixed(3)} hit=${promptsWithExplore}/${promptIds.length} (${adoptionOk ? 'OK' : 'fail'})\n`
    md += `  - answerChars: ${answerDelta.toFixed(1)}% (${answerOk ? 'OK' : 'fail'})\n`
    md += `  - cost: ${costDelta.toFixed(1)}% (${costOk ? 'OK' : 'fail'})\n`
    md += `  - wall: ${wallDelta.toFixed(1)}% (${wallOk ? 'OK' : 'fail'})\n\n`
  }

  md += `## Amostras de narracao (texto fora da resposta final)\n\n`
  for (const prompt of activePrompts) {
    md += `### ${prompt.id}\n\n`
    for (const variant of ['A', 'B'] as const) {
      const rs = results.filter((r) => r.promptId === prompt.id && r.variant === variant && r.ok)
      for (const r of rs) {
        if (r.narrationSamples.length === 0) continue
        md += `**Variant ${variant} run#${r.runIdx + 1}** (${r.narrationBlocks} blocks):\n\n`
        for (const s of r.narrationSamples) md += `- ${s.replace(/\n/g, ' ')}\n`
        md += `\n`
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
