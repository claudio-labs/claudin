#!/usr/bin/env bun
/**
 * Model-launch capture: what a CLI really sends for a model, and what the real
 * API does with its thinking, before a new model is registered.
 *
 * Each model gets a three-prompt session in a throwaway git repo (`-p`, then
 * `-c -p` twice, so earlier turns are genuinely past) through wire-proxy.ts,
 * in front of the real API. Then the last main-thread request is replayed four
 * ways, with the CLI's own headers:
 *   control         unchanged, with `display: "summarized"` so the thinking is readable
 *   binding-only    `thinking.block_binding: drop_block` — is the field accepted?
 *   strip           thinking removed from the oldest assistant turn that had
 *                   it, which is what stripOldThinkingBlocks does to a prefix
 *   strip+binding   the same, with the block_binding escape hatch
 * On a model that enforces preserved thinking, `strip` is a 400 for accounts
 * created on or after 2026-08-31. An older account gets 200 on all four, so a
 * green `strip` says nothing about enforcement — read `replays` with that in mind.
 *
 * `--fixtures=<dir>` writes one JSON per Claude Code model under
 * `<dir>/<claude version>/`: the request shape, the replay outcomes and the
 * model's entry in Claude Code's baked catalog (grepped from the binary). That
 * is what src/providers/model/claudeCodeParity.test.ts asserts Claudin against.
 * Effort comes from the catalog, never from the wire: the wire carries the
 * user's own ~/.claude settings (a `modelSettings` effort pin shows up as-is).
 *
 * Prompts: trivial ones by default. `--hard` asks for real reasoning. At
 * Claude Code's default effort, Sonnet 5.5 thought zero tokens on every trivial
 * turn, so a thinking replay needs `--hard` (and `--effort=high`) to exercise
 * anything.
 *
 * The children are spawned asynchronously on purpose: spawnSync blocks the
 * event loop that hosts the proxy, and the CLI then waits forever for a first
 * byte (the same trap #237 found in wire-diff.ts).
 *
 * Usage:
 *   bun scripts/bench/ab/model-launch-capture.ts --models=claude-sonnet-5-5,claude-opus-5-5
 *   bun scripts/bench/ab/model-launch-capture.ts --hard --effort=high \
 *     --fixtures=src/providers/model/__fixtures__/claude-code-wire
 *   bun scripts/bench/ab/model-launch-capture.ts --bins=claudindev --hard --effort=high
 *   --out=<dir>  (default: a new dir under the OS temp dir)
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { REPO_ROOT } from '../../repoRoot.ts'
import { proxyEnv, readProxyRecords, requestKind, startWireProxy, type ProxyRecord } from './wire-proxy.ts'

type Json = Record<string, unknown>

const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/
const VERSION_RE = /^(\d+\.\d+\.\d+)/
const CATALOG_FIELD_RES = {
  display_name: /display_name:"([^"]+)"/,
  knowledge_cutoff: /knowledge_cutoff:"([^"]+)"/,
  default_effort: /default_effort:"([^"]+)"/,
  fallback_3p: /fallback_3p:"([^"]+)"/,
  pricing: /pricing:"([^"]+)"/,
} as const
const CATALOG_ENTRY_SPAN = 2000
const TURN_TIMEOUT_MS = 240_000
const BINS: Record<string, string> = { claude: 'claude', claudindev: join(REPO_ROOT, 'bin', 'claudin') }

const TRIVIAL_PROMPTS = [
  'Read notes.txt and tell me, in one sentence, which of the numbers in it are prime.',
  'Which of those numbers is the largest? One sentence, no tools.',
  'Read notes.txt again and give me the sum of all its numbers. One sentence.',
]
const HARD_PROMPTS = [
  'Read notes.txt. Find every subset of its numbers that sums to exactly 60, and say how many there are. Be brief in the answer.',
  'Without tools: if each number n in that file is replaced by n mod 7, which subsets now sum to a multiple of 7? Brief answer.',
  'Read notes.txt again. Is there an ordering of its numbers where every adjacent pair has a gcd greater than 1? Brief answer.',
]
const NOTES = 'numbers: 14, 17, 22, 29, 35\n'
const BLOCK_BINDING = { prefix_mismatch_behavior: 'drop_block' }

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const blocksOf = (m: Json): Json[] => (Array.isArray(m.content) ? m.content.filter(isRecord) : [])
const isThinking = (b: Json): boolean => b.type === 'thinking' || b.type === 'redacted_thinking'

export type CatalogEntry = { [K in keyof typeof CATALOG_FIELD_RES]: string | null }

/** A model's entry in Claude Code's baked model catalog, read out of the bundle text. */
export function parseCatalogEntry(bundle: string, model: string): CatalogEntry | null {
  const at = bundle.indexOf(`{id:"${model}",family:`)
  if (at < 0) return null
  // The entry ends where the next one starts; cut there so a missing field is
  // not read from the neighbour.
  const span = bundle.slice(at + 1, at + CATALOG_ENTRY_SPAN)
  const next = span.indexOf('{id:"claude-')
  const entry = next < 0 ? span : span.slice(0, next)
  const out = {} as CatalogEntry
  for (const [key, re] of Object.entries(CATALOG_FIELD_RES) as [keyof CatalogEntry, RegExp][]) {
    out[key] = re.exec(entry)?.[1] ?? null
  }
  return out
}

