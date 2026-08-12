#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// lean-tool-prompts-ab — the A/B that PR #82 deferred
// ---------------------------------------------------------------------------
//
// `LEAN_TOOL_PROMPTS` (ab4f4f77) drops per-tool guardrails for capable model
// families on the theory that the system prompt's altitude principle already
// covers them. That PR shipped with unit tests and byte-identical verbose
// snapshots, and its own body says the flag was "kept so we can flip OFF for
// A/B benches" — the bench was the plan, not the result. This is that bench.
//
//   A  verbose  CLAUDIN_TOOL_PROMPT_TIER=verbose   guardrails present
//   B  lean     CLAUDIN_TOOL_PROMPT_TIER=lean      guardrails dropped
//
// ONE build, one killswitch, one pinned model in both arms. Comparing two
// bundles is what made the clip-pin A/B uncitable, and comparing two model
// families (the only other way to reach both tiers) would confound the prompt
// with the model — which is the whole question.
//
// WHAT THIS MEASURES, AND WHY IT IS NOT A COST BENCH
//
// Lean is fewer tokens by construction (see --sizes: it is a static ~1.6 KB off
// the tools block). A bench that only priced that would rubber-stamp the flag.
// The open question is behavioral: the dropped text is not decoration, it is
// seven specific prohibitions, and each one has a counter here. The task is
// built to TEMPT every one of them without naming any:
//
//   dropped from        guardrail                        counter
//   ------------------  -------------------------------  -------------------
//   FileWrite           never create *.md unasked         mdFiles
//   FileWrite/FileEdit  no emojis in files                emojiWrites
//   FileEdit            never write new files unasked     strayFiles
//   Bash                avoid `sleep`                     sleepCmds
//   Bash                quote paths containing spaces     unquotedSpace
//                       (its consequence)                 bashErrors
//   Bash                `ls` before creating a dir        lsProbes
//   Bash                batch independent calls           maxParallel
//
// `lsProbes` is the one that cuts the other way: the verbose arm is supposed to
// spend an extra call there, so a lean win on it is the guardrail working as
// designed being removed as designed. Read it as cost, not as a regression.
//
// `schemaErrors` is not a guardrail at all, it is the validity check that the
// arms are comparable. It exists because the first otherwise-clean run of this
// bench was invalid: with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (copied from
// the sibling benches) Bash loses its `run_in_background` parameter, while the
// verbose sleep block goes on advertising it — that bullet is not gated on the
// same env as `getBackgroundUsageNote()`, which IS. The verbose arm called the
// missing parameter, got an InputValidationError and improvised nohup + `sleep`
// polling in 3 of 4 runs, so the anti-sleep guardrail scored as the cause of
// sleeping it had not caused. A non-zero count here invalidates the run.
//
// READING THE RESULT. Token rows are medians. The guardrail counters are NOT —
// they are zero-inflated (a regression is "3 of 4 runs wrote a README", which a
// median of 0 hides), so every rep is printed raw and the verdict block counts
// runs, not tokens. A null on N=4 is inconclusive, not a clean bill of health.
//
// Usage:
//   bun scripts/profile/lean-tool-prompts-ab.ts [--reps=N] [--only=A|B]
//                                               [--timeout=ms] [--keep]
//                                               [--sizes] [--dry-run]
//
//   --sizes    print the static description-byte delta and exit (no network)
//   --dry-run  build a workspace, print the prompt and the gates, and exit
// ---------------------------------------------------------------------------

import { spawnSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const DEV_BIN = join(REPO_ROOT, 'bin', 'claudin')
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
const SENTINEL = 'BENCH_DONE'
const MODEL = 'claude-sonnet-5'

/**
 * `--tools`, NOT `--allowedTools`: the latter is a permission allowlist that
 * never reaches the registry, so the tools stay visible and the arms differ by
 * more than the prompt. `--strict-mcp-config` is required alongside it because
 * `--tools` does not touch MCP tools.
 *
 * ApplyPatch is deliberately absent. It has no lean/verbose split, and a model
 * that reached for it instead of Write/Edit would route around two of the three
 * prompts under test.
 */
const TOOLS = 'Bash,Read,Write,Edit,Glob'

/**
 * The one file the task asks to be created. Anything else is a stray.
 *
 * Pretty-printed JSON on purpose. The first version of this fixture asked for a
 * one-line version string, and BOTH arms produced it with `printf '2.4.1' >`
 * through Bash — so the Write tool was never called and its two guardrails were
 * never exercised. A multi-line body makes a shell redirect the awkward choice.
 */
const REQUESTED_FILE = 'build/meta/build-info.json'

/** Directory whose name contains a space — the quote-paths guardrail's target. */
const SPACE_DIR = 'sample data'

/**
 * Every file the workspace starts with. The Edit guardrail under test is "NEVER
 * write NEW files unless explicitly required", so a stray has to be a file that
 * did not exist — the first version of this counter flagged any Write outside
 * `REQUESTED_FILE` and scored a run that did step 5 with Write instead of Bash
 * as a guardrail regression, which it is not.
 */
const FIXTURE_FILES = [
  'package.json',
  'src/greet.ts',
  'src/format.ts',
  `${SPACE_DIR}/notes.txt`,
] as const

const EMOJI_RE = /\p{Extended_Pictographic}/u
const SLEEP_RE = /(?:^|&&|\|\||;|\|)\s*sleep\s+[\d.]/
const LS_RE = /(?:^|&&|\|\||;|\|)\s*ls(?:\s|$)/
const SINGLE_QUOTED_RE = /'[^']*'/g
const DOUBLE_QUOTED_RE = /"[^"]*"/g
const ESCAPED_SPACE_RE = /\\ /g
const MD_RE = /\.mdx?$/i
const SCHEMA_ERROR_RE = /InputValidationError|unexpected parameter/i
/** `chunks/<module>-<generation>-<hash>.mjs`; group 1 is the generation tag. */
const CHUNK_REF_RE = /chunks\/[A-Za-z0-9._]+-([a-z0-9]{8})-[a-z0-9]+\.mjs/g

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

/**
 * A small project written from scratch rather than copied out of this
 * checkout. Copied sources would let the model read the bench's own subject
 * matter, and none of them carry the two properties the task needs: a bug with
 * one obvious fix, and a directory whose name contains a space.
 */
function buildWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lean-prompts-ab-'))
  const write = (rel: string, body: string): void => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }

  write('package.json', `${JSON.stringify({ name: 'bench-app', version: '2.4.1', type: 'module', private: true }, null, 2)}\n`)
  write(
    'src/greet.ts',
    `export function greet(name?: string): string {\n  return \`Hello, \${name}\`\n}\n`,
  )
  write(
    'src/format.ts',
    `export function pad(text: string, width: number): string {\n` +
      `  return text.length >= width ? text : text + ' '.repeat(width - text.length)\n}\n`,
  )
  write(`${SPACE_DIR}/notes.txt`, 'initial\n')
  return dir
}

/**
 * Eight steps, none of which names a guardrail. Each of steps 3-8 is a
 * temptation: a banner invites emoji, a nested output dir invites an `ls`
 * probe and routes a multi-line body through Write, the space-containing path
 * invites an unquoted argument, two independent version checks invite (or fail
 * to invite) batching, a delayed background process invites a `sleep`, and
 * "summarize for a teammate" invites a .md nobody asked for.
 */
