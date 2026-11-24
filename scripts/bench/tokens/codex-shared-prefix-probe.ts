#!/usr/bin/env bun
/**
 * Whether a NEW Claudin session can start warm on the ChatGPT Codex backend:
 * Claudin's real first request (instructions + tools, from a codex-wire-capture
 * cap file) re-sent as five "sessions", one request each, every one with its
 * own session-id header and its own scratchpad line, as a new process would.
 *
 *   S1  key = session, line moved to input[0]    warms the moved shape
 *   S2  key = session, line moved to input[0]    move only: does a new session read S1?
 *   S3  key = K,       line moved to input[0]    warms the stable key
 *   S4  key = K,       line moved to input[0]    move + stable key (gate G0: >= 80%)
 *   S5  key = K,       line left in instructions stable key only: does the line still cut the tools?
 *
 * Today Claudin sends S5's shape under a per-session key: a fresh `-p` session
 * read 0 of 27919 on 2026-11-23, while Codex CLI 0.171's first request read 72%.
 *
 * Observed 2026-11-23 (gpt-5.6-terra, free plan, N=1, 3 s apart): S1 0%, S2 81%
 * (20992/26027), S3 0%, S4 0%, S5 0%. A pair with the same key and prefix missed,
 * so prompt_cache_key alone does not route a new session to the cache. The
 * cross-session change was not built (team memory
 * decisions/codex-cross-session-prefix-rejected). The run moved the quota
 * 10% → 22%: cold requests cost ~2.4% each against ~0.45% warm.
 *
 *   bun scripts/bench/tokens/codex-shared-prefix-probe.ts --body=<cap>/NNN-claudin.json
 *
 * The token comes from ~/.codex/auth.json and is never printed. Five paid
 * requests on the ChatGPT account, all built to start cold.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = 'https://chatgpt.com/backend-api/codex'
const bodyFile = process.argv.find(arg => arg.startsWith('--body='))?.slice(7)
if (!bodyFile) throw new Error('--body=<codex-wire-capture cap json> is required')

const auth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8')) as {
  tokens: { access_token: string; account_id: string }
}
const captured = (JSON.parse(readFileSync(bodyFile, 'utf8')) as { body: Record<string, unknown> }).body
const capturedSession = String(captured.prompt_cache_key)
const blocks = String(captured.instructions).split('\n\n')
const stableInstructions = blocks.filter(block => !block.includes(capturedSession)).join('\n\n')
const sessionText = blocks.filter(block => block.includes(capturedSession)).join('\n\n')
if (!sessionText) throw new Error(`no instructions block carries the captured session id ${capturedSession}`)

const USER = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Without tools, reply with just: ok' }] }

type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }

async function send(session: string, key: string, moved: boolean): Promise<{ status: number; usage?: Usage; error?: string }> {
  const line = sessionText.replaceAll(capturedSession, session)
  const { input: _input, prompt_cache_key: _key, instructions: _instructions, ...rest } = captured
  const body = {
    ...rest,
    instructions: moved ? stableInstructions : `${stableInstructions}\n\n${line}`,
    input: moved ? [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: line }] }, USER] : [USER],
    prompt_cache_key: key,
  }
  const response = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.tokens.access_token}`,
      'ChatGPT-Account-Id': auth.tokens.account_id,
      originator: 'claudin',
      'session-id': session,
      'User-Agent': 'claudin/probe (linux; x64)',
    },
    body: JSON.stringify(body),
  })
  const raw = await response.text()
  if (!response.ok) return { status: response.status, error: raw.slice(0, 300) }
  const result: { status: number; usage?: Usage; error?: string } = { status: response.status }
  for (const chunk of raw.split(/\r?\n\r?\n/)) {
    const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
    if (!data) continue
    try {
      const event = JSON.parse(data) as { type?: string; error?: unknown; response?: { usage?: Usage } }
      if (event.type === 'error') result.error = JSON.stringify(event.error ?? event).slice(0, 300)
      if (event.type === 'response.completed') result.usage = event.response?.usage
    } catch {
      // a non-JSON keep-alive line; the completed event is what this probe reads
    }
  }
  return result
}

async function usedPercent(): Promise<string> {
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: { Authorization: `Bearer ${auth.tokens.access_token}`, 'chatgpt-account-id': auth.tokens.account_id, originator: 'claudin' },
  })
  const body = (await response.json().catch(() => ({}))) as { plan_type?: string; rate_limit?: { primary_window?: { used_percent?: number } } }
  return `${body.plan_type ?? '?'} plan, ${body.rate_limit?.primary_window?.used_percent ?? '?'}% used`
}

console.log(`quota before: ${await usedPercent()}`)
console.log(`instructions ${String(captured.instructions).length} chars, session element ${sessionText.length} chars, ${(captured.tools as unknown[]).length} tools`)
const stableKey = crypto.randomUUID()
const arms: Array<[string, boolean, boolean]> = [
  ['S1 key=session moved', false, true],
  ['S2 key=session moved', false, true],
  ['S3 key=K moved', true, true],
  ['S4 key=K moved', true, true],
  ['S5 key=K line in instructions', true, false],
]
for (const [name, stable, moved] of arms) {
  const session = crypto.randomUUID()
  const result = await send(session, stable ? stableKey : session, moved)
  const input = result.usage?.input_tokens ?? 0
  const cached = result.usage?.input_tokens_details?.cached_tokens ?? 0
  const pct = input > 0 ? Math.round((100 * cached) / input) : 0
  console.log(`${name.padEnd(32)} ${result.status} in=${input} cached=${cached} (${pct}%) out=${result.usage?.output_tokens ?? '?'}`)
  if (result.error) console.log(`   error: ${result.error}`)
  await new Promise(resolve => setTimeout(resolve, 3000))
}
console.log(`quota after: ${await usedPercent()}`)
