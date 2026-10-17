#!/usr/bin/env bun
/**
 * What Claudin sends the ChatGPT Codex backend, beside what the official Codex
 * CLI sends for the same three turns on the same account.
 *
 * Both CLIs run a three-prompt session (`exec` then `exec resume --last` twice
 * for Codex; `-p` then `-c -p` twice for Claudin) in throwaway git repos, each
 * arm through its own mitmdump. The Codex CLI talks WebSocket and Claudin HTTP, so the
 * comparison is per `response.create` frame / per POST, not per byte. Then the
 * flow files are decoded offline by codex-wire-dump.py into one redacted JSON
 * per request, each flow file (the only copy of the tokens) is deleted, and the
 * comparison table prints: the body fields each side sends, how many reasoning
 * items each request replays, the ids and phases on the replayed items, and the
 * reasoning tokens each turn spent.
 *
 *   bun scripts/bench/ab/codex-wire-capture.ts [--model=gpt-5.6-terra] [--out=<dir>]
 *     [--claudin=claudindev] [--codex=codex] [--arm=claudin-off]
 *
 * `--arm=claudin-off` runs a third arm, Claudin with
 * CLAUDIN_CODEX_REASONING_REPLAY=0 — the body from before the replay, so the
 * table has a control.
 *
 * Needs: mitmdump with its CA in ~/.mitmproxy, a Codex CLI logged in with a
 * ChatGPT account (~/.codex/auth.json), and a Claudin build. Claudin runs on a
 * throwaway config dir with one Codex profile linked to that same auth.json, so
 * both CLIs bill the same account and nothing in ~/.claudin changes.
 *
 * Recipe and the 2026-10-16 baseline: team memory `codex-0.162-wire-diff`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROMPTS = [
  'Read notes.txt. Find every subset of its numbers that sums to exactly 60, and say how many there are. Be brief in the answer.',
  'Without tools: if each number n in that file is replaced by n mod 7, which subsets now sum to a multiple of 7? Brief answer.',
  'Read notes.txt again. Is there an ordering of its numbers where every adjacent pair has a gcd greater than 1? Brief answer.',
] as const

const NOTES = 'numbers: 14, 17, 22, 29, 35\n'

/** One request as codex-wire-dump.py wrote it. */
export type CapturedRequest = {
  transport: 'http' | 'websocket'
  status?: number
  headers: Record<string, string>
  body: Record<string, unknown>
  items: Array<{ type?: string; id?: string; phase?: string; encrypted_content_len?: number }>
  usage: Array<{ input?: number; cached?: number; output?: number; reasoning?: number }>
}

/** Per arm: what its main-loop requests carry. */
export type ArmSummary = {
  requests: number
  /** Body keys, with how many requests sent each. */
  fields: Record<string, number>
  include: string[]
  reasoning: string[]
  text: string[]
  parallelToolCalls: string[]
  /** Reasoning items replayed in each request's input, in order. */
  replayedReasoning: number[]
  /** Replayed assistant messages that carried their id / their phase. */
  messagesWithId: number
  messagesWithPhase: number
  messagesReplayed: number
  /** Replayed calls under an id the backend gave (anything but a synthetic fc_<call>). */
  callsWithBackendId: number
  callsReplayed: number
  reasoningTokens: number
  cachedTokens: number
  inputTokens: number
}

const distinct = (values: unknown[]): string[] =>
  [...new Set(values.map(value => (value === undefined ? '(absent)' : JSON.stringify(value))))]

/**
 * A request that runs the agent loop. Codex's prewarm frame (`generate: false`)
 * and Claudin's side queries (a forced tool_choice, as the permission classifier
 * sends) are not the turn being compared.
 */
export function isMainLoopRequest(request: CapturedRequest): boolean {
  if (request.body.generate === false) return false
  return typeof request.body.tool_choice !== 'object'
}

function inputOf(request: CapturedRequest): Array<Record<string, unknown>> {
  return Array.isArray(request.body.input) ? (request.body.input as Array<Record<string, unknown>>) : []
}

