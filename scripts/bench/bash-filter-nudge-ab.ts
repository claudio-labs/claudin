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
const PER_INVOCATION_TIMEOUT_MS = Number(process.env.CLAUDIO_BENCH_TIMEOUT_MS ?? '120000')

// v3 HYBRID — junta TENTACAO (output longo/ruidoso, onde nasce o impulso de pipar pra
// tail) com FRAMING JUSTO (o usuario pede VEREDITO/RESUMO; truncar seria decisao espuria
// do modelo, nao pedido). Roda num worktree isolado (CLAUDIO_BENCH_TARGET_CWD) com timeout
// por invocacao, entao build/test podem rodar de verdade sem mutar o repo vivo nem travar.
// Dois prompts multi-step de proposito: a 1a chamada Bash mostra o marker lines="x/y",
// dando a evidencia (a) chance de influenciar a 2a chamada na mesma sessao.
const PROMPTS: { id: string; text: string }[] = [
  {
    id: 'build-verdict',
    text: 'Rode `bun run build` e me diga so se a compilacao terminou limpa, sem erro. Sim ou nao, e se falhou qual foi o erro. Nao preciso do log inteiro.',
  },
  {
    id: 'test-bash-suite',
    text: 'Rode `bun test src/outputFilter/Bash/` e me diga o veredito: a suite esta saudavel? Quantos testes passaram e algum falhou?',
  },
  {
    id: 'bigfile-summary',
    text: 'Rode `cat src/services/api/openaiShim.ts` e me explique em 2 frases o que esse arquivo faz. Quero so a essencia, nao o arquivo colado de volta.',
  },
  {
    id: 'log-themes',
    text: 'Rode `git log --stat -50` e me resuma em 3 bullets os temas das mudancas recentes. Nao liste commit por commit.',
  },
  {
    id: 'src-tree-overview',
    text: 'Rode `ls -R src` e me diga em uma frase como o diretorio src esta organizado. Quero o panorama, nao a arvore inteira.',
  },
  {
    id: 'build-then-test',
    text: 'Rode `bun run build` e depois `bun test src/outputFilter/Bash/markers.test.ts`. Me diga se os dois passaram sem erro — um sim/nao para cada, e o erro se algo falhou.',
  },
  {
    id: 'diff-biggest-file',
    text: 'Rode `git diff HEAD~15 HEAD` e me diga qual arquivo teve mais mudancas nesse intervalo. So o nome do arquivo e por que, nao precisa do diff todo.',
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
  bashTruncator: number
  resultText: string
}

function projectDirForCwd(cwd: string): string {
  // Must match claudio's real transcript-dir encoding (src/services/vcr.ts): EVERY
  // non-alphanumeric char becomes '-', not just '/'. The old `/`-only rule silently
  // produced a wrong path whenever cwd had '_' or '.' (e.g. /tmp/bench_wt -> -tmp-bench_wt,
  // but the real dir is -tmp-bench-wt), making analyzeSession return Bash=0 for every session.
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
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

/**
 * KPI focado deste bench: o nudge ataca especificamente pipe para head/tail/cat
 * usado para encurtar output (o bypass real do output filter). `cat <<EOF`,
 * `cat > file`, redirecionamentos e `cat arquivo` sozinho nao contam — so o
 * padrao "<algo> | (head|tail|cat) ..." que existe para truncar o stream.
 */
function pipesToTruncator(cmd: string): boolean {
  // segmenta por pipe nao-quotado (reaproveita a logica de quotes de isCompoundCommand)
  const segments: string[] = []
  let cur = ''
  let inS = false
  let inD = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (escaped) { cur += c; escaped = false; continue }
    if (c === '\\') { cur += c; escaped = true; continue }
    if (!inD && c === "'") { inS = !inS; cur += c; continue }
    if (!inS && c === '"') { inD = !inD; cur += c; continue }
    if (!inS && !inD && c === '|' && cmd[i + 1] !== '|' && cmd[i - 1] !== '|') {
      segments.push(cur); cur = ''; continue
    }
    cur += c
  }
  segments.push(cur)
  if (segments.length < 2) return false // sem pipe -> nao e o caso que o nudge ataca
  // basta um segmento DOWNSTREAM (apos o 1o pipe) comecar com head/tail/cat
  for (let s = 1; s < segments.length; s++) {
    const head = segments[s].trim().split(/\s+/)[0] ?? ''
    if (head === 'head' || head === 'tail' || head === 'cat') return true
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Poll the transcript until the Bash tool_use count is stable across two reads (the file is
// still being flushed at child 'close'). Caps at ~3s so a missing transcript can't stall.
async function waitForStableTranscript(sessionId: string, cwd: string): Promise<SessionAnalysis> {
  let prev = -1
  let last: SessionAnalysis = { toolCounts: {}, bashCommands: [] }
  for (let i = 0; i < 15; i++) {
    last = analyzeSession(sessionId, cwd)
    const n = last.bashCommands.length
    if (n === prev && n > 0) return last
    prev = n
    await sleep(200)
  }
  return last
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
    // Safety timeout: this harness has hung before with no upper bound (see team memory
    // narration-ab-cant-measure-frente1). Kill any invocation that runs past the cap so a
    // single stuck child can't wedge the whole run.
    let timedOut = false
    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, PER_INVOCATION_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })
    child.on('close', async (code) => {
      clearTimeout(killTimer)
      const wall = Date.now() - start
      if (timedOut) {
        process.stdout.write(`TIMEOUT (>${PER_INVOCATION_TIMEOUT_MS / 1000}s)\n`)
      }
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
      // RACE FIX: the transcript .jsonl is still being flushed when the child emits 'close'.
      // Reading immediately undercounts tool_use (we saw Bash=0 across all sessions while the
      // on-disk transcripts actually contained the commands). Poll until the parsed Bash count
      // stops growing for two consecutive reads (or we give up after ~3s).
      const analysis = sessionId
        ? await waitForStableTranscript(sessionId, TARGET_CWD)
        : { toolCounts: {}, bashCommands: [] }
      let bashAtomic = 0
      let bashCompound = 0
      let bashTruncator = 0
      for (const c of analysis.bashCommands) {
        if (isCompoundCommand(c)) bashCompound++
        else bashAtomic++
        if (pipesToTruncator(c)) bashTruncator++
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
        bashTruncator,
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
  const totalBashTruncator = sum((r) => r.bashTruncator)
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
    totalBashTruncator,
    pctCompound: totalBash === 0 ? 0 : (totalBashCompound / totalBash) * 100,
    pctTruncator: totalBash === 0 ? 0 : (totalBashTruncator / totalBash) * 100,
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
    md += `| ${r.bashAtomic}/${r.bashCompound} (trunc=${r.bashTruncator}) `
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
    md += `- Bash totals: ${s.totalBash} (atomic=${s.totalBashAtomic}, compound=${s.totalBashCompound}, ${s.pctCompound.toFixed(1)}% composto)\n`
    md += `- **Pipe->truncator (head/tail/cat): ${s.totalBashTruncator} (${s.pctTruncator.toFixed(1)}% dos Bash)** [KPI focado do nudge]\n\n`
  }

  if (summaryA && summaryB) {
    // KPI focado: contagem absoluta de pipe->truncator (head/tail/cat). E o
    // comportamento exato que o nudge ataca; % composto fica como metrica de contexto.
    const truncA = summaryA.totalBashTruncator
    const truncB = summaryB.totalBashTruncator
    const truncDeltaRel = truncA === 0 ? 0 : ((truncB - truncA) / truncA) * 100
    const pctDeltaAbs = summaryB.pctCompound - summaryA.pctCompound
    const costDelta = summaryA.avgCost === 0 ? 0 : ((summaryB.avgCost - summaryA.avgCost) / summaryA.avgCost) * 100
    const tokDelta = summaryA.avgInputTokens === 0 ? 0 : ((summaryB.avgInputTokens - summaryA.avgInputTokens) / summaryA.avgInputTokens) * 100
    md += `### Delta\n\n`
    md += `- **Pipe->truncator: ${truncA} -> ${truncB}** (rel ${truncDeltaRel.toFixed(1)}%) [KPI primario]\n`
    md += `- % composto (contexto): ${summaryA.pctCompound.toFixed(1)}% -> ${summaryB.pctCompound.toFixed(1)}% (abs ${pctDeltaAbs.toFixed(1)}pp)\n`
    md += `- Bash compound: ${summaryA.totalBashCompound} -> ${summaryB.totalBashCompound}\n`
    md += `- Avg input tokens delta: ${tokDelta.toFixed(1)}%\n`
    md += `- Avg cost delta: ${costDelta.toFixed(1)}%\n\n`

    md += `### Kill criteria\n\n`
    md += `- KPI = numero de pipes para head/tail/cat (o bypass exato que o nudge ataca).\n`
    md += `- SHIP se B reduz pipe->truncator em >=30% rel E avg cost nao piora (<+5%).\n`
    md += `- KILL se reducao <30% rel (nudge inerte) OU se cost piora >+5%.\n`
    md += `- NOTA: n=5x2 e sinal preliminar. Regra de time: >=3 replicacoes antes de decidir.\n\n`

    const truncOk = truncDeltaRel <= -30
    const costOk = costDelta <= 5
    const verdict = truncOk && costOk ? 'SHIP candidate (preliminar)' : (truncOk ? 'INVESTIGAR (KPI OK mas cost piorou)' : 'INERT/REVERT (preliminar)')
    md += `- Veredito: **${verdict}**\n`
    md += `  - pipe->truncator delta rel: ${truncDeltaRel.toFixed(1)}% (${truncOk ? 'OK' : 'fail'})\n`
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