/** The body with thinking removed from the oldest assistant turn that carries any. */
export function stripOldestThinking(body: Json): { body: Json; strippedMessage: number } {
  const messages = structuredClone(Array.isArray(body.messages) ? body.messages : []) as Json[]
  const index = messages.findIndex(m => m.role === 'assistant' && blocksOf(m).some(isThinking))
  if (index >= 0) messages[index] = { ...messages[index], content: blocksOf(messages[index]!).filter(b => !isThinking(b)) }
  return { body: { ...body, messages }, strippedMessage: index }
}

export function withThinking(body: Json, extra: Json): Json {
  return { ...body, thinking: { ...(isRecord(body.thinking) ? body.thinking : {}), ...extra } }
}

export type RequestFacts = {
  n: number
  status: number
  model: unknown
  max_tokens: unknown
  thinking: unknown
  effort: unknown
  context_management: unknown
  betas: string[]
  replayedThinking: number
  replayedWithSignature: number
  responseBlocks: string[]
  thinkingTokens: number | null
}

export function requestFacts(record: ProxyRecord, body: Json): RequestFacts {
  const replayed = (Array.isArray(body.messages) ? body.messages.filter(isRecord) : [])
    .filter(m => m.role === 'assistant')
    .flatMap(blocksOf)
    .filter(isThinking)
  return {
    n: record.n,
    status: record.status,
    model: body.model,
    max_tokens: body.max_tokens,
    thinking: body.thinking ?? null,
    effort: isRecord(body.output_config) ? (body.output_config.effort ?? null) : null,
    context_management: body.context_management ?? null,
    betas: (record.headers['anthropic-beta'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
    replayedThinking: replayed.length,
    replayedWithSignature: replayed.filter(b => typeof b.signature === 'string' && b.signature.length > 0).length,
    responseBlocks: record.response?.blocks ?? [],
    thinkingTokens: record.response?.thinkingTokens ?? null,
  }
}

export type ReplayOutcome = { status: number | null; error?: string; thinkingTokens?: number | null; cacheRead?: unknown; cacheWrite?: unknown }

export type ModelFixture = {
  source: string
  capturedAt: string
  model: string
  catalog: CatalogEntry | null
  request: { max_tokens: unknown; thinking: { type: unknown; display: unknown }; context_management: unknown; betas: string[] }
  thinkingReplay: { replayedThinking: number; replayedWithSignature: number; strippedMessage: number; replays: Record<string, number | null> }
}

/**
 * The committed, per-model facts. The request shape is the LAST main request
 * (it carries the longest replayed history); nothing from the prompt, the
 * system prompt or the headers beyond the beta list is kept.
 */
export function buildFixture(args: {
  version: string
  capturedAt: string
  model: string
  catalog: CatalogEntry | null
  mains: RequestFacts[]
  strippedMessage: number
  replays: Record<string, ReplayOutcome>
}): ModelFixture {
  const last = args.mains.at(-1)
  if (!last) throw new Error(`no main-thread request captured for ${args.model}`)
  const thinking = isRecord(last.thinking) ? last.thinking : {}
  return {
    source: `claude-code ${args.version} via scripts/bench/ab/model-launch-capture.ts`,
    capturedAt: args.capturedAt,
    model: args.model,
    catalog: args.catalog,
    request: {
      max_tokens: last.max_tokens,
      thinking: { type: thinking.type ?? null, display: thinking.display ?? null },
      context_management: last.context_management,
      betas: last.betas,
    },
    thinkingReplay: {
      replayedThinking: last.replayedThinking,
      replayedWithSignature: last.replayedWithSignature,
      strippedMessage: args.strippedMessage,
      replays: Object.fromEntries(Object.entries(args.replays).map(([k, v]) => [k, v.status])),
    },
  }
}

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  return {
    models: (get('models') ?? 'claude-sonnet-5-5,claude-opus-5-5').split(',').filter(Boolean),
    bins: (get('bins') ?? 'claude').split(',').filter(Boolean),
    effort: get('effort'),
    hard: argv.includes('--hard'),
    fixtures: get('fixtures'),
    out: get('out') ?? mkdtempSync(join(tmpdir(), 'model-launch-capture-')),
  }
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_ENV_RE.test(k)) env[k] = v
  return { ...env, ...extra }
}

