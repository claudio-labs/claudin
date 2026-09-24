#!/usr/bin/env bun
/**
 * Read-credit E2E — the two flag-gated read features of perf/cat-read-and-batch-read,
 * driven through the BUILT bundle (bin/claudin → dist/cli.mjs) by a scripted mock
 * model. Zero real API calls. Plan: .claudin/plans/composed-squishing-twilight.md,
 * "Verificação" → E2E.
 *
 * A local mock answers every /v1/messages POST (ANTHROPIC_BASE_URL), the way
 * resume-wire-probe.ts does. It keeps no turn counter: for a main-loop request it
 * reads the last user message — the phase's prompt token, or the tool_result of a
 * tool_use it issued — and answers with the next step of the phase's script. Any
 * other request (title, forks, side queries) gets "ok". The checks read what the
 * CLI sent back in those tool_results — text and is_error, what a model would see —
 * and the files on disk after each phase.
 *
 *   1. credit on  — CLAUDIN_BASH_FILE_READ_PASSTHROUGH=1 CLAUDIN_BASH_READ_CREDIT=1
 *      p1: Bash `cat a.ts b.ts` → Patch a.ts → text; p2 (--resume): Patch b.ts → text
 *   2. credit off — p1 as in 1; the Patch is refused as never read (and not resent);
 *      p2 (--resume): Patch b.ts is refused too — the control that makes 1's p2 mean
 *      "rebuilt from the transcript" rather than "a resumed process lets it through"
 *   3. batch on   — CLAUDIN_READ_MULTI=1
 *      p1: Read file_paths [a.ts, b.ts] → Patch b.ts → text; p2 (--resume): Patch a.ts → text
 *   4. batch off  — Read file_paths → the strict schema refuses it
 *
 * a.ts carries two blank lines in a row: the pass-through has to hand the file back
 * byte for byte for the credit to find it (a floor stage folds such a run).
 *
 * Isolation. Each scenario gets a fresh workspace and a fresh CLAUDIN_CONFIG_DIR
 * under one temp dir; its two phases share them, since the resume finds the
 * transcript there. claudin takes the Anthropic API key from the active provider
 * profile and never from ANTHROPIC_API_KEY (providers/auth/auth.ts,
 * getAnthropicApiKeyWithSource), so an empty config dir has no credential at all:
 * the only thing seeded is a config.json with one Anthropic profile holding a fake
 * key and the mock's URL. Nothing of the user's config is read or written, a
 * request that escaped the mock would be refused for its key rather than billed,
 * and the host's CLAUDIN_* / CLAUDE_CODE_* / ANTHROPIC_* variables never reach the
 * child.
 *
 * Usage:
 *   bun scripts/bench/ab/read-credit-e2e.ts
 *   bun scripts/bench/ab/read-credit-e2e.ts --only=1,3 --keep
 *   bun scripts/bench/ab/read-credit-e2e.ts --bin=/path/to/launcher --model=claude-opus-5-5
 *
 * Prints each tool_result's first 200 chars and one PASS/FAIL line per expectation,
 * and exits 1 on any FAIL. The temp dir — a captures.json of every request per
 * scenario — is kept on a FAIL or with --keep.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'

type Json = Record<string, unknown>

const FLAGS = ['bin', 'model', 'only']
const SWITCHES = ['--keep']
const argv = process.argv.slice(2)
// A typo would otherwise run the defaults and say nothing.
const stray = argv.filter(x => !SWITCHES.includes(x) && !FLAGS.some(name => x.startsWith(`--${name}=`)))
if (stray.length) {
  console.error(`unknown argument ${stray.join(' ')} — flags are ${FLAGS.map(f => `--${f}=…`).join(' ')} ${SWITCHES.join(' ')}`)
  process.exit(2)
}
const flag = (name: string, fallback: string) => argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const DEFAULT_BIN = join(REPO_ROOT, 'bin', 'claudin')
const BIN = flag('bin', DEFAULT_BIN)
const MODEL = flag('model', 'claude-opus-5-5')
const ONLY = new Set(flag('only', '').split(',').map(s => s.trim()).filter(Boolean))
const KEEP = argv.includes('--keep')
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
if (BIN === DEFAULT_BIN && !existsSync(BUNDLE)) {
  console.error(`no ${BUNDLE} — the launcher runs the bundle; build it first`)
  process.exit(2)
}

const RUN_TIMEOUT_MS = 150_000
const EXCERPT_CHARS = 200
const MOCK_KEY = 'sk-ant-api03-read-credit-e2e-mock-key'
const PROFILE_ID = 'read-credit-e2e-mock'

// ---------------------------------------------------------------------------
// Workspace and script
// ---------------------------------------------------------------------------

const A_BEFORE = "export const NAME = 'alpha'"
const A_AFTER = "export const NAME = 'alpha-2'"
const B_BEFORE = "export const NAME = 'beta'"
const B_AFTER = "export const NAME = 'beta-2'"

const FILES: Readonly<Record<string, string>> = {
  'a.ts': ['export function add(a: number, b: number): number {', '  return a + b', '}', '', '', A_BEFORE, ''].join('\n'),
  'b.ts': ['export function mul(a: number, b: number): number {', '  return a * b', '}', '', B_BEFORE, ''].join('\n'),
}

type Step = { tool: string; input: Json } | { text: string }
type PhaseScript = { prompt: string; steps: Step[] }

const patchStep = (file: string, from: string, to: string): Step => ({
  tool: 'Patch',
  input: { patchText: ['*** Begin Patch', `*** Update File: ${file}`, '@@', `-${from}`, `+${to}`, '*** End Patch'].join('\n') },
})
const CAT: Step = { tool: 'Bash', input: { command: 'cat a.ts b.ts', description: 'Print a.ts and b.ts' } }
const BATCH_READ = (ws: string): Step => ({ tool: 'Read', input: { file_paths: [join(ws, 'a.ts'), join(ws, 'b.ts')] } })
const PATCH_A = patchStep('a.ts', A_BEFORE, A_AFTER)
const PATCH_B = patchStep('b.ts', B_BEFORE, B_AFTER)
const DONE: Step = { text: 'Done.' }

// ---------------------------------------------------------------------------
// Scenarios and expectations
// ---------------------------------------------------------------------------

type ToolResult = { phase: number; step: number; tool: string; text: string; isError: boolean }
type Capture = { phase: number; route: string; body: Json }
type PhaseOutcome = { sessionId?: string; exitCode: number | null; result?: string; stderrTail: string }
type ScenarioRun = {
  dir: string
  ws: string
  configDir: string
  results: Map<string, ToolResult>
  captures: Capture[]
  phases: PhaseOutcome[]
  /** Each file's content after each phase. */
  disk: Record<string, string>[]
}
type Expectation = { label: string; ok: boolean; why?: string }
type Scenario = {
  key: string
  title: string
  env: Record<string, string>
  script: (ws: string) => PhaseScript[]
  expect: (run: ScenarioRun) => Expectation[]
  info?: (run: ScenarioRun) => string[]
}

