#!/usr/bin/env bun
/**
 * How the ChatGPT Codex backend treats a replayed reasoning item: one real turn,
 * then its continuation sent several ways. Each variant answers one question the
 * reasoning replay (src/providers/shims/codex/) depends on.
 *
 *   A  today's shape: no reasoning item, a synthetic fc_<call> id
 *   C  the reasoning item, the backend's own fc_ id  ← what the replay sends
 *   S  the reasoning item, a synthetic fc_ id         (does the id matter?)
 *   T  the reasoning item with a tampered payload     (what does a refusal look like?)
 *   X  the reasoning item sent to another model       (does a /model switch break it?)
 *
 * Observed 2026-10-16 on gpt-5.6-terra: every variant answered HTTP 200. With a
 * synthetic id the completed response's `output` came back empty (4/4), with
 * the backend's id it was filled (4/4). T answered 200 with a single SSE
 * `error` event, code invalid_encrypted_content and no completion. X was
 * accepted by gpt-6-luna and gpt-5.6-luna.
 *
 *   bun scripts/bench/tokens/codex-reasoning-replay-probe.ts [model] [--only=A,C,T]
 *
 * The token comes from ~/.codex/auth.json and is never printed. Each variant is
 * one paid request on the ChatGPT account.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = 'https://chatgpt.com/backend-api/codex'
const MODEL = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'gpt-5.6-terra'
const ONLY = (process.argv.find(arg => arg.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean)

const auth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8')) as {
  tokens: { access_token: string; account_id: string }
}
const session = crypto.randomUUID()
const INSTRUCTIONS = 'You are a terse assistant. Before calling a tool, write one short sentence saying what you will do.'
const TOOL = {
  type: 'function',
  name: 'get_numbers',
  description: 'Returns the numbers to work with.',
  parameters: { type: 'object', properties: { seed: { type: 'integer' } }, required: ['seed'], additionalProperties: false },
}
const USER = {
  type: 'message',
  role: 'user',
  content: [{
    type: 'input_text',
    text: 'Call get_numbers with seed = the sum of the squares of the first 9 primes (compute it yourself first). Then say how many subsets of the returned numbers sum to exactly 60.',
  }],
}

type Item = Record<string, any>
type Result = { status: number; error?: string; items: Item[]; text: string; completedOutput: number; usage?: Item }

async function send(body: Record<string, unknown>, model = MODEL): Promise<Result> {
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
    body: JSON.stringify({
      model,
      stream: true,
      store: false,
      instructions: INSTRUCTIONS,
      tools: [TOOL],
      tool_choice: 'auto',
      prompt_cache_key: session,
      ...body,
    }),
  })
  const raw = await response.text()
  if (!response.ok) return { status: response.status, error: raw.slice(0, 300), items: [], text: '', completedOutput: -1 }
  const result: Result = { status: response.status, items: [], text: '', completedOutput: -1 }
  for (const chunk of raw.split(/\r?\n\r?\n/)) {
    const data = chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
    if (!data) continue
    let event: Item
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (event.type === 'error') result.error = JSON.stringify(event.error ?? event).slice(0, 300)
    if (event.type === 'response.output_item.done') result.items.push(event.item)
    if (event.type === 'response.output_text.delta') result.text += event.delta ?? ''
    if (event.type === 'response.completed') {
      result.completedOutput = (event.response?.output ?? []).length
      result.usage = event.response?.usage
    }
  }
  return result
}

const first = await send({ input: [USER], include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium' } })
const reasoning = first.items.filter(item => item.type === 'reasoning')
const call = first.items.find(item => item.type === 'function_call')
console.log(`step 1: ${first.status} → ${first.items.map(item => item.type).join(' → ')}`)
if (!call || reasoning.length === 0) {
  console.log('the model thought nothing before its call this time; run it again')
  process.exit(1)
}

const messages = first.items
  .filter(item => item.type === 'message')
  .map(item => ({ type: 'message', role: 'assistant', content: item.content, id: item.id, ...(item.phase && { phase: item.phase }) }))
const reasoningItems = (payload?: (item: Item) => string) =>
  reasoning.map(item => ({
    type: 'reasoning',
    id: item.id,
    summary: [],
    encrypted_content: payload ? payload(item) : item.encrypted_content,
  }))
const callItem = (id: string) => ({ type: 'function_call', id, call_id: call.call_id, name: call.name, arguments: call.arguments })
const output = { type: 'function_call_output', call_id: call.call_id, output: '[14, 17, 22, 29, 35]' }
const synthetic = `fc_${String(call.call_id).replace(/^call_/, '')}`
const replay = { include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium' } }

const variants: Array<[string, string, () => Promise<Result>]> = [
  ['A', "today's shape: no reasoning, synthetic id", () =>
    send({ input: [USER, ...messages, callItem(synthetic), output], reasoning: { effort: 'medium' } })],
  ['C', 'reasoning + the backend id', () =>
    send({ input: [USER, ...reasoningItems(), ...messages, callItem(call.id), output], ...replay })],
  ['S', 'reasoning + a synthetic id', () =>
    send({ input: [USER, ...reasoningItems(), ...messages, callItem(synthetic), output], ...replay })],
  ['T', 'reasoning with a tampered payload', () =>
    send({
      input: [USER, ...reasoningItems(item => `${item.encrypted_content.slice(0, -40)}${'A'.repeat(40)}`), ...messages, callItem(call.id), output],
      ...replay,
    })],
  ['X', 'reasoning sent to another model', () =>
    send({ input: [USER, ...reasoningItems(), ...messages, callItem(call.id), output], ...replay }, process.env.OTHER_MODEL ?? 'gpt-6-luna')],
]

for (const [id, what, run] of variants) {
  if (ONLY.length > 0 && !ONLY.includes(id)) continue
  const result = await run()
  const usage = result.usage
    ? `in=${result.usage.input_tokens} out=${result.usage.output_tokens} reasoning=${result.usage.output_tokens_details?.reasoning_tokens}`
    : ''
  console.log(`${id} ${what}: ${result.status} completed.output=${result.completedOutput} ${usage}`)
  if (result.error) console.log(`   error: ${result.error}`)
  if (result.text) console.log(`   "${result.text.replace(/\n/g, ' ').slice(0, 100)}"`)
}
