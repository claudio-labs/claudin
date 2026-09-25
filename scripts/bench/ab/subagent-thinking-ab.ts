#!/usr/bin/env bun
// Sub-agent thinking A/B: what a sub-agent spends, and what it shows, once it
// inherits the parent's thinking config instead of running with thinking off.
//
// Until 2026-09-25 every non-fork sub-agent ran with `thinkingConfig:
// {type:'disabled'}` (runAgent.ts), which sends no `thinking` field. Opus 5.5
// thinks anyway, at the server's default and under display "omitted", so the
// saving did not exist and the agent's progress updates never came back. A
// sub-agent on a model with effort now inherits the parent's config
// (src/tools/AgentTool/subagentThinking.ts); CLAUDIN_DISABLE_SUBAGENT_THINKING=1
// restores the old behavior, which is the `off` arm here.
//
// Two arms, same build, same task, run side by side in each rep:
//   off      CLAUDIN_DISABLE_SUBAGENT_THINKING=1
//   inherit  default
// Both run with CLAUDIN_THINKING_DISPLAY=updates — the interactive display, so
// a progress update comes back as text — and through wire-proxy.ts, which
// records the body of every child request and the thinking count of every
// response.
//
// Per run, for the child (a fresh Code agent; parent ids removed, forkBench):
//   thinking  the `thinking` field its requests carried ("none" when absent)
//   think     thinking tokens the API counted over its responses
//   updates   child responses that returned progress-update text
//   calls     child API calls; api = parent + child
//   cost      priced from the transcripts by --model
// and whether the parent relayed both facts.
//
// Usage:
//   bun run scripts/bench/ab/subagent-thinking-ab.ts --model=claude-opus-5-5 --reps=3
//   bun run scripts/bench/ab/subagent-thinking-ab.ts --model=claude-sonnet-4-6 --effort=medium

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { REPO_ROOT } from '../../repoRoot.ts'
import { BENCH_ENV, cost, loadSession, priceFor, range, rangesOverlap } from './forkBench.ts'
import { median, parseArgs, runHeadless } from './headlessProbe.ts'
import { proxyEnv, readProxyRecords, startWireProxy, type WireProxy } from './wire-proxy.ts'

type Arm = 'off' | 'inherit'
const ARMS: Arm[] = ['off', 'inherit']
const ARM_ENV: Record<Arm, Record<string, string>> = {
  off: { CLAUDIN_DISABLE_SUBAGENT_THINKING: '1' },
  inherit: {},
}
const MODULES = 12
// The host session's own variables would leak into the arms (session-cache-ab
// strips the same set).
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/

function makeCwd(arm: Arm, rep: number): { cwd: string; secret: number; exportsOf: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), `subagent-thinking-${arm}-${rep}-`))
  mkdirSync(join(cwd, 'src'), { recursive: true })
  const secret = 1000 + rep * 37
  const exportsOf = ['alpha', 'beta', 'gamma'].map(n => `${n}${rep}`)
  for (let i = 1; i <= MODULES; i++) {
    const names = i === 3 ? exportsOf : [`fn${i}a`, `fn${i}b`]
    const body = names.map(n => `export function ${n}(x: number): number {\n  return x + ${i}\n}\n`).join('\n')
    const constant = i === 7 ? `export const SECRET_LIMIT = ${secret}\n\n` : ''
    writeFileSync(join(cwd, 'src', `mod${i}.ts`), `// module ${i}\n${constant}${body}`)
  }
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['add', '-A'], { cwd })
  execFileSync('git', ['-c', 'user.email=b@b', '-c', 'user.name=bench', 'commit', '-q', '-m', 'fixture'], { cwd })
  return { cwd, secret, exportsOf }
}

/** The request's `thinking` field as `type[/display]`, or "none". */
function thinkingField(file: string): string {
  const body = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as { thinking?: { type?: string; display?: string } }
  return body.thinking ? [body.thinking.type, body.thinking.display].filter(Boolean).join('/') : 'none'
}

type Row = {
  arm: Arm
  rep: number
  correct: boolean
  thinking: string
  calls: number
  think: number
  updates: number
  child: number
  total: number
  api: number
}

