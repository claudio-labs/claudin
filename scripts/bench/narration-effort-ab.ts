#!/usr/bin/env bun
/**
 * Bench A/B: mede se subir o `effort` (adaptive -> xhigh) reduz a "narracao
 * inter-tool-call" — o padrao le-arquivo -> comenta -> le-arquivo -> comenta,
 * que polui o canal de texto visivel (e o cache_write/contexto) no Opus 4.8.
 *
 * Hipotese: effort=xhigh empurra mais raciocinio para o canal `thinking`
 * (escondido), reduzindo o que vaza no canal `text` visivel. NAO-testada.
 * Cuidado: xhigh custa mais output/thinking tokens — pode reduzir narracao
 * mas subir custo. Ler narracao + output_tokens + custo JUNTOS.
 *
 * Diferenca para narration-prompt-ab.ts (steering): aqui ambas as variantes
 * usam o MESMO bundle (dist/cli.mjs). A unica diferenca e' a env var
 * CLAUDIN_EFFORT_LEVEL no spawn:
 *   Variante A = adaptive  (servidor escala per-request; nenhum campo effort)
 *   Variante B = xhigh     (effort=xhigh fixo; Opus 4.8 suporta)
 *
 * Precedencia confirmada em src/providers/effort/effort.ts:234,243 — a env var domina
 * (env -> appState -> model default). adaptive -> resolveAppliedEffort retorna
 * undefined -> request sem campo effort (effort.ts:250).
 *
 * KPI primario: chars de narracao por sessao (blocos `text` emitidos em
 * mensagens assistant NAO-finais, ou junto de tool_use na mesma mensagem).
 * O texto da ultima mensagem assistant sem tool_use = a resposta (nao conta).
 * KPI secundario: output_tokens, cost, n de blocos de narracao, answer chars.
 *
 * Uso:
 *   CLAUDIN_BENCH_FEATURE=dist/cli.mjs \
 *   ANTHROPIC_MODEL=claude-opus-4-8 \
 *   bun run scripts/bench/narration-effort-ab.ts
 *
 * Variaveis de ambiente:
 *   ANTHROPIC_MODEL=claude-opus-4-8    (default — narracao e' Opus-4.8-specific)
 *   CLAUDIN_BENCH_RUNS=3               (runs por prompt por variante; min 3 por regra de bench)
 *   CLAUDIN_BENCH_FEATURE=dist/cli.mjs (mesmo bundle nas duas variantes)
 *   CLAUDIN_BENCH_TARGET_CWD=<repo>    (cwd das invocacoes; default = repo root)
 *   CLAUDIN_BENCH_PROMPTS=0            (limita N prompts; 0 = todos)
 *   CLAUDIN_BENCH_EFFORT_A=adaptive    (effort da variante A)
 *   CLAUDIN_BENCH_EFFORT_B=xhigh       (effort da variante B)
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const FEATURE = process.env.CLAUDIN_BENCH_FEATURE ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const RUNS_PER_PROMPT = Number(process.env.CLAUDIN_BENCH_RUNS ?? '3')
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const TARGET_CWD = process.env.CLAUDIN_BENCH_TARGET_CWD ?? REPO_ROOT
const MAX_PROMPTS = Number(process.env.CLAUDIN_BENCH_PROMPTS ?? '0')
const EFFORT_A = process.env.CLAUDIN_BENCH_EFFORT_A ?? 'adaptive'
const EFFORT_B = process.env.CLAUDIN_BENCH_EFFORT_B ?? 'xhigh'

// Tarefas de EXPLORACAO read-only (forcam varios reads/greps sem mutar o repo).
// Pedem explicacao/descricao para provocar o padrao le->narra->le->narra.
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
  effort: string
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
}

/**
 * Le o transcript .jsonl e separa texto-narracao de texto-resposta.
 *
 * Regra: percorre as mensagens assistant em ordem. Um bloco `text` conta como
 * narracao se (a) a mensagem assistant tambem tem tool_use (falou e chamou tool
 * no mesmo turno), ou (b) a mensagem nao e' a ultima mensagem assistant do
 * transcript (comentou no meio do trabalho). O texto da ultima mensagem
 * assistant que NAO tem tool_use e' a resposta final (nao conta como narracao).
 */
