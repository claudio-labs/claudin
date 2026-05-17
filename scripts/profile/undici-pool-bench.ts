#!/usr/bin/env bun
// undici 8 pool tuning bench — ROADMAP item 11.5.
//
// Measures the effect of undici Pool/Agent knobs (allowH2, connections,
// keepAliveTimeout, pipelining) on request latency against two local mock
// servers: one h2-capable (ALPN h2 + http/1.1) and one h1-only (forces
// fallback if the client attempts h2). The goal is to decide empirically
// whether tuning src/utils/proxy.ts:getProxyAgent() is worth shipping.
//
// Scenarios:
//   sequential-burst  — 50 sequential requests against one origin (typical turn)
//   parallel-burst    — 8 parallel × 5 rounds (sub-agent simultaneity)
//   cold-then-warm    — 1 req, idle, 1 req (sensitive to keepAliveTimeout)
//   mixed-providers   — interleave h2 + h1-only (cross-regression check)
//
// Usage:
//   bun run scripts/profile/undici-pool-bench.ts              # full matrix
//   bun run scripts/profile/undici-pool-bench.ts --quick      # default + 4 candidates
//   bun run scripts/profile/undici-pool-bench.ts --scenario=sequential-burst
//   bun run scripts/profile/undici-pool-bench.ts --json > baselines/undici-pool.json
//   bun run scripts/profile/undici-pool-bench.ts --compare
//   bun run scripts/profile/undici-pool-bench.ts --sanity     # harness sanity checks (needs Node)
//
// Required: bench needs --expose-gc only if you want clean heap deltas; not
// used here (this bench is latency-only).

import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer as createH1Server, type Server as H1Server } from 'node:http'
import { createSecureServer, type Http2SecureServer } from 'node:http2'
import type { AddressInfo } from 'node:net'
import diagnosticsChannel from 'node:diagnostics_channel'
import { Pool, Agent, type Dispatcher } from 'undici'

const HERE = dirname(fileURLToPath(import.meta.url))
const TLS_DIR = join(HERE, '__fixtures__', 'undici-tls')
const BASELINE_PATH = join(HERE, 'baselines', 'undici-pool.json')

// ----------------------------------------------------------------------------
// CLI parsing
// ----------------------------------------------------------------------------

type Args = {
  quick: boolean
  json: boolean
  compare: boolean
  sanity: boolean
  scenario: string | undefined
  latencyMs: number
  payloadBytes: number
  warmRounds: number
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find(a => a.startsWith(`--${name}=`))
    return hit?.slice(name.length + 3)
  }
  return {
    quick: argv.includes('--quick'),
    json: argv.includes('--json'),
    compare: argv.includes('--compare'),
    sanity: argv.includes('--sanity'),
    scenario: get('scenario'),
    latencyMs: Number(get('latency-ms') ?? '50'),
    payloadBytes: Number(get('payload-bytes') ?? '2048'),
    warmRounds: Number(get('warm-rounds') ?? '3'),
  }
}

// ----------------------------------------------------------------------------
// Mock servers
// ----------------------------------------------------------------------------

type ServerHandle = {
  type: 'h2-capable' | 'h1-only'
  origin: string
  close: () => Promise<void>
}

async function startH2Server(latencyMs: number, payloadBytes: number): Promise<ServerHandle> {
  const cert = readFileSync(join(TLS_DIR, 'cert.pem'))
  const key = readFileSync(join(TLS_DIR, 'key.pem'))
  // allowHTTP1: accept http/1.1 ALPN fallback alongside h2.
  const server: Http2SecureServer = createSecureServer({ cert, key, allowHTTP1: true })
  const payload = Buffer.alloc(payloadBytes, 0x61)
  // The 'request' event handles both h2 and h1 fallback in a unified API
  // when `allowHTTP1: true` — registering 'stream' too would double-respond.
  server.on('request', (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(payload)
    }, latencyMs)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    type: 'h2-capable',
    origin: `https://127.0.0.1:${port}`,
    close: () => new Promise(r => server.close(() => r())),
  }
}

async function startH1Server(latencyMs: number, payloadBytes: number): Promise<ServerHandle> {
  // Plain http (no TLS, no ALPN). undici talks h1 here; allowH2 has no effect
  // for http:// origins, so this scenario isolates "what if the gateway is
  // http:// behind a TLS-terminating proxy" — the typical OpenAI-compat case.
  const payload = Buffer.alloc(payloadBytes, 0x62)
  const server: H1Server = createH1Server((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(payload)
    }, latencyMs)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    type: 'h1-only',
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => server.close(() => r())),
  }
}

