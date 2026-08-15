#!/usr/bin/env bun
/**
 * Does the Codex backend actually require `strict: true` with every property in
 * `required`? ANSWERED 2026-07-29 — yes; see RESULTS below. This script stays as
 * the reusable instrument for re-checking after a model or backend change.
 *
 * `convertToolsToResponsesTools` (src/providers/shims/codexShim.ts) asserted that
 * since the initial commit — "Codex requires strict schemas: all properties must
 * be required" — with no recorded 400 backing it. That forced-required list is
 * what makes the model invent placeholder arguments (`pages: ""`), because it
 * has no legal way to omit an optional one.
 *
 * RESULTS ON RECORD (gpt-5.5 over Codex OAuth). Produced with `claudindev -p
 * --output-format stream-json`, one variant per build, rather than with this
 * script: on Linux the Codex OAuth blob lives in libsecret, which the
 * credential reader below cannot reach.
 *
 *   strict + forced required + widening (shipped) → 200, model sends null
 *   strict + truthful required                    → 400 invalid_function_parameters,
 *                                                   "'required' … must include every
 *                                                    key in properties. Missing
 *                                                    'isolation'."
 *   no strict + truthful required + widening      → 200, model sends null
 *   no strict + truthful required, NO widening    → 200, model invents
 *                                                   limit:1, pages:"", view:"full"
 *
 * The last row is the one that matters: dropping `strict` does not stop the
 * model from inventing arguments, and an invented `limit: 1` is a value no
 * strip can catch — the read silently returns one line and the answer is wrong.
 * The widening is what fixes this, not the `required` list.
 *
 * This probe sends the same tool under five schema variants and reports, for
 * each: the HTTP status, and whether the model omitted the optional arguments it
 * was told not to use. It builds the request body itself rather than calling
 * performCodexRequest, because the whole point is to vary `strict`/`required`,
 * which that function hardcodes — but everything else about the request
 * (instructions, parallel_tool_calls, the Codex-CLI User-Agent shape, the
 * originator/session headers) mirrors performCodexRequest, so a rejection can
 * be attributed to the schema rather than to an unfamiliar-looking client.
 *
 * `v0` is the positive control: the pre-fix shape that produced 135 identical
 * placeholder calls in one session. If v0 does NOT come back PLACEHOLDER, the
 * harness cannot detect the effect at all and every other verdict is void.
 *
 *   bun scripts/profile/codex-strict-probe.ts
 *   bun scripts/profile/codex-strict-probe.ts --model gpt-5.4 --only v2 --reps 5
 *
 * Credentials are read straight from the config dir rather than through
 * src/providers/oauth/codexCredentials.js: importing that module pulls in the analytics
 * chain, which only resolves under the build's stub aliases. The token is used
 * for the Authorization header and is never printed.
 */

import { readFileSync } from 'fs'
import { arch, homedir, platform, release } from 'os'
import { join } from 'path'

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

type Variant = {
  id: string
  what: string
  /** Whether to send `strict: true` on the function tool. */
  strict: boolean
  /** Which keys go in `required`. */
  required: 'truthful' | 'all'
  /**
   * How optional props are widened:
   *   none       — no widening at all (the original, pre-fix shape)
   *   plain      — `type: [t,'null']`, enums left alone (the first fix)
   *   shipped    — plain, plus `enum: [...values, null]` (what production sends)
   *   anyOf-enum — plain, plus `anyOf:[{enum…},{type:'null'}]` (the alternative)
   */
  widen: 'none' | 'plain' | 'shipped' | 'anyOf-enum'
}

const VARIANTS: Variant[] = [
  {
    id: 'v0',
    what: 'CONTROL: the pre-fix shape (forced required, no widening)',
    strict: true,
    required: 'all',
    widen: 'none',
  },
  {
    id: 'v1',
    what: 'strict: true + truthful required',
    strict: true,
    required: 'truthful',
    widen: 'none',
  },
  {
    id: 'v2',
    what: 'no strict flag + truthful required',
    strict: false,
    required: 'truthful',
    widen: 'none',
  },
  {
    id: 'v3',
    what: 'SHIPPED: forced required + type-union widening, null in the enum list',
    strict: true,
    required: 'all',
    widen: 'shipped',
  },
  {
    id: 'v4',
    what: 'fallback shape: forced required + anyOf enum widening',
    strict: true,
    required: 'all',
    widen: 'anyOf-enum',
  },
]

