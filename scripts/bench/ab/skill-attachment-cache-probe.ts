#!/usr/bin/env bun
// Skill + attachment cache probe: does a Skill whose prompt command emits a
// turn-start attachment make the NEXT turn rewrite the cached prefix?
//
// The Skill tool runs its prompt command like a user turn, so the attachment
// pipeline adds turn-start attachments (task_reconcile, auto_mode) after the
// skill body. Until 2026-10-01 the loop rendered each tool message alone, so
// in-turn that attachment went out as a text block AFTER the skill body, and
// from the next turn on — rendered with the whole history — inside the
// "Launching skill" tool_result. Opus 5.5 binds every thinking block to the
// bytes before it: at the next turn's first request the server dropped the
// thinking that followed (input_transformations: thinking_dropped,
// prefix_binding_mismatch) and the prefix from there was written again.
// See src/agent/query/toolResultMessages.ts.
//
// One process per rep, two user turns over stream-json, in a throwaway git
// repo that carries a `demo` skill:
//   turn 1  TaskCreate + TaskUpdate in_progress (the open task is what makes
//           the Skill's prompt command emit task_reconcile), the Skill, then
//           the skill's Bash steps
//   turn 2  a one-line question
// The verdict comes from the session transcript: the turn-2 opening request's
// thinking drops and its cache_read against the previous request's prompt.
//
// Measured 2026-10-01 (Opus 5.5, effort high, 3 reps each, same time):
//   claudin 1.1.39  rewritten 3/3: 3 thinking blocks dropped from messages.9,
//                   opening read 18.7k against a 19.7k previous prompt
//   branch          rewritten 0/3: opening read = previous prompt − 2 tokens
// The prompt here is small, so the lookback still finds an entry a few
// positions back; in a long session the read falls to the system floor.
//
// Exit 1 when a rep's opening dropped thinking or read back < previous prompt
// − 2k; exit 2 when no rep produced the shape (Skill + attachment, then
// thinking) — the model did not follow the script, nothing was measured.
//
// Usage:
//   bun run scripts/bench/ab/skill-attachment-cache-probe.ts --bin=claudindev --reps=3
//   bun run scripts/bench/ab/skill-attachment-cache-probe.ts --bin=claudin --reps=3

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, transcriptPath } from './headlessProbe.ts'

// A probe launched from inside a claudin session would inherit that session's
// switches (display, killswitches, the session marker).
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/
const MAX_LOST_TOKENS = 2_000

const SKILL = `---
name: demo
description: Demo checks for this repo. Use when asked to run the demo skill.
---

Run these checks in order:

1. Work out N = (sum of the digits of 4876213) * 13 - (number of primes below 30), then run \`echo N\` with Bash.
2. Run \`ls -la\` with Bash and count the entries.
3. Run \`date +%Y\` with Bash.
4. Reply with one line per step.
`
const TURN_1 =
  'First create one task with TaskCreate ("Run demo checks") and mark it in_progress with TaskUpdate. ' +
  'Then load the demo skill with the Skill tool and carry out all of its steps. Do not update the task afterwards.'
const TURN_2 = 'Thanks. Separate question: is 221 prime? One line.'

type Json = Record<string, any>
type Call = { id: string; ctx: number; read: number; write: number; drops: string[]; thinking: boolean }
type Rep = {
  verdict: 'kept' | 'REWRITTEN' | 'no-shape'
  attachment: string | null
  opening?: Call
  previous?: Call
  newDrops: string[]
}

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-attachment-cache-probe-'))
  mkdirSync(join(cwd, '.claudin/skills/demo'), { recursive: true })
  writeFileSync(join(cwd, '.claudin/skills/demo/SKILL.md'), SKILL)
  writeFileSync(join(cwd, 'README.md'), '# demo\n')
  spawnSync('git', ['init', '-q'], { cwd })
  spawnSync('git', ['add', '.'], { cwd })
  spawnSync('git', ['-c', 'user.email=probe@example.com', '-c', 'user.name=probe', 'commit', '-qm', 'init'], { cwd })
  return cwd
}