const NOT_READ = 'has not been read yet'
const CREDIT_LINE_RE = /files? printed whole — (?:they count|it counts) as read/
const CREDIT_TWO_RE = /^\(2 files printed whole — they count as read\b.*\)$/
const HEADER_A_RE = /^==> a\.ts <==$/m
const HEADER_B_RE = /^==> b\.ts <==$/m

const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? ''
const isPatchSuccess = (r: ToolResult): boolean => !r.isError && r.text.startsWith('Success.') && !r.text.includes(NOT_READ)

function resultAt(run: ScenarioRun, phase: number, step: number): ToolResult | undefined {
  return [...run.results.values()].find(r => r.phase === phase && r.step === step)
}

function onResult(run: ScenarioRun, phase: number, step: number, label: string, test: (r: ToolResult) => boolean): Expectation {
  const r = resultAt(run, phase, step)
  if (!r) return { label, ok: false, why: `no tool_result for p${phase + 1} step ${step + 1} reached the mock` }
  return { label, ok: test(r) }
}

function onDisk(run: ScenarioRun, phase: number, file: string, label: string, test: (content: string) => boolean): Expectation {
  const content = run.disk[phase]?.[file]
  if (content === undefined) return { label, ok: false, why: `phase ${phase + 1} did not run` }
  return { label, ok: test(content) }
}