// ----------------------------------------------------------------------------
// Diagnostics hooks (count tcp connects + h2 negotiation)
// ----------------------------------------------------------------------------

type ConnStats = {
  tcpConnects: number
  h2Negotiated: number
  requestsSent: number
}

function attachDiagnostics(): { stats: ConnStats; detach: () => void } {
  const stats: ConnStats = { tcpConnects: 0, h2Negotiated: 0, requestsSent: 0 }
  const onConnected = (msg: unknown) => {
    stats.tcpConnects++
    const m = msg as { socket?: { alpnProtocol?: string | false | null } }
    if (m.socket?.alpnProtocol === 'h2') stats.h2Negotiated++
  }
  const onSendHeaders = () => {
    stats.requestsSent++
  }
  diagnosticsChannel.subscribe('undici:client:connected', onConnected)
  diagnosticsChannel.subscribe('undici:client:sendHeaders', onSendHeaders)
  return {
    stats,
    detach: () => {
      diagnosticsChannel.unsubscribe('undici:client:connected', onConnected)
      diagnosticsChannel.unsubscribe('undici:client:sendHeaders', onSendHeaders)
    },
  }
}

// ----------------------------------------------------------------------------
// Dispatcher factory
// ----------------------------------------------------------------------------

type PoolConfig = {
  allowH2: boolean
  connections: number
  keepAliveTimeout: number
  pipelining: number
}

function configKey(c: PoolConfig): string {
  return `h2=${c.allowH2 ? 1 : 0} c=${c.connections} kat=${c.keepAliveTimeout} p=${c.pipelining}`
}

function makeDispatcher(origin: string, c: PoolConfig): Dispatcher {
  return new Pool(origin, {
    allowH2: c.allowH2,
    connections: c.connections,
    keepAliveTimeout: c.keepAliveTimeout,
    pipelining: c.pipelining,
    connect: { rejectUnauthorized: false },
  })
}

// ----------------------------------------------------------------------------
// Scenarios
// ----------------------------------------------------------------------------

type Scenario = 'sequential-burst' | 'parallel-burst' | 'cold-then-warm' | 'mixed-providers'

type Metrics = {
  p50: number
  p95: number
  p99: number
  totalMs: number
  tcpConnects: number
  h2Negotiated: number
  socketReusePct: number
  samples: number
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]!
}

async function oneRequest(dispatcher: Dispatcher, origin: string): Promise<number> {
  const t0 = performance.now()
  const res = await dispatcher.request({ origin, path: '/', method: 'GET' })
  await res.body.dump()
  return performance.now() - t0
}

async function runSequential(
  dispatcher: Dispatcher,
  origin: string,
  n: number,
): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(await oneRequest(dispatcher, origin))
  return out
}

async function runParallel(
  dispatcher: Dispatcher,
  origin: string,
  parallel: number,
  rounds: number,
): Promise<number[]> {
  const out: number[] = []
  for (let r = 0; r < rounds; r++) {
    const samples = await Promise.all(
      Array.from({ length: parallel }, () => oneRequest(dispatcher, origin)),
    )
    out.push(...samples)
  }
  return out
}

async function runColdThenWarm(
  dispatcher: Dispatcher,
  origin: string,
  idleMs: number,
): Promise<number[]> {
  const a = await oneRequest(dispatcher, origin)
  await new Promise(r => setTimeout(r, idleMs))
  const b = await oneRequest(dispatcher, origin)
  return [a, b]
}

