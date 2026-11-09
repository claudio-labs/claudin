#!/usr/bin/env bun
/**
 * Per-turn effort on the real API, measured before Claudin sends it. A
 * mid-conversation `{role: "system", content: [], output_config: {effort}}`
 * placed right after a user turn sets that turn's effort without rewriting
 * the cached prefix (platform.claude.com/docs/en/build-with-claude/effort).
 * Two questions, a few dozen small requests on the user's own Claude Code
 * login:
 *
 *   accept   which beta header makes the message legal, on which model: the
 *            documented `mid-conversation-output-config-2026-07-01`, the alias
 *            Claude Code 2.1.321 sends (`per-turn-control-2026-07-01`), and none
 *            (the control: it must be a 400).
 *   layout   after an effort change, does the cache read the whole previous
 *            prefix when the top-level effort stays at the first turn's (A, the
 *            docs' advice) or when it follows the turn (B, what Claude Code
 *            2.1.321 sends)? Efforts medium → low → xhigh → low. The control
 *            (C) changes the top-level effort with no system message and no
 *            beta — today's wire, and the case the docs say restarts the cache.
 *
 * How: `claude -p` runs once through wire-proxy.ts so its headers (the OAuth
 * login) and its system blocks are captured; every probe request is a replay
 * with those headers and the arm's beta list. Each layout run puts a fresh
 * nonce in its system prompt, so no run reads another's cache.
 *
 *   bun scripts/bench/tokens/per-turn-effort-probe.ts [--out=DIR] [--bin=claude]
 *       [--models=claude-opus-5-5,…] [--layout-models=claude-sonnet-5-5,claude-opus-5-5] [--arms=A,B,C]
 *   (`--models=` with nothing skips the acceptance matrix.)
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proxyEnv, readBody, readProxyRecords, startWireProxy, type WireProxy } from '../ab/wire-proxy.ts'

type Json = Record<string, unknown>

export const DOCS_BETA = 'mid-conversation-output-config-2026-07-01'
export const ALIAS_BETA = 'per-turn-control-2026-07-01'
const PER_TURN_BETAS = new Set([DOCS_BETA, ALIAS_BETA])
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_)/
const DEFAULT_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const DEFAULT_LAYOUT_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5']
export const LAYOUT_EFFORTS = ['medium', 'low', 'xhigh', 'low'] as const
const WORDS = ['one', 'two', 'three', 'four']
// ~5k tokens, over every model's minimum cacheable prefix.
const FILLER = Array.from({ length: 700 }, (_, i) => `Reference line ${i}: the probe reads nothing from this text.`).join('\n')

const flag = (name: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)

/** The messages and top-level effort of turn `turn` (0-based) under a layout. */
export function layoutRequest(
  layout: 'A' | 'B' | 'C',
  turn: number,
): { topEffort: string; messages: Json[] } {
  const messages: Json[] = []
  for (let i = 0; i <= turn; i++) {
    const last = i === turn
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Turn ${i + 1}: reply with the single word ${WORDS[i]}.`,
          ...(last && { cache_control: { type: 'ephemeral' } }),
        },
      ],
    })
    if (layout !== 'C' && i > 0 && LAYOUT_EFFORTS[i] !== LAYOUT_EFFORTS[i - 1]) {
      messages.push({ role: 'system', content: [], output_config: { effort: LAYOUT_EFFORTS[i] } })
    }
    if (!last) messages.push({ role: 'assistant', content: [{ type: 'text', text: WORDS[i] }] })
  }
  return { topEffort: layout === 'A' ? LAYOUT_EFFORTS[0] : LAYOUT_EFFORTS[turn]!, messages }
}

function runSeed(bin: string, url: string): Promise<number | null> {
  const cwd = mkdtempSync(join(tmpdir(), 'per-turn-seed-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_ENV_RE.test(k)) env[k] = v
  Object.assign(env, proxyEnv(url))
  // Asynchronous on purpose: spawnSync would block the event loop hosting the proxy.
  return new Promise(done => {
    const child = spawn(bin, ['-p', 'Reply with the single word ok.', '--model', 'claude-haiku-5-5'], { cwd, env, stdio: 'ignore' })
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
    child.on('close', code => {
      clearTimeout(timer)
      done(code)
    })
  })
}

type Outcome = { status: number; error?: string; usage?: Json | null }

async function send(proxy: WireProxy, label: string, body: Json, betas: string[]): Promise<Outcome> {
  try {
    const { status, record } = await proxy.replay('seed', label, body, { betas })
    return { status, usage: record.response?.usage ?? null }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const status = Number(/replay got (\d+)/.exec(message)?.[1] ?? 0)
    return { status, error: message.replace(/^wire-proxy: replay got \d+: /, '').slice(0, 240) }
  }
}

async function main(): Promise<void> {
  const out = flag('out') ?? mkdtempSync(join(tmpdir(), 'per-turn-effort-probe-'))
  mkdirSync(out, { recursive: true })
  const models = flag('models')?.split(',') ?? DEFAULT_MODELS
  const layoutModels = flag('layout-models')?.split(',') ?? DEFAULT_LAYOUT_MODELS
  const proxyDir = join(out, 'proxy')
  const proxy = await startWireProxy(proxyDir)
  try {
    const code = await runSeed(flag('bin') ?? 'claude', proxy.url('seed'))
    const seedRecord = readProxyRecords(proxyDir, 'seed').find(r => r.reqFile && r.headers['anthropic-beta'])
    if (!seedRecord || !proxy.hasHeaders('seed')) throw new Error(`the seed run (exit ${code}) sent no /v1/messages request`)
    const seedBody = readBody(proxyDir, 'seed', seedRecord.reqFile!)
    const baseBetas = seedRecord.headers['anthropic-beta']!.split(',').filter(b => !PER_TURN_BETAS.has(b))
    const system = seedBody.system as Json[]

    const accept: Json[] = []
    for (const model of flag('models') === '' ? [] : models) {
      for (const [arm, extra] of [['docs', [DOCS_BETA]], ['alias', [ALIAS_BETA]], ['none', []]] as const) {
        const body = {
          model,
          max_tokens: 512,
          system,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          messages: [
            { role: 'user', content: 'Reply with the single word ok.' },
            { role: 'system', content: [], output_config: { effort: 'low' } },
          ],
        }
        const outcome = await send(proxy, `accept.${model}.${arm}`, body, [...baseBetas, ...extra])
        accept.push({ model, arm, ...outcome })
        console.error(`[accept] ${model} ${arm}: ${outcome.status}${outcome.error ? ` ${outcome.error.slice(0, 120)}` : ''}`)
      }
    }

    const layout: Json[] = []
    const arms = (flag('arms')?.split(',') ?? ['A', 'B', 'C']) as Array<'A' | 'B' | 'C'>
    for (const model of layoutModels) {
      for (const arm of arms) {
        const nonce = randomUUID()
        const runSystem = [...system, { type: 'text', text: `Probe ${nonce}.\n${FILLER}`, cache_control: { type: 'ephemeral' } }]
        for (let turn = 0; turn < LAYOUT_EFFORTS.length; turn++) {
          const { topEffort, messages } = layoutRequest(arm, turn)
          const body = { model, max_tokens: 512, system: runSystem, thinking: { type: 'adaptive' }, output_config: { effort: topEffort }, messages }
          const outcome = await send(proxy, `layout.${model}.${arm}`, body, arm === 'C' ? baseBetas : [...baseBetas, DOCS_BETA])
          const usage = outcome.usage ?? {}
          const row = {
            model,
            arm,
            turn: turn + 1,
            effort: LAYOUT_EFFORTS[turn],
            topEffort,
            status: outcome.status,
            error: outcome.error,
            input: usage.input_tokens,
            cacheRead: usage.cache_read_input_tokens,
            cacheWrite: usage.cache_creation_input_tokens,
          }
          layout.push(row)
          console.error(`[layout] ${model} ${arm} turn ${turn + 1} (${LAYOUT_EFFORTS[turn]}, top ${topEffort}): ${outcome.status} read=${row.cacheRead} write=${row.cacheWrite} in=${row.input}${outcome.error ? ` ${outcome.error.slice(0, 120)}` : ''}`)
        }
      }
    }

    writeFileSync(join(out, 'results.json'), JSON.stringify({ baseBetas, accept, layout }, null, 2))
    console.log(`results: ${join(out, 'results.json')}`)
  } finally {
    await proxy.close()
  }
}

if (import.meta.main) await main()
