#!/usr/bin/env bun
// Extract Claude Code's system prompt and tool definitions from the wire, one
// file each, for diffing against claudin's (dump-system-prompt.ts is that side).
//
//   bun scripts/bench/tokens/extract-claude-code-prompt.ts [--out=DIR] [--mode=interactive|print]
//        [--model=ID] [--bin=PATH | $CLAUDE_BIN] [--prompt=TEXT] [--config=DIR] [--timeout=SECS]
//        [--no-deferred] [--env=NAME=VALUE ...]
//   diff -ru <dirA> <dirB>          # two versions, or interactive against print
//
// How: the installed `claude` is pointed at a local stub of the Messages API
// (ANTHROPIC_BASE_URL, a fake key). The stub records every /v1/messages body and
// answers with a canned "ok", so the run needs no login, sends nothing upstream
// and costs nothing. The prompt and the tool list are not stored in the binary
// as readable text (memory `claude-code-2.1.270-prompt-diff` had to grep
// `strings` output, and got prose but no schemas); the request body is the one
// place both exist exactly as the model sees them, after every runtime gate.
//
// Modes. `interactive` (default) drives the real TUI on a pty — Bun's
// `terminal` spawn option, POSIX only — seeding a config dir that skips
// onboarding, and types the prompt. `print` runs `claude -p`, which needs no
// pty but is a DIFFERENT prompt: on 2.1.284 it opens with "You are a Claude
// agent, built on Anthropic's Claude Agent SDK." instead of "You are Claude
// Code", and lacks tools such as AskUserQuestion, EnterPlanMode and
// ExitPlanMode. Compare like with like.
//
// Deferred tools. Claude Code sends only some tools' schemas; the rest are named
// in a mid-conversation `role: "system"` message and load through ToolSearch. The
// stub answers the first agent-loop request with `ToolSearch select:<all of
// them>`, so the request after it carries every schema; tools.json is that one.
// `--no-deferred` skips the round trip and keeps only what was sent up front.
//
// `--env=NAME=VALUE` (repeatable) passes a variable to the child on top of the
// short inherited list — how an A/B arm's flag is captured (a claudin
// `--variant` of session-cache-ab.ts, say) without touching the source.
//
// What the extraction is and is not:
//   - `requestKind()` picks the agent-loop requests out of the side requests;
//     the others are listed in meta.json, not written out.
//   - It runs from a fixed temp cwd with a fresh CLAUDE_CONFIG_DIR, so no
//     CLAUDE.md, memory or settings of yours leaks in. That also means no
//     server-side feature flags cached in ~/.claude.json. Claude Code gates
//     prompt sections on flags (memory `claude-code-2.1.270-prompt-diff` names
//     `willow_tern` and `amber_sextant`), so this shows the prompt WITHOUT them.
//     Whether that differs for the version at hand has not been measured;
//     `--config=$HOME/.claude` reuses your cached flags, at the price of your
//     settings and of writing a session transcript there — compare the two
//     `systemSha256` values in meta.json.
//   - The env section carries today's date, so two runs on different days
//     differ there. system.txt's first block is a per-request billing header;
//     `systemSha256` leaves it out, and two runs the same day hash the same.
//   - `metadata` (device id, and an account uuid under a real config) is
//     redacted from request.json.
//
// Layout under --out (default: <tmpdir>/claude-code-prompt-<version>-<mode>):
//   system.txt              the system blocks, joined by a blank line
//   messages.txt            every message of the first request — the injected
//                           <system-reminder>, the env section, the deferred
//                           tool names and the agent list live here, not in system
//   tools.json              every tool exactly as sent (from the last request)
//   tools/<Name>.txt        description text
//   tools/<Name>.schema.json  input_schema
//   request.json            the whole first request body
//   meta.json               version, mode, model, headers, block boundaries,
//                           sizes, sha256s, tools still deferred, and the side
//                           requests that were skipped
//
// Claudin as the subject. `--bin=<repo>/bin/claudin --config=DIR` extracts claudin's own
// prompt the same way, for a side-by-side `diff -ru`. Claudin does not read
// ANTHROPIC_API_KEY without a provider profile, so DIR needs a config.json with
// `providerProfiles` + `activeProviderProfileId` (an anthropic profile with a fake apiKey
// and a non-empty `baseUrl`, e.g. https://api.anthropic.com — a profile without one is
// dropped and the TUI opens the provider wizard; the requests still reach the stub through
// ANTHROPIC_BASE_URL), and, to get past the TUI's dialogs, `legacyMigrationSkipped: true`,
// `customApiKeyResponses.approved: [<last 20 chars of the key>]` and
// `projects[<tmpdir>/cc-extract/work].hasTrustDialogAccepted: true`. DIR must sit outside
// <tmpdir>/cc-extract, which every run deletes. Build first (`bun run build`): the
// launcher runs dist/cli.mjs.
//
// Nothing extracted belongs in this repo: it is Anthropic's text. Keep it in
// the temp dir, or diff and quote only what a finding needs.

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMessagesPath, proxyEnv, requestKind, type RequestKind } from '../ab/wire-proxy.ts'

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const STUB_KEY = 'sk-ant-api03-stub-key-for-local-extraction'
const DEFAULT_PROMPT = 'Reply with the single word ok.'
const DEFAULT_TIMEOUT_SECS = 90
/** Block 0 of `system` is a billing header whose `cch` and `cc_prompt_id` change on every request. */
const BILLING_HEADER = 'x-anthropic-billing-header:'
/** Fixed paths: the cwd is in the env section and the config dir in the memory section, so a random one makes every run differ. */
const SCRATCH = join(tmpdir(), 'cc-extract')
const WORK_DIR = join(SCRATCH, 'work')
const RECORDED_HEADERS = ['anthropic-beta', 'anthropic-version', 'user-agent', 'x-app']
/** The one environment a run inherits; everything else could steer the prompt (ANTHROPIC_*, CLAUDE_CODE_USE_*). */
const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR']

