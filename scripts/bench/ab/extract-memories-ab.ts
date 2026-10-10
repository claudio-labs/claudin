#!/usr/bin/env bun
/**
 * Extract-memories A/B — can the background memory extraction run on a cheaper
 * model without saving worse memories?
 *
 * The extraction (src/memory/extract/extractMemories.ts) is a fork of the main
 * loop: the session's model and effort, reading the main loop's prompt cache.
 * CLAUDIN_EXTRACT_MEMORIES_MODEL runs it as a fresh agent on another model
 * instead (freshAgentParams): it shares no cache, so it reads only the messages
 * since the last extraction, at CLAUDIN_EXTRACT_MEMORIES_EFFORT.
 *
 * Arms (more with --variant):
 *   base     the fork, on the session's model (Opus 5.5 at medium)
 *   placebo  base again with an inert variable: the noise floor
 *   haiku    CLAUDIN_EXTRACT_MEMORIES_MODEL=haiku, CLAUDIN_EXTRACT_MEMORIES_EFFORT=high
 *
 * Every arm extracts from the SAME conversation:
 *   1. record — one session of six turns in a fresh git workspace, run once
 *      with auto-memory off (CLAUDIN_DISABLE_AUTO_MEMORY=1) so the main agent
 *      never saves a memory itself, which would make the extraction skip
 *      (hasMemoryWritesSince). The turns do small real tasks and drop, on the
 *      way, five things worth remembering and two that are not:
 *        role     a Go backend dev, new to TypeScript              → user, global dir
 *        exports  never default exports, and why (bundle size)     → feedback
 *        freeze   src/billing/ frozen until "a próxima sexta"      → project
 *        grafana  where the CI logs live — a dashboard the last turn
 *                 corrects to another one                          → reference, the corrected URL
 *        deploy   staging moved from GitHub Actions to a Gitea webhook, while
 *                 the workspace holds a memory saying GitHub Actions → that memory
 *        meeting  "tenho uma reunião às 15h"                        → nothing
 *        token    the webhook's token, said in passing             → nothing
 *   2. per arm × rep — a copy of the workspace and of the transcript, resumed
 *      (--fork-session) for one closing turn that asks for no tool, with the
 *      extraction let into `-p` (CLAUDIN_EXTRACT_MEMORIES_HEADLESS=1) and fired
 *      at once (CLAUDIN_EXTRACT_MEMORIES_EVERY=1), through the recording proxy
 *      (wire-proxy.ts). `-p` waits for it before exiting (drainPendingExtraction).
 *   3. grade from disk, cost from the wire.
 *
 * Grading, per fact: the memory carrying it sits in a directory its kind
 * allows, its frontmatter is valid and of the expected type, its index links
 * it, and no other file carries the fact (memory-write-ab.ts's checks);
 * `deploy` must land in the existing file. A detail a good memory keeps is
 * reported beside three facts, ungated: role says "new to TypeScript", exports
 * keeps its why, freeze an absolute date. Then the leaks (a memory or an index
 * carrying the meeting or the token) and the extras (new memory files carrying
 * none of the facts).
 *
 * Cost: the extraction's requests only — those carrying the extraction prompt
 * (src/memory/extract/prompts.ts) — priced per model from the proxy's usage at
 * the rates of src/providers/usage/modelCost.ts, Haiku 5.5's long-prompt tier
 * included. The closing turn's own requests are the same in every arm and are
 * reported apart.
 *
 * Not measured: the conversation is every arm's whole window, so the fresh
 * agent's cut to "messages since the last extraction" never bites here. In a
 * long session the fork reads the whole prefix from the cache while the fresh
 * agent reads only the delta; the per-request prompt tokens in the report are
 * what to extrapolate from.
 *
 * Gates, written before the first run, for each arm but base and placebo:
 *   1. mechanism — every run extracted (the debug log's "finished"), none was
 *      skipped because the main agent wrote a memory, and every extraction
 *      request went to the model and effort the arm names;
 *   2. quality — its fact passes total at least the lower of base's and
 *      placebo's, and it leaks no more often than the higher;
 *   3. cost — its extraction cost median is below base's and placebo's, with
 *      a range disjoint from both.
 *
 * Run 2026-10-10 (/tmp/extract-memories-ab/20261010-204526, then 10 more reps
 * of base and haiku on its recording, …-204957): haiku cost 94% less per
 * extraction ($0.009 against $0.155, ranges disjoint), mechanism and leaks
 * clean, but quality FAILED — it saved no user-profile memory at all (role)
 * in 2 of 15 runs, where the fork saved it in 20 of 20; every other fact
 * 15/15. At xhigh (…-211240, alone on the same
 * recording, read against the fork's 35 runs there): 75/75 facts, no leak, no
 * extra, $0.013 against $0.155 (−92%, ranges disjoint) — but 53s a request
 * against the fork's 25s. An earlier xhigh pass (…-205738) lost 2 of 15 runs
 * to the 60s `-p` drain, since raised to 5 minutes.
 * Rejected as a default on 2026-10-10: not worth it (team memory
 * decisions/extract-memories-haiku-rejected).
 *
 * Usage:
 *   bun scripts/bench/ab/extract-memories-ab.ts --dry-run       # plan + grader self-test, no tokens
 *   bun scripts/bench/ab/extract-memories-ab.ts --reps=5        # record once, then base, placebo, haiku
 *   bun scripts/bench/ab/extract-memories-ab.ts --reps=3 --only=base,haiku-medium \
 *     --variant=haiku-medium:CLAUDIN_EXTRACT_MEMORIES_MODEL=haiku,CLAUDIN_EXTRACT_MEMORIES_EFFORT=medium
 *   bun scripts/bench/ab/extract-memories-ab.ts --recording=/tmp/extract-memories-ab/<stamp>   # reuse its recording
 *
 * Run `bun run build` first: bin/claudin runs the bundle. Host CLAUDECODE /
 * CLAUDE_CODE_* / CLAUDIN_* variables are stripped (session-cache-ab.ts
 * spawnCollect).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'
import { parseJsonl } from './cliUsage'
import { range, rangesOverlap } from './forkBench'
import { configDir, median } from './headlessProbe'
import {
  absOf,
  allMemoryFiles,
  dirOf,
  fm,
  frontmatterOf,
  frontmatterProblems,
  GLOBAL,
  isIndexed,
  MEMORY_REL,
  type MEMORY_TYPES,
  type MemoryRoots,
} from './memory-write-ab'
import { git, spawnCollect, stamp, table, version } from './session-cache-ab'
import { isMessagesPath, proxyEnv, readBody, readProxyRecords, startWireProxy, type WireProxy } from './wire-proxy'

const BENCH_ROOT = '/tmp/extract-memories-ab'
const MODEL = 'claude-opus-5-5'
const EFFORT = 'medium'
/** How the extraction prompt opens (src/memory/extract/prompts.ts): what tells its requests apart. */
const EXTRACTION_OPENER = 'You are now acting as the memory extraction subagent'
const DAY_MS = 86_400_000

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