function analyzeSession(sessionId: string, cwd: string): SessionAnalysis {
  const empty: SessionAnalysis = { toolCounts: {}, narrationBlocks: 0, narrationChars: 0, answerChars: 0, narrationSamples: [] }
  const projectDir = projectDirForCwd(cwd)
  const path = join(homedir(), '.claudin', 'projects', projectDir, `${sessionId}.jsonl`)
  if (!existsSync(path)) return empty

  const counts: Record<string, number> = {}
  interface AsstMsg { texts: string[]; hasToolUse: boolean }
  const asstMsgs: AsstMsg[] = []

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
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block?.name === 'string') {
        hasToolUse = true
        counts[block.name] = (counts[block.name] ?? 0) + 1
      } else if (block?.type === 'text' && typeof block?.text === 'string') {
        const t = block.text.trim()
        if (t.length > 0) texts.push(t)
      }
      // blocos `thinking`/`redacted_thinking` sao ignorados (canal correto, escondido)
    }
    asstMsgs.push({ texts, hasToolUse })
  }

  // indice da ultima mensagem assistant que tem texto e nao tem tool_use = resposta
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
  for (let i = 0; i < asstMsgs.length; i++) {
    const m = asstMsgs[i]
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

  return { toolCounts: counts, narrationBlocks, narrationChars, answerChars, narrationSamples }
}

