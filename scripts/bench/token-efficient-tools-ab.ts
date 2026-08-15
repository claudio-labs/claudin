#!/usr/bin/env bun
/**
 * Bench A/B: token-efficient tools (FC v3 JSON tool_use)
 *
 * Mesmo binario (dist/cli.mjs) em ambas as variantes; o que muda e' so o env:
 *   A (baseline) = default (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=true, sem JSON tool_use)
 *   B (feature)  = CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=false + CLAUDE_CODE_JSON_TOOL_USE=1
 *
 * Anthropic anuncia ~4.5% reducao em output tokens; o ganho concentra em turnos
 * com tool_use (~14% nesses). Provider tem que ser 1P Anthropic ou Foundry; em
 * openaiShim/Bedrock/Vertex o header e' strippado e o bench fica inerte.
 *
 * KPIs:
 * - PRIMARIO:  output_tokens por sessao (efeito direto do header)
 * - PRIMARIO:  cache_creation tokens (= "write tokens" — o que vai pro cache)
 * - PRIMARIO:  narration chars (qualidade do canal — nao deve piorar)
 * - SECUNDARIO: tool use breakdown (qual tool, quantas vezes), turns, cost
 *
 * Uso:
 *   bun run scripts/bench/token-efficient-tools-ab.ts
 *
 * Vars:
 *   ANTHROPIC_MODEL=claude-opus-4-8   (default)
 *   CLAUDIN_BENCH_RUNS=2              (runs por prompt por variante; 3 prompts*2*2 = 12)
 *   CLAUDIN_BENCH_ENTRY=dist/cli.mjs  (binario unico; default = dist atual)
 *   CLAUDIN_BENCH_TARGET_CWD=<repo>   (default = repo root)
 *   CLAUDIN_BENCH_PROMPTS=0           (limita prompts; 0 = todos)
 *   CLAUDIN_BENCH_PARALLEL=1          (invocacoes concorrentes; cada uma e' sessao isolada)
 *   CLAUDIN_BENCH_RESUME=<path.md>    (re-roda apenas FAILs do report anterior, merge no novo)
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = process.env.CLAUDIN_BENCH_ENTRY ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const RUNS_PER_PROMPT = Number(process.env.CLAUDIN_BENCH_RUNS ?? '2')
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const TARGET_CWD = process.env.CLAUDIN_BENCH_TARGET_CWD ?? REPO_ROOT
const MAX_PROMPTS = Number(process.env.CLAUDIN_BENCH_PROMPTS ?? '0')
const PROMPT_IDS_FILTER = (process.env.CLAUDIN_BENCH_PROMPT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const PARALLEL = Math.max(1, Number(process.env.CLAUDIN_BENCH_PARALLEL ?? '1'))
const RESUME_FROM = process.env.CLAUDIN_BENCH_RESUME ?? ''

interface ResumeJob { promptId: string; variant: 'A' | 'B'; runIdx: number }

function parseResumeFails(path: string): ResumeJob[] {
  const md = readFileSync(path, 'utf8')
  const jobs: ResumeJob[] = []
  for (const line of md.split('\n')) {
    if (!line.startsWith('| ')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 5) continue
    const [, promptId, variant, runStr, ok] = cells
    if (ok !== 'N') continue
    if (variant !== 'A' && variant !== 'B') continue
    const runIdx = Number(runStr) - 1
    if (!Number.isFinite(runIdx) || runIdx < 0) continue
    jobs.push({ promptId, variant, runIdx })
  }
  return jobs
}

async function runWithConcurrency<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= jobs.length) return
      out[i] = await jobs[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => worker()))
  return out
}

// Prompts de exploracao read-only com varios tool_use (onde o header pega).
const PROMPTS: { id: string; text: string }[] = [
  {
    id: 'explain-openai-shim',
    text: 'Explique como o openaiShim traduz tool calls do formato Anthropic para o formato OpenAI Chat Completions. Leia os arquivos relevantes em src/providers/shims/openaiShim/ e me de uma explicacao final coesa.',
  },
  {
    id: 'explain-auto-memory',
    text: 'Como funciona o sistema de auto-memory deste repositorio? Descreva o fluxo de ponta a ponta lendo o codigo relevante (src/memdir, src/services/extractMemories, src/services/SessionMemory).',
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
  toolUseTurns: number
  narrationBlocks: number
  narrationChars: number
  answerChars: number
  narrationSamples: string[]
}

function projectDirForCwd(cwd: string): string {
  return cwd.replace(/[\/]/g, '-')
}

interface SessionAnalysis {
  toolCounts: Record<string, number>
  toolUseTurns: number
  narrationBlocks: number
  narrationChars: number
  answerChars: number
  narrationSamples: string[]
}

function analyzeSession(sessionId: string, cwd: string): SessionAnalysis {
  const empty: SessionAnalysis = { toolCounts: {}, toolUseTurns: 0, narrationBlocks: 0, narrationChars: 0, answerChars: 0, narrationSamples: [] }
  const projectDir = projectDirForCwd(cwd)
  const path = join(homedir(), '.claudin', 'projects', projectDir, `${sessionId}.jsonl`)
  if (!existsSync(path)) return empty

  const counts: Record<string, number> = {}
  interface AsstMsg { texts: string[]; hasToolUse: boolean }
  const asstMsgs: AsstMsg[] = []

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    const role = obj?.message?.role ?? obj?.type
    const content = obj?.message?.content
    if (role !== 'assistant' || !Array.isArray(content)) continue

    const texts: string[] = []
    let hasToolUse = false
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block?.name === 'string') {
        hasToolUse = true
        counts[block.name] = (counts[block.name] ?? 0) + 1
      } else if (block?.type === 'text' && typeof block?.text === 'string') {
        const t = block.text.trim()
        if (t.length > 0) texts.push(t)
      }
    }
    asstMsgs.push({ texts, hasToolUse })
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
  let toolUseTurns = 0
  const narrationSamples: string[] = []
  for (let i = 0; i < asstMsgs.length; i++) {
    const m = asstMsgs[i]
    if (m.hasToolUse) toolUseTurns++
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

  return { toolCounts: counts, toolUseTurns, narrationBlocks, narrationChars, answerChars, narrationSamples }
}

function runOnce(variant: 'A' | 'B', prompt: { id: string; text: string }, runIdx: number): Promise<RunResult> {
  const variantLabel = variant === 'A' ? 'baseline' : 'feature'
  process.stdout.write(`  [${variant}/${variantLabel}] ${prompt.id} run#${runIdx + 1} ... `)
  const start = Date.now()
  // Env diff: A herda o default do cli.tsx (DISABLE_EXPERIMENTAL=true, JSON_TOOL_USE=unset).
  // B liga explicitamente o header beta + o gate de JSON tool_use.
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (variant === 'B') {
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 'false'
    env.CLAUDE_CODE_JSON_TOOL_USE = '1'
    // Destrancar betas tambem habilita global-cache-scope, que esta bugado
    // no caminho atual ("system[0] global mas tools renderizam antes" -> 400).
    // Mantemos especificamente desligado para isolar o efeito de token-efficient.
    env.CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE = '1'
  } else {
    delete env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    delete env.CLAUDE_CODE_JSON_TOOL_USE
    delete env.CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE
  }
  return new Promise((resolvePromise) => {
    const child = spawn('node', [ENTRY, '-p', prompt.text, '--model', MODEL, '--output-format', 'json'], {
      cwd: TARGET_CWD,
      env,
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
      } catch {}
      const ok = code === 0 && parsed?.type === 'result' && parsed?.subtype === 'success'
      if (!ok) process.stdout.write(`FAIL (exit=${code})\n`)
      const sessionId: string = parsed?.session_id ?? ''
      const usageRecord = parsed?.modelUsage ?? {}
      const usageEntry: any = Object.values(usageRecord)[0] ?? {}
      const a = sessionId ? analyzeSession(sessionId, TARGET_CWD) : { toolCounts: {}, toolUseTurns: 0, narrationBlocks: 0, narrationChars: 0, answerChars: 0, narrationSamples: [] }
      if (ok) {
        process.stdout.write(`OK ${(parsed.duration_ms / 1000).toFixed(1)}s out=${usageEntry?.outputTokens ?? 0} write=${usageEntry?.cacheCreationInputTokens ?? 0} narr=${a.narrationChars}\n`)
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
        toolUseTurns: a.toolUseTurns,
        narrationBlocks: a.narrationBlocks,
        narrationChars: a.narrationChars,
        answerChars: a.answerChars,
        narrationSamples: a.narrationSamples,
      })
    })
  })
}

function formatToolCounts(counts: Record<string, number>): string {
  const known = ['Read', 'Grep', 'Glob', 'Bash']
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
    avgToolUseTurns: avg((r) => r.toolUseTurns),
    avgNarrationBlocks: avg((r) => r.narrationBlocks),
    avgNarrationChars: avg((r) => r.narrationChars),
    avgAnswerChars: avg((r) => r.answerChars),
    totalToolCounts,
  }
}

async function main() {
  if (!existsSync(ENTRY)) {
    console.error(`Entry not found: ${ENTRY}`)
    console.error(`Build first: bun run build`)
    process.exit(1)
  }
  let activePrompts = PROMPT_IDS_FILTER.length > 0
    ? PROMPTS.filter((p) => PROMPT_IDS_FILTER.includes(p.id))
    : PROMPTS
  if (MAX_PROMPTS > 0) activePrompts = activePrompts.slice(0, MAX_PROMPTS)
  console.log(`Bench token-efficient tools: ${activePrompts.length} prompts x ${RUNS_PER_PROMPT} runs x 2 variants = ${activePrompts.length * RUNS_PER_PROMPT * 2} invocations`)
  console.log(`  Entry:        ${ENTRY}`)
  console.log(`  Model:        ${MODEL}`)
  console.log(`  Target cwd:   ${TARGET_CWD}`)
  console.log(`  A = baseline (no betas)`)
  console.log(`  B = CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=false CLAUDE_CODE_JSON_TOOL_USE=1`)
  console.log('')

  // Monta a lista de (prompt, variant, runIdx). Em RESUME, so' inclui o que falhou no relatorio anterior.
  type Job = { prompt: { id: string; text: string }; variant: 'A' | 'B'; runIdx: number }
  const jobs: Job[] = []
  if (RESUME_FROM) {
    const fails = parseResumeFails(RESUME_FROM)
    console.log(`Resume mode: re-rodando ${fails.length} FAILs de ${RESUME_FROM}`)
    for (const f of fails) {
      const p = PROMPTS.find((pp) => pp.id === f.promptId)
      if (!p) { console.warn(`  skip: prompt id desconhecido ${f.promptId}`); continue }
      jobs.push({ prompt: p, variant: f.variant, runIdx: f.runIdx })
    }
  } else {
    for (let runIdx = 0; runIdx < RUNS_PER_PROMPT; runIdx++) {
      for (const prompt of activePrompts) {
        // Alterna ordem A/B por iteracao pra balancear qualquer cache warming.
        if ((runIdx + activePrompts.indexOf(prompt)) % 2 === 0) {
          jobs.push({ prompt, variant: 'A', runIdx })
          jobs.push({ prompt, variant: 'B', runIdx })
        } else {
          jobs.push({ prompt, variant: 'B', runIdx })
          jobs.push({ prompt, variant: 'A', runIdx })
        }
      }
    }
  }
  if (jobs.length === 0) {
    console.error('Nenhum job para rodar.')
    process.exit(1)
  }
  console.log(`Concorrencia: ${PARALLEL} (${jobs.length} invocacoes)`)
  const results = await runWithConcurrency(
    jobs.map((j) => () => runOnce(j.variant, j.prompt, j.runIdx)),
    PARALLEL,
  )

  const summaryA = summarize(results, 'A')
  const summaryB = summarize(results, 'B')

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(REPO_ROOT, 'scripts', 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const safeModel = MODEL.replace(/[^a-z0-9-]/gi, '_')
  const outPath = join(outDir, `token-efficient-tools-ab-${safeModel}-${ts}.md`)

  let md = `# Bench A/B - token-efficient tools (FC v3 JSON tool_use)\n\n`
  md += `- Timestamp: ${new Date().toISOString()}\n`
  md += `- Model: \`${MODEL}\`\n`
  md += `- Entry: \`${ENTRY}\`\n`
  md += `- Runs por prompt: ${RUNS_PER_PROMPT}\n`
  md += `- A = baseline; B = DISABLE_EXPERIMENTAL_BETAS=false + JSON_TOOL_USE=1\n\n`

  md += `## Tabela por invocacao\n\n`
  md += `| Prompt | V | Run | OK | out tok | write tok | in tok | cache read | narr chars | answer chars | turns | tool turns | cost $ | tools |\n`
  md += `|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n`
  for (const r of results) {
    md += `| ${r.promptId} | ${r.variant} | ${r.runIdx + 1} | ${r.ok ? 'Y' : 'N'} `
    md += `| ${r.outputTokens} | ${r.cacheCreationTokens} | ${r.inputTokens} | ${r.cacheReadTokens} `
    md += `| ${r.narrationChars} | ${r.answerChars} | ${r.numTurns} | ${r.toolUseTurns} | ${r.totalCostUsd.toFixed(4)} `
    md += `| ${formatToolCounts(r.toolCounts)} |\n`
  }

  md += `\n## Sumario\n\n`
  for (const [name, s] of [['A (baseline)', summaryA], ['B (feature)', summaryB]] as const) {
    if (!s) { md += `### ${name}\n\nSem runs validas.\n\n`; continue }
    md += `### ${name} (n=${s.n})\n\n`
    md += `- Avg output tokens: ${s.avgOutputTokens.toFixed(0)}\n`
    md += `- Avg cache-creation (write) tokens: ${s.avgCacheCreationTokens.toFixed(0)}\n`
    md += `- Avg input tokens: ${s.avgInputTokens.toFixed(0)}\n`
    md += `- Avg cache-read tokens: ${s.avgCacheReadTokens.toFixed(0)}\n`
    md += `- Avg narration chars: ${s.avgNarrationChars.toFixed(0)}\n`
    md += `- Avg narration blocks: ${s.avgNarrationBlocks.toFixed(2)}\n`
    md += `- Avg answer chars: ${s.avgAnswerChars.toFixed(0)}\n`
    md += `- Avg cost: $${s.avgCost.toFixed(4)} (total $${s.totalCost.toFixed(4)})\n`
    md += `- Avg total turns: ${s.avgTurns.toFixed(1)} (tool_use turns: ${s.avgToolUseTurns.toFixed(1)})\n`
    md += `- Tool totals: ${formatToolCounts(s.totalToolCounts)}\n\n`
  }

  if (summaryA && summaryB) {
    const rel = (a: number, b: number) => (a === 0 ? 0 : ((b - a) / a) * 100)
    const outDelta = rel(summaryA.avgOutputTokens, summaryB.avgOutputTokens)
    const writeDelta = rel(summaryA.avgCacheCreationTokens, summaryB.avgCacheCreationTokens)
    const narrDelta = rel(summaryA.avgNarrationChars, summaryB.avgNarrationChars)
    const answerDelta = rel(summaryA.avgAnswerChars, summaryB.avgAnswerChars)
    const costDelta = rel(summaryA.avgCost, summaryB.avgCost)
    const turnsDelta = rel(summaryA.avgTurns, summaryB.avgTurns)
    const toolTurnsDelta = rel(summaryA.avgToolUseTurns, summaryB.avgToolUseTurns)
    md += `### Delta\n\n`
    md += `- **Output tokens: ${summaryA.avgOutputTokens.toFixed(0)} -> ${summaryB.avgOutputTokens.toFixed(0)} (rel ${outDelta.toFixed(1)}%)** [PRIMARIO]\n`
    md += `- **Write (cache_creation): ${summaryA.avgCacheCreationTokens.toFixed(0)} -> ${summaryB.avgCacheCreationTokens.toFixed(0)} (rel ${writeDelta.toFixed(1)}%)** [PRIMARIO]\n`
    md += `- Narration chars: ${summaryA.avgNarrationChars.toFixed(0)} -> ${summaryB.avgNarrationChars.toFixed(0)} (rel ${narrDelta.toFixed(1)}%)\n`
    md += `- Answer chars: ${summaryA.avgAnswerChars.toFixed(0)} -> ${summaryB.avgAnswerChars.toFixed(0)} (rel ${answerDelta.toFixed(1)}%)\n`
    md += `- Cost: ${costDelta.toFixed(1)}%\n`
    md += `- Total turns: ${summaryA.avgTurns.toFixed(1)} -> ${summaryB.avgTurns.toFixed(1)} (rel ${turnsDelta.toFixed(1)}%)\n`
    md += `- Tool_use turns: ${summaryA.avgToolUseTurns.toFixed(1)} -> ${summaryB.avgToolUseTurns.toFixed(1)} (rel ${toolTurnsDelta.toFixed(1)}%)\n\n`

    md += `### Kill criteria\n\n`
    md += `- SHIP se B reduz output tokens em >=3% rel E answer chars nao cai >15% E cost nao piora.\n`
    md += `- INERT se output delta fica em [-2%, +2%] (provavelmente provider nao 1P, header sendo dropado).\n`
    md += `- INVESTIGAR se narration baixa muito (>=20%) sem que output baixe — efeito colateral inesperado.\n\n`
    const outOk = outDelta <= -3
    const answerOk = answerDelta >= -15
    const costOk = costDelta <= 2
    const verdict = outOk && answerOk && costOk ? 'SHIP candidate' : (Math.abs(outDelta) < 2 ? 'INERT (provavelmente provider nao-1P)' : 'INVESTIGAR')
    md += `- Veredito: **${verdict}**\n`
    md += `  - output delta: ${outDelta.toFixed(1)}% (${outOk ? 'OK' : 'fail'})\n`
    md += `  - answer delta: ${answerDelta.toFixed(1)}% (${answerOk ? 'OK' : 'fail'})\n`
    md += `  - cost delta: ${costDelta.toFixed(1)}% (${costOk ? 'OK' : 'fail'})\n\n`
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