const PROJECT_FILES: Record<string, string> = {
  'README.md': '# texto-kit\n\nSmall TypeScript text helpers.\n',
  'package.json': `${JSON.stringify({ name: 'texto-kit', version: '0.3.0', type: 'module', scripts: { test: 'bun test' } }, null, 2)}\n`,
  'src/index.ts': "export { capitalize } from './capitalize'\n",
  'src/capitalize.ts': 'export function capitalize(text: string): string {\n  return text.charAt(0).toUpperCase() + text.slice(1)\n}\n',
  'src/billing/invoice.ts':
    'export function invoiceTotal(lines: { qty: number; unit: number }[]): number {\n  return lines.reduce((sum, line) => sum + line.qty * line.unit, 0)\n}\n',
}

/** The memory the workspace starts with, relative to the memory root: `deploy` must update it. */
const SEED_DEPLOY = 'team/staging-deploy.md'
const SEED_MEMORY: Record<string, string> = {
  [SEED_DEPLOY]: fm(
    ['name: staging-deploy', 'description: how staging gets deployed', 'type: project'],
    'Staging deploys run from the GitHub Actions workflow `.github/workflows/deploy.yml` on every merge to `main`.',
  ),
  'team/MEMORY.md': '- [Staging deploy](staging-deploy.md) — GitHub Actions on every merge to main\n',
}

const TURNS: readonly string[] = [
  'Oi! Contexto rápido: sou dev backend, programo em Go há uns 10 anos, mas é a primeira vez que mexo num projeto TypeScript. Cria em src/slug.ts uma função slugify(text: string) que deixa tudo minúsculo e troca espaços por hífen.',
  'Boa. Uma regra daqui: nunca use export default, sempre named export — o tree-shaking do nosso bundler se perdia com default export e o bundle de produção dobrou de tamanho. Confere se o slug.ts segue isso e exporta o slugify pelo src/index.ts.',
  'Agora cria src/slug.test.ts com uns três casos pro slugify. Ah, e não mexe em nada de src/billing/ até a próxima sexta — o financeiro está fechando o trimestre e congelou essa pasta.',
  'Roda os testes rapidinho, que daqui a pouco tenho uma reunião às 15h. E se o CI quebrar algum dia, os logs ficam no Grafana em https://grafana.internal.example/d/ci-builds — é lá que a gente olha primeiro.',
  'Adiciona uma linha no README sobre o slugify. E uma atualização: o deploy de staging não é mais pelo GitHub Actions — migramos para o webhook do Gitea no mês passado (o token do webhook é stg_9f3b2c7d1e4a8f60d2c1, se precisar).',
  'Ah, corrigindo o que eu falei antes: o dashboard de CI certo é https://grafana.internal.example/d/ci-pipeline — o ci-builds foi desativado. Pode commitar o que fizemos hoje?',
]
const CLOSING = 'Antes de fechar: em uma frase, e sem usar nenhuma ferramenta, qual seria o próximo passo natural aqui?'

/** A git repo with one pinned commit, holding the project and the seeded team memory. */
function makeWorkspace(dir: string): void {
  const memory = Object.entries(SEED_MEMORY).map(([rel, text]) => [join(MEMORY_REL, rel), text] as const)
  for (const [rel, content] of [...Object.entries(PROJECT_FILES), ...memory]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const steps: string[][] = [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Bench User'],
    ['config', 'user.email', 'bench@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.hooksPath', '.git/no-hooks'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'chore: import texto-kit 0.3.0'],
  ]
  for (const step of steps) {
    const r = git(dir, ...step)
    if (!r.ok) throw new Error(`git ${step.join(' ')} failed in ${dir}: ${r.out}`)
  }
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The Friday after `from`, and the one after it: "a próxima sexta" can mean either. */
export function fridaysAfter(from: Date): Date[] {
  const noon = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12)
  const ahead = (5 - noon.getDay() + 7) % 7 || 7
  const first = new Date(noon.getTime() + ahead * DAY_MS)
  return [first, new Date(first.getTime() + 7 * DAY_MS)]
}

/** Any of `days` as a memory might write it: ISO, dd/mm, "16 de outubro", "October 16". */
export function datesRe(days: readonly Date[]): RegExp {
  const alternatives = days.flatMap(d => {
    const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()]
    const mm = String(m + 1).padStart(2, '0')
    const dd = String(day).padStart(2, '0')
    return [`${y}-${mm}-${dd}`, `\\b${dd}/${mm}\\b`, `\\b${day}/${m + 1}\\b`, `\\b${day} de ${MONTHS_PT[m]}`, `${MONTHS_EN[m]} ${day}\\b`, `\\b${day} ${MONTHS_EN[m]}`]
  })
  return new RegExp(alternatives.join('|'), 'i')
}

type Fact = {
  id: string
  /** What the conversation said, as the memory carrying it must say it. */
  fact: RegExp
  type: (typeof MEMORY_TYPES)[number]
  /** Directories the memory may be in, relative to the memory root ('' private, GLOBAL the global dir). */
  dirs: readonly string[]
  /** The existing memory the fact must land in, when it updates one. */
  updates?: string
  /** A detail a good memory keeps: reported, not gated. */
  detail?: { name: string; re: (recordedOn: Date) => RegExp }
}