async function runScenario(
  scenario: Scenario,
  servers: { h2: ServerHandle; h1: ServerHandle },
  config: PoolConfig,
  args: Args,
): Promise<{ serverType: string; metrics: Metrics }[]> {
  const results: { serverType: string; metrics: Metrics }[] = []

  const runOne = async (
    server: ServerHandle,
    work: (d: Dispatcher) => Promise<number[]>,
  ): Promise<Metrics> => {
    const dispatcher = makeDispatcher(server.origin, config)
    // Warm-up to populate pool — exclude these samples from stats.
    for (let i = 0; i < args.warmRounds; i++) await oneRequest(dispatcher, server.origin)
    const { stats, detach } = attachDiagnostics()
    const t0 = performance.now()
    const samples = await work(dispatcher)
    const totalMs = performance.now() - t0
    detach()
    await dispatcher.close()
    const reusePct =
      stats.requestsSent > 0
        ? ((stats.requestsSent - stats.tcpConnects) / stats.requestsSent) * 100
        : 0
    return {
      p50: pct(samples, 50),
      p95: pct(samples, 95),
      p99: pct(samples, 99),
      totalMs,
      tcpConnects: stats.tcpConnects,
      h2Negotiated: stats.h2Negotiated,
      socketReusePct: Math.max(0, reusePct),
      samples: samples.length,
    }
  }

  if (scenario === 'sequential-burst') {
    results.push({
      serverType: 'h2-capable',
      metrics: await runOne(servers.h2, d => runSequential(d, servers.h2.origin, 50)),
    })
    results.push({
      serverType: 'h1-only',
      metrics: await runOne(servers.h1, d => runSequential(d, servers.h1.origin, 50)),
    })
  } else if (scenario === 'parallel-burst') {
    results.push({
      serverType: 'h2-capable',
      metrics: await runOne(servers.h2, d => runParallel(d, servers.h2.origin, 8, 5)),
    })
    results.push({
      serverType: 'h1-only',
      metrics: await runOne(servers.h1, d => runParallel(d, servers.h1.origin, 8, 5)),
    })
  } else if (scenario === 'cold-then-warm') {
    // Idle slightly longer than the smallest keepAliveTimeout (4s) to surface
    // the effect — but capped to keep matrix runtime sane.
    const idleMs = Math.min(5_000, config.keepAliveTimeout + 500)
    results.push({
      serverType: 'h2-capable',
      metrics: await runOne(servers.h2, d => runColdThenWarm(d, servers.h2.origin, idleMs)),
    })
    results.push({
      serverType: 'h1-only',
      metrics: await runOne(servers.h1, d => runColdThenWarm(d, servers.h1.origin, idleMs)),
    })
  } else {
    // mixed-providers — interleave h2 and h1 requests
    const dispatcherH2 = makeDispatcher(servers.h2.origin, config)
    const dispatcherH1 = makeDispatcher(servers.h1.origin, config)
    for (let i = 0; i < args.warmRounds; i++) {
      await oneRequest(dispatcherH2, servers.h2.origin)
      await oneRequest(dispatcherH1, servers.h1.origin)
    }
    const { stats, detach } = attachDiagnostics()
    const t0 = performance.now()
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      samples.push(await oneRequest(dispatcherH2, servers.h2.origin))
      samples.push(await oneRequest(dispatcherH1, servers.h1.origin))
    }
    const totalMs = performance.now() - t0
    detach()
    await dispatcherH2.close()
    await dispatcherH1.close()
    const reusePct =
      stats.requestsSent > 0
        ? ((stats.requestsSent - stats.tcpConnects) / stats.requestsSent) * 100
        : 0
    results.push({
      serverType: 'mixed',
      metrics: {
        p50: pct(samples, 50),
        p95: pct(samples, 95),
        p99: pct(samples, 99),
        totalMs,
        tcpConnects: stats.tcpConnects,
        h2Negotiated: stats.h2Negotiated,
        socketReusePct: Math.max(0, reusePct),
        samples: samples.length,
      },
    })
  }

  return results
}

// ----------------------------------------------------------------------------
// Matrix
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: PoolConfig = {
  allowH2: false,
  connections: 1, // undici Pool default — one connection per origin
  keepAliveTimeout: 4_000,
  pipelining: 1,
}

function buildMatrix(quick: boolean): PoolConfig[] {
  if (quick) {
    return [
      DEFAULT_CONFIG,
      { ...DEFAULT_CONFIG, allowH2: true },
      { ...DEFAULT_CONFIG, connections: 16 },
      { ...DEFAULT_CONFIG, keepAliveTimeout: 30_000 },
      { ...DEFAULT_CONFIG, pipelining: 10 },
    ]
  }
  const out: PoolConfig[] = []
  for (const allowH2 of [false, true]) {
    for (const connections of [1, 6, 16, 64]) {
      for (const keepAliveTimeout of [4_000, 30_000, 60_000]) {
        for (const pipelining of [0, 1, 10]) {
          out.push({ allowH2, connections, keepAliveTimeout, pipelining })
        }
      }
    }
  }
  return out
}

const ALL_SCENARIOS: Scenario[] = [
  'sequential-burst',
  'parallel-burst',
  'cold-then-warm',
  'mixed-providers',
]

// ----------------------------------------------------------------------------
// Reporting
// ----------------------------------------------------------------------------

type Row = {
  scenario: Scenario
  serverType: string
  config: PoolConfig
  metrics: Metrics
}

