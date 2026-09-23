#!/usr/bin/env bun
// Beta acceptance probe: does the REAL Anthropic API accept each beta header
// and body field Claudin is about to send, on this account? One tiny `-p`
// request per (arm × model) through the CLI, with the arm injected through
// ANTHROPIC_BETAS (betas.ts appends it verbatim) and CLAUDIN_EXTRA_BODY
// (spread last into the request body) — so it runs BEFORE any code sends them.
//
// Usage:
//   bun run scripts/bench/tokens/beta-acceptance-probe.ts --dry   # local mock: prove each arm reaches the wire
//   bun run scripts/bench/tokens/beta-acceptance-probe.ts         # the real API
//   --models=claude-opus-5-5,claude-fable-5-1,claude-sonnet-5  --arms=baseline,display-updates  --bin=claudindev
//
// REAL API CALLS without --dry: one short request per cell. On a Claude
// subscription login they count against usage limits, not dollars.
//
// Two controls are what make "accepted" mean something, and the report fails
// loudly if either passes:
//   - unknown-beta: a made-up beta name. If the API took it, a header-only arm
//     would prove nothing.
//   - updates-no-beta: display "updates" without its beta, which the docs say
//     is a 400. If the API took it, the probe could not see a rejected field.
// --dry is the third control: an arm whose header or field never leaves the
// CLI (a build that ignores the env var) would otherwise read as accepted.
//
// The child env drops CLAUDECODE, CLAUDE_CODE_*, CLAUDIN_* and every
// ANTHROPIC_* credential/base-URL variable, so each run uses the normal login
// and the endpoint the product would use. It runs in a throwaway cwd with
// --no-session-persistence, so nothing lands in this repo's session list.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Arm = {
  name: string
  betas?: string[]
  body?: Record<string, unknown>
  env?: Record<string, string>
  expect: 'accept' | 'reject'
  /** What --dry must find on the wire for this arm to count as injected. */
  wire?: (req: { betas: string[]; body: any }) => boolean
}

const THINKING = { type: 'adaptive' }
const hasBeta = (b: string) => (r: { betas: string[] }) => r.betas.includes(b)

const ARMS: Arm[] = [
  { name: 'baseline', expect: 'accept' },
  {
    name: 'unknown-beta',
    betas: ['claudin-probe-nonexistent-2099-01-01'],
    expect: 'reject',
    wire: hasBeta('claudin-probe-nonexistent-2099-01-01'),
  },
  {
    name: 'updates-no-beta',
    body: { thinking: { ...THINKING, display: 'updates' } },
    expect: 'reject',
    wire: r => r.body?.thinking?.display === 'updates',
  },
  {
    name: 'display-omitted',
    body: { thinking: { ...THINKING, display: 'omitted' } },
    expect: 'accept',
    wire: r => r.body?.thinking?.display === 'omitted',
  },
  {
    name: 'display-updates',
    betas: ['thinking-display-updates-2026-08-18'],
    body: { thinking: { ...THINKING, display: 'updates' } },
    expect: 'accept',
    wire: r => r.body?.thinking?.display === 'updates' && r.betas.includes('thinking-display-updates-2026-08-18'),
  },
  {
    name: 'thinking-token-count',
    betas: ['thinking-token-count-2026-05-13'],
    expect: 'accept',
    wire: hasBeta('thinking-token-count-2026-05-13'),
  },
  {
    name: 'context-management',
    betas: ['context-management-2025-06-27'],
    body: { context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } },
    expect: 'accept',
    wire: r => r.betas.includes('context-management-2025-06-27') && r.body?.context_management?.edits?.[0]?.keep === 'all',
  },
  {
    name: 'cache-diagnosis',
    betas: ['cache-diagnosis-2026-04-07'],
    body: { diagnostics: { previous_message_id: null } },
    expect: 'accept',
    wire: r => r.betas.includes('cache-diagnosis-2026-04-07') && r.body?.diagnostics !== undefined,
  },
  {
    name: 'prompt-caching-scope',
    betas: ['prompt-caching-scope-2026-01-05'],
    expect: 'accept',
    wire: hasBeta('prompt-caching-scope-2026-01-05'),
  },
  {
    name: 'afk-mode',
    betas: ['afk-mode-2026-01-31'],
    expect: 'accept',
    wire: hasBeta('afk-mode-2026-01-31'),
  },
  // Everything the experimental switch still guards, global cache scope
  // included, then the same without global scope — the pair that isolates the
  // 400 the token-efficient-tools A/B hit in May.
  {
    name: 'experimental-on',
    env: { CLAUDIN_DISABLE_EXPERIMENTAL_BETAS: 'false' },
    expect: 'accept',
    wire: r =>
      Array.isArray(r.body?.system) &&
      r.body.system.some((s: any) => s?.cache_control?.scope === 'global'),
  },
  {
    name: 'experimental-on-no-global',
    env: { CLAUDIN_DISABLE_EXPERIMENTAL_BETAS: 'false', CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE: '1' },
    expect: 'accept',
    wire: r =>
      r.betas.includes('prompt-caching-scope-2026-01-05') &&
      Array.isArray(r.body?.system) &&
      !r.body.system.some((s: any) => s?.cache_control?.scope === 'global'),
  },
]

const argv = process.argv.slice(2)
const opt = (name: string, dflt: string): string =>
  argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DRY = argv.includes('--dry')