export const FACTS: readonly Fact[] = [
  { id: 'role', fact: /\bGo\b|[Gg]olang/, type: 'user', dirs: [GLOBAL], detail: { name: 'new to TS', re: () => /TypeScript|\bTS\b/ } },
  {
    id: 'exports',
    fact: /export default|default exports?|named exports?|exports? nomead/i,
    type: 'feedback',
    dirs: ['', 'team/'],
    detail: { name: 'why', re: () => /tree.?shak|bundle/i },
  },
  {
    id: 'freeze',
    fact: /billing/i,
    type: 'project',
    dirs: ['', 'team/'],
    detail: { name: 'absolute date', re: recordedOn => datesRe([...fridaysAfter(recordedOn), ...fridaysAfter(new Date())]) },
  },
  { id: 'grafana', fact: /grafana\.internal\.example\/d\/ci-pipeline/i, type: 'reference', dirs: ['', 'team/', 'team/docs/'] },
  { id: 'deploy', fact: /gitea/i, type: 'project', dirs: ['team/'], updates: SEED_DEPLOY },
]

/** What no memory, index included, may carry: an ephemeral detail, and a credential. */
const LEAKS: Record<string, RegExp> = {
  meeting: /reuni[aã]o|meeting|\b15h\b|15:00|\b3 ?pm\b/i,
  token: /stg_9f3b2c7d1e4a8f60d2c1/,
}

type FactGrade = {
  file: string | null
  where: boolean
  frontmatter: boolean
  index: boolean
  single: boolean
  pass: boolean
  /** Whether the memory keeps the fact's detail; null for a fact without one. */
  detail: boolean | null
  problems: string[]
}

export type Grade = {
  facts: Record<string, FactGrade>
  /** Facts that pass, out of FACTS.length. */
  score: number
  /** Per LEAKS entry, the memory files and indexes carrying it, relative to the memory root. */
  leaks: Record<string, string[]>
  /** New memory files carrying none of the facts. */
  extras: string[]
}

const leaked = (g: Grade): string[] => Object.entries(g.leaks).flatMap(([kind, files]) => files.map(f => `${kind}: ${f}`))

const textOf = (roots: MemoryRoots, rel: string): string => readFileSync(absOf(roots, rel), 'utf8')

function gradeFact(roots: MemoryRoots, fact: Fact, recordedOn: Date): FactGrade {
  const carrying = allMemoryFiles(roots).filter(rel => fact.fact.test(textOf(roots, rel)))
  const allowed = (rel: string) => (fact.updates ? rel === fact.updates : fact.dirs.includes(dirOf(rel)))
  const file = carrying.find(allowed) ?? carrying[0] ?? null
  if (!file) {
    return { file, where: false, frontmatter: false, index: false, single: false, pass: false, detail: fact.detail ? false : null, problems: ['no memory carries it'] }
  }
  const text = textOf(roots, file)
  const type = frontmatterOf(text)?.type
  const problems = frontmatterProblems(file, text, roots.globalRoot !== null)
  if (type !== fact.type) problems.push(`type "${type ?? ''}", not "${fact.type}"`)
  const frontmatter = problems.length === 0
  const where = allowed(file)
  const index = isIndexed(roots, file)
  const single = carrying.length === 1
  if (!where) problems.push(fact.updates ? `in ${file}, not the existing ${fact.updates}` : `in "${dirOf(file) || '(private root)'}"`)
  if (!index) problems.push('not in its index')
  if (!single) problems.push(`in ${carrying.length} files: ${carrying.join(', ')}`)
  return {
    file,
    where,
    frontmatter,
    index,
    single,
    pass: where && frontmatter && index && single,
    detail: fact.detail ? fact.detail.re(recordedOn).test(text) : null,
    problems,
  }
}

/** Every .md under `dir`, indexes included, relative to it. */
function markdownFiles(dir: string, sub = ''): string[] {
  if (!existsSync(join(dir, sub))) return []
  return readdirSync(join(dir, sub), { withFileTypes: true }).flatMap(entry => {
    const rel = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) return markdownFiles(dir, rel)
    return entry.name.endsWith('.md') ? [rel] : []
  })
}

function everyMemoryText(roots: MemoryRoots): Array<[string, string]> {
  const own = markdownFiles(roots.root).map(rel => [rel, join(roots.root, rel)] as const)
  const global = roots.globalRoot === null ? [] : markdownFiles(roots.globalRoot).map(rel => [`${GLOBAL}${rel}`, join(roots.globalRoot!, rel)] as const)
  return [...own, ...global].map(([rel, abs]) => [rel, readFileSync(abs, 'utf8')])
}

export function gradeRun(roots: MemoryRoots, recordedOn: Date): Grade {
  const facts = Object.fromEntries(FACTS.map(fact => [fact.id, gradeFact(roots, fact, recordedOn)]))
  const extras = allMemoryFiles(roots).filter(
    rel => !(rel in SEED_MEMORY) && !FACTS.some(fact => fact.fact.test(textOf(roots, rel))),
  )
  const texts = everyMemoryText(roots)
  const leaks = Object.fromEntries(
    Object.entries(LEAKS).map(([kind, re]) => [kind, texts.filter(([, text]) => re.test(text)).map(([rel]) => rel)]),
  )
  return { facts, score: Object.values(facts).filter(g => g.pass).length, leaks, extras }
}

/** Memory files a run added or changed, with their text, for reading side by side. */
function changedMemory(roots: MemoryRoots): Array<[string, string]> {
  return everyMemoryText(roots).filter(([rel, text]) => SEED_MEMORY[rel] !== text)
}

// ---------------------------------------------------------------------------
// The wire: what the extraction sent, and what it cost
// ---------------------------------------------------------------------------

type Rates = { input: number; write5m: number; write1h: number; read: number; output: number }

/** $/Mtok, as src/providers/usage/modelCost.ts has them (COST_TIER_4_20, COST_HAIKU_55). */
const PRICES: ReadonlyArray<{ match: string; rates: Rates; long?: Rates & { above: number } }> = [
  { match: 'opus-5-5', rates: { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 } },
  {
    match: 'haiku-5-5',
    rates: { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 },
    long: { above: 100_000, input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 },
  },
]

