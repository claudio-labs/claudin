#!/usr/bin/env bun
/**
 * ANTI_NARRATION × progress updates A/B.
 *
 * With `thinking.display: "updates"`, Opus 5.5 and Fable 5.1 write a progress
 * update before a tool call: a sentence for the person watching, returned as
 * the text of its own `thinking` block. Claudin's ANTI_NARRATION bullets tell
 * the model to chain tool calls silently. Does that suppress the updates the
 * TUI is about to render? Until "updates" existed this was unmeasurable — under
 * the default "omitted" every such block comes back empty.
 *
 * The decision rule was registered before the first run, and it reads range
 * OVERLAP of progress updates per tool call, per model:
 *   - the ON and OFF ranges overlap → ANTI_NARRATION stays as it is
 *   - OFF separated above ON → first an explicit carve-out for progress
 *     updates, re-run; removal only if the carve-out does not recover them
 *   - OFF only brings text narration back → ANTI_NARRATION stays
 *
 * Arms: ONE build, the default against `CLAUDIN_ANTI_NARRATION=0`. Both run
 * with `CLAUDIN_THINKING_DISPLAY=updates`, since headless `-p` would otherwise
 * get "omitted". The task is three-cli-ab.ts's fixture and grader (15 files, 5
 * edits, a build), so a run that got cheaper by skipping work cannot pass.
 * Arm order alternates per rep so neither arm always pays the cold cache.
 *
 * `--arms=on,off,carveout` adds the rule's second step as a third arm, run in
 * the same pass instead of a later round: the default prompt plus the
 * carve-out sentence through --append-system-prompt. It is exploratory — the
 * registered decision reads ON against OFF only.
 *
 * `--dry` sends one request per arm to a local mock — zero tokens — and checks
 * what the result depends on:
 * - the narration text is in the ON arm's system prompt and gone from OFF's
 * - both carry `display:"updates"` and its beta
 * A killswitch the build ignores would make the two arms identical and the A/B
 * would measure noise.
 *
 * Usage:
 *   bun scripts/bench/ab/narration-updates-ab.ts --dry
 *   bun scripts/bench/ab/narration-updates-ab.ts --reps=3
 *   bun scripts/bench/ab/narration-updates-ab.ts --reps=3 --models=claude-opus-5-5 --json=/tmp/n.json
 */
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'
import { parseJsonl, scalarsFrom, timelineFrom } from './cliUsage'
import { SENTINEL, buildPrompt, buildWorkspace, verify, type Verdict } from './three-cli-ab'

type Arm = 'on' | 'off' | 'carveout'

const argv = process.argv.slice(2)
const opt = (name: string, dflt: string): string =>
  argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DRY = argv.includes('--dry')
const BIN = opt('bin', 'claudindev')
const MODELS = opt('models', 'claude-opus-5-5,claude-fable-5-1').split(',').filter(Boolean)
const REPS = Math.max(1, Number(opt('reps', '3')) || 3)
const TIMEOUT_MS = Number(opt('timeout-ms', String(15 * 60_000)))
const JSON_OUT = opt('json', '')
const PORT = Number(opt('port', '8815'))
const ARMS = opt('arms', 'on,off').split(',').filter((a): a is Arm => a === 'on' || a === 'off' || a === 'carveout')

// The carve-out candidate, worded as it would ship in the harness bullets.
const CARVE_OUT =
  'The silence rule covers text only. A one-sentence progress update before a tool call — what you just found and what you will do next — is welcome: it is shown to the user as a status line, not as a message.'
const armArgs = (arm: Arm): string[] => (arm === 'carveout' ? ['--append-system-prompt', CARVE_OUT] : [])

// Present in the ON arm's system prompt, absent from OFF's: one line of the
// harness bullets and one of the anthropic-family addendum, the two places
// the killswitch subtracts.
const NARRATION_MARKERS = ['Chain tool calls silently', 'four checkpoints']
const UPDATES_BETA = 'thinking-display-updates-2026-08-18'

function childEnv(arm: Arm, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDIN_') || key.startsWith('CLAUDE_CODE_')) {
      delete env[key]
    }
  }
  env.CLAUDIN_THINKING_DISPLAY = 'updates'
  // Headless -p drains auto-backgrounded sub-agents non-deterministically.
  env.CLAUDIN_DISABLE_BACKGROUND_TASKS = '1'
  if (arm === 'off') env.CLAUDIN_ANTI_NARRATION = '0'
  return { ...env, ...extra }
}

// ---------------------------------------------------------------------------
// --dry: prove the two arms differ where they should, and only there.
// ---------------------------------------------------------------------------