/** One required arg, one optional string, one optional enum — the exact shape that breaks today. */
function buildTool(variant: Variant): Record<string, unknown> {
  const filter: Record<string, unknown> = { type: 'string', description: 'Substring filter. Omit to read the whole file.' }
  const modeDescription = 'Rendering mode. Omit to let the tool decide.'
  const mode: Record<string, unknown> = {
    type: 'string',
    enum: ['outline', 'full'],
    description: modeDescription,
  }

  const properties: Record<string, unknown> = {
    path: { type: 'string', description: 'Absolute path to read.' },
    filter: variant.widen === 'none' ? filter : { ...filter, type: ['string', 'null'] },
    mode: buildModeSchema(variant.widen, modeDescription),
  }

  const tool: Record<string, unknown> = {
    type: 'function',
    name: 'probe_read',
    description: 'Reads a file. Only `path` is meaningful for this task.',
    parameters: {
      type: 'object',
      properties,
      required: variant.required === 'all' ? Object.keys(properties) : ['path'],
      additionalProperties: false,
    },
  }
  if (variant.strict) tool.strict = true
  return tool
}

function buildModeSchema(widen: Variant['widen'], description: string): Record<string, unknown> {
  switch (widen) {
    case 'shipped':
      // Exactly what allowNull emits today (codexShim.ts) — the form that has
      // never been sent to the backend.
      return { type: ['string', 'null'], enum: ['outline', 'full', null], description }
    case 'anyOf-enum':
      return { description, anyOf: [{ type: 'string', enum: ['outline', 'full'] }, { type: 'null' }] }
    default:
      return { type: 'string', enum: ['outline', 'full'], description }
  }
}

const PROMPT =
  'Call probe_read on /etc/hostname. You do not want to filter anything and you have no ' +
  'preference about the rendering mode, so do not pass those arguments at all.'

const INSTRUCTIONS =
  'You are a coding agent. Call the tools you are given. Never pass an argument you do not need.'

type ProbeResult = {
  variant: Variant
  status: number
  error?: string
  args?: Record<string, unknown>
  verdict: string
}