const tokens = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** One request's cost: a prompt over the long-prompt threshold bills every term at the long rates. */
export function costOf(model: string, usage: Json): number {
  const price = PRICES.find(p => model.includes(p.match))
  if (!price) throw new Error(`no price for ${model} — add it to PRICES`)
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : {}
  const write = tokens(usage.cache_creation_input_tokens)
  const write1h = tokens(split.ephemeral_1h_input_tokens)
  const write5m = isRecord(usage.cache_creation) ? tokens(split.ephemeral_5m_input_tokens) : write
  const prompt = tokens(usage.input_tokens) + tokens(usage.cache_read_input_tokens) + write
  const r = price.long && prompt > price.long.above ? price.long : price.rates
  return (
    (tokens(usage.input_tokens) * r.input +
      write5m * r.write5m +
      write1h * r.write1h +
      tokens(usage.cache_read_input_tokens) * r.read +
      tokens(usage.output_tokens) * r.output) /
    1e6
  )
}

const blocksOf = (content: unknown): Json[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isRecord) : []

export function isExtractionRequest(body: Json): boolean {
  const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
  return messages.some(
    m => m.role === 'user' && blocksOf(m.content).some(b => typeof b.text === 'string' && b.text.trimStart().startsWith(EXTRACTION_OPENER)),
  )
}

type Extraction = {
  requests: number
  errors: number
  costUsd: number
  /** Prompt tokens, summed over the requests: uncached, written, read. */
  input: number
  write: number
  read: number
  output: number
  thinking: number
  ms: number
  models: string[]
  efforts: string[]
}

type Wire = { extraction: Extraction; closingCostUsd: number }

function wireOf(proxy: WireProxy, label: string): Wire {
  const x: Extraction = { requests: 0, errors: 0, costUsd: 0, input: 0, write: 0, read: 0, output: 0, thinking: 0, ms: 0, models: [], efforts: [] }
  let closingCostUsd = 0
  const records = readProxyRecords(proxy.logDir, label)
    .filter(r => r.reqFile && isMessagesPath(r.path))
    .sort((a, b) => a.n - b.n)
  for (const r of records) {
    const body = readBody(proxy.logDir, label, r.reqFile!)
    const usage = r.response?.usage ?? null
    const model = r.response?.model ?? String(body.model ?? '')
    const cost = usage ? costOf(model, usage) : 0
    if (!isExtractionRequest(body)) {
      closingCostUsd += cost
      continue
    }
    x.requests++
    if (r.status >= 400 || !usage) x.errors++
    x.costUsd += cost
    x.input += tokens(usage?.input_tokens)
    x.write += tokens(usage?.cache_creation_input_tokens)
    x.read += tokens(usage?.cache_read_input_tokens)
    x.output += tokens(usage?.output_tokens)
    x.thinking += r.response?.thinkingTokens ?? 0
    x.ms += r.ms
    if (!x.models.includes(model)) x.models.push(model)
    const effort = isRecord(body.output_config) && typeof body.output_config.effort === 'string' ? body.output_config.effort : 'none'
    if (!x.efforts.includes(effort)) x.efforts.push(effort)
  }
  return { extraction: x, closingCostUsd }
}

// ---------------------------------------------------------------------------
// The debug log: whether the extraction ran
// ---------------------------------------------------------------------------

const FINISHED_RE = /\[extractMemories\] finished — (\d+) files written/
const ERROR_RE = /\[extractMemories\] error: (.*)/
const SKIPPED_MARK = '[extractMemories] skipping — conversation already wrote to memory files'
const STARTED_MARK = '[extractMemories] starting'

type Mechanism = { started: boolean; finished: boolean; filesWritten: number | null; skipped: boolean; error: string | null }

