#!/usr/bin/env bun
/**
 * Bench A/B: como o modelo ESCOLHE ler, sobre uma sessao multi-arquivo.
 *
 * Compara dois binarios em 10 perguntas ancoradas em 10 arquivos de tamanhos
 * diferentes (~30 turnos por run) e classifica CADA chamada de Read pela forma:
 *
 *   symbol   symbol='X'              — corpo de um simbolo
 *   outline  view='outline'          — so as assinaturas
 *   range    offset/limit            — uma faixa conhecida
 *   full     view='full'             — corpo inteiro, pedido explicitamente
 *   default  nenhum dos acima        — arquivo inteiro ate o cap de linhas
 *
 * `default` e a metrica que importa: e a leitura que o prompt do Read manda
 * evitar. Diferente do cache-ab-bench, o workload aqui NAO dita a forma da
 * leitura (aquele forca "Read it AGAIN in full" para medir cache) — a escolha
 * e do modelo, que e exatamente a variavel sob teste.
 *
 * Uso:
 *   bun run scripts/bench/ab/read-strategy-ab.ts
 *
 * Variaveis de ambiente:
 *   ANTHROPIC_MODEL=claude-sonnet-5     (default)
 *   CLAUDIN_BENCH_RUNS=1                (runs por variante)
 *   CLAUDIN_BENCH_BASELINE=dist/baseline/cli.mjs
 *   CLAUDIN_BENCH_FEATURE=dist/cli.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'

const BASELINE =
  process.env.CLAUDIN_BENCH_BASELINE ?? join(REPO_ROOT, 'dist', 'baseline', 'cli.mjs')
const FEATURE = process.env.CLAUDIN_BENCH_FEATURE ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const RUNS = Number(process.env.CLAUDIN_BENCH_RUNS ?? '1')
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5'
const TARGET_CWD = process.env.CLAUDIN_BENCH_TARGET_CWD ?? REPO_ROOT
const SENTINEL = 'BENCH_DONE'

// Dez arquivos de tamanhos diferentes, cada pergunta respondivel por uma parte
// do arquivo — para que ler tudo seja uma ESCOLHA do modelo, nao a unica saida.
const QUESTIONS: readonly { file: string; ask: string }[] = [
  {
    file: 'src/agent/QueryEngine.ts',
    ask: 'o que o loop principal faz quando uma tool call e abortada no meio',
  },
  {
    file: 'src/tools/Tool.ts',
    ask: 'quais campos um Tool precisa declarar e quais sao opcionais',
  },
  {
    file: 'src/providers/transport/withRetry.ts',
    ask: 'qual e a politica de backoff e o que decide se um erro e retentavel',
  },
  {
    file: 'src/providers/transport/client.ts',
    ask: 'onde os headers da requisicao sao montados',
  },
  {
    file: 'src/agent/context.ts',
    ask: 'o que dessa contagem de contexto e memoizado e o que recalcula por turno',
  },
  {
    file: 'src/providers/shims/openaiShim.ts',
    ask: 'como uma tool call do formato Anthropic vira o formato OpenAI',
  },
  {
    file: 'src/agent/compact/microCompact.ts',
    ask: 'qual e o gatilho do micro-compact e o que ele preserva',
  },
  {
    file: 'src/agent/cache/cacheProfile.ts',
    ask: 'quais perfis existem e o que muda entre eles',
  },
  {
    file: 'src/shared/envUtils.ts',
    ask: 'como uma env var e interpretada como truthy e como falsy',
  },
  {
    file: 'src/shared/data/array.ts',
    ask: 'quais helpers esse modulo exporta',
  },
  // As tres ultimas sao do tipo "quem chama X": a pergunta que `output_mode:
  // "symbols"` responde em uma chamada e que `content` so consegue PARECER
  // responder, porque a linha de match nao carrega a funcao que a envolve.
  {
    file: 'src/providers/presets/activeProvider.ts',
    ask: 'quais funcoes chamam tryGetActiveProvider e o que elas fazem com o resultado',
  },
  {
    file: 'src/shared/errors.ts',
    ask: 'quais funcoes chamam isAbortError e o que muda quando ele e verdadeiro',
  },
  {
    file: 'src/platform/config/config.ts',
    ask: 'quais funcoes chamam getGlobalConfig fora do proprio modulo',
  },
]

function buildPrompt(): string {
  const steps = QUESTIONS.map(
    (q, i) => `  ${i + 1}. Em \`${q.file}\`: ${q.ask}?`,
  )
  return [
    `Responda estas ${QUESTIONS.length} perguntas sobre ESTE repositorio, uma por vez,`,
    `ancorando cada resposta no codigo real (cite arquivo:linha).`,
    `Responda uma pergunta por mensagem, na ordem, com 2-4 frases cada.`,
    // Sem isso o bench mede outra coisa: numa run o modelo delegou para 3
    // sub-agentes e fez 4 leituras proprias, virando uma sessao de delegacao
    // contra duas de leitura dentro do MESMO braco. A variavel sob teste e como
    // ele le, entao delegar tem que sair do caminho.
    `Responda voce mesmo: nao delegue para sub-agentes.`,
    `Perguntas:`,
    ...steps,
    ``,
    `Ao terminar a ultima, encerre a mensagem final com o token exato ${SENTINEL}.`,
  ].join('\n')
}

type ReadShape = 'symbol' | 'outline' | 'range' | 'full' | 'default'

function classifyRead(input: Record<string, unknown> | undefined): ReadShape {
  if (!input) return 'default'
  if (typeof input.symbol === 'string' && input.symbol.length > 0) return 'symbol'
  if (input.view === 'outline') return 'outline'
  if (input.offset !== undefined || input.limit !== undefined) return 'range'
  if (input.view === 'full') return 'full'
  return 'default'
}

type RunResult = {
  variant: 'A' | 'B'
  runIdx: number
  ok: boolean
  durationMs: number
  costUsd: number
  numTurns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  sessionId: string
  toolCounts: Record<string, number>
  readShapes: Record<ReadShape, number>
  grepModes: Record<string, number>
  answeredAll: boolean
}

const PATH_SEP_RE = /[/]/g

function readSessionCounts(sessionId: string): {
  tools: Record<string, number>
  shapes: Record<ReadShape, number>
  grepModes: Record<string, number>
} {
  const shapes: Record<ReadShape, number> = {
    symbol: 0,
    outline: 0,
    range: 0,
    full: 0,
    default: 0,
  }
  const tools: Record<string, number> = {}
  const grepModes: Record<string, number> = {}
  const path = join(
    homedir(),
    '.claudin',
    'projects',
    TARGET_CWD.replace(PATH_SEP_RE, '-'),
    `${sessionId}.jsonl`,
  )
  if (!existsSync(path)) return { tools, shapes, grepModes }
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    let rec: { message?: { content?: unknown } }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const content = rec?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_use' || typeof block?.name !== 'string') continue
      tools[block.name] = (tools[block.name] ?? 0) + 1
      if (block.name === 'Read') {
        shapes[classifyRead(block.input as Record<string, unknown>)] += 1
      }
      if (block.name === 'Grep') {
        const input = block.input as Record<string, unknown> | undefined
        const mode = (input?.output_mode as string) ?? 'files_with_matches'
        grepModes[mode] = (grepModes[mode] ?? 0) + 1
      }
    }
  }
  return { tools, shapes, grepModes }
}

function runOnce(
  variant: 'A' | 'B',
  entryPath: string,
  runIdx: number,
): Promise<RunResult> {
  const label = variant === 'A' ? 'baseline' : 'feature'
  process.stdout.write(`  [${variant}/${label}] run#${runIdx + 1} ... `)
  const start = Date.now()
  return new Promise(resolvePromise => {
    const child = spawn(
      'node',
      [entryPath, '-p', buildPrompt(), '--model', MODEL, '--output-format', 'json'],
      { cwd: TARGET_CWD, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', c => {
      out += c.toString()
    })
    child.stderr.on('data', () => {})
    child.on('close', code => {
      const durationMs = Date.now() - start
      let parsed: Record<string, any> = {}
      try {
        parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}')
      } catch {
        // parse error — counted as not ok below
      }
      const ok = code === 0 && parsed?.subtype === 'success'
      const sessionId: string = parsed?.session_id ?? ''
      const usage: Record<string, number> =
        (Object.values(parsed?.modelUsage ?? {})[0] as Record<string, number>) ?? {}
      const { tools, shapes, grepModes } = sessionId
        ? readSessionCounts(sessionId)
        : {
            tools: {},
            shapes: { symbol: 0, outline: 0, range: 0, full: 0, default: 0 },
            grepModes: {},
          }
      const reads = Object.values(shapes).reduce((a, b) => a + b, 0)
      process.stdout.write(
        ok
          ? `OK ${(durationMs / 1000).toFixed(0)}s reads=${reads} default=${shapes.default} outline=${shapes.outline} symbol=${shapes.symbol} range=${shapes.range} grep-symbols=${grepModes.symbols ?? 0}\n`
          : `FAIL (exit=${code})\n`,
      )
      resolvePromise({
        variant,
        runIdx,
        ok,
        durationMs,
        costUsd: parsed?.total_cost_usd ?? 0,
        numTurns: parsed?.num_turns ?? 0,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadInputTokens ?? 0,
        sessionId,
        toolCounts: tools,
        readShapes: shapes,
        grepModes,
        answeredAll: String(parsed?.result ?? '').includes(SENTINEL),
      })
    })
  })
}

function sum(rows: RunResult[], pick: (r: RunResult) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0)
}

function avg(rows: RunResult[], pick: (r: RunResult) => number): number {
  return rows.length === 0 ? 0 : sum(rows, pick) / rows.length
}

function shapeTotals(rows: RunResult[]): Record<ReadShape, number> {
  const totals: Record<ReadShape, number> = {
    symbol: 0,
    outline: 0,
    range: 0,
    full: 0,
    default: 0,
  }
  for (const r of rows) {
    for (const key of Object.keys(totals) as ReadShape[]) {
      totals[key] += r.readShapes[key]
    }
  }
  return totals
}

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(0)}%`
}

async function main(): Promise<void> {
  for (const [name, path] of [
    ['Baseline', BASELINE],
    ['Feature', FEATURE],
  ] as const) {
    if (!existsSync(path)) {
      console.error(`${name} entry not found: ${path}`)
      process.exit(1)
    }
  }

  console.log(`Bench: ${QUESTIONS.length} perguntas x ${RUNS} runs x 2 variantes`)
  console.log(`  Baseline (A): ${BASELINE}`)
  console.log(`  Feature  (B): ${FEATURE}`)
  console.log(`  Model:        ${MODEL}`)
  console.log('')

  const results: RunResult[] = []
  for (let runIdx = 0; runIdx < RUNS; runIdx++) {
    results.push(await runOnce('A', BASELINE, runIdx))
    results.push(await runOnce('B', FEATURE, runIdx))
  }

  const arms = {
    A: results.filter(r => r.variant === 'A' && r.ok),
    B: results.filter(r => r.variant === 'B' && r.ok),
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(REPO_ROOT, 'scripts', 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `read-strategy-ab-${ts}.md`)

  let md = `# Bench A/B — estrategia de leitura do Read\n\n`
  md += `- Timestamp: ${new Date().toISOString()}\n- Model: \`${MODEL}\`\n`
  md += `- Baseline: \`${BASELINE}\`\n- Feature: \`${FEATURE}\`\n- Runs: ${RUNS}\n\n`

  md += `## Forma das leituras\n\n`
  md += `| arm | n | reads | default | outline | symbol | range | full |\n|---|--:|--:|--:|--:|--:|--:|--:|\n`
  for (const [label, rows] of [['A (baseline)', arms.A], ['B (feature)', arms.B]] as const) {
    const t = shapeTotals(rows)
    const reads = Object.values(t).reduce((a, b) => a + b, 0)
    md += `| ${label} | ${rows.length} | ${reads} | ${t.default} (${pct(t.default, reads)}) `
    md += `| ${t.outline} | ${t.symbol} | ${t.range} | ${t.full} |\n`
  }

  // Por run, nao so o agregado: uma unica run que se comporta de outro jeito
  // (delegar em vez de ler) move o total inteiro, e a media esconde isso.
  md += `\n## Por run\n\n`
  md += `| arm | run | reads | corpo inteiro | turns | in | $ | wall |\n|---|--:|--:|--:|--:|--:|--:|--:|\n`
  for (const r of results.filter(x => x.ok)) {
    const whole = r.readShapes.default + r.readShapes.full
    const reads = Object.values(r.readShapes).reduce((a, b) => a + b, 0)
    md += `| ${r.variant} | ${r.runIdx + 1} | ${reads} | ${whole} | ${r.numTurns} `
    md += `| ${r.inputTokens} | $${r.costUsd.toFixed(4)} | ${(r.durationMs / 1000).toFixed(0)}s |\n`
  }

  md += `\n## Modo do Grep\n\n`
  md += `| arm | greps | symbols | content | files_with_matches | count |\n|---|--:|--:|--:|--:|--:|\n`
  for (const [label, rows] of [['A (baseline)', arms.A], ['B (feature)', arms.B]] as const) {
    const modes: Record<string, number> = {}
    for (const r of rows) {
      for (const [k, v] of Object.entries(r.grepModes)) modes[k] = (modes[k] ?? 0) + v
    }
    const greps = Object.values(modes).reduce((a, b) => a + b, 0)
    md += `| ${label} | ${greps} | ${modes.symbols ?? 0} (${pct(modes.symbols ?? 0, greps)}) `
    md += `| ${modes.content ?? 0} | ${modes.files_with_matches ?? 0} | ${modes.count ?? 0} |\n`
  }

  md += `\n## Custo\n\n`
  md += `| arm | avg turns | avg in | avg out | avg cache_read | total $ | avg wall |\n|---|--:|--:|--:|--:|--:|--:|\n`
  for (const [label, rows] of [['A (baseline)', arms.A], ['B (feature)', arms.B]] as const) {
    md += `| ${label} | ${avg(rows, r => r.numTurns).toFixed(1)} `
    md += `| ${avg(rows, r => r.inputTokens).toFixed(0)} | ${avg(rows, r => r.outputTokens).toFixed(0)} `
    md += `| ${avg(rows, r => r.cacheReadTokens).toFixed(0)} | $${sum(rows, r => r.costUsd).toFixed(4)} `
    md += `| ${(avg(rows, r => r.durationMs) / 1000).toFixed(1)}s |\n`
  }

  if (arms.A.length > 0 && arms.B.length > 0) {
    const ta = shapeTotals(arms.A)
    const tb = shapeTotals(arms.B)
    const readsA = Object.values(ta).reduce((a, b) => a + b, 0)
    const readsB = Object.values(tb).reduce((a, b) => a + b, 0)
    const targetedA = ta.outline + ta.symbol + ta.range
    const targetedB = tb.outline + tb.symbol + tb.range
    // `default` e `full` sao o MESMO comportamento — corpo inteiro — escrito de
    // duas formas, e o prompt muda qual delas o modelo usa. Medir so `default`
    // le uma troca de `view='full'` por omissao do parametro como regressao;
    // agregue os dois ou a metrica mente.
    const wholeA = ta.default + ta.full
    const wholeB = tb.default + tb.full
    md += `\n## Delta\n\n`
    md += `- Corpo inteiro (\`default\` + \`full\`): ${pct(wholeA, readsA)} -> ${pct(wholeB, readsB)}\n`
    md += `- Leituras direcionadas (outline+symbol+range): ${pct(targetedA, readsA)} -> ${pct(targetedB, readsB)}\n`
    md += `- Reads por run: ${(readsA / arms.A.length).toFixed(1)} -> ${(readsB / arms.B.length).toFixed(1)}\n`
    md += `- Respostas completas (sentinela): ${arms.A.filter(r => r.answeredAll).length}/${arms.A.length} -> ${arms.B.filter(r => r.answeredAll).length}/${arms.B.length}\n`
    md += `\n### Criterio\n\n`
    md += `- GO se corpo-inteiro cair >= 15 pontos percentuais, SEM perder resposta\n`
    md += `  completa E sem subir custo por run — ler em fatias pode custar MAIS na\n`
    md += `  sessao inteira, porque cada fatia e um round-trip que re-envia o\n`
    md += `  transcript. A forma da leitura sozinha nao decide nada.\n`
    md += `- NO-GO se corpo-inteiro mover menos de 5 pontos (texto inerte), se alguma\n`
    md += `  resposta sumir, ou se o custo por run subir mais que 5%.\n`
  }

  md += `\n## Respostas (para conferir que nao houve perda)\n\n`
  for (const r of results.filter(x => x.ok)) {
    md += `### ${r.variant} run#${r.runIdx + 1} — sessao \`${r.sessionId.slice(0, 8)}\`\n\n`
    md += `Tools: ${Object.entries(r.toolCounts).map(([k, v]) => `${k}=${v}`).join(' ')}\n\n`
  }

  writeFileSync(outPath, md)
  console.log('')
  console.log(`Report: ${outPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