async function runArm(arm: Arm, rep: number, args: ReturnType<typeof parseArgs>, effort: string | undefined, proxy: WireProxy): Promise<Row> {
  const { cwd, secret, exportsOf } = makeCwd(arm, rep)
  const label = `${arm}-r${rep}`
  const prompt =
    `Use the Agent tool with subagent_type "Code" (run_in_background false) and exactly this prompt: ` +
    `'In the current directory, find the module under src/ that defines SECRET_LIMIT and the module that exports a function named ${exportsOf[0]}. ` +
    `Report the value of SECRET_LIMIT and every function name that second module exports, and nothing else.' ` +
    `Then reply with the agent's report verbatim, nothing else.`
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt,
    env: { ...BENCH_ENV, ...ARM_ENV[arm], CLAUDIN_THINKING_DISPLAY: 'updates', ...proxyEnv(proxy.url(label)) },
    timeoutMs: args.timeoutMs,
    extraArgs: ['--max-turns', '30', ...(effort ? ['--effort', effort] : [])],
  })
  const session = loadSession(cwd, run.sessionId)
  const { price } = priceFor(args.model)
  const child = session.children[0]
  const childIds = new Set((child?.calls ?? []).map(c => c.id))
  const records = readProxyRecords(proxy.logDir, label).filter(r => r.response?.id && childIds.has(r.response.id))
  const fields = new Set(records.filter(r => r.reqFile).map(r => thinkingField(join(proxy.logDir, label, r.reqFile!))))
  const childCost = cost(child?.calls ?? [], price).total
  return {
    arm,
    rep,
    correct: run.finalText.includes(String(secret)) && exportsOf.every(n => run.finalText.includes(n)),
    thinking: [...fields].join(',') || '?',
    calls: child?.calls.length ?? 0,
    think: records.reduce((s, r) => s + (r.response?.thinkingTokens ?? 0), 0),
    updates: records.filter(r => (r.response?.thinkingChars ?? 0) > 0).length,
    child: childCost,
    total: childCost + cost(session.parent, price).total,
    api: session.parent.length + (child?.calls.length ?? 0),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { bin: join(REPO_ROOT, 'bin', 'claudin'), model: 'claude-opus-5-5', timeoutMs: 600_000 })
  const effort = process.argv.find(a => a.startsWith('--effort='))?.slice('--effort='.length)
  for (const k of Object.keys(process.env)) if (HOST_ENV_RE.test(k)) delete process.env[k]
  const runDir = join(tmpdir(), 'subagent-thinking-ab', new Date().toISOString().replace(/[:.]/g, '-'))
  const proxy = await startWireProxy(join(runDir, 'proxy'))
  const rows: Row[] = []
  try {
    for (let rep = 1; rep <= args.reps; rep++) {
      const reps = await Promise.all(ARMS.map(arm => runArm(arm, rep, args, effort, proxy)))
      for (const r of reps) {
        rows.push(r)
        console.log(
          `${r.arm.padEnd(7)} rep=${rep} ${r.correct ? 'PASS' : 'FAIL'} thinking=${r.thinking.padEnd(16)} calls=${r.calls} think=${String(r.think).padStart(5)} updates=${r.updates} child=$${r.child.toFixed(4)} total=$${r.total.toFixed(4)} api=${r.api}`,
        )
      }
    }
  } finally {
    await proxy.close()
  }
  writeFileSync(join(runDir, 'results.json'), JSON.stringify({ model: args.model, effort: effort ?? 'default', rows }, null, 2))
  console.log(`\n=== SUB-AGENT THINKING A/B model=${args.model} effort=${effort ?? 'default'} reps=${args.reps} → ${runDir} ===`)
  const col = (arm: Arm, pick: (r: Row) => number) => rows.filter(r => r.arm === arm).map(pick)
  for (const arm of ARMS) {
    const xs = rows.filter(r => r.arm === arm)
    console.log(
      `${arm.padEnd(7)} n=${xs.length} correct=${xs.filter(r => r.correct).length}/${xs.length} thinking=${[...new Set(xs.map(r => r.thinking))].join(' ')} ` +
        `think=${median(col(arm, r => r.think))} updates=${median(col(arm, r => r.updates))} calls=${median(col(arm, r => r.calls))} api=${median(col(arm, r => r.api))} ` +
        `child=$${median(col(arm, r => r.child)).toFixed(4)} [${range(col(arm, r => r.child), 4)}] total=$${median(col(arm, r => r.total)).toFixed(4)} [${range(col(arm, r => r.total), 4)}]`,
    )
  }
  for (const [name, pick] of [['child cost', (r: Row) => r.child], ['total cost', (r: Row) => r.total], ['api calls', (r: Row) => r.api]] as const) {
    const off = col('off', pick)
    const inherit = col('inherit', pick)
    const delta = ((median(inherit) - median(off)) / (median(off) || 1)) * 100
    console.log(`   inherit vs off, ${name}: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%, ranges ${rangesOverlap(inherit, off) ? 'OVERLAP' : 'disjoint'}`)
  }
  const bad = rows.filter(r => r.calls === 0 || !r.correct)
  console.log(`failures (no child or wrong answer): ${bad.length}`)
  process.exit(bad.length ? 1 : 0)
}

main()