function formatTable(rows: Row[]): string {
  const lines: string[] = []
  const header =
    'scenario'.padEnd(18) +
    'server'.padEnd(13) +
    'config'.padEnd(34) +
    'p50'.padStart(8) +
    'p95'.padStart(8) +
    'p99'.padStart(8) +
    'total'.padStart(10) +
    'tcp'.padStart(6) +
    'h2'.padStart(5) +
    'reuse%'.padStart(8)
  lines.push(header)
  lines.push('-'.repeat(header.length))
  for (const r of rows) {
    lines.push(
      r.scenario.padEnd(18) +
        r.serverType.padEnd(13) +
        configKey(r.config).padEnd(34) +
        r.metrics.p50.toFixed(1).padStart(8) +
        r.metrics.p95.toFixed(1).padStart(8) +
        r.metrics.p99.toFixed(1).padStart(8) +
        r.metrics.totalMs.toFixed(0).padStart(10) +
        String(r.metrics.tcpConnects).padStart(6) +
        String(r.metrics.h2Negotiated).padStart(5) +
        r.metrics.socketReusePct.toFixed(0).padStart(8),
    )
  }
  return lines.join('\n')
}

function compareToBaseline(rows: Row[]): string {
  if (!existsSync(BASELINE_PATH)) {
    return `(no baseline at ${BASELINE_PATH} — run without --compare first to generate)`
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Row[]
  const idx = new Map<string, Row>()
  for (const r of baseline) {
    idx.set(`${r.scenario}|${r.serverType}|${configKey(r.config)}`, r)
  }
  const lines: string[] = []
  // Default config is our reference within the current run, but we also
  // print drift vs the on-disk baseline (reproducibility check).
  for (const r of rows) {
    const key = `${r.scenario}|${r.serverType}|${configKey(r.config)}`
    const b = idx.get(key)
    if (!b) continue
    const delta = ((r.metrics.p95 - b.metrics.p95) / b.metrics.p95) * 100
    const arrow = delta < -10 ? '↓↓' : delta < -5 ? '↓ ' : delta > 10 ? '↑↑' : delta > 5 ? '↑ ' : '~ '
    lines.push(
      `${arrow} ${r.scenario.padEnd(18)} ${r.serverType.padEnd(13)} ${configKey(r.config).padEnd(34)} p95 ${b.metrics.p95.toFixed(1)} → ${r.metrics.p95.toFixed(1)} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`,
    )
  }
  return lines.join('\n')
}

function rankByDefault(rows: Row[]): string {
  // Find the default-config row per (scenario, serverType) and report which
  // configs beat it by ≥10% on p95.
  const defaults = new Map<string, Row>()
  for (const r of rows) {
    if (configKey(r.config) === configKey(DEFAULT_CONFIG)) {
      defaults.set(`${r.scenario}|${r.serverType}`, r)
    }
  }
  const wins: string[] = []
  const losses: string[] = []
  for (const r of rows) {
    if (configKey(r.config) === configKey(DEFAULT_CONFIG)) continue
    const base = defaults.get(`${r.scenario}|${r.serverType}`)
    if (!base) continue
    const delta = ((r.metrics.p95 - base.metrics.p95) / base.metrics.p95) * 100
    if (delta <= -10) {
      wins.push(
        `  ${r.scenario}/${r.serverType} ${configKey(r.config)}: p95 ${base.metrics.p95.toFixed(1)} → ${r.metrics.p95.toFixed(1)} (${delta.toFixed(1)}%)`,
      )
    } else if (delta >= 5) {
      losses.push(
        `  ${r.scenario}/${r.serverType} ${configKey(r.config)}: p95 ${base.metrics.p95.toFixed(1)} → ${r.metrics.p95.toFixed(1)} (+${delta.toFixed(1)}%)`,
      )
    }
  }
  return [
    `Wins (≥10% faster on p95 vs default ${configKey(DEFAULT_CONFIG)}):`,
    wins.length ? wins.join('\n') : '  (none)',
    '',
    `Regressions (≥5% slower):`,
    losses.length ? losses.join('\n') : '  (none)',
  ].join('\n')
}

// ----------------------------------------------------------------------------
// Sanity checks (replaces undici-pool-bench.test.ts — run with --sanity)
// ----------------------------------------------------------------------------

async function runSanity(): Promise<void> {
  let passed = 0
  let failed = 0
  const results: string[] = []

  async function run(name: string, fn: () => Promise<void>): Promise<void> {
    const disposables: Array<{ close: () => Promise<void> }> = []
    try {
      await fn()
      passed++
      results.push(`  ✓ ${name}`)
    } catch (err) {
      failed++
      results.push(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      while (disposables.length) {
        try {
          await disposables.pop()?.close()
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  await run('h2-capable server negotiates ALPN h2 when allowH2=true', async () => {
    const cert = readFileSync(join(TLS_DIR, 'cert.pem'))
    const key = readFileSync(join(TLS_DIR, 'key.pem'))
    const server = createSecureServer({ cert, key, allowHTTP1: true })
    server.on('request', (_req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    const origin = `https://127.0.0.1:${port}`
    let alpn: string | undefined | null | false
    const onConnected = (msg: unknown) => {
      const m = msg as { socket?: { alpnProtocol?: string | false | null } }
      alpn = m.socket?.alpnProtocol
    }
    diagnosticsChannel.subscribe('undici:client:connected', onConnected)
    const pool = new Pool(origin, { allowH2: true, connect: { rejectUnauthorized: false } })
    try {
      const res = await pool.request({ origin, path: '/', method: 'GET' })
      await res.body.dump()
      assert.equal(alpn, 'h2')
    } finally {
      diagnosticsChannel.unsubscribe('undici:client:connected', onConnected)
      await pool.close()
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  await run('h1-only origin keeps http/1.1 even if allowH2=true', async () => {
    const server = createH1Server((_req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    const origin = `http://127.0.0.1:${port}`
    let alpn: string | undefined | null | false = 'unset'
    const onConnected = (msg: unknown) => {
      const m = msg as { socket?: { alpnProtocol?: string | false | null } }
      alpn = m.socket?.alpnProtocol
    }
    diagnosticsChannel.subscribe('undici:client:connected', onConnected)
    const pool = new Pool(origin, { allowH2: true })
    try {
      const res = await pool.request({ origin, path: '/', method: 'GET' })
      await res.body.dump()
      assert.ok(alpn === false || alpn == null, `expected false/null, got ${JSON.stringify(alpn)}`)
    } finally {
      diagnosticsChannel.unsubscribe('undici:client:connected', onConnected)
      await pool.close()
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  await run('socket reuse — N sequential requests on connections=1 produce 1 tcp connect', async () => {
    const server = createH1Server((_req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    const origin = `http://127.0.0.1:${port}`
    let connects = 0
    let requests = 0
    const onConnected = () => { connects++ }
    const onSendHeaders = () => { requests++ }
    diagnosticsChannel.subscribe('undici:client:connected', onConnected)
    diagnosticsChannel.subscribe('undici:client:sendHeaders', onSendHeaders)
    const pool = new Pool(origin, { connections: 1, keepAliveTimeout: 30_000, pipelining: 1 })
    try {
      for (let i = 0; i < 5; i++) {
        const res = await pool.request({ origin, path: '/', method: 'GET' })
        await res.body.dump()
      }
      assert.equal(requests, 5)
      assert.equal(connects, 1)
    } finally {
      diagnosticsChannel.unsubscribe('undici:client:connected', onConnected)
      diagnosticsChannel.unsubscribe('undici:client:sendHeaders', onSendHeaders)
      await pool.close()
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  console.log(`undici-pool-bench harness sanity (${passed + failed} tests):`)
  for (const line of results) console.log(line)
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`)
    process.exit(1)
  }
  console.log(`\nAll ${passed} sanity tests passed`)
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.sanity) {
    await runSanity()
    return
  }

  const matrix = buildMatrix(args.quick)
  const scenarios: Scenario[] = args.scenario
    ? [args.scenario as Scenario]
    : args.quick
      ? ['sequential-burst']
      : ALL_SCENARIOS

  const h2 = await startH2Server(args.latencyMs, args.payloadBytes)
  const h1 = await startH1Server(args.latencyMs, args.payloadBytes)
  if (!args.json) {
    process.stderr.write(
      `mock servers: h2=${h2.origin} h1=${h1.origin} ; matrix=${matrix.length} configs × ${scenarios.length} scenarios\n`,
    )
  }

  const rows: Row[] = []
  let i = 0
  const total = matrix.length * scenarios.length
  for (const scenario of scenarios) {
    for (const config of matrix) {
      i++
      if (!args.json) {
        process.stderr.write(
          `[${i}/${total}] ${scenario} ${configKey(config)}\r`,
        )
      }
      const results = await runScenario(scenario, { h2, h1 }, config, args)
      for (const r of results) {
        rows.push({ scenario, serverType: r.serverType, config, metrics: r.metrics })
      }
    }
  }
  if (!args.json) process.stderr.write('\n')

  await h2.close()
  await h1.close()

  if (args.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
    return
  }

  console.log('\n' + formatTable(rows))
  console.log('\n' + rankByDefault(rows))

  if (args.compare) {
    console.log('\n=== Drift vs on-disk baseline ===')
    console.log(compareToBaseline(rows))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