function run(bin: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string }> {
  return new Promise(done => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c))
    const timer = setTimeout(() => child.kill('SIGTERM'), TURN_TIMEOUT_MS)
    child.on('close', status => {
      clearTimeout(timer)
      done({ status, stdout })
    })
  })
}

function resultText(stdout: string): string {
  for (const line of stdout.split('\n').reverse()) {
    try {
      const event = JSON.parse(line) as Json
      if (event.type === 'result') return String(event.result ?? '')
    } catch {
      // stream-json interleaves nothing but JSON; a torn last line is skipped
    }
  }
  return ''
}

function readBody(dir: string, reqFile: string): Json {
  return JSON.parse(gunzipSync(readFileSync(join(dir, reqFile))).toString('utf8')) as Json
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  const prompts = a.hard ? HARD_PROMPTS : TRIVIAL_PROMPTS
  const proxyDir = join(a.out, 'proxy')
  const proxy = await startWireProxy(proxyDir)
  const claudeVersion = VERSION_RE.exec(spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? 'unknown'
  const claudeBundle = a.bins.includes('claude')
    ? readFileSync(realpathSync(spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout.trim()), 'latin1')
    : ''
  const report: Json = {}
  try {
    for (const bin of a.bins) {
      for (const model of a.models) {
        const label = `${bin}.${model}`
        const cwd = mkdtempSync(join(tmpdir(), `mlc-${label}-`))
        writeFileSync(join(cwd, 'notes.txt'), NOTES)
        spawnSync('git', ['init', '-q'], { cwd })
        const env = childEnv(proxyEnv(proxy.url(label)))
        const turns: Json[] = []
        for (const [i, prompt] of prompts.entries()) {
          const args = [
            ...(i > 0 ? ['-c'] : []),
            '-p', prompt,
            '--model', model,
            ...(a.effort ? ['--effort', a.effort] : []),
            '--output-format', 'stream-json', '--verbose',
            '--allowedTools', 'Read',
            '--max-turns', '4',
          ]
          const r = await run(BINS[bin] ?? bin, args, cwd, env)
          const answer = resultText(r.stdout)
          turns.push({ prompt, exit: r.status, answer })
          console.error(`[${label}] turn ${i + 1}: exit ${r.status} → ${answer.replace(/\s+/g, ' ').slice(0, 140)}`)
        }

        const dir = join(proxyDir, label)
        const withBodies = readProxyRecords(proxyDir, label)
          .filter(r => r.reqFile)
          .map(r => ({ record: r, body: readBody(dir, r.reqFile!) }))
        const mains = withBodies.filter(x => requestKind(x.body) === 'main')
        const facts = mains.map(x => requestFacts(x.record, x.body))
        const replays: Record<string, ReplayOutcome> = {}
        let strippedMessage = -1
        let thinkingText = ''
        const last = mains.at(-1)
        if (last) {
          const stripped = stripOldestThinking(last.body)
          strippedMessage = stripped.strippedMessage
          const variants: Record<string, Json> = {
            control: withThinking(last.body, { display: 'summarized' }),
            'binding-only': withThinking(last.body, { block_binding: BLOCK_BINDING }),
            strip: stripped.body,
            'strip+binding': withThinking(stripped.body, { block_binding: BLOCK_BINDING }),
          }
          for (const [name, body] of Object.entries(variants)) {
            try {
              const res = await proxy.replay(label, `${label}.replay-${name}`, body)
              const usage = res.record.response?.usage ?? {}
              replays[name] = {
                status: res.status,
                thinkingTokens: res.record.response?.thinkingTokens ?? null,
                cacheRead: usage.cache_read_input_tokens,
                cacheWrite: usage.cache_creation_input_tokens,
              }
              if (name === 'control') thinkingText = res.thinkingText
            } catch (e) {
              replays[name] = { status: null, error: String(e).slice(0, 400) }
            }
            console.error(`[${label}] replay ${name}: ${JSON.stringify(replays[name])}`)
          }
        }
        report[label] = { turns, requests: facts, strippedMessage, replays, thinkingText }

        if (a.fixtures && bin === 'claude') {
          const fixture = buildFixture({
            version: claudeVersion,
            capturedAt: new Date().toISOString().slice(0, 10),
            model,
            catalog: parseCatalogEntry(claudeBundle, model),
            mains: facts,
            strippedMessage,
            replays,
          })
          const target = join(a.fixtures, claudeVersion)
          mkdirSync(target, { recursive: true })
          writeFileSync(join(target, `${model}.json`), `${JSON.stringify(fixture, null, 2)}\n`)
          console.error(`[${label}] fixture → ${join(target, `${model}.json`)}`)
        }
      }
    }
  } finally {
    await proxy.close()
  }
  writeFileSync(join(a.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.error(`report → ${join(a.out, 'report.json')}`)
}

if (import.meta.main) await main()