export function summarizeArm(requests: CapturedRequest[]): ArmSummary {
  const main = requests.filter(isMainLoopRequest)
  const summary: ArmSummary = {
    requests: main.length,
    fields: {},
    include: distinct(main.map(r => r.body.include)),
    reasoning: distinct(main.map(r => r.body.reasoning)),
    text: distinct(main.map(r => r.body.text)),
    parallelToolCalls: distinct(main.map(r => r.body.parallel_tool_calls)),
    replayedReasoning: [],
    messagesWithId: 0,
    messagesWithPhase: 0,
    messagesReplayed: 0,
    callsWithBackendId: 0,
    callsReplayed: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    inputTokens: 0,
  }
  for (const request of main) {
    for (const key of Object.keys(request.body)) summary.fields[key] = (summary.fields[key] ?? 0) + 1
    const input = inputOf(request)
    summary.replayedReasoning.push(input.filter(item => item.type === 'reasoning').length)
    for (const item of input) {
      if (item.type === 'message' && item.role === 'assistant') {
        summary.messagesReplayed++
        if (typeof item.id === 'string') summary.messagesWithId++
        if (typeof item.phase === 'string') summary.messagesWithPhase++
      }
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        summary.callsReplayed++
        const callId = String(item.call_id ?? '')
        const synthetic = `fc_${callId.replace(/^call_/, '')}`
        if (typeof item.id === 'string' && item.id !== synthetic) summary.callsWithBackendId++
      }
    }
    for (const usage of request.usage) {
      summary.reasoningTokens += usage.reasoning ?? 0
      summary.cachedTokens += usage.cached ?? 0
      summary.inputTokens += usage.input ?? 0
    }
  }
  return summary
}

/** The comparison table, one row per question, one column per arm. */
export function formatTable(arms: Record<string, ArmSummary>): string {
  const names = Object.keys(arms)
  const allFields = [...new Set(names.flatMap(name => Object.keys(arms[name]!.fields)))].sort()
  const rows: Array<[string, ...string[]]> = [
    ['main-loop requests', ...names.map(n => String(arms[n]!.requests))],
    ['include', ...names.map(n => arms[n]!.include.join(' | '))],
    ['reasoning', ...names.map(n => arms[n]!.reasoning.join(' | '))],
    ['text', ...names.map(n => arms[n]!.text.join(' | '))],
    ['parallel_tool_calls', ...names.map(n => arms[n]!.parallelToolCalls.join(' | '))],
    ['reasoning items replayed per request', ...names.map(n => arms[n]!.replayedReasoning.join(' '))],
    ['assistant messages with id / phase', ...names.map(n => {
      const a = arms[n]!
      return `${a.messagesWithId}/${a.messagesReplayed} · ${a.messagesWithPhase}/${a.messagesReplayed}`
    })],
    ['calls under the backend id', ...names.map(n => `${arms[n]!.callsWithBackendId}/${arms[n]!.callsReplayed}`)],
    ['reasoning tokens (sum)', ...names.map(n => String(arms[n]!.reasoningTokens))],
    ['cached / input tokens (sum)', ...names.map(n => `${arms[n]!.cachedTokens} / ${arms[n]!.inputTokens}`)],
    ...allFields.map(field => [
      `field: ${field}`,
      ...names.map(n => {
        const count = arms[n]!.fields[field] ?? 0
        return count === 0 ? '—' : `${count}/${arms[n]!.requests}`
      }),
    ] as [string, ...string[]]),
  ]
  const widths = [0, ...names.map(() => 0)].map((_, column) =>
    Math.max(column === 0 ? 0 : names[column - 1]!.length, ...rows.map(row => (row[column] ?? '').length)),
  )
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(['', ...names]), ...rows.map(row => line(row))].join('\n')
}

/** The captured requests under <dir>, by arm label. */
export function readCaptures(dir: string): Record<string, CapturedRequest[]> {
  const byLabel: Record<string, CapturedRequest[]> = {}
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const label = file.replace(/^\d+-/, '').replace(/\.json$/, '')
    ;(byLabel[label] ??= []).push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as CapturedRequest)
  }
  return byLabel
}

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function run(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
  // Async on purpose: spawnSync would block the event loop while the CLI waits
  // on the network, which is harmless here but keeps the timeouts honest.
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } as Record<string, string>, stdio: 'ignore' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000)
    child.on('exit', code => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

function freshRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.txt'), NOTES)
  spawnSync('git', ['init', '-q'], { cwd: dir })
  spawnSync('git', ['add', 'notes.txt'], { cwd: dir })
  spawnSync('git', ['-c', 'user.email=x@x', '-c', 'user.name=x', 'commit', '-qm', 'init'], { cwd: dir })
}