async function runVariant(
  variant: Variant,
  opts: { baseUrl: string; model: string; apiKey: string; accountId?: string },
): Promise<ProbeResult> {
  // Mirrors the body performCodexRequest builds (codexShim.ts): instructions
  // present, parallel_tool_calls true, no temperature/top_p for GPT models.
  const body = {
    model: opts.model,
    instructions: INSTRUCTIONS,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
    store: false,
    stream: true,
    tools: [buildTool(variant)],
    tool_choice: 'auto',
    parallel_tool_calls: true,
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Same shape as production: the OpenAI backend soft-gates on this.
    'User-Agent': `claudin/probe (${platform()} ${release()}; ${arch()})`,
    Authorization: `Bearer ${opts.apiKey}`,
    originator: 'claudin',
    'session-id': crypto.randomUUID(),
  }
  if (opts.accountId) headers['ChatGPT-Account-Id'] = opts.accountId

  const response = await fetch(`${opts.baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      variant,
      status: response.status,
      error: text.slice(0, 400),
      verdict: `REJECTED (${response.status})`,
    }
  }

  // Accumulate the function_call arguments out of the SSE stream. The terminal
  // `item` ASSIGNS and the deltas APPEND, so the two cannot double-count: the
  // `output_item.added` event carries `arguments: ""` (falsy, skipped) and the
  // final `output_item.done` carries the complete string.
  let argsText = ''
  let streamFailure: string | undefined
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payloadText = line.slice(5).trim()
      if (!payloadText || payloadText === '[DONE]') continue
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(payloadText) as Record<string, unknown>
      } catch {
        continue
      }
      // A 200 can still fail mid-stream — without this it would read as
      // "accepted, model just did not call the tool".
      const type = typeof payload.type === 'string' ? payload.type : ''
      if (type === 'response.failed' || type === 'error' || payload.error) {
        streamFailure = JSON.stringify(payload.error ?? payload).slice(0, 300)
      }
      const item = payload.item as { type?: string; arguments?: string } | undefined
      if (item?.type === 'function_call' && typeof item.arguments === 'string' && item.arguments) {
        argsText = item.arguments
      }
      if (typeof payload.delta === 'string' && payload.type === 'response.function_call_arguments.delta') {
        argsText += payload.delta
      }
    }
  }

  let args: Record<string, unknown> | undefined
  try {
    args = JSON.parse(argsText) as Record<string, unknown>
  } catch {
    args = undefined
  }

  if (streamFailure) {
    return {
      variant,
      status: response.status,
      error: streamFailure,
      verdict: 'STREAM FAILED after 200',
    }
  }

  return { variant, status: response.status, args, verdict: judge(args) }
}

/** The question the probe exists to answer: could the model decline the optional args? */
function judge(args: Record<string, unknown> | undefined): string {
  if (!args) return 'NO TOOL CALL — model answered in prose (retry, verdict void)'
  const optional = ['filter', 'mode']
  const present = optional.filter(key => key in args)
  if (present.length === 0) return 'CLEAN — optional args omitted entirely'
  const nulled = present.filter(key => args[key] === null)
  const placeholders = present.filter(key => args[key] !== null)
  if (placeholders.length === 0) return `NULLED — sent ${nulled.join(', ')} as null (strip needed downstream)`
  return `PLACEHOLDER — invented ${placeholders.map(key => `${key}=${JSON.stringify(args[key])}`).join(', ')}`
}

/** The `codex` blob out of ~/.claudin/.credentials.json — token never logged. */
function readCodexCredentials(): { apiKey?: string; accountId?: string } {
  const configDir = process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
  let blob: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')) as Record<string, unknown>
    blob = (raw.codex as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }

  const apiKey =
    (typeof blob.accessToken === 'string' && blob.accessToken) ||
    (typeof blob.apiKey === 'string' && blob.apiKey) ||
    undefined

  let accountId = typeof blob.accountId === 'string' ? blob.accountId : undefined
  if (!accountId && typeof blob.idToken === 'string') {
    // The account id also rides in the id_token's OpenAI auth claim.
    try {
      const payload = JSON.parse(
        Buffer.from(blob.idToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as Record<string, unknown>
      const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
      const claimed = auth?.chatgpt_account_id
      if (typeof claimed === 'string') accountId = claimed
    } catch {
      /* leave unset — the probe reports it as MISSING */
    }
  }

  return { apiKey, accountId }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }

  const credentials = readCodexCredentials()
  if (!credentials.apiKey) {
    console.error('No Codex credentials found. Run /provider and sign in with Codex OAuth first.')
    process.exit(1)
  }

  const opts = {
    baseUrl: flag('base-url') ?? DEFAULT_CODEX_BASE_URL,
    model: flag('model') ?? 'gpt-5.4',
    apiKey: credentials.apiKey,
    accountId: credentials.accountId,
  }
  const only = flag('only')
  const variants = only ? VARIANTS.filter(v => v.id === only) : VARIANTS
  const reps = Math.max(1, Number(flag('reps') ?? '3'))

  console.log(
    `model=${opts.model} baseUrl=${opts.baseUrl} accountId=${opts.accountId ? 'set' : 'MISSING'} reps=${reps}\n`,
  )

  // Whether the model omits an argument is a sampling outcome, so each variant
  // runs `reps` times and the verdicts are counted rather than taken from one
  // draw.
  const byVariant = new Map<string, string[]>()
  for (const variant of variants) {
    const verdicts: string[] = []
    for (let rep = 0; rep < reps; rep++) {
      process.stdout.write(`${variant.id}.${rep + 1} — ${variant.what} … `)
      try {
        const result = await runVariant(variant, opts)
        verdicts.push(result.verdict)
        console.log(result.verdict)
        if (result.error) console.log(`   ${result.error.replace(/\n/g, ' ')}`)
        if (result.args) console.log(`   args: ${JSON.stringify(result.args)}`)
      } catch (e) {
        const message = `THREW — ${e instanceof Error ? e.message : String(e)}`
        verdicts.push(message)
        console.log(message)
      }
    }
    byVariant.set(variant.id, verdicts)
  }

  console.log('\n--- summary ---')
  for (const variant of variants) {
    const verdicts = byVariant.get(variant.id) ?? []
    const counts = new Map<string, number>()
    for (const verdict of verdicts) {
      const head = verdict.split(' —')[0] ?? verdict
      counts.set(head, (counts.get(head) ?? 0) + 1)
    }
    const tally = [...counts].map(([head, n]) => `${head}×${n}`).join('  ')
    console.log(`${variant.id}  ${tally}`)
  }

  const control = byVariant.get('v0')
  if (control && !control.some(verdict => verdict.startsWith('PLACEHOLDER'))) {
    console.log(
      '\n⚠ CONTROL FAILED: v0 (the pre-fix shape) never produced a placeholder, so this ' +
        'run cannot detect the effect being tested. Treat every other verdict as void.',
    )
  }
}

void main()
