#!/usr/bin/env bun
// TTL-wait probe: what each CLI caches at which TTL, and what a sub-agent pays
// for a wait longer than five minutes.
//
// The 2026-09-26..28 census found 27 rewrites of a 5m-TTL sub-agent prefix
// after a WaitFor or a foreground Bash of 5-10 minutes ($65 of write premium in
// three days). Claudin inherited its tiering (main thread 1h, `agent:*` 5m);
// this measures it against Claude Code on the same task, through the recording
// proxy, before deciding between a keep-alive and a longer TTL.
//
// One session per arm, all arms at once. The main thread delegates to a
// sub-agent that reads two files, runs a ~6.5-minute foreground command, reads
// a third file and answers. Per arm:
//   - the TTL census of every request (`scripts/bench/tokens/ttl-census.ts`);
//   - the sub-agent's first request after the wait: cache read and the
//     5m/1h write, i.e. whether the prefix survived;
//   - keep-alive pings sent during the wait.
//
// Arms: claude (the installed Claude Code), claudindev (keep-alive on, the
// default since 2026-10-09), claudindev-noka (CLAUDIN_CACHE_KEEPALIVE=0, the
// control: the sub-agent's prefix should expire there).
//
// KNOWN GAP (2026-10-09, Opus 5.5): through this proxy the keep-alive ping
// does not keep the prefix. The claudindev arm sent its `stream: false`,
// `max_tokens: 1` ping at 4m30s (its body is saved as a req file), but the proxy
// never logged an answer for it, and the request after the wait was
// REWRITTEN, the same as in claudindev-noka. Run directly with `--debug`, the
// same task kept the prefix: `[cache keep-alive] <agentId>: read 33899
// created 0 ($0.0068)`, then read 33,899 / created 137 after a 6-min wait.
// Until the proxy carries a non-streaming request across a long idle
// connection, the claudindev arm here measures the proxy and not the
// keep-alive.
//
// Usage:
//   bun run scripts/bench/ab/ttl-wait-probe.ts [--model=claude-opus-5-5] [--wait-s=390]

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.ts'
import { classifyRequests, ttlCensus } from '../tokens/ttl-census.ts'
import { runHeadless } from './headlessProbe.ts'
import { isMessagesPath, proxyEnv, readBody, readProxyRecords, startWireProxy, type WireProxy } from './wire-proxy.ts'

type Arm = { label: string; bin: string; env: Record<string, string> }
const ARMS: Arm[] = [
  { label: 'claude', bin: 'claude', env: {} },
  { label: 'claudindev', bin: join(REPO_ROOT, 'bin', 'claudin'), env: {} },
  { label: 'claudindev-noka', bin: join(REPO_ROOT, 'bin', 'claudin'), env: { CLAUDIN_CACHE_KEEPALIVE: '0' } },
]
// The host session's own variables must not reach the arms.
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/
const FIVE_MIN_MS = 5 * 60 * 1000

function makeCwd(label: string): string {
  const cwd = mkdtempSync(join(tmpdir(), `ttl-wait-${label}-`))
  mkdirSync(join(cwd, 'notes'))
  // ~40 KB each, so the sub-agent's prefix is worth keeping.
  const filler = (tag: string) =>
    Array.from({ length: 800 }, (_, i) => `${tag} line ${i}: the quick brown fox jumps over the lazy dog`).join('\n')
  writeFileSync(join(cwd, 'notes', 'a.md'), `ALPHA-FIRST\n${filler('a')}\n`)
  writeFileSync(join(cwd, 'notes', 'b.md'), `BRAVO-FIRST\n${filler('b')}\n`)
  writeFileSync(join(cwd, 'notes', 'c.md'), `CHARLIE-FIRST\n${filler('c')}\n`)
  return cwd
}

function prompt(waitS: number): string {
  return (
    'Delegate this to a sub-agent with your agent tool and wait for it (not in the background), then reply with its answer verbatim. ' +
    "The sub-agent's task: 'Read notes/a.md and notes/b.md in full. Then run this exact shell command in the foreground and wait " +
    `for it to finish — it takes about ${Math.round(waitS / 60)} minutes, so give it a 10-minute timeout and do not run it in the background: ` +
    `python3 -c "import time; time.sleep(${waitS}); print(\\"slept\\")". ` +
    "Then read notes/c.md and answer with the first line of each of the three files, nothing else.'"
  )
}

type Verdict = { gapMin: number; read: number; write5m: number; write1h: number } | null

