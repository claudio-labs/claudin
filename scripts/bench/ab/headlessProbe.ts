// Shared harness for the headless `-p` probes in this directory.
//
// One `runHeadless` call = one `claudindev -p --output-format stream-json`
// run in a caller-chosen cwd, parsed into what every probe asks for: the
// per-API-call usage (deduped by `message.id`, since the stream repeats a
// message once per content block), the tool_result texts, the `system`
// records, the final `result` text and the session id. Probes assert on
// those and print their own tables.
//
// What headless does NOT emit, measured 2026-09-08: the REPL's `[Cache: …]`
// line (it is `useOnQuery` code, never reached under `-p`), so a probe that
// needs cache-break attribution passes `--debug` via `extraArgs` and reads
// `<configDir>/debug/<sessionId>.txt` (`debugLogPath`) — that is where
// `[PROMPT CACHE BREAK] …` lands — or checks `cacheBreakDiffs()` for a new
// `cache-break-*.diff` in the temp dir.
//
// Always run in a throwaway cwd and never `-c`: headless resume is keyed by
// the project dir, so `-c` inside the repo hijacks the user's live session.

import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export type ProbeArgs = {
  bin: string
  reps: number
  model?: string
  timeoutMs: number
}

export function parseArgs(argv: string[], defaults: Partial<ProbeArgs> = {}): ProbeArgs {
  const a: ProbeArgs = { bin: 'claudindev', reps: 3, timeoutMs: 300_000, ...defaults }
  for (const s of argv) {
    if (s.startsWith('--bin=')) a.bin = s.slice(6)
    else if (s.startsWith('--reps=')) a.reps = Number(s.slice(7))
    else if (s.startsWith('--model=')) a.model = s.slice(8)
    else if (s.startsWith('--timeout=')) a.timeoutMs = Number(s.slice(10))
  }
  return a
}

export type Usage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }
}

export type Call = {
  id: string
  /** Tool names in this message, in order (one per tool_use block). */
  tools: string[]
  /** The tool_use ids, parallel to `tools`. */
  toolUseIds: string[]
  cr: number
  cc: number
  in: number
  out: number
  usage: Usage
}

export type ToolResult = {
  toolUseId: string
  /** Name of the tool that produced it, when its tool_use was seen. */
  name?: string
  text: string
  isError: boolean
}

export type HeadlessRun = {
  calls: Call[]
  toolResults: ToolResult[]
  /** Text of every `system` record (init included), in order. */
  systemLines: string[]
  finalText: string
  sessionId: string
  totalCostUsd: number
  stderr: string
  exitCode: number | null
}

export type RunOptions = {
  bin: string
  model?: string
  cwd: string
  prompt: string
  env?: Record<string, string>
  timeoutMs: number
  extraArgs?: string[]
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .join('')
}