const SCENARIOS: Scenario[] = [
  {
    key: '1',
    title: 'credit on',
    env: { CLAUDIN_BASH_FILE_READ_PASSTHROUGH: '1', CLAUDIN_BASH_READ_CREDIT: '1' },
    script: () => [
      { prompt: 'Show a.ts and b.ts, then rename NAME in a.ts.', steps: [CAT, PATCH_A, DONE] },
      { prompt: 'Now rename NAME in b.ts.', steps: [PATCH_B, DONE] },
    ],
    expect: run => [
      onResult(run, 0, 0, 'p1 Bash result is wrapped in <bash-output-read>', r =>
        !r.isError && r.text.startsWith('<bash-output-read>') && r.text.includes('</bash-output-read>'),
      ),
      onResult(run, 0, 0, 'p1 Bash result ends with "(2 files printed whole — they count as read…)"', r =>
        CREDIT_TWO_RE.test(lastLine(r.text)),
      ),
      onResult(run, 0, 1, 'p1 Patch a.ts with no Read succeeds (no "has not been read yet")', isPatchSuccess),
      onDisk(run, 0, 'a.ts', 'p1 a.ts is patched on disk', c => c.includes(A_AFTER)),
      onResult(run, 1, 0, 'p2 (--resume) Patch b.ts succeeds — the credit was rebuilt from the transcript', isPatchSuccess),
      onDisk(run, 1, 'b.ts', 'p2 b.ts is patched on disk', c => c.includes(B_AFTER)),
    ],
    info: run => [creditedFilesInTranscript(run)],
  },
  {
    key: '2',
    title: 'credit off',
    env: {},
    script: () => [
      { prompt: 'Show a.ts and b.ts, then rename NAME in a.ts.', steps: [CAT, PATCH_A, DONE] },
      // The control for scenario 1's p2: the same cat and the same resume, with
      // nothing credited to rebuild, leave b.ts unread.
      { prompt: 'Now rename NAME in b.ts.', steps: [PATCH_B, DONE] },
    ],
    expect: run => [
      onResult(run, 0, 0, 'p1 Bash result carries no <bash-output-read> marker', r => !r.isError && !r.text.includes('<bash-output-read>')),
      onResult(run, 0, 0, 'p1 Bash result carries no credit line', r => !CREDIT_LINE_RE.test(r.text)),
      onResult(run, 0, 1, 'p1 Patch a.ts is refused with "has not been read yet"', r => r.isError && r.text.includes(NOT_READ)),
      onDisk(run, 0, 'a.ts', 'p1 a.ts is unchanged on disk', c => c === FILES['a.ts']),
      onResult(run, 1, 0, 'p2 (--resume, control) Patch b.ts is refused with "has not been read yet"', r =>
        r.isError && r.text.includes(NOT_READ),
      ),
    ],
  },
  {
    key: '3',
    title: 'batch Read on',
    env: { CLAUDIN_READ_MULTI: '1' },
    script: ws => [
      { prompt: 'Read a.ts and b.ts, then rename NAME in b.ts.', steps: [BATCH_READ(ws), PATCH_B, DONE] },
      { prompt: 'Now rename NAME in a.ts.', steps: [PATCH_A, DONE] },
    ],
    expect: run => [
      onResult(run, 0, 0, 'p1 Read result carries both "==> a.ts <==" and "==> b.ts <=="', r =>
        !r.isError && HEADER_A_RE.test(r.text) && HEADER_B_RE.test(r.text),
      ),
      onResult(run, 0, 1, 'p1 Patch b.ts succeeds', isPatchSuccess),
      onDisk(run, 0, 'b.ts', 'p1 b.ts is patched on disk', c => c.includes(B_AFTER)),
      onResult(run, 1, 0, 'p2 (--resume) Patch a.ts succeeds — the batch was rebuilt per file', isPatchSuccess),
      onDisk(run, 1, 'a.ts', 'p2 a.ts is patched on disk', c => c.includes(A_AFTER)),
    ],
  },
  {
    key: '4',
    title: 'batch Read off',
    env: {},
    script: ws => [{ prompt: 'Read a.ts and b.ts.', steps: [BATCH_READ(ws), DONE] }],
    expect: run => [
      onResult(run, 0, 0, 'p1 Read with file_paths is refused by input validation (InputValidationError on file_paths)', r =>
        r.isError && r.text.includes('InputValidationError') && r.text.includes('file_paths'),
      ),
    ],
  },
]