/** The sub-agent's first request after a gap longer than five minutes. */
function afterWait(logDir: string, label: string): { verdict: Verdict; pings: number } {
  const records = readProxyRecords(logDir, label)
    .filter(r => r.reqFile && r.status < 400 && isMessagesPath(r.path))
    .sort((a, b) => a.n - b.n)
  const requests = records.map(r => ({ body: readBody(logDir, label, r.reqFile!), usage: r.response?.usage ?? null }))
  const groups = classifyRequests(requests)
  let lastEnd: number | null = null
  let verdict: Verdict = null
  records.forEach((r, i) => {
    if (groups[i] !== 'sub-agent' || verdict) return
    const start = Date.parse(r.t)
    if (lastEnd !== null && start - lastEnd > FIVE_MIN_MS) {
      const u = (r.response?.usage ?? {}) as Record<string, unknown>
      const cc = (u.cache_creation ?? {}) as Record<string, unknown>
      verdict = {
        gapMin: (start - lastEnd) / 60_000,
        read: Number(u.cache_read_input_tokens ?? 0),
        write5m: Number(cc.ephemeral_5m_input_tokens ?? 0),
        write1h: Number(cc.ephemeral_1h_input_tokens ?? 0),
      }
    }
    lastEnd = start + r.ms
  })
  return { verdict, pings: groups.filter(g => g === 'ping').length }
}

async function runArm(arm: Arm, proxy: WireProxy, model: string, waitS: number): Promise<void> {
  const cwd = makeCwd(arm.label)
  const run = await runHeadless({
    bin: arm.bin,
    model,
    cwd,
    prompt: prompt(waitS),
    env: { ...arm.env, ...proxyEnv(proxy.url(arm.label)) },
    timeoutMs: (waitS + 900) * 1000,
  })
  const correct = ['ALPHA-FIRST', 'BRAVO-FIRST', 'CHARLIE-FIRST'].every(s => run.finalText.includes(s))
  console.log(`  ${arm.label.padEnd(14)} ${correct ? 'PASS' : 'FAIL'} exit=${run.exitCode} calls(main)=${run.calls.length}`)
}

async function main(): Promise<void> {
  const model = process.argv.find(a => a.startsWith('--model='))?.slice(8) ?? 'claude-opus-5-5'
  const waitS = Number(process.argv.find(a => a.startsWith('--wait-s='))?.slice(9) ?? 390)
  for (const k of Object.keys(process.env)) if (HOST_ENV_RE.test(k)) delete process.env[k]
  const runDir = join(tmpdir(), 'ttl-wait-probe', new Date().toISOString().replace(/[:.]/g, '-'))
  const proxy = await startWireProxy(join(runDir, 'proxy'))
  try {
    console.log(`=== TTL WAIT PROBE model=${model} wait=${waitS}s → ${runDir} ===`)
    await Promise.all(ARMS.map(arm => runArm(arm, proxy, model, waitS)))
  } finally {
    await proxy.close()
  }
  for (const arm of ARMS) {
    const records = readProxyRecords(proxy.logDir, arm.label)
      .filter(r => r.reqFile && r.status < 400 && isMessagesPath(r.path))
      .sort((a, b) => a.n - b.n)
    const census = ttlCensus(records.map(r => ({ body: readBody(proxy.logDir, arm.label, r.reqFile!), usage: r.response?.usage ?? null })))
    const { verdict, pings } = afterWait(proxy.logDir, arm.label)
    console.log(`\n== ${arm.label}: ${records.length} requests, ${pings} ping(s)`)
    for (const [group, s] of Object.entries(census)) {
      if (s.requests === 0) continue
      const m = s.markers
      console.log(
        `  ${group.padEnd(10)} reqs=${String(s.requests).padStart(3)} markers sys 5m/1h=${m.system['5m']}/${m.system['1h']} tools=${m.tools['5m']}/${m.tools['1h']} msgs=${m.messages['5m']}/${m.messages['1h']}  writes 5m=${s.write5m} 1h=${s.write1h} read=${s.read}`,
      )
    }
    console.log(
      verdict
        ? `  after the wait (${verdict.gapMin.toFixed(1)} min): read=${verdict.read} write 5m=${verdict.write5m} 1h=${verdict.write1h} → ${verdict.read > verdict.write5m + verdict.write1h ? 'SURVIVED' : 'REWRITTEN'}`
        : '  no sub-agent request after a >5 min gap (the wait did not happen as a gap)',
    )
  }
}

main()