const BIN = opt('bin', 'claudindev')
const MODELS = opt('models', 'claude-opus-5-5,claude-fable-5-1,claude-sonnet-5').split(',').filter(Boolean)
const ONLY = opt('arms', '').split(',').filter(Boolean)
const PORT = Number(opt('port', '8814'))
const OUT = opt('out', join(tmpdir(), 'beta-acceptance'))
const CWD = join(tmpdir(), 'wire-matrix-cwd')
const PROMPT = 'Reply with the single word ok.'

type Seen = { betas: string[]; body: any }
let seen: Seen[] = []

function startMock(): Promise<{ close: () => void }> {
  return new Promise(resolveStart => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        const path = req.url ?? ''
        if (path.includes('/v1/messages') && !path.includes('count_tokens')) {
          let body: any = null
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            body = null
          }
          const betas = String(req.headers['anthropic-beta'] ?? '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
          seen.push({ betas, body })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(
            [
              'event: message_start',
              `data: {"type":"message_start","message":{"id":"msg_probe","type":"message","role":"assistant","model":"${body?.model ?? 'x'}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}`,
              '',
              'event: content_block_start',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
              '',
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
              '',
              'event: content_block_stop',
              'data: {"type":"content_block_stop","index":0}',
              '',
              'event: message_delta',
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
              '',
              'event: message_stop',
              'data: {"type":"message_stop"}',
              '',
              '',
            ].join('\n'),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(path.includes('count_tokens') ? '{"input_tokens":1}' : '{}')
      })
    })
    server.listen(PORT, () => resolveStart({ close: () => server.close() }))
  })
}

function childEnv(arm: Arm, model: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const key of Object.keys(env)) {
    if (
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDIN_') ||
      key.startsWith('CLAUDE_CODE_') ||
      key.startsWith('_CLAUDE_CODE_') ||
      key === 'ANTHROPIC_BASE_URL' ||
      key === 'ANTHROPIC_API_KEY' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key === 'ANTHROPIC_BETAS'
    ) {
      delete env[key]
    }
  }
  env.ANTHROPIC_MODEL = model
  if (arm.betas?.length) env.ANTHROPIC_BETAS = arm.betas.join(',')
  if (arm.body) env.CLAUDIN_EXTRA_BODY = JSON.stringify(arm.body)
  Object.assign(env, arm.env ?? {})
  if (DRY) {
    env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}`
    env.CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL = '1'
  }
  return env
}

// Async: in --dry the mock lives in this process.
function runCli(env: Record<string, string>, model: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(
      BIN,
      ['-p', PROMPT, '--model', model, '--output-format', 'json', '--no-session-persistence'],
      { env, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += String(d)))
    child.stderr.on('data', d => (stderr += String(d)))
    const kill = setTimeout(() => child.kill('SIGTERM'), 120_000)
    child.on('close', code => {
      clearTimeout(kill)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

type Outcome = { verdict: 'accept' | 'reject'; detail: string }

function classify(r: { code: number; stdout: string; stderr: string }): Outcome {
  let parsed: any = null
  try {
    parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '')
  } catch {
    parsed = null
  }
  if (r.code === 0 && parsed && parsed.is_error === false) {
    return { verdict: 'accept', detail: String(parsed.result ?? '').slice(0, 40) }
  }
  const text = String(parsed?.result ?? r.stderr ?? r.stdout).replace(/\s+/g, ' ')
  return { verdict: 'reject', detail: text.slice(0, 220) }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  const arms = ONLY.length ? ARMS.filter(a => ONLY.includes(a.name)) : ARMS
  const mock = DRY ? await startMock() : null
  console.log(`${DRY ? 'DRY (local mock)' : 'LIVE (real API)'} · bin=${BIN} · ${arms.length} arms × ${MODELS.length} models`)
  const rows: Array<{ arm: string; model: string; ok: boolean; detail: string }> = []
  try {
    for (const arm of arms) {
      for (const model of MODELS) {
        seen = []
        const r = await runCli(childEnv(arm, model), model)
        if (DRY) {
          const req = seen.find(s => s.body?.model === model) ?? seen[0]
          const injected = !arm.wire || (req !== undefined && arm.wire(req))
          if (req) writeFileSync(join(OUT, `dry-${arm.name}-${model}.json`), JSON.stringify(req, null, 2))
          rows.push({ arm: arm.name, model, ok: injected, detail: req ? (injected ? 'on the wire' : 'NOT on the wire') : `no request (exit ${r.code})` })
        } else {
          const o = classify(r)
          rows.push({ arm: arm.name, model, ok: o.verdict === arm.expect, detail: `${o.verdict}: ${o.detail}` })
        }
        const last = rows[rows.length - 1]!
        console.log(`  ${last.ok ? '✓' : '✗'} ${arm.name.padEnd(26)} ${model.padEnd(18)} ${last.detail}`)
      }
    }
  } finally {
    mock?.close()
  }
  const file = join(OUT, `${DRY ? 'dry' : 'live'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(rows, null, 2))
  const failed = rows.filter(r => !r.ok)
  console.log(`\n${rows.length - failed.length}/${rows.length} as expected · ${file}`)
  if (failed.length) {
    console.log('unexpected:')
    for (const f of failed) console.log(`  ${f.arm} × ${f.model}: ${f.detail}`)
    process.exitCode = 1
  }
}

void main()