export async function runHeadless(opts: RunOptions): Promise<HeadlessRun> {
  const cli = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    ...(opts.model ? ['--model', opts.model] : []),
    opts.prompt,
    // After the prompt on purpose: `--debug [filter]` takes an optional
    // value and would swallow the prompt as its filter if it came first.
    ...(opts.extraArgs ?? []),
  ]
  const child = spawn(opts.bin, cli, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  const calls = new Map<string, Call>()
  const order: string[] = []
  const seenToolUse = new Set<string>()
  const toolNameById = new Map<string, string>()
  const toolResults: ToolResult[] = []
  const systemLines: string[] = []
  let finalText = ''
  let sessionId = ''
  let totalCostUsd = 0
  let buf = ''
  const onLine = (line: string): void => {
    if (!line.startsWith('{')) return
    let v: Record<string, unknown>
    try { v = JSON.parse(line) } catch { return }
    if (typeof v.session_id === 'string' && !sessionId) sessionId = v.session_id
    if (v.type === 'system') {
      const text = typeof v.text === 'string' ? v.text : typeof v.content === 'string' ? v.content : JSON.stringify(v).slice(0, 400)
      systemLines.push(`${String(v.subtype ?? '')}: ${text}`)
      return
    }
    if (v.type === 'result') {
      if (typeof v.result === 'string') finalText = v.result
      if (typeof v.total_cost_usd === 'number') totalCostUsd = v.total_cost_usd
      return
    }
    const m = (v.message ?? {}) as Record<string, unknown>
    const content = (m.content ?? []) as Array<Record<string, unknown>>
    if (v.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result') continue
        const id = String(b.tool_use_id ?? '')
        toolResults.push({
          toolUseId: id,
          name: toolNameById.get(id),
          text: textOf(b.content),
          isError: b.is_error === true,
        })
      }
      return
    }
    if (v.type !== 'assistant') return
    const id = String(m.id ?? '')
    if (!id) return
    const u = (m.usage ?? {}) as Usage
    let c = calls.get(id)
    if (!c) {
      c = { id, tools: [], toolUseIds: [], cr: 0, cc: 0, in: 0, out: 0, usage: u }
      calls.set(id, c)
      order.push(id)
    }
    if ((u.output_tokens ?? 0) >= (c.usage.output_tokens ?? 0)) c.usage = u
    c.cr = c.usage.cache_read_input_tokens ?? 0
    c.cc = c.usage.cache_creation_input_tokens ?? 0
    c.in = c.usage.input_tokens ?? 0
    c.out = c.usage.output_tokens ?? 0
    for (const b of content) {
      if (b.type !== 'tool_use') continue
      const tid = String(b.id ?? '')
      if (seenToolUse.has(tid)) continue
      seenToolUse.add(tid)
      c.tools.push(String(b.name))
      c.toolUseIds.push(tid)
      toolNameById.set(tid, String(b.name))
    }
  }
  child.stdout!.on('data', d => {
    buf += String(d)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, nl).trim())
      buf = buf.slice(nl + 1)
    }
  })
  const stderr: string[] = []
  child.stderr!.on('data', d => stderr.push(String(d)))
  const timer = setTimeout(() => child.kill(), opts.timeoutMs)
  const exitCode = await new Promise<number | null>(res => child.on('close', code => res(code)))
  clearTimeout(timer)
  if (buf.trim()) onLine(buf.trim())
  if (order.length === 0) {
    console.error('no assistant messages; stderr head:', stderr.join('').slice(0, 400))
  }
  return {
    calls: order.map(id => calls.get(id)!),
    toolResults,
    systemLines,
    finalText,
    sessionId,
    totalCostUsd,
    stderr: stderr.join(''),
    exitCode,
  }
}

/** The config dir, honouring `CLAUDIN_CONFIG_DIR` the way the app does. */
export function configDir(): string {
  return process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
}

/** Where `--debug` writes a session's log (`[PROMPT CACHE BREAK] …` lives there). */
export function debugLogPath(sessionId: string): string {
  return join(configDir(), 'debug', `${sessionId}.txt`)
}

export function readDebugLog(sessionId: string): string {
  try {
    return readFileSync(debugLogPath(sessionId), 'utf8')
  } catch {
    return ''
  }
}

/** The app's temp dir (`getClaudeTempDir`): `<tmpdir>/claude-<uid>`. */
export function claudeTempDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid'
  return join(tmpdir(), `claude-${uid}`)
}

/** `cache-break-*.diff` files in the temp dir modified at or after `sinceMs`. */
export function cacheBreakDiffs(sinceMs: number): string[] {
  let names: string[]
  try {
    names = readdirSync(claudeTempDir())
  } catch {
    return []
  }
  return names
    .filter(n => n.startsWith('cache-break-') && n.endsWith('.diff'))
    .map(n => join(claudeTempDir(), n))
    .filter(p => {
      try {
        return statSync(p).mtimeMs >= sinceMs
      } catch {
        return false
      }
    })
}

/** The transcript `.jsonl` the app wrote for a session started in `cwd`. */
export function transcriptPath(cwd: string, sessionId: string): string {
  return join(configDir(), 'projects', cwd.replace(/\//g, '-'), `${sessionId}.jsonl`)
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!
}