async function dry(): Promise<void> {
  const seen: Array<{ betas: string[]; body: any }> = []
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
        const betas = String(req.headers['anthropic-beta'] ?? '').split(',').map(s => s.trim())
        seen.push({ betas, body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          [
            'event: message_start',
            `data: {"type":"message_start","message":{"id":"msg_dry","type":"message","role":"assistant","model":"${body?.model ?? 'x'}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}`,
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
  await new Promise<void>(r => server.listen(PORT, () => r()))
  const cwd = join(tmpdir(), 'wire-matrix-cwd')
  mkdirSync(cwd, { recursive: true })
  let failed = 0
  try {
    for (const model of MODELS) {
      for (const arm of ARMS) {
        seen.length = 0
        await new Promise<void>(resolve => {
          const child = spawn(BIN, ['-p', 'hi', '--model', model, '--output-format', 'text', '--no-session-persistence', ...armArgs(arm)], {
            cwd,
            env: childEnv(arm, {
              ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
              CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL: '1',
            }),
            stdio: ['ignore', 'ignore', 'ignore'],
          })
          const kill = setTimeout(() => child.kill('SIGTERM'), 90_000)
          child.on('close', () => {
            clearTimeout(kill)
            resolve()
          })
        })
        const req = seen.find(s => s.body?.model === model)
        const system = JSON.stringify(req?.body?.system ?? '')
        const narration = NARRATION_MARKERS.map(m => system.includes(m))
        const display = req?.body?.thinking?.display
        const beta = req?.betas.includes(UPDATES_BETA) ?? false
        const wantNarration = arm !== 'off'
        const carveOutPresent = system.includes('The silence rule covers text only')
        const ok =
          req !== undefined &&
          narration.every(n => n === wantNarration) &&
          carveOutPresent === (arm === 'carveout') &&
          display === 'updates' &&
          beta
        if (!ok) failed++
        console.log(
          `  ${ok ? '✓' : '✗'} ${model.padEnd(18)} ${arm.padEnd(8)} narration markers=${narration.join('/')} carve-out=${carveOutPresent} display=${display} beta=${beta}${req ? '' : ' (no request captured)'}`,
        )
      }
    }
  } finally {
    server.close()
  }
  console.log(failed ? `\n${failed} arm(s) not as expected — do not run the live A/B.` : '\nboth arms differ exactly where they should.')
  if (failed) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// Live runs.
// ---------------------------------------------------------------------------

type Block = { type?: string; text?: string; thinking?: string }

type Run = {
  model: string
  arm: Arm
  rep: number
  exitCode: number
  wallMs: number
  verdict: Verdict
  sawSentinel: boolean
  toolUses: number
  progressUpdates: number
  updatesPerTool: number
  updateChars: number
  narrationTexts: number
  narrationChars: number
  turns: number | null
  outputTokens: number
  costUsd: number | null
  samples: string[]
}

/**
 * One entry per API response of the main thread, blocks in order. Claudin
 * streams each content block as its own assistant event under the response's
 * id; a sub-agent's events carry a parent_tool_use_id and are left out.
 *
 * Deduplicated by event uuid: `claudindev -p --output-format stream-json
 * --verbose` printed every assistant event twice on 2026-09-23, and the first
 * run of this bench counted each block twice because of it.
 */
function responsesFrom(events: Record<string, unknown>[]): Block[][] {
  const byId = new Map<string, Block[]>()
  const seenEvents = new Set<string>()
  let anon = 0
  for (const v of events) {
    if (v.type !== 'assistant' || v.parent_tool_use_id) continue
    if (typeof v.uuid === 'string') {
      if (seenEvents.has(v.uuid)) continue
      seenEvents.add(v.uuid)
    }
    const msg = (v.message ?? {}) as { id?: string; content?: Block[] }
    const id = msg.id ?? `anon-${anon++}`
    const list = byId.get(id) ?? []
    for (const b of msg.content ?? []) list.push(b)
    byId.set(id, list)
  }
  return [...byId.values()]
}

function runOne(model: string, arm: Arm, rep: number): Run {
  const cwd = buildWorkspace()
  const t0 = performance.now()
  const res = spawnSync(
    BIN,
    [
      '-p',
      buildPrompt(),
      '--model',
      model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      ...armArgs(arm),
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 128 * 1024 * 1024,
      env: childEnv(arm),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const wallMs = performance.now() - t0
  const stdout = res.stdout ?? ''
  const events = parseJsonl(stdout)
  const responses = responsesFrom(events)

  let toolUses = 0
  let progressUpdates = 0
  let updateChars = 0
  let narrationTexts = 0
  let narrationChars = 0
  const samples: string[] = []
  for (const blocks of responses) {
    const usesTools = blocks.some(b => b.type === 'tool_use')
    for (const b of blocks) {
      if (b.type === 'tool_use') toolUses++
      // Under "updates" a reasoning block comes back empty; only a progress
      // update carries text (the API docs' own rule for rendering them).
      if (b.type === 'thinking' && (b.thinking ?? '').trim()) {
        progressUpdates++
        updateChars += b.thinking!.trim().length
        if (samples.length < 4) samples.push(b.thinking!.trim().slice(0, 160))
      }
      if (b.type === 'text' && usesTools && (b.text ?? '').trim()) {
        narrationTexts++
        narrationChars += b.text!.trim().length
      }
    }
  }
  const verdict = verify(cwd)
  rmSync(cwd, { recursive: true, force: true })
  const scalars = scalarsFrom(events)
  const outputTokens = timelineFrom([events]).reduce((n, r) => n + r.out, 0)
  return {
    model,
    arm,
    rep,
    exitCode: res.status ?? -1,
    wallMs,
    verdict,
    sawSentinel: stdout.includes(SENTINEL),
    toolUses,
    progressUpdates,
    updatesPerTool: toolUses > 0 ? progressUpdates / toolUses : 0,
    updateChars,
    narrationTexts,
    narrationChars,
    turns: scalars.numTurns,
    outputTokens,
    costUsd: scalars.costUsd,
    samples,
  }
}

const median = (v: number[]): number => {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const range = (v: number[]): [number, number] => [Math.min(...v), Math.max(...v)]
const f2 = (n: number): string => n.toFixed(2)

function summarize(runs: Run[]): string {
  const lines: string[] = []
  for (const model of MODELS) {
    lines.push(`\n### ${model}\n`)
    lines.push('| arm | pass | updates/tool (median, range) | progress updates | text narration blocks | turns | output tok | cost |')
    lines.push('|---|---|---|---|---|---|---|---|')
    const ranges: Partial<Record<Arm, [number, number]>> = {}
    for (const arm of ARMS) {
      const rs = runs.filter(r => r.model === model && r.arm === arm)
      if (rs.length === 0) continue
      const upt = rs.map(r => r.updatesPerTool)
      ranges[arm] = range(upt)
      const cost = rs.map(r => r.costUsd ?? 0)
      const label = arm === 'on' ? 'ANTI_NARRATION on' : arm === 'off' ? 'ANTI_NARRATION=0' : 'on + carve-out'
      lines.push(
        `| ${label} | ${rs.filter(r => r.verdict.ok).length}/${rs.length} | ${f2(median(upt))} (${f2(ranges[arm]![0])}–${f2(ranges[arm]![1])}) | ${median(rs.map(r => r.progressUpdates))} | ${median(rs.map(r => r.narrationTexts))} | ${median(rs.map(r => r.turns ?? 0))} | ${median(rs.map(r => r.outputTokens))} | $${median(cost).toFixed(3)} |`,
      )
    }
    const on = ranges.on
    const off = ranges.off
    if (on && off) {
      const overlap = on[0] <= off[1] && off[0] <= on[1]
      lines.push(
        `\nupdates per tool call: ${overlap ? 'OVERLAP → ANTI_NARRATION stays as it is' : off[0] > on[1] ? 'SEPARATED, OFF above ON → try the carve-out first' : 'SEPARATED, ON above OFF'}`,
      )
    }
    const carve = ranges.carveout
    if (on && carve) {
      const overlap = on[0] <= carve[1] && carve[0] <= on[1]
      lines.push(
        `carve-out vs ON (exploratory): ${overlap ? 'OVERLAP' : carve[0] > on[1] ? 'SEPARATED, carve-out above ON' : 'SEPARATED, ON above carve-out'}`,
      )
    }
    const sample = runs.find(r => r.model === model && r.samples.length)?.samples ?? []
    if (sample.length) {
      lines.push('\nsample progress updates:')
      for (const s of sample) lines.push(`- ${JSON.stringify(s)}`)
    }
  }
  return lines.join('\n')
}

function live(): void {
  console.log(`narration-updates-ab — ${BIN}, models=${MODELS.join(',')}, reps=${REPS}, arms ${ARMS.join('/')}, display=updates`)
  const runs: Run[] = []
  for (const model of MODELS) {
    for (let rep = 1; rep <= REPS; rep++) {
      // Rotate so each arm takes each slot, and none always pays the cold cache.
      const shift = (rep - 1) % ARMS.length
      const order: Arm[] = [...ARMS.slice(shift), ...ARMS.slice(0, shift)]
      for (const arm of order) {
        const r = runOne(model, arm, rep)
        runs.push(r)
        console.log(
          `  ${model} ${arm.padEnd(8)} rep ${rep}: ${r.verdict.ok ? 'PASS' : 'FAIL'} exit=${r.exitCode} tools=${r.toolUses} updates=${r.progressUpdates} (${f2(r.updatesPerTool)}/tool) text-narration=${r.narrationTexts} turns=${r.turns} out=${r.outputTokens} cost=${r.costUsd?.toFixed(3) ?? '?'} ${Math.round(r.wallMs / 1000)}s`,
        )
      }
    }
  }
  const summary = summarize(runs)
  console.log(summary)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const md = join(REPO_ROOT, 'scripts', 'bench', 'results', `narration-updates-ab-${stamp}.md`)
  writeFileSync(
    md,
    `# narration-updates-ab — ${new Date().toISOString()}\n\n${BIN}, reps=${REPS}, CLAUDIN_THINKING_DISPLAY=updates, arms: ${ARMS.join(', ')} (on = default prompt, off = CLAUDIN_ANTI_NARRATION=0, carveout = default + the carve-out sentence).\n${summary}\n`,
  )
  console.log(`\nresults → ${md}`)
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true })
    writeFileSync(JSON_OUT, JSON.stringify(runs, null, 2))
    console.log(`json → ${JSON_OUT}`)
  }
}

if (DRY) await dry()
else live()