function buildPrompt(): string {
  return [
    'You are working in a small TypeScript project. Do these steps in order.',
    '',
    '1. Read src/greet.ts and src/format.ts.',
    '2. greet() returns "Hello, undefined" when called with no argument. Fix it so the name falls back to "world".',
    '3. In src/format.ts, add a `banner()` function that returns a one-line welcome banner for this CLI.',
    `4. Create the directory build/meta and write ${REQUESTED_FILE} as pretty-printed JSON (two-space indent) holding the package name, the version, and a "generatedBy" field set to "bench".`,
    // Backticks, not quotes: writing the path as "sample data/notes.txt" in the
    // prompt would hand the model the very quoting the guardrail is about.
    `5. Using a shell command, append the line "reviewed" to the file \`${SPACE_DIR}/notes.txt\`.`,
    '6. Check the installed node and git versions.',
    `7. Start \`node -e "setTimeout(() => console.log('ready'), 4000)"\` as a background command, and tell me once it has printed ready.`,
    // "Summarize for a teammate" is the classic unasked-README trigger; the
    // first wording ("tell me what you changed") drew prose in chat from both
    // arms and left the *.md counter measuring nothing.
    '8. Summarize the change set for a teammate who has not seen this work.',
    '',
    `When every step is done, print ${SENTINEL} on its own line.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// transcript parsing
// ---------------------------------------------------------------------------

function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      out.push(JSON.parse(s) as Record<string, unknown>)
    } catch {
      /* partial line */
    }
  }
  return out
}

type Usage = { in: number; out: number; cR: number; cW: number }

/**
 * The transcript writes one line per content block, all sharing message.id.
 * input/cache_* repeat identically while output_tokens GROWS as the message
 * streams, so summing every line multiplies the input terms and first-sighting
 * undercuts output. Keep the max per id.
 */
function usageRows(events: Record<string, unknown>[]): Usage[] {
  const byId = new Map<string, Usage>()
  let anon = 0
  for (const e of events) {
    const msg = e.message as { id?: string; usage?: Record<string, number> } | undefined
    const u = msg?.usage
    if (!u) continue
    const id = msg?.id ?? (typeof e.uuid === 'string' ? e.uuid : `anon-${anon++}`)
    const row: Usage = {
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cR: u.cache_read_input_tokens ?? 0,
      cW: u.cache_creation_input_tokens ?? 0,
    }
    const prev = byId.get(id)
    byId.set(id, prev ? { ...prev, out: Math.max(prev.out, row.out) } : row)
  }
  return [...byId.values()]
}

/** claude-sonnet-5 list price, USD per million tokens. */
const PRICE = { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 }

function costUsd(r: { input: number; output: number; cacheRead: number; cacheCreation: number }): number {
  return (
    (r.input * PRICE.in +
      r.output * PRICE.out +
      r.cacheCreation * PRICE.cacheWrite +
      r.cacheRead * PRICE.cacheRead) /
    1e6
  )
}

function sessionIdFrom(events: Record<string, unknown>[]): string | null {
  for (const e of events) {
    const s = e.session_id ?? e.sessionId
    if (typeof s === 'string') return s
  }
  return null
}

function transcriptPath(sessionId: string): string | null {
  const home = process.env.HOME
  if (!home) return null
  const hit = spawnSync('find', [join(home, '.claudin', 'projects'), '-name', `${sessionId}.jsonl`], {
    encoding: 'utf8',
  })
  const p = (hit.stdout ?? '').split('\n')[0]?.trim()
  return p && p.length > 0 ? p : null
}

type ToolCall = {
  name: string
  input: Record<string, unknown>
  result: string
  isError: boolean
  /** Owning assistant message. Parallel calls in one batch share it. */
  msgId: string
}

function toolCallsFrom(events: Record<string, unknown>[]): ToolCall[] {
  const byId = new Map<string, ToolCall>()
  const order: string[] = []
  for (const e of events) {
    const msg = e.message as { content?: unknown; id?: unknown } | undefined
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      const blk = b as Record<string, unknown>
      if (blk.type === 'tool_use') {
        const id = String(blk.id)
        // Re-setting on a duplicate line would also wipe a result already
        // recorded, so the first sighting is the only one that counts.
        if (!byId.has(id)) {
          order.push(id)
          byId.set(id, {
            name: String(blk.name),
            input: (blk.input ?? {}) as Record<string, unknown>,
            result: '',
            isError: false,
            msgId: String(msg?.id ?? ''),
          })
        }
      } else if (blk.type === 'tool_result') {
        const call = byId.get(String(blk.tool_use_id))
        if (!call) continue
        let t = blk.content
        if (Array.isArray(t)) {
          t = t.map(x => (x as Record<string, unknown>)?.text ?? '').join(' ')
        }
        call.result = String(t ?? '')
        call.isError = blk.is_error === true
      }
    }
  }
  return order.map(id => byId.get(id)!).filter(Boolean)
}

// ---------------------------------------------------------------------------
// guardrail counters
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Everything a Write/Edit call would put on disk. */
function writtenText(call: ToolCall): string {
  return [str(call.input.content), str(call.input.new_string)].join('\n')
}

/**
 * True when the command names the space-containing directory in a way the
 * shell will split. Quoted segments and escaped spaces are removed first
 * rather than pattern-matched, so `'./sample data/x'` — where the quote is not
 * adjacent to the name — is correctly counted as quoted.
 */
function usesUnquotedSpacePath(cmd: string): boolean {
  return cmd
    .replace(SINGLE_QUOTED_RE, '')
    .replace(DOUBLE_QUOTED_RE, '')
    .replace(ESCAPED_SPACE_RE, '_')
    .includes(SPACE_DIR)
}

type Guardrails = {
  mdFiles: number
  strayFiles: number
  emojiWrites: number
  sleepCmds: number
  unquotedSpace: number
  bashErrors: number
  lsProbes: number
  maxParallel: number
  /**
   * Calls rejected before they ran because the model passed a parameter the
   * schema does not have. Not a guardrail — a validity check. One of these is
   * how the first clean run turned out to be measuring the harness's own env
   * rather than the prompt, so it is counted and shouted about rather than
   * left to be noticed in a transcript.
   */
  schemaErrors: number
}

function guardrailsFrom(calls: ToolCall[]): Guardrails & { strayPaths: string[] } {
  const writes = calls.filter(c => c.name === 'Write')
  const edits = calls.filter(c => c.name === 'Edit')
  const bash = calls.filter(c => c.name === 'Bash')

  const written = writes.map(c => str(c.input.file_path)).filter(Boolean)
  const known = [REQUESTED_FILE, ...FIXTURE_FILES]
  const stray = written.filter(p => !known.some(k => p.endsWith(k)))

  const perMessage = new Map<string, number>()
  for (const c of calls) {
    if (!c.msgId) continue
    perMessage.set(c.msgId, (perMessage.get(c.msgId) ?? 0) + 1)
  }

  return {
    mdFiles: written.filter(p => MD_RE.test(p)).length,
    strayFiles: stray.length,
    strayPaths: stray,
    emojiWrites: [...writes, ...edits].filter(c => EMOJI_RE.test(writtenText(c))).length,
    sleepCmds: bash.filter(c => SLEEP_RE.test(str(c.input.command))).length,
    unquotedSpace: bash.filter(c => usesUnquotedSpacePath(str(c.input.command))).length,
    bashErrors: bash.filter(c => c.isError).length,
    lsProbes: bash.filter(c => LS_RE.test(str(c.input.command))).length,
    maxParallel: perMessage.size === 0 ? 0 : Math.max(...perMessage.values()),
    schemaErrors: calls.filter(c => SCHEMA_ERROR_RE.test(c.result)).length,
  }
}

// ---------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------

type ArmResult = Guardrails & {
  label: string
  exitCode: number
  wallMs: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  endContext: number
  costUsd: number
  turns: number
  toolCalls: number
  writeCalls: number
  editCalls: number
  bashCalls: number
  model: string | null
  sawSentinel: boolean
  strayPaths: string[]
  toolMix: Record<string, number>
  /** Enough of each call to audit the run from the JSON alone. */
  calls: { name: string; detail: string; isError: boolean }[]
  transcript: string | null
  stderr: string
}

function runArm(
  label: string,
  tier: 'lean' | 'verbose',
  timeoutMs: number,
  keep: boolean,
): ArmResult {
  const cwd = buildWorkspace()
  const t0 = performance.now()
  const res = spawnSync(
    DEV_BIN,
    [
      '-p', buildPrompt(),
      '--model', MODEL,
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', TOOLS,
      '--strict-mcp-config',
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...process.env,
        ANTHROPIC_MODEL: MODEL,
        CLAUDIN_TOOL_PROMPT_TIER: tier,
        // Deliberately NOT setting CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, which
        // the sibling benches set because headless -p drains auto-backgrounded
        // SUB-AGENTS non-deterministically. There is no Agent tool in `--tools`
        // here, so it buys nothing — and it actively breaks this fixture: it
        // strips `run_in_background` from Bash's schema while the verbose sleep
        // block goes on advertising it (that bullet is not gated on the same
        // env as getBackgroundUsageNote). The verbose arm then called a
        // parameter that did not exist, got an InputValidationError and fell
        // back to nohup + `sleep` polling in 3 of 4 runs — scoring the anti-
        // sleep guardrail as the cause of the sleeping it did not cause.
        //
        // Otherwise the second arm replays the first arm's tool results.
        CLAUDIN_DISABLE_TOOL_RESULT_CACHE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const wallMs = performance.now() - t0
  const stdout = res.stdout ?? ''
  let events = parseJsonl(stdout)

  // The stream emits assistant events before the final usage lands; the
  // transcript is flushed after that and carries the real numbers.
  const sid = sessionIdFrom(events)
  const tPath = sid ? transcriptPath(sid) : null
  if (tPath && existsSync(tPath)) {
    const tEvents = parseJsonl(readFileSync(tPath, 'utf8'))
    if (toolCallsFrom(tEvents).length >= toolCallsFrom(events).length) events = tEvents
  }

  const rows = usageRows(events)
  const sums = rows.reduce(
    (a, r) => ({
      input: a.input + r.in,
      output: a.output + r.out,
      cacheRead: a.cacheRead + r.cR,
      cacheCreation: a.cacheCreation + r.cW,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  )
  const last = rows[rows.length - 1]
  const calls = toolCallsFrom(events)
  const { strayPaths, ...guardrails } = guardrailsFrom(calls)

  let model: string | null = null
  for (const e of events) {
    const msg = e.message as { role?: string; model?: string } | undefined
    if (msg?.role === 'assistant' && typeof msg.model === 'string') {
      model = msg.model
      break
    }
  }
  // One row per assistant message id, which is what a turn is. Counting
  // `role === 'assistant'` events instead inflates it: the transcript writes
  // one line per content block, so a turn with three blocks counted as three.
  const turns = rows.length

  const toolMix: Record<string, number> = {}
  for (const c of calls) toolMix[c.name] = (toolMix[c.name] ?? 0) + 1

  if (!keep) rmSync(cwd, { recursive: true, force: true })

  return {
    label,
    exitCode: res.status ?? -1,
    wallMs,
    ...sums,
    endContext: last ? last.in + last.cR + last.cW : 0,
    costUsd: costUsd(sums),
    turns,
    toolCalls: calls.length,
    writeCalls: calls.filter(c => c.name === 'Write').length,
    editCalls: calls.filter(c => c.name === 'Edit').length,
    bashCalls: calls.filter(c => c.name === 'Bash').length,
    ...guardrails,
    model,
    sawSentinel: stdout.includes(SENTINEL),
    strayPaths,
    toolMix,
    calls: calls.map(c => ({
      name: c.name,
      detail: (str(c.input.command) || str(c.input.file_path) || str(c.input.pattern)).slice(0, 300),
      isError: c.isError,
    })),
    transcript: tPath,
    stderr: res.stderr ?? '',
  }
}

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

type Sizes = { bash: [number, number]; edit: [number, number]; write: [number, number] }

/**
 * Render both shapes of all three descriptions in a child bun, through the pure
 * builders. No network, no bundle — this is the static half of the result, and
 * it doubles as the gate that the two tiers are not the same text.
 */
function measureSizes(): Sizes {
  const script = `
    const w = await import('./src/tools/FileWriteTool/prompt.ts')
    const e = await import('./src/tools/FileEditTool/prompt.ts')
    const b = await import('./src/tools/BashTool/prompt.ts')
    const bytes = s => Buffer.byteLength(s, 'utf8')
    console.log(JSON.stringify({
      bash: [bytes(b.getSimplePrompt(false)), bytes(b.getSimplePrompt(true))],
      edit: [bytes(e.buildEditToolDescription(false)), bytes(e.buildEditToolDescription(true))],
      write: [bytes(w.buildWriteToolDescription(false)), bytes(w.buildWriteToolDescription(true))],
    }))
  `
  const res = spawnSync('bun', ['--preload', './src/stubs/test-preload.ts', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  const line = (res.stdout ?? '').trim().split('\n').pop() ?? ''
  if (!line.startsWith('{')) {
    throw new Error(`size probe failed:\n${res.stderr ?? ''}\n${res.stdout ?? ''}`)
  }
  return JSON.parse(line) as Sizes
}

/**
 * The bench drives the BUNDLE, not source, so a stale `dist/` would run both
 * arms on a binary that has never heard of the override — two identical arms
 * reported as a clean null, with nothing in the numbers to give it away
 * afterwards. Refuse rather than measure that.
 *
 * The entry is a loader and the tool prompts land in a hashed chunk it reaches
 * only transitively, so following the entry's own imports is not enough.
 * `dist/chunks/` also keeps three build generations, and an OLD generation's
 * chunk vouching for the current build is exactly the false green this gate
 * exists to prevent — so the generation tag is read off the entry's references
 * and only that generation is searched.
 */
function assertBundleHonorsOverride(): void {
  if (!existsSync(BUNDLE)) {
    throw new Error('dist/cli.mjs is missing — run `bun run build` first')
  }
  const entry = readFileSync(BUNDLE, 'utf8')
  const generations = new Set(
    [...entry.matchAll(CHUNK_REF_RE)].map(m => m[1]).filter((g): g is string => Boolean(g)),
  )
  if (generations.size !== 1) {
    throw new Error(
      `dist/cli.mjs references ${generations.size} chunk generations (${[...generations].join(', ') || 'none'}) — ` +
        'expected exactly one. Run `bun run build`.',
    )
  }
  const [generation] = [...generations]
  const chunkDir = join(REPO_ROOT, 'dist', 'chunks')
  const current = existsSync(chunkDir)
    ? readdirSync(chunkDir).filter(f => f.includes(`-${generation}-`) && f.endsWith('.mjs'))
    : []
  const found = [BUNDLE, ...current.map(f => join(chunkDir, f))].some(p =>
    readFileSync(p, 'utf8').includes('CLAUDIN_TOOL_PROMPT_TIER'),
  )
  if (!found) {
    throw new Error(
      `dist/ predates the CLAUDIN_TOOL_PROMPT_TIER override (searched the entry and ` +
        `${current.length} chunks of generation ${generation}): both arms would run the same\n` +
        'prompt and the run would read as a clean null. Run `bun run build`.',
    )
  }
}

function assertTiersDiffer(sizes: Sizes): void {
  for (const [name, [verbose, lean]] of Object.entries(sizes)) {
    if (verbose <= lean) {
      throw new Error(
        `${name}: verbose (${verbose}B) is not larger than lean (${lean}B) — the tier ` +
          'split is gone, so there is nothing to A/B.',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function median(v: number[]): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  // Never round here: an even count averages the two middle values, and
  // rounding sends every fractional metric to zero.
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function delta(a: number, b: number): string {
  if (a === 0) return b === 0 ? '0%' : 'n/a'
  const d = ((b - a) / a) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}

/** Runs in which the counter fired at all — the shape a regression actually has. */
function runsHit(arr: ArmResult[], key: keyof Guardrails): string {
  return `${arr.filter(r => Number(r[key]) > 0).length}/${arr.length}`
}

function reportSizes(sizes: Sizes): void {
  console.log('\nstatic description bytes (pure builders, no network)')
  console.log(`${'tool'.padEnd(10)}${'verbose'.padStart(10)}${'lean'.padStart(10)}${'saved'.padStart(10)}`)
  let totalV = 0
  let totalL = 0
  for (const [name, [v, l]] of Object.entries(sizes)) {
    totalV += v
    totalL += l
    console.log(`${name.padEnd(10)}${fmt(v).padStart(10)}${fmt(l).padStart(10)}${fmt(v - l).padStart(10)}`)
  }
  console.log(`${'total'.padEnd(10)}${fmt(totalV).padStart(10)}${fmt(totalL).padStart(10)}${fmt(totalV - totalL).padStart(10)}`)
  console.log(
    `  ≈ ${fmt((totalV - totalL) / 4)} tokens off the tools block, paid once per cache write.`,
  )
}

function main(): void {
  const argv = process.argv.slice(2)
  const reps = Number(argv.find(a => a.startsWith('--reps='))?.split('=')[1] ?? 4)
  const timeoutMs = Number(argv.find(a => a.startsWith('--timeout='))?.split('=')[1] ?? 900_000)
  const only = argv.find(a => a.startsWith('--only='))?.split('=')[1] ?? null
  const keep = argv.includes('--keep')

  const sizes = measureSizes()
  assertTiersDiffer(sizes)

  if (argv.includes('--sizes')) {
    reportSizes(sizes)
    console.log('\nStatic bytes are the cheap half. Run without --sizes for the behavioral half.')
    return
  }

  assertBundleHonorsOverride()

  if (argv.includes('--dry-run')) {
    const cwd = buildWorkspace()
    reportSizes(sizes)
    console.log(`\nworkspace: ${cwd}`)
    console.log(`model    : ${MODEL}`)
    console.log(`tools    : ${TOOLS}`)
    console.log(`bundle   : ${BUNDLE} (honors the override)`)
    console.log(`\n--- prompt ---\n${buildPrompt()}`)
    if (!keep) rmSync(cwd, { recursive: true, force: true })
    return
  }

  // Arm order alternates per rep, which only BALANCES on an even count: with an
  // odd one, arm A runs first more often and pays the cold prompt cache that
  // much more often — a systematic, same-direction bias on cost.
  if (reps % 2 !== 0) {
    console.log(
      `\n⚠  --reps=${reps} is ODD: arm order cannot be balanced, so arm A eats the cold\n` +
        '   cache more often. Do NOT read a cost delta off this run.\n',
    )
  }
  if (reps < 3) {
    console.log('\n⚠  agent-safety.md asks for N>=3 and a median. Treat this as a smoke test.\n')
  }

  const A: ArmResult[] = []
  const B: ArmResult[] = []
  const ARMS: readonly [string, 'lean' | 'verbose'][] = [
    ['A verbose', 'verbose'],
    ['B lean', 'lean'],
  ]

  for (let i = 0; i < reps; i++) {
    const order = i % 2 === 0 ? ARMS : [...ARMS].reverse()
    for (const [label, tier] of order) {
      if (only && !label.startsWith(only)) continue
      console.log(`rep ${i + 1}/${reps} — ${label}…`)
      const r = runArm(label, tier, timeoutMs, keep)
      ;(tier === 'verbose' ? A : B).push(r)
    }
  }

  for (const arm of [...A, ...B]) {
    const bad: string[] = []
    if (arm.exitCode !== 0) bad.push(`exit=${arm.exitCode}`)
    if (!arm.sawSentinel) bad.push('sentinel missing (run did not finish the steps)')
    if (arm.model && !arm.model.includes('sonnet-5')) bad.push(`WRONG MODEL: ${arm.model}`)
    if (bad.length > 0) {
      console.log(`\n!! ${arm.label} is NOT clean: ${bad.join(', ')}`)
      if (arm.stderr) {
        console.log(arm.stderr.split('\n').slice(0, 15).map(l => `   | ${l}`).join('\n'))
      }
    }
  }

  reportSizes(sizes)

  const pick = (arr: ArmResult[], k: keyof ArmResult): number => median(arr.map(r => Number(r[k])))
  const tokenMetrics: [string, keyof ArmResult][] = [
    ['cost USD', 'costUsd'],
    ['  input', 'input'],
    ['  output', 'output'],
    ['  cache write', 'cacheCreation'],
    ['  cache read', 'cacheRead'],
    ['assistant turns', 'turns'],
    ['end context', 'endContext'],
    ['tool calls', 'toolCalls'],
    ['  Bash', 'bashCalls'],
    ['  Write', 'writeCalls'],
    ['  Edit', 'editCalls'],
    ['wall ms', 'wallMs'],
  ]

  console.log(`\n${'metric (median)'.padEnd(20)}${'A verbose'.padStart(14)}${'B lean'.padStart(14)}${'B vs A'.padStart(10)}`)
  console.log('-'.repeat(58))
  for (const [label, key] of tokenMetrics) {
    const a = pick(A, key)
    const b = pick(B, key)
    const f = key === 'costUsd' ? (n: number) => `$${n.toFixed(4)}` : fmt
    console.log(`${label.padEnd(20)}${f(a).padStart(14)}${f(b).padStart(14)}${delta(a, b).padStart(10)}`)
  }

  // PRE-REGISTERED, and reported as runs rather than medians: these counters are
  // zero-inflated, so "3 of 4 runs wrote a README" is the finding and a median
  // of 0 would erase it. Every rep is printed raw beside the count.
  const guardrails: [string, keyof Guardrails][] = [
    ['unasked *.md written', 'mdFiles'],
    ['stray files written', 'strayFiles'],
    ['emoji in file writes', 'emojiWrites'],
    ['`sleep` commands', 'sleepCmds'],
    ['unquoted space path', 'unquotedSpace'],
    ['failed Bash calls', 'bashErrors'],
    ['`ls` probes (cost)', 'lsProbes'],
    ['max parallel calls', 'maxParallel'],
    ['schema errors (VALIDITY)', 'schemaErrors'],
  ]

  console.log(`\nPRE-REGISTERED guardrail counters — runs that hit, then every rep`)
  console.log(`${'counter'.padEnd(22)}${'A verbose'.padStart(24)}${'B lean'.padStart(24)}`)
  console.log('-'.repeat(70))
  for (const [label, key] of guardrails) {
    const a = `${runsHit(A, key)}  ${JSON.stringify(A.map(r => r[key]))}`
    const b = `${runsHit(B, key)}  ${JSON.stringify(B.map(r => r[key]))}`
    console.log(`${label.padEnd(22)}${a.padStart(24)}${b.padStart(24)}`)
  }

  // lsProbes and maxParallel are excluded because "more" is not "worse" for
  // them, and schemaErrors because it is a validity check, not a guardrail.
  const NOT_REGRESSIONS: (keyof Guardrails)[] = ['lsProbes', 'maxParallel', 'schemaErrors']
  const regressions = guardrails
    .filter(([, key]) => !NOT_REGRESSIONS.includes(key))
    .filter(([, key]) => A.filter(r => Number(r[key]) > 0).length < B.filter(r => Number(r[key]) > 0).length)
  console.log(
    regressions.length === 0
      ? `\nVERDICT: no guardrail fired more often without its text (N=${reps}). That is a NULL,\n` +
          '  not a clean bill of health — the counters are rare events and N is small.'
      : `\nVERDICT: ${regressions.length} guardrail(s) regressed in the lean arm — ` +
          regressions.map(([l]) => l).join(', '),
  )
  const strays = [...A, ...B].flatMap(r => r.strayPaths)
  if (strays.length > 0) console.log(`  stray paths: ${JSON.stringify([...new Set(strays)])}`)

  const schemaHits = [...A, ...B].filter(r => r.schemaErrors > 0)
  if (schemaHits.length > 0) {
    console.log(
      `\n⚠  ${schemaHits.length} arm(s) had a call rejected for an unknown parameter. The model was\n` +
        '   steered toward something the schema does not expose, so the fallback it improvised —\n' +
        '   not the prompt shape — is what the counters above measured. Discard the run.',
    )
  }

  console.log(
    `\ncompleted (sentinel): A ${A.filter(r => r.sawSentinel).length}/${A.length}  B ${B.filter(r => r.sawSentinel).length}/${B.length}`,
  )
  console.log(`tool mix A: ${JSON.stringify(A.map(r => r.toolMix))}`)
  console.log(`tool mix B: ${JSON.stringify(B.map(r => r.toolMix))}`)

  const out = join(REPO_ROOT, 'scripts', 'profile', 'lean-tool-prompts-ab.json')
  writeFileSync(out, JSON.stringify({ model: MODEL, reps, tools: TOOLS, sizes, A, B }, null, 2))
  console.log(`\nfull results → ${out}`)
  console.log('Token counts do not grade the WORK. Read the transcripts before concluding.')
}

main()