function runOnce(variant: 'A' | 'B', effort: string, prompt: { id: string; text: string }, runIdx: number): Promise<RunResult> {
  process.stdout.write(`  [${variant}/effort=${effort}] ${prompt.id} run#${runIdx + 1} ... `)
  const start = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn('node', [FEATURE, '-p', prompt.text, '--model', MODEL, '--output-format', 'json'], {
      cwd: TARGET_CWD,
      env: { ...process.env, CLAUDIN_EFFORT_LEVEL: effort },
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
      const a = sessionId ? analyzeSession(sessionId, TARGET_CWD) : { toolCounts: {}, narrationBlocks: 0, narrationChars: 0, answerChars: 0, narrationSamples: [] }
      if (ok) {
        process.stdout.write(`OK ${(parsed.duration_ms / 1000).toFixed(1)}s narrBlocks=${a.narrationBlocks} narrChars=${a.narrationChars} out=${usageEntry?.outputTokens ?? 0}\n`)
      }
      resolvePromise({
        promptId: prompt.id,
        variant,
        effort,
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
    avgNarrationBlocks: avg((r) => r.narrationBlocks),
    avgNarrationChars: avg((r) => r.narrationChars),
    avgAnswerChars: avg((r) => r.answerChars),
    totalToolCounts,
  }
}

async function main() {
  if (!existsSync(FEATURE)) {
    console.error(`Feature entry not found: ${FEATURE}`)
    console.error(`Build first: bun run build`)
    process.exit(1)
  }

  const activePrompts = MAX_PROMPTS > 0 ? PROMPTS.slice(0, MAX_PROMPTS) : PROMPTS
  console.log(`Bench narracao x effort: ${activePrompts.length} prompts x ${RUNS_PER_PROMPT} runs x 2 variants = ${activePrompts.length * RUNS_PER_PROMPT * 2} invocations`)
  console.log(`  Bundle (A e B): ${FEATURE}`)
  console.log(`  Variante A:     effort=${EFFORT_A}`)
  console.log(`  Variante B:     effort=${EFFORT_B}`)
  console.log(`  Model:          ${MODEL}`)
  console.log(`  Target cwd:     ${TARGET_CWD}`)
  console.log('')

  const results: RunResult[] = []
  for (let runIdx = 0; runIdx < RUNS_PER_PROMPT; runIdx++) {
    for (const prompt of activePrompts) {
      results.push(await runOnce('A', EFFORT_A, prompt, runIdx))
      results.push(await runOnce('B', EFFORT_B, prompt, runIdx))
    }
  }

  const summaryA = summarize(results, 'A')
  const summaryB = summarize(results, 'B')

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(REPO_ROOT, 'scripts', 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const safeModel = MODEL.replace(/[^a-z0-9-]/gi, '_')
  const outPath = join(outDir, `narration-effort-ab-${safeModel}-${ts}.md`)

  let md = `# Bench A/B — effort (${EFFORT_A} vs ${EFFORT_B}) x narracao\n\n`
  md += `- Timestamp: ${new Date().toISOString()}\n`
  md += `- Model: \`${MODEL}\`\n`
  md += `- Bundle (A e B): \`${FEATURE}\`\n`
  md += `- Variante A: effort=\`${EFFORT_A}\`\n`
  md += `- Variante B: effort=\`${EFFORT_B}\`\n`
  md += `- Runs por prompt: ${RUNS_PER_PROMPT}\n`
  md += `- KPI: chars de narracao inter-tool-call (texto assistant fora da resposta final)\n\n`

  md += `## Tabela por invocacao\n\n`
  md += `| Prompt | V | eff | Run | OK | narr blocks | narr chars | answer chars | out tok | cost $ | wall(s) | turns | tools |\n`
  md += `|---|---|---|---:|:-:|---:|---:|---:|---:|---:|---:|---:|---|\n`
  for (const r of results) {
    md += `| ${r.promptId} | ${r.variant} | ${r.effort} | ${r.runIdx + 1} | ${r.ok ? 'Y' : 'N'} `
    md += `| ${r.narrationBlocks} | ${r.narrationChars} | ${r.answerChars} `
    md += `| ${r.outputTokens} | ${r.totalCostUsd.toFixed(4)} | ${(r.durationMs / 1000).toFixed(1)} | ${r.numTurns} `
    md += `| ${formatToolCounts(r.toolCounts)} |\n`
  }

  md += `\n## Sumario\n\n`
  for (const [name, s] of [[`A (effort=${EFFORT_A})`, summaryA], [`B (effort=${EFFORT_B})`, summaryB]] as const) {
    if (!s) { md += `### ${name}\n\nSem runs validas.\n\n`; continue }
    md += `### ${name} (n=${s.n})\n\n`
    md += `- Avg narration blocks: ${s.avgNarrationBlocks.toFixed(2)}\n`
    md += `- Avg narration chars: ${s.avgNarrationChars.toFixed(0)}\n`
    md += `- Avg answer chars: ${s.avgAnswerChars.toFixed(0)}\n`
    md += `- Avg output tokens: ${s.avgOutputTokens.toFixed(0)}\n`
    md += `- Avg cost: $${s.avgCost.toFixed(4)} (total $${s.totalCost.toFixed(4)})\n`
    md += `- Avg cache-creation tokens: ${s.avgCacheCreationTokens.toFixed(0)}\n`
    md += `- Avg turns: ${s.avgTurns.toFixed(1)}\n`
    md += `- Tool totals: ${formatToolCounts(s.totalToolCounts)}\n\n`
  }

  if (summaryA && summaryB) {
    const rel = (a: number, b: number) => (a === 0 ? 0 : ((b - a) / a) * 100)
    const narrCharDelta = rel(summaryA.avgNarrationChars, summaryB.avgNarrationChars)
    const narrBlockDelta = rel(summaryA.avgNarrationBlocks, summaryB.avgNarrationBlocks)
    const outDelta = rel(summaryA.avgOutputTokens, summaryB.avgOutputTokens)
    const costDelta = rel(summaryA.avgCost, summaryB.avgCost)
    const answerDelta = rel(summaryA.avgAnswerChars, summaryB.avgAnswerChars)
    md += `### Delta (A=${EFFORT_A} -> B=${EFFORT_B})\n\n`
    md += `- Narration chars: ${summaryA.avgNarrationChars.toFixed(0)} -> ${summaryB.avgNarrationChars.toFixed(0)} (rel ${narrCharDelta.toFixed(1)}%)\n`
    md += `- Narration blocks: ${summaryA.avgNarrationBlocks.toFixed(2)} -> ${summaryB.avgNarrationBlocks.toFixed(2)} (rel ${narrBlockDelta.toFixed(1)}%)\n`
    md += `- Output tokens: ${summaryA.avgOutputTokens.toFixed(0)} -> ${summaryB.avgOutputTokens.toFixed(0)} (rel ${outDelta.toFixed(1)}%)\n`
    md += `- Answer chars: ${summaryA.avgAnswerChars.toFixed(0)} -> ${summaryB.avgAnswerChars.toFixed(0)} (rel ${answerDelta.toFixed(1)}%)\n`
    md += `- Avg cost delta: ${costDelta.toFixed(1)}%\n\n`

    md += `### Kill criteria (meta usuario: -70 a -80% de narracao)\n\n`
    md += `- SHIP (recomendar ${EFFORT_B} default p/ loops 4.8) se B reduz narration chars em >=70% rel E answer chars nao cai >15% E custo nao estoura (>+30%).\n`
    md += `- PARCIAL/INVESTIGAR se narration cai mas <70%, OU cai >=70% porem custo sobe demais (>+30%) — comparar com Frente 1 (stripper determinístico).\n`
    md += `- KILL (effort inerte p/ narracao) se reducao <25% — seguir com Frente 1.\n`
    md += `- DEGRADOU se answer chars despenca >15% (modelo ficou mudo demais).\n\n`
    const narrHit70 = narrCharDelta <= -70
    const narrHit25 = narrCharDelta <= -25
    const answerOk = answerDelta >= -15
    const costOk = costDelta <= 30
    let verdict: string
    if (!answerOk) verdict = 'DEGRADOU (resposta encolheu)'
    else if (narrHit70 && costOk) verdict = `SHIP candidate (recomendar ${EFFORT_B})`
    else if (narrHit70 && !costOk) verdict = 'PARCIAL (atingiu narracao mas custo estourou) -> comparar Frente 1'
    else if (narrHit25) verdict = 'PARCIAL (<70%) -> seguir Frente 1'
    else verdict = 'INERTE p/ narracao -> seguir Frente 1'
    md += `- Veredito: **${verdict}**\n`
    md += `  - narration chars delta: ${narrCharDelta.toFixed(1)}% (meta <=-70: ${narrHit70 ? 'OK' : 'nao'})\n`
    md += `  - answer chars delta: ${answerDelta.toFixed(1)}% (${answerOk ? 'OK' : 'fail'})\n`
    md += `  - cost delta: ${costDelta.toFixed(1)}% (${costOk ? 'OK' : 'caro'})\n\n`
    md += `> Ler runs BRUTAS, nao so medias. Narracao no mesmo baseline varia ~551-1037 chars\n`
    md += `> entre runs identicas (ruido). Exigir efeito bem acima desse ruido.\n\n`
  }

  md += `## Amostras de narracao (texto fora da resposta final)\n\n`
  for (const prompt of activePrompts) {
    md += `### ${prompt.id}\n\n`
    for (const variant of ['A', 'B'] as const) {
      const rs = results.filter((r) => r.promptId === prompt.id && r.variant === variant && r.ok)
      for (const r of rs) {
        if (r.narrationSamples.length === 0) continue
        md += `**Variant ${variant} (effort=${r.effort}) run#${r.runIdx + 1}** (${r.narrationBlocks} blocks):\n\n`
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