export type Seen = { path: string; headers: Record<string, string>; body: Json | null }

// ---------------------------------------------------------------------------
// The stub
// ---------------------------------------------------------------------------

/** What the stub says back: plain text, or one tool call for the CLI to run locally. */
export type Reply = { toolUse: { name: string; input: Json } | null }

const TEXT_REPLY: Reply = { toolUse: null }

function message(model: string, reply: Reply): Json {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: reply.toolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function contentBlock(reply: Reply): Json {
  return reply.toolUse
    ? { type: 'tool_use', id: 'toolu_stub', name: reply.toolUse.name, input: reply.toolUse.input }
    : { type: 'text', text: 'ok' }
}

function jsonReply(model: string, reply: Reply): Json {
  return { ...message(model, reply), content: [contentBlock(reply)] }
}

function sseReply(model: string, reply: Reply): string {
  const start: Json = reply.toolUse
    ? { type: 'tool_use', id: 'toolu_stub', name: reply.toolUse.name, input: {} }
    : { type: 'text', text: '' }
  const delta: Json = reply.toolUse
    ? { type: 'input_json_delta', partial_json: JSON.stringify(reply.toolUse.input) }
    : { type: 'text_delta', text: 'ok' }
  const events: [string, Json][] = [
    ['message_start', { type: 'message_start', message: message(model, TEXT_REPLY) }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: reply.toolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

/** `respond` sees each /v1/messages body and how many came before it. */
export function startStub(respond: (body: Json | null, index: number) => Reply): {
  url: string
  seen: Seen[]
  close(): void
} {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (req.method === 'POST' && pathname.includes('count_tokens')) return Response.json({ input_tokens: 1 })
      if (req.method !== 'POST' || !isMessagesPath(pathname)) return Response.json({ error: 'stub' }, { status: 404 })

      const parsed: unknown = await req.json().catch(() => null)
      const body = isRecord(parsed) ? parsed : null
      const headers: Record<string, string> = {}
      for (const name of RECORDED_HEADERS) {
        const value = req.headers.get(name)
        if (value !== null) headers[name] = value
      }
      const reply = respond(body, seen.length)
      seen.push({ path: pathname, headers, body })

      const model = typeof body?.model === 'string' ? body.model : 'claude-stub'
      if (body?.stream === false) return Response.json(jsonReply(model, reply))
      return new Response(sseReply(model, reply), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, close: () => void server.stop(true) }
}

// ---------------------------------------------------------------------------
// Reading the body
// ---------------------------------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The system field is a string or an array of text blocks; both come back as blocks. */
export function systemBlocks(body: Json): Json[] {
  if (typeof body.system === 'string') return [{ type: 'text', text: body.system }]
  return Array.isArray(body.system) ? body.system.filter(isRecord) : []
}

const textOf = (block: Json): string => (typeof block.text === 'string' ? block.text : '')

/** Every agent-loop request, in order; the first is the model's first look at the session. */
export function mainRequests(seen: readonly Seen[]): Seen[] {
  return seen.filter(s => s.body !== null && requestKind(s.body) === 'main')
}

const messagesOf = (body: Json): Json[] => (Array.isArray(body.messages) ? body.messages.filter(isRecord) : [])

/** A message's content as text; blocks without `text` (tool calls, results) are shown as JSON. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content
    .map(b => (isRecord(b) && typeof b.text === 'string' ? b.text : JSON.stringify(b)))
    .join('\n\n')
}

/**
 * Every message the request carries. The first turn holds more than the user's prompt: an
 * injected `<system-reminder>`, and a mid-conversation `role: "system"` message with the
 * environment section, the deferred tool names and the agent list — prompt the model reads
 * that `system` does not contain.
 */
export function renderMessages(body: Json): string {
  return messagesOf(body)
    .map((m, i) => `===== messages[${i}] role=${String(m.role)} =====\n${contentText(m.content)}`)
    .join('\n\n')
}

const DEFERRED_HEADER = /deferred tools are now available via ToolSearch[^\n]*:\n((?:[^\n]+\n)+)/

/** The tools whose schemas are not on the wire yet: named in a message, loaded through ToolSearch. */
export function deferredToolNames(body: Json): string[] {
  for (const m of messagesOf(body)) {
    const list = DEFERRED_HEADER.exec(contentText(m.content))?.[1]
    if (list) return list.split('\n').map(l => l.trim()).filter(l => /^[\w.-]+$/.test(l))
  }
  return []
}

const hasTool = (body: Json, name: string): boolean =>
  Array.isArray(body.tools) && body.tools.some(t => isRecord(t) && t.name === name)

/**
 * The stub's script. Once, on the first agent-loop request that names deferred tools, it answers
 * with a ToolSearch call selecting all of them, so the request after it carries their schemas.
 * `asked()` tells the driver a second agent-loop request is still owed.
 */
export function scriptedResponder(loadDeferred: boolean): {
  respond: (body: Json | null) => Reply
  asked: () => boolean
} {
  let asked = false
  return {
    asked: () => asked,
    respond(body) {
      if (!loadDeferred || asked || !body || requestKind(body) !== 'main' || !hasTool(body, 'ToolSearch')) {
        return TEXT_REPLY
      }
      const names = deferredToolNames(body)
      if (names.length === 0) return TEXT_REPLY
      asked = true
      return { toolUse: { name: 'ToolSearch', input: { query: `select:${names.join(',')}`, max_results: names.length } } }
    },
  }
}

const toolName = (tool: Json): string => (typeof tool.name === 'string' ? tool.name : '<unnamed>')

/** A file-system-safe name; MCP tools carry `mcp__server__tool`, built-ins are plain words. */
const fileSafe = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_')

export type Extraction = { system: string; messages: string; tools: Json[]; meta: Json }

/** `first` gives the system prompt and messages; `last` the tools, since deferred ones only load after a turn. */
export function extract(
  first: Seen,
  last: Seen,
  seen: readonly Seen[],
  info: { version: string; bin: string; mode: Mode },
): Extraction {
  const body = first.body ?? {}
  const blocks = systemBlocks(body)
  const system = blocks.map(textOf).join('\n\n')
  const stableSystem = blocks.map(textOf).filter(t => !t.startsWith(BILLING_HEADER)).join('\n\n')
  const tools = (Array.isArray(last.body?.tools) ? last.body.tools : []).filter(isRecord)
  const stillDeferred = deferredToolNames(last.body ?? {}).filter(n => !tools.some(t => toolName(t) === n))

  const sides = seen
    .filter(s => s !== first && s !== last)
    .map(s => ({
      path: s.path,
      kind: (s.body ? requestKind(s.body) : 'other') as RequestKind,
      model: typeof s.body?.model === 'string' ? s.body.model : null,
      tools: Array.isArray(s.body?.tools) ? s.body.tools.length : 0,
    }))

  const meta: Json = {
    claudeCode: info.version,
    bin: info.bin,
    mode: info.mode,
    model: body.model ?? null,
    headers: first.headers,
    thinking: body.thinking ?? null,
    outputConfig: body.output_config ?? null,
    maxTokens: body.max_tokens ?? null,
    systemChars: system.length,
    systemSha256: sha256(stableSystem),
    systemBlocks: blocks.map((b, index) => ({
      index,
      chars: textOf(b).length,
      cacheControl: b.cache_control ?? null,
      firstLine: textOf(b).split('\n', 1)[0]?.slice(0, 100) ?? '',
    })),
    toolCount: tools.length,
    deferredNotLoaded: stillDeferred,
    tools: tools.map(t => ({
      name: toolName(t),
      descriptionChars: typeof t.description === 'string' ? t.description.length : 0,
      schemaChars: JSON.stringify(t.input_schema ?? {}).length,
      sha256: sha256(JSON.stringify(t)),
    })),
    otherRequests: sides,
  }
  return { system, messages: renderMessages(body), tools, meta }
}

/** The body with the per-install identifier dropped: `metadata.user_id` carries a device id and, with a real config, an account uuid. */
const redacted = (body: Json | null): Json => ({ ...body, ...(body && 'metadata' in body ? { metadata: '<redacted>' } : {}) })

export function writeExtraction(out: string, first: Seen, e: Extraction): void {
  mkdirSync(join(out, 'tools'), { recursive: true })
  writeFileSync(join(out, 'system.txt'), e.system)
  writeFileSync(join(out, 'messages.txt'), `${e.messages}\n`)
  writeFileSync(join(out, 'tools.json'), `${JSON.stringify(e.tools, null, 2)}\n`)
  for (const tool of e.tools) {
    const file = fileSafe(toolName(tool))
    writeFileSync(join(out, 'tools', `${file}.txt`), typeof tool.description === 'string' ? tool.description : '')
    writeFileSync(join(out, 'tools', `${file}.schema.json`), `${JSON.stringify(tool.input_schema ?? {}, null, 2)}\n`)
  }
  writeFileSync(join(out, 'request.json'), `${JSON.stringify(redacted(first.body), null, 2)}\n`)
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(e.meta, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Running claude
// ---------------------------------------------------------------------------

async function claudeVersion(bin: string): Promise<string> {
  const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text.trim() || 'unknown'
}

export type Mode = 'interactive' | 'print'

export type Options = {
  bin: string
  out: string | null
  model: string | null
  prompt: string
  config: string | null
  timeoutSecs: number
  loadDeferred: boolean
  /** Extra variables for the child, set last. */
  env?: Record<string, string>
  mode: Mode
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
const TUI_BOOT_QUIET_MS = 1500
const SETTLE_QUIET_MS = 2500

/**
 * A config dir that starts the TUI straight at the prompt: onboarding done, the stub key
 * pre-approved (it would otherwise ask), the work dir trusted. Shape is that of 2.1.x; a
 * version that adds a dialog stalls at it, and the error carries the screen so it can be seen.
 */
function seedConfig(config: string, cwd: string): void {
  mkdirSync(config, { recursive: true })
  const seed = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    numStartups: 10,
    customApiKeyResponses: { approved: [STUB_KEY.slice(-20)], rejected: [] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
  }
  writeFileSync(join(config, '.claude.json'), JSON.stringify(seed))
}

/** Runs `claude -p` to completion; what it printed is the failure evidence. */
async function driveChild(argv: string[], cwd: string, env: Record<string, string>, timeoutSecs: number) {
  const proc = Bun.spawn(argv, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutSecs * 1000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return `claude -p exited ${code}\nstdout: ${stdout.slice(0, 400)}\nstderr: ${stderr.slice(0, 400)}`
}

/**
 * Runs the real TUI on a pty: waits for the screen to go quiet, types the prompt, then waits
 * until the stub has stopped hearing from it (and the ToolSearch round trip, if owed, is in).
 * The timeout is not an error by itself — whatever agent-loop requests arrived are extracted.
 */
async function driveTui(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutSecs: number,
  prompt: string,
  stub: { seen: Seen[] },
  asked: () => boolean,
) {
  let screen = ''
  let lastData = Date.now()
  const decoder = new TextDecoder()
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal, data) {
        screen += decoder.decode(data)
        lastData = Date.now()
      },
    },
  })
  const deadline = Date.now() + timeoutSecs * 1000
  const tail = () => `screen: ${screen.replace(ANSI_RE, '').slice(-600)}`
  try {
    if (!proc.terminal) throw new Error('no pty on this platform; use --mode=print')
    while (Date.now() - lastData < TUI_BOOT_QUIET_MS || screen === '') {
      if (Date.now() > deadline) return `TUI never went quiet\n${tail()}`
      await sleep(200)
    }
    proc.terminal.write(`${prompt}\r`)
    let count = 0
    let changedAt = Date.now()
    while (Date.now() < deadline) {
      await sleep(250)
      if (stub.seen.length !== count) {
        count = stub.seen.length
        changedAt = Date.now()
      }
      const mains = mainRequests(stub.seen).length
      const owed = asked() && mains < 2
      if (mains > 0 && !owed && Date.now() - changedAt > SETTLE_QUIET_MS) break
    }
    return tail()
  } finally {
    // An open pty keeps Bun's event loop alive after the child is gone, so close it, and make sure the child is.
    proc.kill()
    if ((await Promise.race([proc.exited, sleep(3000)])) === undefined) proc.kill('SIGKILL')
    proc.terminal?.close()
  }
}

export async function runExtraction(options: Options): Promise<{ out: string; extraction: Extraction }> {
  const version = await claudeVersion(options.bin)
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
  const cwd = WORK_DIR
  const config = options.config ?? join(SCRATCH, 'config')
  if (options.config === null && options.mode === 'interactive') seedConfig(config, cwd)
  const script = scriptedResponder(options.loadDeferred)
  const stub = startStub(script.respond)

  const env: Record<string, string> = { TERM: options.mode === 'interactive' ? 'xterm-256color' : 'dumb' }
  for (const name of INHERITED_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  Object.assign(env, proxyEnv(stub.url), {
    ANTHROPIC_API_KEY: STUB_KEY,
    CLAUDE_CONFIG_DIR: config,
    CLAUDIN_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }, options.env ?? {})

  const modelArgs = options.model ? ['--model', options.model] : []
  try {
    const evidence =
      options.mode === 'interactive'
        ? await driveTui([options.bin, ...modelArgs], cwd, env, options.timeoutSecs, options.prompt, stub, script.asked)
        : await driveChild(
            [options.bin, '-p', options.prompt, '--output-format', 'json', ...modelArgs],
            cwd,
            env,
            options.timeoutSecs,
          )

    const mains = mainRequests(stub.seen)
    const first = mains[0]
    const last = mains[mains.length - 1]
    if (!first || !last) {
      const seenLines = stub.seen.map(s => `  ${s.path} kind=${s.body ? requestKind(s.body) : 'unparsed'}`).join('\n')
      throw new Error(
        `no agent-loop request reached the stub (${options.mode} mode).\nrequests seen: ${stub.seen.length}${seenLines ? `\n${seenLines}` : ''}\n${evidence}`,
      )
    }
    const extraction = extract(first, last, stub.seen, { version, bin: options.bin, mode: options.mode })
    const out = options.out ?? join(tmpdir(), `claude-code-prompt-${version.split(' ')[0]}-${options.mode}`)
    writeExtraction(out, first, extraction)
    return { out, extraction }
  } finally {
    stub.close()
    rmSync(SCRATCH, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`
  const hit = argv.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : null
}

function summary(out: string, e: Extraction): string {
  const lines = [
    `Claude Code ${e.meta.claudeCode} · ${e.meta.mode} · model ${e.meta.model} · written to ${out}`,
    '',
    `system: ${e.meta.systemChars} chars in ${(e.meta.systemBlocks as unknown[]).length} block(s), sha256 ${String(e.meta.systemSha256).slice(0, 12)}`,
  ]
  for (const b of e.meta.systemBlocks as { index: number; chars: number; firstLine: string }[]) {
    lines.push(`  [${b.index}] ${String(b.chars).padStart(6)}  ${b.firstLine}`)
  }
  lines.push('', `tools: ${e.meta.toolCount}   (description / schema chars)`)
  const tools = e.meta.tools as { name: string; descriptionChars: number; schemaChars: number }[]
  for (const t of tools) {
    lines.push(`  ${t.name.padEnd(28)} ${String(t.descriptionChars).padStart(6)} / ${String(t.schemaChars).padStart(6)}`)
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const bin = flag(argv, 'bin') ?? process.env.CLAUDE_BIN ?? Bun.which('claude')
  if (!bin) {
    console.error('claude not found on PATH; pass --bin=PATH or set CLAUDE_BIN')
    process.exit(2)
  }
  const { out, extraction } = await runExtraction({
    bin,
    out: flag(argv, 'out'),
    model: flag(argv, 'model'),
    prompt: flag(argv, 'prompt') ?? DEFAULT_PROMPT,
    config: flag(argv, 'config'),
    timeoutSecs: Number(flag(argv, 'timeout') ?? DEFAULT_TIMEOUT_SECS),
    loadDeferred: !argv.includes('--no-deferred'),
    mode: flag(argv, 'mode') === 'print' ? 'print' : 'interactive',
    env: Object.fromEntries(
      argv
        .filter(a => a.startsWith('--env='))
        .map(a => a.slice('--env='.length))
        .map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
    ),
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
  console.log(summary(out, extraction))
  process.exit(0)
}
