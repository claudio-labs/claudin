#!/usr/bin/env bun
/**
 * Bench A/B: mede se promover o gatilho de plan mode na instrucao de auto-mode
 * (src/services/messages/autoMode.ts) aumenta a taxa com que o modelo chama a tool
 * EnterPlanMode quando o usuario pede explicitamente um plano.
 *
 * Variante A = baseline (instrucao atual, item "Prefer action over planning"
 * com o gatilho de plan enterrado como sub-clausula).
 * Variante B = instrucao reordenada (gatilho de plan promovido a item proprio
 * no topo).
 *
 * KPI primario (binario): o run chamou a tool EnterPlanMode?
 *   - prompts plan-*  -> queremos % ALTA (aderencia ao pedido de plano).
 *   - prompt control-* -> queremos % BAIXA (nao regredir o "execute immediately").
 * KPI secundario: tokens / cost / wall (sanity).
 *
 * Uso:
 *   CLAUDIN_BENCH_BASELINE=dist-baseline/cli.mjs \
 *   bun run scripts/bench/auto-mode-plan-adherence-ab.ts
 *
 * Variaveis de ambiente:
 *   ANTHROPIC_MODEL=claude-opus-4-8     (default)
 *   CLAUDIN_BENCH_RUNS=3                (runs por prompt por variante)
 *   CLAUDIN_BENCH_BASELINE=dist-baseline/cli.mjs
 *   CLAUDIN_BENCH_FEATURE=dist/cli.mjs
 *   CLAUDIN_BENCH_TARGET_CWD=<repo>
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const BASELINE = process.env.CLAUDIN_BENCH_BASELINE ?? join(REPO_ROOT, 'dist-baseline', 'cli.mjs')
const FEATURE = process.env.CLAUDIN_BENCH_FEATURE ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const RUNS_PER_PROMPT = Number(process.env.CLAUDIN_BENCH_RUNS ?? '3')
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'
const TARGET_CWD = process.env.CLAUDIN_BENCH_TARGET_CWD ?? REPO_ROOT

type PromptKind = 'plan' | 'control'

// Foco: pedidos IMPLICITOS de plano (o caso real do usuario). O baseline ja lista
// frases literais ("vamos planejar"), entao o gap esta nos pedidos por intencao:
// perguntar como faria, pedir a abordagem antes, convidar a deliberar.
const PROMPTS: { id: string; kind: PromptKind; text: string }[] = [
  {
    id: 'implicit-howwould',
    kind: 'plan',
    text: 'como voce faria pra adicionar um novo slash command /foo neste repo?',
  },
  {
    id: 'implicit-approach-first',
    kind: 'plan',
    text: 'me explica a abordagem antes de mexer no tratamento de erro do BashTool',
  },
  {
    id: 'implicit-think',
    kind: 'plan',
    text: 'vamos pensar em como adicionar suporte a um novo provider OpenAI-compativel',
  },
  {
    id: 'explicit-sanity',
    kind: 'plan',
    text: 'vamos planejar como adicionar um novo slash command /bar neste repo',
  },
  {
    id: 'control-direct-action',
    kind: 'control',
    text: 'adicione um console.log em src/utils/log.ts pra debugar',
  },
  {
    // Guarda anti-trigger-happy: pergunta factual sobre como o codigo JA funciona.
    // Deve ficar em prosa (Q&A), NAO entrar em plan mode. Se B disparar plan aqui,
    // a regra de desambiguacao ficou ampla demais.
    id: 'control-howworks',
    kind: 'control',
    text: 'como funciona o tratamento de erro do BashTool hoje?',
  },
]

interface RunResult {
  promptId: string
  promptKind: PromptKind
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
  enteredPlanMode: boolean
  resultText: string
}

function projectDirForCwd(cwd: string): string {
  return cwd.replace(/[\/]/g, '-')
}

interface SessionAnalysis {
  toolCounts: Record<string, number>
  enteredPlanMode: boolean
}

function analyzeSession(sessionId: string, cwd: string): SessionAnalysis {
  const projectDir = projectDirForCwd(cwd)
  const path = join(homedir(), '.claudin', 'projects', projectDir, `${sessionId}.jsonl`)
  if (!existsSync(path)) return { toolCounts: {}, enteredPlanMode: false }
  const counts: Record<string, number> = {}
  let enteredPlanMode = false
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const content = obj?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block?.name === 'string') {
          counts[block.name] = (counts[block.name] ?? 0) + 1
          if (block.name === 'EnterPlanMode') enteredPlanMode = true
        }
      }
    } catch {
      // ignore non-json
    }
  }
  return { toolCounts: counts, enteredPlanMode }
}

function runOnce(
  variant: 'A' | 'B',
  entryPath: string,
  prompt: { id: string; kind: PromptKind; text: string },
  runIdx: number,
): Promise<RunResult> {
  const variantLabel = variant === 'A' ? 'baseline' : 'feature'
  process.stdout.write(`  [${variant}/${variantLabel}] ${prompt.id} run#${runIdx + 1} ... `)
  const start = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(
      'node',
      // --max-turns 2: a decisao de planejar acontece no 1o turno (modelo chama
      // EnterPlanMode antes de executar). Corta wall-time de ~120s p/ ~20s e evita
      // que tarefas longas (ou AskUserQuestion travando headless) inflem o tempo.
      [entryPath, '-p', prompt.text, '--permission-mode', 'auto', '--model', MODEL, '--output-format', 'json', '--max-turns', '2'],
      {
        cwd: TARGET_CWD,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
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
      const analysis = sessionId ? analyzeSession(sessionId, TARGET_CWD) : { toolCounts: {}, enteredPlanMode: false }
      if (ok) {
        process.stdout.write(`OK ${(parsed.duration_ms / 1000).toFixed(1)}s plan=${analysis.enteredPlanMode ? 'YES' : 'no'}\n`)
      }
      resolvePromise({
        promptId: prompt.id,
        promptKind: prompt.kind,
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
        toolCounts: analysis.toolCounts,
        enteredPlanMode: analysis.enteredPlanMode,
        resultText: typeof parsed?.result === 'string' ? parsed.result : '',
      })
    })
  })
}

function formatToolCounts(counts: Record<string, number>): string {
  const known = ['EnterPlanMode', 'Bash', 'Read', 'Grep', 'Glob']
  const parts: string[] = []
  for (const k of known) parts.push(`${k}=${counts[k] ?? 0}`)
  const other = Object.entries(counts)
    .filter(([k]) => !known.includes(k))
    .reduce((acc, [, v]) => acc + v, 0)
  if (other > 0) parts.push(`other=${other}`)
  return parts.join(' ')
}

/**
 * Taxa de plan mode para um subconjunto. Mede por presenca de sessionId (run
 * analisavel), NAO por exit success: com --max-turns 2, runs que executam (controle)
 * podem terminar como max_turns/error e ainda assim ter sessao gravada com a decisao
 * de plan mode registrada no jsonl. Contar so `ok` descartaria esses dados.
 */