function mechanismOf(debugLog: string): Mechanism {
  const finished = FINISHED_RE.exec(debugLog)
  return {
    started: debugLog.includes(STARTED_MARK),
    finished: finished !== null,
    filesWritten: finished ? Number(finished[1]) : null,
    skipped: debugLog.includes(SKIPPED_MARK),
    error: ERROR_RE.exec(debugLog)?.[1] ?? null,
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

type Args = {
  reps: number
  only: string[] | null
  recording: string | null
  timeoutMs: number
  dryRun: boolean
  bin: string
  env: Record<string, Record<string, string>>
  arms: string[]
}

const DEFAULT_ARMS: Record<string, Record<string, string>> = {
  base: {},
  placebo: { CLAUDIN_BENCH_PLACEBO: '1' },
  haiku: { CLAUDIN_EXTRACT_MEMORIES_MODEL: 'haiku', CLAUDIN_EXTRACT_MEMORIES_EFFORT: 'high' },
}

/** The model (a substring of its id) and effort an arm's extraction requests must carry. */
function expectedWire(env: Record<string, string>): { model: string; effort: string } {
  const spec = env.CLAUDIN_EXTRACT_MEMORIES_MODEL
  if (!spec) return { model: MODEL, effort: EFFORT }
  const aliases: Record<string, string> = { haiku: 'haiku-5-5', sonnet: 'sonnet-5-5', opus: 'opus-5-5' }
  return { model: aliases[spec] ?? spec, effort: env.CLAUDIN_EXTRACT_MEMORIES_EFFORT ?? 'high' }
}

/** Every workspace path has the same length, so the transcript's paths keep their size when rewritten. */
const workspaceOf = (runDir: string, n: number): string => join(runDir, `ws${String(n).padStart(3, '0')}`)
/** The app's project dir name for a cwd (sessionStoragePortable.ts sanitizePath, short paths). */
const projectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const transcriptOf = (cwd: string, sessionId: string): string => join(configDir(), 'projects', projectSlug(cwd), `${sessionId}.jsonl`)

function cliArgs(prompt: string, o: { globalDir: string; maxTurns: number; budgetUsd: number; resume?: string; extra?: string[] }): string[] {
  return [
    '-p',
    prompt,
    '--model',
    MODEL,
    '--effort',
    EFFORT,
    '--max-turns',
    String(o.maxTurns),
    '--max-budget-usd',
    String(o.budgetUsd),
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    // The session's own global memory dir: never the real ~/.claudin/memory/.
    '--settings',
    JSON.stringify({ autoMemoryGlobalDirectory: o.globalDir }),
    ...(o.resume ? ['--resume', o.resume] : []),
    ...(o.extra ?? []),
  ]
}

type Recording = { workspace: string; sessionId: string; transcript: string; recordedOn: string; costUsd: number }

const rootsOf = (workspace: string): MemoryRoots => ({ root: join(workspace, MEMORY_REL), globalRoot: `${workspace}.global` })

async function record(args: Args, runDir: string): Promise<Recording> {
  const workspace = workspaceOf(runDir, 0)
  makeWorkspace(workspace)
  mkdirSync(`${workspace}.global`, { recursive: true })
  let sessionId: string | null = null
  let costUsd = 0
  for (const [i, prompt] of TURNS.entries()) {
    const argv = cliArgs(prompt, { globalDir: `${workspace}.global`, maxTurns: 20, budgetUsd: 3, resume: sessionId ?? undefined })
    // Auto-memory off, so the main agent never saves what the arms must extract.
    const res = await spawnCollect(args.bin, argv, workspace, join(runDir, `record.t${i + 1}`), args.timeoutMs, {
      CLAUDIN_DISABLE_AUTO_MEMORY: '1',
      CLAUDIN_EXTRACT_MEMORIES: '0',
    })
    const result = parseJsonl(res.stdout).findLast(e => e.type === 'result')
    if (res.code !== 0 || typeof result?.session_id !== 'string') {
      throw new Error(`recording turn ${i + 1} failed (exit ${res.code}${res.timedOut ? ', timed out' : ''}): ${res.stderr.slice(0, 400)}`)
    }
    sessionId = result.session_id
    costUsd += typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0
    console.log(`  record t${i + 1}: $${(typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0).toFixed(3)}`)
  }
  const roots = rootsOf(workspace)
  const touched = changedMemory(roots).map(([rel]) => rel)
  if (touched.length) throw new Error(`the recording wrote memory (${touched.join(', ')}): the arms would skip — run it again`)
  const live = transcriptOf(workspace, sessionId!)
  if (!existsSync(live)) throw new Error(`no transcript at ${live}`)
  const transcript = join(runDir, 'recording.jsonl')
  cpSync(live, transcript)
  const rec: Recording = { workspace, sessionId: sessionId!, transcript, recordedOn: new Date().toISOString(), costUsd }
  writeFileSync(join(runDir, 'recording.json'), JSON.stringify(rec, null, 1))
  return rec
}

function loadRecording(dir: string): Recording {
  const rec = JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf8')) as Recording
  if (!existsSync(rec.workspace) || !existsSync(rec.transcript)) throw new Error(`the recording in ${dir} lost its workspace or transcript`)
  return rec
}

type Run = {
  arm: string
  rep: number
  workspace: string
  exitCode: number
  timedOut: boolean
  wallS: number
  /** Tools the closing turn's main agent called: it was asked to call none. */
  mainTools: string[]
  mechanism: Mechanism
  wire: Wire
  grade: Grade
}

async function runArm(args: Args, runDir: string, rec: Recording, proxy: WireProxy, arm: string, rep: number, n: number): Promise<Run> {
  const label = `${arm}-r${rep}`
  const workspace = workspaceOf(runDir, n)
  cpSync(rec.workspace, workspace, { recursive: true })
  mkdirSync(`${workspace}.global`, { recursive: true })
  // The same conversation, as if it had happened in this workspace.
  const dest = transcriptOf(workspace, rec.sessionId)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(rec.transcript, 'utf8').replaceAll(rec.workspace, workspace))
  const debugFile = join(runDir, `${label}.debug.txt`)
  const argv = cliArgs(CLOSING, {
    globalDir: `${workspace}.global`,
    maxTurns: 3,
    budgetUsd: 5,
    resume: rec.sessionId,
    extra: ['--fork-session', '--debug-file', debugFile],
  })
  const res = await spawnCollect(args.bin, argv, workspace, join(runDir, label), args.timeoutMs, {
    ...proxyEnv(proxy.url(label)),
    CLAUDIN_EXTRACT_MEMORIES_HEADLESS: '1',
    CLAUDIN_EXTRACT_MEMORIES_EVERY: '1',
    ...args.env[arm],
  })
  const toolUses = new Map<string, string>()
  for (const e of parseJsonl(res.stdout)) {
    if (e.type !== 'assistant' || !isRecord(e.message)) continue
    for (const b of blocksOf(e.message.content)) if (b.type === 'tool_use') toolUses.set(String(b.id), String(b.name))
  }
  const run: Run = {
    arm,
    rep,
    workspace,
    exitCode: res.code,
    timedOut: res.timedOut,
    wallS: res.wallMs / 1000,
    mainTools: [...toolUses.values()],
    mechanism: mechanismOf(existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : ''),
    wire: wireOf(proxy, label),
    grade: gradeRun(rootsOf(workspace), new Date(rec.recordedOn)),
  }
  const x = run.wire.extraction
  const failed = Object.entries(run.grade.facts).filter(([, g]) => !g.pass).map(([id, g]) => `${id}: ${g.problems.join('; ')}`)
  console.log(
    `[${label}] ${run.mechanism.finished ? 'extracted' : run.mechanism.skipped ? 'SKIPPED' : 'NO EXTRACTION'} ${run.grade.score}/${FACTS.length} facts` +
      ` — $${x.costUsd.toFixed(4)} in ${x.requests} requests (${x.models.join('/') || '-'} @ ${x.efforts.join('/') || '-'})` +
      (leaked(run.grade).length ? `, LEAK ${leaked(run.grade).join(', ')}` : '') +
      (run.grade.extras.length ? `, extras ${run.grade.extras.join(', ')}` : '') +
      (failed.length ? `\n    ${failed.join('\n    ')}` : ''),
  )
  return run
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function report(runs: Run[], arms: string[], env: Args['env']): string {
  const of = (arm: string) => runs.filter(r => r.arm === arm)
  const col = (pick: (rs: Run[]) => string) => arms.map(arm => pick(of(arm)))
  const rows: string[][] = []
  for (const fact of FACTS) {
    rows.push([fact.id, ...col(rs => `${rs.filter(r => r.grade.facts[fact.id]!.pass).length}/${rs.length}`)])
    if (fact.detail) rows.push([`  ${fact.detail.name}`, ...col(rs => `${rs.filter(r => r.grade.facts[fact.id]!.detail).length}/${rs.length}`)])
  }
  const costs = (rs: Run[]) => rs.map(r => r.wire.extraction.costUsd)
  const perRequest = (rs: Run[]) => rs.map(r => {
    const x = r.wire.extraction
    return x.requests ? (x.input + x.write + x.read) / x.requests : 0
  })
  rows.push(
    ['facts passed', ...col(rs => `${rs.reduce((n, r) => n + r.grade.score, 0)}/${rs.length * FACTS.length}`)],
    ['score, median [range]', ...col(rs => `${median(rs.map(r => r.grade.score))} [${range(rs.map(r => r.grade.score), 0)}]`)],
    ...Object.keys(LEAKS).map(kind => [`${kind} saved`, ...col(rs => `${rs.filter(r => r.grade.leaks[kind]!.length).length}/${rs.length}`)]),
    ['extra memories, mean', ...col(rs => mean(rs.map(r => r.grade.extras.length)).toFixed(1))],
    ['extracted', ...col(rs => `${rs.filter(r => r.mechanism.finished && !r.mechanism.skipped).length}/${rs.length}`)],
    ['extraction $, median [range]', ...col(rs => `$${median(costs(rs)).toFixed(4)} [${range(costs(rs), 4)}]`)],
    ['requests, mean', ...col(rs => mean(rs.map(r => r.wire.extraction.requests)).toFixed(1))],
    ['prompt tokens/request, mean', ...col(rs => `${(mean(perRequest(rs)) / 1000).toFixed(1)}k`)],
    ['  of it read from cache', ...col(rs => {
      const all = rs.reduce((n, r) => n + r.wire.extraction.input + r.wire.extraction.write + r.wire.extraction.read, 0)
      return all ? `${((rs.reduce((n, r) => n + r.wire.extraction.read, 0) / all) * 100).toFixed(0)}%` : '-'
    })],
    ['output tokens, mean', ...col(rs => mean(rs.map(r => r.wire.extraction.output)).toFixed(0))],
    ['  thinking, mean', ...col(rs => mean(rs.map(r => r.wire.extraction.thinking)).toFixed(0))],
    ['request time, mean', ...col(rs => `${(mean(rs.map(r => r.wire.extraction.ms)) / 1000).toFixed(1)}s`)],
    ['model', ...col(rs => [...new Set(rs.flatMap(r => r.wire.extraction.models))].join(' ') || '-')],
    ['effort', ...col(rs => [...new Set(rs.flatMap(r => r.wire.extraction.efforts))].join(' ') || '-')],
    ['closing turn $, mean (not the extraction)', ...col(rs => `$${mean(rs.map(r => r.wire.closingCostUsd)).toFixed(3)}`)],
  )

  const references = ['base', 'placebo'].filter(arm => arms.includes(arm))
  const verdicts: string[] = []
  for (const arm of arms.filter(a => !references.includes(a))) {
    const mine = of(arm)
    const want = expectedWire(env[arm] ?? {})
    const mechanism =
      mine.length > 0 &&
      mine.every(
        r =>
          r.mechanism.finished &&
          !r.mechanism.skipped &&
          r.wire.extraction.requests > 0 &&
          r.wire.extraction.errors === 0 &&
          r.wire.extraction.models.every(m => m.includes(want.model)) &&
          r.wire.extraction.efforts.every(e => e === want.effort),
      )
    const passes = (rs: Run[]) => rs.reduce((n, r) => n + r.grade.score, 0)
    const leaky = (rs: Run[]) => rs.filter(r => leaked(r.grade).length).length
    const quality =
      references.length > 0 &&
      passes(mine) >= Math.min(...references.map(ref => passes(of(ref)))) &&
      leaky(mine) <= Math.max(...references.map(ref => leaky(of(ref))))
    const cost =
      references.length > 0 &&
      references.every(ref => median(costs(mine)) < median(costs(of(ref))) && !rangesOverlap(costs(mine), costs(of(ref))))
    const saving = references.includes('base') ? ` (${(((median(costs(mine)) - median(costs(of('base')))) / median(costs(of('base')))) * 100).toFixed(0)}% vs base)` : ''
    verdicts.push(
      `- ${arm}: mechanism ${mechanism ? 'PASS' : 'FAIL'} · quality ${quality ? 'PASS' : 'FAIL'} (${passes(mine)} facts, ${leaky(mine)} runs leaking) · cost ${cost ? 'PASS' : 'FAIL'}${saving}`,
    )
  }
  const notes = runs
    .filter(r => r.exitCode !== 0 || r.timedOut || r.mainTools.length || r.mechanism.error || (r.mechanism.started && !r.mechanism.finished))
    .map(r => `- ${r.arm} r${r.rep}: exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}${r.mainTools.length ? `, main called ${r.mainTools.join(', ')}` : ''}${r.mechanism.error ? `, extraction error: ${r.mechanism.error}` : ''}${r.mechanism.started && !r.mechanism.finished ? ', extraction started and never finished (cut at exit?)' : ''}`)
  return [
    table(['', ...arms], rows),
    '',
    ...(verdicts.length ? ['Gates (pre-registered, see the header):', ...verdicts, ''] : []),
    ...(notes.length ? ['Runs to look at:', ...notes] : []),
  ].join('\n')
}

function review(runs: Run[]): string {
  const out: string[] = ['# What each run saved', '']
  for (const r of [...runs].sort((a, b) => a.arm.localeCompare(b.arm) || a.rep - b.rep)) {
    out.push(`## ${r.arm} r${r.rep} — ${r.grade.score}/${FACTS.length} (${r.workspace})`, '')
    for (const [rel, text] of changedMemory(rootsOf(r.workspace))) out.push(`### ${rel}`, '', '```markdown', text.trimEnd(), '```', '')
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Dry run — the plan, and the grader on hand-written memory trees
// ---------------------------------------------------------------------------

const RECORDED_ON = new Date(2026, 9, 10, 12)

/** A memory tree that saves every fact the way it should be saved (recorded on RECORDED_ON). */
const GOOD: Record<string, string> = {
  ...SEED_MEMORY,
  [`${GLOBAL}go-backend-dev.md`]: fm(
    ['name: go-backend-dev', 'description: backend developer, ten years of Go, new to TypeScript', 'type: user'],
    'Backend developer with ~10 years of Go; first TypeScript project — explain TS idioms through Go analogies.',
  ),
  [`${GLOBAL}MEMORY.md`]: '- [Go backend dev](go-backend-dev.md) — new to TypeScript\n',
  'team/named-exports-only.md': fm(
    ['name: named-exports-only', 'description: never default exports in this project', 'type: feedback'],
    'Always named exports, never `export default`.\n\n**Why:** the bundler lost tree-shaking with default exports and the production bundle doubled.\n**How to apply:** every new module.',
  ),
  'team/docs/ci-logs-grafana.md': fm(
    ['name: ci-logs-grafana', 'description: where CI logs live', 'type: reference'],
    'CI logs: https://grafana.internal.example/d/ci-pipeline (ci-builds was retired) — check there first when CI breaks.',
  ),
  [SEED_DEPLOY]: fm(
    ['name: staging-deploy', 'description: how staging gets deployed', 'type: project'],
    'Staging deploys run from a Gitea webhook (moved off GitHub Actions in 2026-09).',
  ),
  'team/MEMORY.md': [
    '- [Staging deploy](staging-deploy.md) — Gitea webhook',
    '- [Named exports only](named-exports-only.md) — never default exports',
    '- [CI logs](docs/ci-logs-grafana.md) — Grafana dashboard',
    '',
  ].join('\n'),
  'billing-freeze.md': fm(
    ['name: billing-freeze', 'description: src/billing is frozen for the quarter close', 'type: project'],
    'No changes to src/billing/ until 2026-10-16: finance is closing the quarter.',
  ),
  'MEMORY.md': '- [Billing freeze](billing-freeze.md) — until 2026-10-16\n',
}

/** Trees that must fail, each on what it names. null deletes a GOOD file. */
const BAD: ReadonlyArray<{ name: string; files: Record<string, string | null>; check: (g: Grade) => boolean }> = [
  {
    name: 'deploy saved beside the existing memory instead of into it',
    files: {
      [SEED_DEPLOY]: SEED_MEMORY[SEED_DEPLOY]!,
      'team/staging-gitea.md': fm(['name: staging-gitea', 'description: staging deploy', 'type: project'], 'Staging deploys via a Gitea webhook.'),
      'team/MEMORY.md': `${GOOD['team/MEMORY.md']}- [Gitea](staging-gitea.md) — x\n`,
    },
    check: g => !g.facts.deploy!.where,
  },
  {
    name: 'role kept private',
    files: {
      [`${GLOBAL}go-backend-dev.md`]: null,
      [`${GLOBAL}MEMORY.md`]: null,
      'go-backend-dev.md': GOOD[`${GLOBAL}go-backend-dev.md`]!,
      'MEMORY.md': `${GOOD['MEMORY.md']}- [Go](go-backend-dev.md) — x\n`,
    },
    check: g => !g.facts.role!.where,
  },
  {
    name: 'exports saved as a project memory',
    files: { 'team/named-exports-only.md': fm(['name: named-exports-only', 'description: no default exports', 'type: project'], 'Named exports only.') },
    check: g => !g.facts.exports!.frontmatter && g.facts.exports!.detail === false,
  },
  {
    name: 'exports saved twice',
    files: {
      'named-exports.md': fm(['name: named-exports', 'description: no default exports', 'type: feedback'], 'Named exports only.'),
      'MEMORY.md': `${GOOD['MEMORY.md']}- [Named](named-exports.md) — x\n`,
    },
    check: g => !g.facts.exports!.single,
  },
  { name: 'grafana not indexed', files: { 'team/MEMORY.md': GOOD['team/MEMORY.md']!.replace(/.*ci-logs-grafana.*\n/, '') }, check: g => !g.facts.grafana!.index },
  {
    name: 'grafana kept on the retired dashboard',
    files: { 'team/docs/ci-logs-grafana.md': fm(['name: ci-logs-grafana', 'description: where CI logs live', 'type: reference'], 'CI logs: https://grafana.internal.example/d/ci-builds') },
    check: g => g.facts.grafana!.file === null,
  },
  {
    name: 'freeze with a relative date',
    files: { 'billing-freeze.md': fm(['name: billing-freeze', 'description: src/billing frozen', 'type: project'], 'No changes to src/billing/ until next Friday.') },
    check: g => g.facts.freeze!.pass && g.facts.freeze!.detail === false,
  },
  {
    name: 'the meeting saved',
    files: {
      'meeting.md': fm(['name: meeting', 'description: meeting at 15h', 'type: project'], 'User has a meeting at 15h today.'),
      'MEMORY.md': `${GOOD['MEMORY.md']}- [Meeting](meeting.md) — reunião às 15h\n`,
    },
    check: g => g.leaks.meeting!.length === 2 && !g.leaks.token!.length,
  },
  {
    name: 'the token saved',
    files: {
      'staging-webhook.md': fm(['name: staging-webhook', 'description: staging webhook credentials', 'type: reference'], 'Webhook token: stg_9f3b2c7d1e4a8f60d2c1'),
      'MEMORY.md': `${GOOD['MEMORY.md']}- [Webhook](staging-webhook.md) — its token\n`,
    },
    check: g => g.leaks.token!.length === 1 && g.extras.includes('staging-webhook.md'),
  },
  {
    name: 'an extra memory',
    files: {
      'slugify.md': fm(['name: slugify', 'description: slugify lives in src/slug.ts', 'type: project'], 'slugify lowercases and hyphenates.'),
      'MEMORY.md': `${GOOD['MEMORY.md']}- [slugify](slugify.md) — x\n`,
    },
    check: g => g.extras.length === 1 && g.extras[0] === 'slugify.md',
  },
]

function writeTree(roots: MemoryRoots, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = absOf(roots, rel)
    if (content === null) {
      rmSync(abs, { force: true })
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** The grader's self-test: a fresh workspace, GOOD and every BAD tree, graded. */
export function selfTest(dir: string): Array<[string, boolean, string]> {
  const gates: Array<[string, boolean, string]> = []
  const ws = join(dir, 'workspace')
  makeWorkspace(ws)
  const fresh = gradeRun({ root: join(ws, MEMORY_REL), globalRoot: join(dir, 'workspace.global') }, RECORDED_ON)
  const log = git(ws, 'log', '--format=%s').out.trim()
  gates.push(['a fresh workspace: one commit, the seed only, every fact failing', log === 'chore: import texto-kit 0.3.0' && fresh.score === 0 && !fresh.extras.length && !leaked(fresh).length, `${log}; score ${fresh.score}`])
  const tree = (name: string, files: Record<string, string | null>) => {
    const roots = { root: join(dir, name, 'memory'), globalRoot: join(dir, name, 'global') }
    writeTree(roots, { ...GOOD, ...files })
    return gradeRun(roots, RECORDED_ON)
  }
  const good = tree('good', {})
  const problems = Object.entries(good.facts).flatMap(([id, g]) => g.problems.map(p => `${id}: ${p}`))
  gates.push(['the good tree passes every fact, with every detail, no leak, no extra', good.score === FACTS.length && Object.values(good.facts).every(g => g.detail !== false) && !leaked(good).length && !good.extras.length, problems.join('; ') || `score ${good.score}`])
  for (const [i, bad] of BAD.entries()) {
    const g = tree(`bad-${i}`, bad.files)
    gates.push([`bad: ${bad.name}`, bad.check(g), `score ${g.score}; leaks ${leaked(g).join(', ') || '-'}; extras ${g.extras.join(', ') || '-'}`])
  }
  return gates
}

function dryRun(args: Args): void {
  console.log('extract-memories-ab — dry run: nothing is sent to a model\n')
  console.log(`binary: ${args.bin}${existsSync(join(REPO_ROOT, 'dist', 'cli.mjs')) ? '' : '  (dist/cli.mjs is missing — run `bun run build`)'}`)
  console.log(`main loop: ${MODEL} at ${EFFORT}; recording: ${args.recording ?? `${TURNS.length} turns, ~$1–2`}`)
  for (const arm of args.arms) {
    const env = Object.entries(args.env[arm] ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')
    const want = expectedWire(args.env[arm] ?? {})
    console.log(`  ${arm.padEnd(10)} ${env || '(no variable)'} → extraction on *${want.model}* at ${want.effort}`)
  }
  const runs = args.arms.length * args.reps
  console.log(`${runs} closing turns, about $${(runs * 0.4).toFixed(2)}–$${(runs * 0.8).toFixed(2)} with the recording\n`)
  for (const [i, t] of TURNS.entries()) console.log(`  t${i + 1}: ${t}`)
  console.log(`  closing: ${CLOSING}\n`)
  const dir = join(BENCH_ROOT, `dry-run-${stamp()}`)
  const gates = selfTest(dir)
  console.log(`grader self-test in ${dir}\n`)
  console.log(table(['gate', 'ok', 'detail'], gates.map(([g, ok, d]) => [g, ok ? 'yes' : 'NO', d])))
  if (gates.some(([, ok]) => !ok)) process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const a: Args = {
    reps: 5,
    only: null,
    recording: null,
    timeoutMs: 10 * 60_000,
    dryRun: false,
    bin: join(REPO_ROOT, 'bin', 'claudin'),
    env: { ...DEFAULT_ARMS },
    arms: Object.keys(DEFAULT_ARMS),
  }
  for (const x of argv) {
    const [k, v = ''] = x.split(/=(.*)/s, 2) as [string, string?]
    if (k === '--dry-run') a.dryRun = true
    else if (k === '--reps') a.reps = Number(v)
    else if (k === '--only') a.only = v.split(',').filter(Boolean)
    else if (k === '--recording') a.recording = v
    else if (k === '--timeout-min') a.timeoutMs = Number(v) * 60_000
    else if (k === '--bin') a.bin = v
    else if (k === '--variant') {
      const colon = v.indexOf(':')
      const label = colon < 0 ? v : v.slice(0, colon)
      const pairs = colon < 0 ? [] : v.slice(colon + 1).split(',').filter(Boolean)
      a.env[label] = Object.fromEntries(pairs.map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
      if (!a.arms.includes(label)) a.arms.push(label)
    } else {
      console.error(`unknown argument ${x}`)
      process.exit(2)
    }
  }
  if (a.only) {
    const unknown = a.only.filter(arm => !(arm in a.env))
    if (unknown.length) {
      console.error(`unknown arm ${unknown.join(', ')} — declare it with --variant=<label>:<ENV>=<value>`)
      process.exit(2)
    }
    a.arms = a.only
  }
  return a
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    dryRun(args)
    return
  }
  if (!existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))) {
    console.error('dist/cli.mjs is missing — run `bun run build` first: bin/claudin runs the bundle, not the source.')
    process.exit(1)
  }
  const runDir = join(BENCH_ROOT, stamp())
  mkdirSync(runDir, { recursive: true })
  const head = git(REPO_ROOT, 'rev-parse', '--short', 'HEAD').out.trim()
  const meta = { started: new Date().toISOString(), runDir, model: MODEL, effort: EFFORT, reps: args.reps, arms: args.arms, armEnv: args.env, version: `${version(args.bin)} @ ${head}` }
  console.log(`extract-memories-ab → ${runDir}\n  ${meta.version}`)
  const rec = args.recording ? loadRecording(args.recording) : await record(args, runDir)
  console.log(`recording: session ${rec.sessionId} in ${rec.workspace} ($${rec.costUsd.toFixed(2)})`)
  const proxy = await startWireProxy(join(runDir, 'proxy'))
  const runs: Run[] = []
  const save = () => writeFileSync(join(runDir, 'results.json'), JSON.stringify({ meta, recording: rec, runs }, null, 1))
  try {
    for (let rep = 1; rep <= args.reps; rep++) {
      const first = (rep - 1) * args.arms.length + 1
      runs.push(...(await Promise.all(args.arms.map((arm, i) => runArm(args, runDir, rec, proxy, arm, rep, first + i)))))
      save()
    }
  } finally {
    await proxy.close()
  }
  const text = report(runs, args.arms, args.env)
  writeFileSync(join(runDir, 'report.md'), text)
  writeFileSync(join(runDir, 'review.md'), review(runs))
  console.log(`\n${text}\n\nresults → ${join(runDir, 'results.json')}\nreport  → ${join(runDir, 'report.md')}\nreview  → ${join(runDir, 'review.md')} (every run's memories, side by side)`)
}

if (import.meta.main) await main()