/** Records one arm through its own mitmdump, then decodes it into <out>/cap. */
async function recordArm(
  arm: string,
  out: string,
  proxyEnv: Record<string, string>,
  port: number,
  turns: (env: Record<string, string>) => Promise<void>,
): Promise<void> {
  const flows = join(out, `flows-${arm}.mitm`)
  const proxy = spawn('mitmdump', ['--listen-host', '127.0.0.1', '--listen-port', String(port), '-w', flows, '-q'], { stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  try {
    await turns(proxyEnv)
  } finally {
    proxy.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  spawnSync('mitmdump', ['-nr', flows, '-s', join(import.meta.dir, 'codex-wire-dump.py'), '-q'], {
    env: { ...process.env, CODEX_WIRE_OUT: join(out, 'cap'), CODEX_WIRE_LABEL: arm },
    stdio: 'inherit',
  })
  // The flow file holds the bearer token and the cookies; the JSONs do not.
  rmSync(flows, { force: true })
}

async function main(): Promise<void> {
  const model = argValue('model', 'gpt-5.6-terra')
  const out = argValue('out', join(process.cwd(), `codex-wire-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`))
  const claudinBin = argValue('claudin', 'claudindev')
  const codexBin = argValue('codex', 'codex')
  const withControl = process.argv.includes('--arm=claudin-off')
  const port = 8899

  const mitmCa = join(homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem')
  const authJson = join(homedir(), '.codex', 'auth.json')
  for (const needed of [mitmCa, authJson]) {
    if (!existsSync(needed)) throw new Error(`missing ${needed}`)
  }

  mkdirSync(out, { recursive: true })
  rmSync(join(out, 'cap'), { recursive: true, force: true })
  const bundle = join(out, 'ca-bundle.pem')
  writeFileSync(bundle, readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8') + readFileSync(mitmCa, 'utf8'))
  const proxyEnv = {
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
    HTTP_PROXY: `http://127.0.0.1:${port}`,
    SSL_CERT_FILE: bundle,
    NODE_EXTRA_CA_CERTS: bundle,
    CODEX_CA_CERTIFICATE: bundle,
  }

  await recordArm('codex', out, proxyEnv, port, async env => {
    const repo = join(out, 'repo-codex')
    freshRepo(repo)
    for (const [i, prompt] of PROMPTS.entries()) {
      const args = i === 0
        ? ['exec', '-m', model, '-s', 'read-only', prompt]
        : ['exec', 'resume', '--last', '-m', model, prompt]
      console.log(`codex turn ${i + 1}: exit ${await run(codexBin, args, repo, env)}`)
    }
  })

  const arms: Array<[string, Record<string, string>]> = [['claudin', {}]]
  if (withControl) arms.push(['claudin-off', { CLAUDIN_CODEX_REASONING_REPLAY: '0' }])
  for (const [arm, armEnv] of arms) {
    const cfg = join(out, `cfg-${arm}`)
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'config.json'), JSON.stringify({
      providerProfiles: [{
        id: 'provider_codexwire',
        name: 'Codex wire capture',
        provider: 'openai',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        model,
        extras: { codexAuthPath: authJson },
      }],
      activeProviderProfileId: 'provider_codexwire',
      hasCompletedOnboarding: true,
    }, null, 2))
    await recordArm(arm, out, proxyEnv, port, async env => {
      const repo = join(out, `repo-${arm}`)
      freshRepo(repo)
      for (const [i, prompt] of PROMPTS.entries()) {
        const args = i === 0
          ? ['-p', '--dangerously-skip-permissions', prompt]
          : ['-c', '-p', '--dangerously-skip-permissions', prompt]
        console.log(`${arm} turn ${i + 1}: exit ${await run(claudinBin, args, repo, { ...env, CLAUDIN_CONFIG_DIR: cfg, ...armEnv })}`)
      }
    })
  }

  const byLabel = readCaptures(join(out, 'cap'))
  const summaries: Record<string, ArmSummary> = {}
  for (const arm of ['codex', ...arms.map(([name]) => name)]) summaries[arm] = summarizeArm(byLabel[arm] ?? [])
  const table = formatTable(summaries)
  writeFileSync(join(out, 'table.txt'), `${table}\n`)
  console.log(`\n${table}\n\nredacted captures: ${join(out, 'cap')}`)
}

if (import.meta.main) await main()