function planRate(results: RunResult[]): { n: number; planned: number; pct: number } {
  const analyzable = results.filter((r) => r.sessionId !== '')
  const planned = analyzable.filter((r) => r.enteredPlanMode).length
  return { n: analyzable.length, planned, pct: analyzable.length === 0 ? 0 : (planned / analyzable.length) * 100 }
}

function avgCost(results: RunResult[]): number {
  // Mede por sessao analisavel, nao por exit success: com --max-turns 2 nenhum run
  // termina como success, mas o custo real esta em parsed.total_cost_usd de qualquer modo.
  const analyzable = results.filter((r) => r.sessionId !== '')
  if (analyzable.length === 0) return 0
  return analyzable.reduce((a, r) => a + r.totalCostUsd, 0) / analyzable.length
}

async function main() {
  if (!existsSync(BASELINE)) {
    console.error(`Baseline entry not found: ${BASELINE}`)
    console.error(`Snapshot the baseline build first: cp -r dist dist-baseline`)
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

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(REPO_ROOT, 'scripts', 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const safeModel = MODEL.replace(/[^a-z0-9-]/gi, '_')
  const outPath = join(outDir, `auto-mode-plan-adherence-ab-${safeModel}-${ts}.md`)

  let md = `# Bench A/B — auto-mode plan adherence\n\n`
  md += `- Timestamp: ${new Date().toISOString()}\n`
  md += `- Model: \`${MODEL}\`\n`
  md += `- Baseline: \`${BASELINE}\`\n`
  md += `- Feature:  \`${FEATURE}\`\n`
  md += `- Runs por prompt: ${RUNS_PER_PROMPT}\n\n`

  md += `## Tabela por invocacao\n\n`
  md += `| Prompt | Kind | V | Run | OK | PlanMode | Tokens in/out/cache_read | Cost $ | Wall (s) | Turns | Tool calls | Session |\n`
  md += `|---|---|---|---:|:-:|:-:|---|---:|---:|---:|---|---|\n`
  for (const r of results) {
    md += `| ${r.promptId} | ${r.promptKind} | ${r.variant} | ${r.runIdx + 1} | ${r.ok ? 'Y' : 'N'} `
    md += `| ${r.enteredPlanMode ? 'YES' : 'no'} `
    md += `| ${r.inputTokens}/${r.outputTokens}/${r.cacheReadTokens} `
    md += `| ${r.totalCostUsd.toFixed(4)} `
    md += `| ${(r.durationMs / 1000).toFixed(1)} `
    md += `| ${r.numTurns} `
    md += `| ${formatToolCounts(r.toolCounts)} `
    md += `| ${r.sessionId.slice(0, 8)} |\n`
  }

  // KPI por categoria e variante
  md += `\n## KPI — taxa de plan mode\n\n`
  md += `| Subconjunto | A (baseline) | B (feature) | Delta (pp) |\n`
  md += `|---|---|---|---:|\n`
  const planA = planRate(results.filter((r) => r.promptKind === 'plan' && r.variant === 'A'))
  const planB = planRate(results.filter((r) => r.promptKind === 'plan' && r.variant === 'B'))
  const ctrlA = planRate(results.filter((r) => r.promptKind === 'control' && r.variant === 'A'))
  const ctrlB = planRate(results.filter((r) => r.promptKind === 'control' && r.variant === 'B'))
  md += `| plan-* | ${planA.planned}/${planA.n} (${planA.pct.toFixed(0)}%) | ${planB.planned}/${planB.n} (${planB.pct.toFixed(0)}%) | ${(planB.pct - planA.pct).toFixed(0)} |\n`
  md += `| control-* | ${ctrlA.planned}/${ctrlA.n} (${ctrlA.pct.toFixed(0)}%) | ${ctrlB.planned}/${ctrlB.n} (${ctrlB.pct.toFixed(0)}%) | ${(ctrlB.pct - ctrlA.pct).toFixed(0)} |\n\n`

  // por prompt individual
  md += `### Por prompt (plan rate A -> B)\n\n`
  for (const prompt of PROMPTS) {
    const a = planRate(results.filter((r) => r.promptId === prompt.id && r.variant === 'A'))
    const b = planRate(results.filter((r) => r.promptId === prompt.id && r.variant === 'B'))
    md += `- **${prompt.id}** (${prompt.kind}): ${a.planned}/${a.n} (${a.pct.toFixed(0)}%) -> ${b.planned}/${b.n} (${b.pct.toFixed(0)}%)\n`
  }
  md += `\n`

  // custo sanity
  const costA = avgCost(results.filter((r) => r.variant === 'A'))
  const costB = avgCost(results.filter((r) => r.variant === 'B'))
  const costDelta = costA === 0 ? 0 : ((costB - costA) / costA) * 100
  md += `## Custo (sanity)\n\n`
  md += `- Avg cost A: $${costA.toFixed(4)} | Avg cost B: $${costB.toFixed(4)} | delta ${costDelta.toFixed(1)}%\n\n`

  // veredito
  md += `## Kill criteria\n\n`
  md += `- SHIP se B plan-rate >=80% nos plan-* E (B-A) >= +25pp E control nao regride (B nao dispara plan no controle).\n`
  md += `- KILL se B plan-rate <60% nos plan-* OU ganho <+15pp vs A (nudge inerte).\n\n`
  const shipPlan = planB.pct >= 80 && (planB.pct - planA.pct) >= 25
  const controlOk = ctrlB.pct <= ctrlA.pct + 1e-9 || ctrlB.pct <= 20
  const killInert = planB.pct < 60 || (planB.pct - planA.pct) < 15
  const verdict = shipPlan && controlOk ? 'SHIP candidate' : (killInert ? 'INERT/REVERT' : 'INVESTIGAR')
  md += `- Veredito: **${verdict}**\n`
  md += `  - plan-rate B: ${planB.pct.toFixed(0)}% (ship>=80, kill<60)\n`
  md += `  - delta B-A: ${(planB.pct - planA.pct).toFixed(0)}pp (ship>=25, kill<15)\n`
  md += `  - control B: ${ctrlB.pct.toFixed(0)}% (nao deve subir vs A=${ctrlA.pct.toFixed(0)}%)\n\n`

  // outputs lado a lado
  md += `## Outputs (resultText) lado a lado\n\n`
  for (const prompt of PROMPTS) {
    md += `### ${prompt.id} (${prompt.kind})\n\n> ${prompt.text}\n\n`
    for (const variant of ['A', 'B'] as const) {
      const rs = results.filter((r) => r.promptId === prompt.id && r.variant === variant && r.ok)
      for (const r of rs) {
        md += `**Variant ${variant} run#${r.runIdx + 1}** (plan=${r.enteredPlanMode ? 'YES' : 'no'}):\n\n\`\`\`\n${r.resultText.slice(0, 800)}${r.resultText.length > 800 ? '\n…[truncado]' : ''}\n\`\`\`\n\n`
      }
    }
  }

  writeFileSync(outPath, md)

  console.log('')
  console.log(`KPI plan-*:   A ${planA.pct.toFixed(0)}%  ->  B ${planB.pct.toFixed(0)}%  (delta ${(planB.pct - planA.pct).toFixed(0)}pp)`)
  console.log(`KPI control-*: A ${ctrlA.pct.toFixed(0)}%  ->  B ${ctrlB.pct.toFixed(0)}%`)
  console.log(`Veredito: ${verdict}`)
  console.log('')
  console.log(`Report: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