/** Two user turns in one process; resolves with the session id. */
async function runTwoTurns(bin: string, model: string, cwd: string, timeoutMs: number): Promise<string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_ENV_RE.test(k)) env[k] = v
  Object.assign(env, { CLAUDIN_ENABLE_TASKS: '1', CLAUDIN_THINKING_DISPLAY: 'updates' })
  const child = spawn(
    bin,
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', model, '--effort', 'high', '--permission-mode', 'auto'],
    { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] },
  )
  let sessionId = ''
  let buf = ''
  const waiting: (() => void)[] = []
  child.stdout.on('data', (d: Buffer) => {
    buf += String(d)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      try {
        const event = JSON.parse(line) as Json
        if (typeof event.session_id === 'string') sessionId = event.session_id
        if (event.type === 'result') waiting.shift()?.()
      } catch {
        // stream-json carries nothing but JSON lines
      }
    }
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  const closed = new Promise(res => child.on('close', res))
  const send = (text: string) =>
    Promise.race([
      new Promise<void>(res => {
        waiting.push(res)
        child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
      }),
      closed,
    ])
  await send(TURN_1)
  await send(TURN_2)
  child.stdin.end()
  await closed
  clearTimeout(timer)
  return sessionId
}

export function judge(transcript: string): Rep {
  const records = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Json)
  const calls = new Map<string, Call>()
  const order: string[] = []
  let skillUseId: string | null = null
  let afterSkillResult = false
  let attachment: string | null = null
  let thinkingAfterSkill = false
  let turn2Seen = false
  let openingId: string | null = null
  for (const r of records) {
    if (r.isSidechain) continue
    const m = r.message
    if (r.type === 'assistant' && m?.id && m.usage) {
      let c = calls.get(m.id)
      if (!c) {
        const u = m.usage
        c = {
          id: m.id,
          ctx: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
          read: u.cache_read_input_tokens,
          write: u.cache_creation_input_tokens,
          drops: (m.input_transformations ?? []).filter((t: Json) => t.type === 'thinking_dropped').map((t: Json) => t.path),
          thinking: false,
        }
        calls.set(m.id, c)
        order.push(m.id)
        if (turn2Seen && !openingId) openingId = m.id
      }
      for (const b of m.content ?? []) {
        if (b.type === 'thinking') c.thinking = true
        if (b.type === 'tool_use' && b.name === 'Skill' && !skillUseId) skillUseId = b.id
      }
      if (afterSkillResult && c.thinking && !turn2Seen) thinkingAfterSkill = true
      continue
    }
    if (r.type === 'user' && Array.isArray(m?.content) && skillUseId) {
      if (m.content.some((b: Json) => b.type === 'tool_result' && b.tool_use_id === skillUseId)) afterSkillResult = true
    }
    if (r.type === 'user' && typeof m?.content === 'string' && m.content === TURN_2) turn2Seen = true
    if (r.type === 'attachment' && afterSkillResult && !attachment && !turn2Seen) {
      attachment = r.attachment?.type ?? 'unknown'
    }
  }
  if (!attachment || !thinkingAfterSkill || !openingId) return { verdict: 'no-shape', attachment, newDrops: [] }
  const opening = calls.get(openingId)!
  const previous = calls.get(order[order.indexOf(openingId) - 1]!)!
  const newDrops = opening.drops.filter(p => !previous.drops.includes(p))
  const rewritten = newDrops.length > 0 || opening.read < previous.ctx - MAX_LOST_TOKENS
  return { verdict: rewritten ? 'REWRITTEN' : 'kept', attachment, opening, previous, newDrops }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { model: 'claude-opus-5-5', timeoutMs: 600_000 })
  const reps: Rep[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    const cwd = makeRepo()
    const sessionId = await runTwoTurns(args.bin, args.model!, cwd, args.timeoutMs)
    const transcript = transcriptPath(cwd, sessionId)
    if (!sessionId || !existsSync(transcript)) {
      console.log(`rep ${rep}: no transcript (session ${sessionId || 'none'})`)
      continue
    }
    const r = judge(transcript)
    reps.push(r)
    const o = r.opening
    const p = r.previous
    console.log(
      `rep ${rep}: ${r.verdict.padEnd(9)} attachment=${r.attachment ?? '-'}` +
        (o && p
          ? ` prev ctx=${p.ctx} → opening read=${o.read} write=${o.write} new thinking drops=${r.newDrops.length}` +
            (r.newDrops.length ? ` (first messages.${Math.min(...r.newDrops.map(d => Number(d.split('.')[1])))})` : '')
          : '') +
        `  ${transcript}`,
    )
  }
  const measured = reps.filter(r => r.verdict !== 'no-shape')
  const rewritten = measured.filter(r => r.verdict === 'REWRITTEN').length
  console.log(`\n=== SKILL ATTACHMENT CACHE PROBE bin=${args.bin} measured=${measured.length}/${args.reps} rewritten=${rewritten} ===`)
  process.exit(measured.length === 0 ? 2 : rewritten > 0 ? 1 : 0)
}

if (import.meta.main) main()