// ---------------------------------------------------------------------------
// Mock model
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function blocksOf(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function toolResultText(block: Json): string {
  return blocksOf(block.content)
    .filter(b => b.type === 'text')
    .map(b => String(b.text ?? ''))
    .join('\n')
}

/** The main loop sends the tool pool; titles and other side queries send none. */
const isMainLoop = (body: Json): boolean => Array.isArray(body.tools) && body.tools.length > 5

let counter = 0

function frame(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(): string {
  return frame('message_start', {
    type: 'message_start',
    message: {
      id: `msg_e2e_${++counter}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
}

function messageEnd(stopReason: string): string {
  return (
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }) +
    frame('message_stop', { type: 'message_stop' })
  )
}

function textReply(text: string): string {
  return (
    messageStart() +
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    messageEnd('end_turn')
  )
}

function toolUseReply(id: string, name: string, input: Json): string {
  return (
    messageStart() +
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }) +
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }) +
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    messageEnd('tool_use')
  )
}

type Active = { run: ScenarioRun; phase: number; token: string; steps: Step[] }
type Issued = { run: ScenarioRun; phase: number; step: number; tool: string }

let active: Active | null = null
const issued = new Map<string, Issued>()

/**
 * The reply to one request, and how it was routed. A main-loop request whose last
 * user message answers a tool_use this phase issued gets the step after it, and
 * the tool_result is recorded; one that carries the phase's prompt token gets the
 * first step. Anything else is a side request.
 */
function route(body: Json): { sse: string; route: string } {
  const side = { sse: textReply('ok'), route: 'side' }
  if (!active || !isMainLoop(body)) return side
  const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
  const blocks = blocksOf(messages.findLast(m => m.role === 'user')?.content)
  let next: number | undefined
  for (const block of blocks) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const from = issued.get(block.tool_use_id)
    if (!from || from.run !== active.run || from.phase !== active.phase) continue
    active.run.results.set(block.tool_use_id, {
      phase: from.phase,
      step: from.step,
      tool: from.tool,
      text: toolResultText(block),
      isError: block.is_error === true,
    })
    next = Math.max(next ?? 0, from.step + 1)
  }
  if (next === undefined) {
    const said = blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
    if (!said.includes(active.token)) return side
    next = 0
  }
  const where = `p${active.phase + 1} step ${next + 1}`
  const step = active.steps[next]
  if (!step) return { sse: textReply('ok'), route: `${where}: past the script` }
  if ('text' in step) return { sse: textReply(step.text), route: `${where}: text` }
  const id = `toolu_e2e_${String(issued.size + 1).padStart(3, '0')}`
  issued.set(id, { run: active.run, phase: active.phase, step: next, tool: step.tool })
  return { sse: toolUseReply(id, step.tool, step.input), route: `${where}: ${step.tool}` }
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = req.url ?? ''
    if (path.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 100 }))
      return
    }
    if (req.method !== 'POST' || !path.includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body: Json = {}
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (isRecord(parsed)) body = parsed
    } catch (e) {
      console.error(`mock: unparseable request body on ${path}: ${e}`)
    }
    const reply = route(body)
    active?.run.captures.push({ phase: active.phase, route: reply.route, body })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(reply.sse)
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
const BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/** Stripped from the host env: the session running this script leaks its own. */
const HOST_ENV_RE = /^(?:CLAUDECODE$|CLAUDE_CODE_|_?CLAUDIN_|ANTHROPIC_)/

function childEnv(configDir: string, flags: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !HOST_ENV_RE.test(k)) env[k] = v
  }
  const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
  return {
    ...env,
    CLAUDIN_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: BASE_URL,
    // A localhost base URL otherwise flips the CLI into its non-first-party shape.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
    DISABLE_AUTOUPDATER: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...flags,
  }
}

function makeWorkspace(ws: string): void {
  mkdirSync(ws, { recursive: true })
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(ws, name), content)
}

/** The one credential claudin needs: an Anthropic profile, pointed at the mock, with a fake key. */
function seedConfig(configDir: string): void {
  mkdirSync(configDir, { recursive: true })
  const profile = { id: PROFILE_ID, name: 'read-credit e2e mock', provider: 'anthropic', baseUrl: BASE_URL, model: MODEL, apiKey: MOCK_KEY }
  const config = { providerProfiles: [profile], activeProviderProfileId: PROFILE_ID, hasCompletedOnboarding: true }
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2))
}

function runCli(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    // Async spawn: the mock shares this process, and spawnSync would starve it.
    const child = spawn(BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += String(d)))
    child.stderr.on('data', d => (stderr += String(d)))
    const kill = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS)
    child.on('error', e => (stderr += String(e)))
    child.on('close', code => {
      clearTimeout(kill)
      resolve({ code, stdout, stderr })
    })
  })
}

function jsonLines(text: string): Json[] {
  return text.split('\n').flatMap(line => {
    try {
      const parsed: unknown = JSON.parse(line)
      return isRecord(parsed) ? [parsed] : []
    } catch {
      return [] // a progress line or a partial write, not an event
    }
  })
}

const COMMON = ['--model', MODEL, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']

async function runScenario(s: Scenario, root: string): Promise<ScenarioRun> {
  const dir = join(root, `scenario-${s.key}`)
  const run: ScenarioRun = {
    dir,
    ws: join(dir, 'workspace'),
    configDir: join(dir, 'config'),
    results: new Map(),
    captures: [],
    phases: [],
    disk: [],
  }
  makeWorkspace(run.ws)
  seedConfig(run.configDir)
  const env = childEnv(run.configDir, s.env)
  let sessionId: string | undefined
  for (const [phase, script] of s.script(run.ws).entries()) {
    if (phase > 0 && !sessionId) break
    const token = `[e2e ${s.key}/p${phase + 1}]`
    const resume = phase > 0 && sessionId ? ['--resume', sessionId] : []
    active = { run, phase, token, steps: script.steps }
    const out = await runCli(['-p', `${script.prompt} ${token}`, ...resume, ...COMMON], run.ws, env)
    active = null
    const events = jsonLines(out.stdout)
    const init = events.find(e => e.type === 'system' && e.subtype === 'init')
    const result = events.findLast(e => e.type === 'result')
    const id = typeof init?.session_id === 'string' ? init.session_id : undefined
    if (phase === 0) sessionId = id
    run.phases.push({
      sessionId: id,
      exitCode: out.code,
      result: result ? `${String(result.subtype)}, num_turns ${String(result.num_turns)}` : undefined,
      stderrTail: (out.stderr || out.stdout).slice(-400),
    })
    run.disk.push(Object.fromEntries(Object.keys(FILES).map(f => [f, readFileSync(join(run.ws, f), 'utf8')])))
  }
  writeFileSync(join(dir, 'captures.json'), JSON.stringify(run.captures, null, 1))
  return run
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function findTranscript(configDir: string, sessionId: string): string | undefined {
  const projects = join(configDir, 'projects')
  if (!existsSync(projects)) return undefined
  return readdirSync(projects)
    .map(d => join(projects, d, `${sessionId}.jsonl`))
    .find(p => existsSync(p))
}

/** What `--resume` rebuilds the credit from: the Bash result's Out, as the transcript keeps it. */
function creditedFilesInTranscript(run: ScenarioRun): string {
  const id = run.phases[0]?.sessionId
  if (!id) return 'transcript: no session'
  const path = findTranscript(run.configDir, id)
  if (!path) return `transcript: none for ${id} under ${run.configDir}/projects`
  for (const entry of jsonLines(readFileSync(path, 'utf8'))) {
    const out = entry.toolUseResult
    if (isRecord(out) && Array.isArray(out.creditedFiles)) {
      return `transcript: the Bash Out carries creditedFiles ${JSON.stringify(out.creditedFiles.map(p => relative(run.ws, String(p))))}`
    }
  }
  return 'transcript: no tool result carries creditedFiles'
}

function report(s: Scenario, run: ScenarioRun): Expectation[] {
  const flags = Object.entries(s.env).map(([k, v]) => `${k}=${v}`)
  console.log(`\n== ${s.key}. ${s.title} — ${flags.length ? flags.join(' ') : 'flags unset'}`)
  run.phases.forEach((p, phase) => {
    const served = run.captures.filter(c => c.phase === phase)
    const mainLoop = served.filter(c => c.route !== 'side').length
    console.log(
      `  p${phase + 1}${phase > 0 ? ' (--resume)' : ''}: exit ${p.exitCode}, result ${p.result ?? 'none'}, ` +
        `session ${p.sessionId ?? '?'} — the mock answered ${mainLoop} main-loop and ${served.length - mainLoop} side request(s)`,
    )
    if (p.exitCode !== 0 || !p.sessionId) console.log(`    output tail: ${JSON.stringify(p.stderrTail)}`)
    const results = [...run.results.values()].filter(r => r.phase === phase).sort((x, y) => x.step - y.step)
    for (const r of results) {
      console.log(`    ${r.tool.padEnd(5)} is_error=${String(r.isError).padEnd(5)} ${JSON.stringify(r.text.slice(0, EXCERPT_CHARS))}`)
    }
  })
  for (const line of s.info?.(run) ?? []) console.log(`  info  ${line}`)
  const checks = s.expect(run)
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.why ? ` — ${c.why}` : ''}`)
  return checks
}

const chosen = SCENARIOS.filter(s => ONLY.size === 0 || ONLY.has(s.key))
const root = mkdtempSync(join(tmpdir(), 'read-credit-e2e-'))
const built = BIN === DEFAULT_BIN ? `, bundle built ${statSync(BUNDLE).mtime.toISOString()}` : ''
console.log(`${BIN} — ${MODEL}${built}; mock ${BASE_URL}; scratch ${root}`)

const checks: Expectation[] = []
try {
  for (const s of chosen) checks.push(...report(s, await runScenario(s, root)))
} finally {
  server.close()
}
const failed = checks.filter(c => !c.ok).length
console.log(`\n${checks.length - failed} PASS, ${failed} FAIL`)
if (failed === 0 && !KEEP) rmSync(root, { recursive: true, force: true })
else console.log(`kept ${root} (captures.json per scenario)`)
process.exit(failed === 0 ? 0 : 1)
