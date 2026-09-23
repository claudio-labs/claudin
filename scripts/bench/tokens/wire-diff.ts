#!/usr/bin/env bun
// Wire-diff: capture the EXACT request body each CLI sends to the Anthropic
// Messages API and diff the cache-relevant structure. Zero real API calls,
// fully deterministic — this is the offender-finder for prompt-cache regressions.
//
// HOW: a local mock server honors ANTHROPIC_BASE_URL (the @anthropic-ai/sdk reads
// it natively, and claudin does NOT override it for the Anthropic transport, so the
// active profile is bypassed). Each CLI is pointed at /A or /B; the server logs the
// POST body + anthropic-beta header and returns a minimal valid SSE stream so the
// CLI finishes one clean turn. Then we diff system blocks, cache_control marker
// positions, the attribution header, tool ordering, and betas.
//
// Usage:
//   bun run scripts/bench/tokens/wire-diff.ts                       # claude vs claudindev
//   bun run scripts/bench/tokens/wire-diff.ts --a=claude --b=claudindev
//   bun run scripts/bench/tokens/wire-diff.ts --raw                 # also dump raw bodies to /tmp
//   bun run scripts/bench/tokens/wire-diff.ts --model=claude-sonnet-5
//   bun run scripts/bench/tokens/wire-diff.ts --full                # keep hooks/MCP/plugins
//
// STATUS 2026-09-22: FIXED and verified against claude 2.1.280. The earlier
// "captures 0 requests" note blamed the injected ANTHROPIC_API_KEY; that was
// wrong. The real cause was in this file: the mock server and the CLI shared one
// process, and the CLI was launched with `spawnSync`, which blocks the event loop
// for the child's entire lifetime. The connection sat in the accept backlog and
// JS never serviced it, so the CLI waited for a first byte that could not arrive
// and we SIGTERM'd it at the timeout (exit 143, zero captures). Claude Code's own
// `--debug-file` shows both halves: `[API REQUEST] /v1/messages source=sdk`
// followed by `Slow first byte: no stream chunk 30.0s after request sent`.
// The fix is an async `spawn` + await exit. Two smaller things also mattered:
// CLAUDECODE / CLAUDE_CODE_ENTRYPOINT leak into the child from whichever
// Claude-Code-family CLI runs this script, and `--bare` (default here) keeps the
// capture deterministic — no hooks, plugins, MCP or keychain, api-key auth only.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const PORT = 8799
// Read straight off argv: the mock SSE payload below is built at module scope and
// has to echo back the same model id the CLIs are launched with.
const MODEL = process.argv.slice(2).find(x => x.startsWith('--model='))?.slice('--model='.length) ?? 'claude-sonnet-4-6'

type Args = { a: string; b: string; raw: boolean; help: boolean; full: boolean }
function parseArgs(argv: string[]): Args {
  const o: Args = { a: 'claude', b: 'claudindev', raw: false, help: false, full: false }
  for (const x of argv) {
    if (x === '--help' || x === '-h') o.help = true
    else if (x === '--raw') o.raw = true
    else if (x === '--full') o.full = true
    else if (x.startsWith('--a=')) o.a = x.slice('--a='.length)
    else if (x.startsWith('--b=')) o.b = x.slice('--b='.length)
  }
  return o
}

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","model":"' + MODEL + '","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
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
].join('\n')

type Capture = { body: any; beta: string | null; path: string }
const captures: Capture[] = [] // flat; runs are separated temporally via a cursor

function startServer(): Promise<{ close: () => void }> {
  return new Promise(resolveStart => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const path = req.url ?? ''
        // count_tokens → return a plain JSON token count (non-streaming).
        if (path.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ input_tokens: 100 }))
          return
        }
        if (path.includes('/v1/messages')) {
          let body: any = null
          try { body = JSON.parse(raw) } catch { body = { _unparsed: raw.slice(0, 200) } }
          captures.push({
            body,
            beta: (req.headers['anthropic-beta'] as string) ?? null,
            path,
          })
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(SSE)
          return
        }
        // Any other endpoint (quota, /v1/me, etc.) → benign 200.
        if (process.env.WIRE_DIFF_TRACE) console.log(`    [trace] ${req.method} ${path}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(PORT, () => resolveStart({ close: () => server.close() }))
  })
}

// Deterministic capture args. `--bare` is the important one: it drops hooks,
// plugins, LSP, auto-memory, CLAUDE.md discovery and keychain reads, and pins
// auth to ANTHROPIC_API_KEY — so what lands in the body is the CLI's own shape
// rather than this machine's configuration. Both CLIs accept all of these.
//
// The two CLIs resolve auth DIFFERENTLY under --bare, and it is load-bearing
// here: Claude Code reads ANTHROPIC_API_KEY from the environment, while
// claudin's bare mode reads only the active Anthropic provider profile's
// apiKey or an apiKeyHelper (src/providers/auth/auth.ts:228-243) and never the
// env var. So a bare claudin run on a machine whose /provider is unconfigured
// (the default OAuth/subscription setup) exits 1 with
// "Not logged in · Please run /login" and captures nothing. Use --full for the
// claudin side there: it drops both the bare flags and the injected key, so
// each CLI authenticates exactly as it normally does.
const BARE_ARGS = ['--bare', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']

function runCli(bin: string, full: boolean): Promise<{ code: number; stderr: string }> {
  // Use the CLI's REAL config (so its active provider/creds are intact) and only
  // redirect the DESTINATION to our localhost mock via ANTHROPIC_BASE_URL — which the
  // Anthropic SDK reads natively and claudin does not override for the anthropic
  // transport. Sandbox stays ON: if the override is ignored the request goes to the
  // real API and is BLOCKED (hangs, we kill it) — it can never actually be charged.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: process.env.HOME ?? '',                 // REAL home → config present, no onboarding hang
    ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
    ANTHROPIC_MODEL: MODEL,
  }
  if (!full) {
    // api-key transport honors the base URL, and under --bare it is the only
    // credential Claude Code will look at.
    env.ANTHROPIC_API_KEY = 'sk-ant-api03-mock-capture-key'
  } else {
    delete env.ANTHROPIC_API_KEY
  }
  // Both CLIs are Claude-Code-family, so a child inherits CLAUDECODE=1 from
  // whichever one is running this script and takes a nested-session path.
  //
  // The CLAUDIN_* / CLAUDE_CODE_* killswitches leak the same way and they move
  // the very bytes being compared — a session running with
  // CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=true hands its child a shorter
  // anthropic-beta header and the diff reads as a fork divergence that does not
  // exist. Strip the whole family, then re-apply only what this harness sets.
  for (const key of Object.keys(env)) {
    if (
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDIN_') ||
      key.startsWith('CLAUDE_CODE_')
    ) {
      delete env[key]
    }
  }
  // An OAuth token in the environment outranks the mock key and sends the run
  // to the real API instead of the mock.
  delete env.ANTHROPIC_AUTH_TOKEN
  if (process.env.WIRE_DIFF_TRACE) {
    const leaked = Object.keys(env).filter(
      k => k.startsWith('CLAUDIN_') || k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC_'),
    )
    console.log(`    [trace] ${bin} env: ${leaked.join(', ') || '(none of the families)'}`)
  }
  const argv = [
    '-p', 'hi',
    '--model', MODEL,
    ...(full ? [] : BARE_ARGS),
    '--output-format', 'text',
  ]
  // ASYNC spawn, not spawnSync: the mock server lives in THIS process, and a
  // synchronous child blocks the event loop that would accept its connection.
  // That single line is what made every earlier run capture zero requests.
  return new Promise(resolve => {
    const child = spawn(bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', d => (stderr += String(d)))
    // Keep stdout: a CLI that refuses the run (unknown model, missing auth)
    // prints the reason there and exits 1 with an EMPTY stderr, which read as
    // "did not honor ANTHROPIC_BASE_URL" for longer than it should have.
    child.stdout.on('data', d => (stdout += String(d)))
    const kill = setTimeout(() => child.kill('SIGTERM'), 90_000)
    child.on('close', code => {
      clearTimeout(kill)
      const why = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ')
      resolve({ code: code ?? -1, stderr: why.slice(-600) })
    })
  })
}

// ---- structural summary of a request body ----
function summarize(cap: Capture) {
  const b = cap.body ?? {}
  const system = Array.isArray(b.system) ? b.system : (typeof b.system === 'string' ? [{ type: 'text', text: b.system }] : [])
  const tools = Array.isArray(b.tools) ? b.tools : []
  const messages = Array.isArray(b.messages) ? b.messages : []

  const sysBlocks = system.map((s: any, i: number) => {
    const text = typeof s === 'string' ? s : (s.text ?? '')
    const cc = (typeof s === 'object' && s.cache_control) ? s.cache_control : null
    return {
      i,
      chars: text.length,
      cc: cc ? (cc.ttl ? `ephemeral/${cc.ttl}` : 'ephemeral') : null,
      head: text.replace(/\s+/g, ' ').slice(0, 70),
    }
  })

  const toolNames = tools.map((t: any) => t.name)
  const toolsWithCC = tools.filter((t: any) => t.cache_control).map((t: any) => t.name)
  const toolsChars = JSON.stringify(tools).length

  const msgRows = messages.map((m: any, i: number) => {
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    const ccCount = content.filter((c: any) => c && typeof c === 'object' && c.cache_control).length
    return { i, role: m.role, blocks: content.length, cc: ccCount }
  })

  const ccTotal =
    sysBlocks.filter((s: any) => s.cc).length +
    toolsWithCC.length +
    msgRows.reduce((n: number, r: any) => n + r.cc, 0)

  return {
    model: b.model,
    beta: cap.beta,
    thinking: b.thinking ? JSON.stringify(b.thinking) : null,
    // Top-level request fields a model launch changes. `output_config.effort`
    // and `max_tokens` are the two that silently diverge per model, and
    // `context_management` is how the server is asked to handle thinking
    // instead of the client rewriting history.
    maxTokens: b.max_tokens ?? null,
    outputConfig: b.output_config ? JSON.stringify(b.output_config) : null,
    contextManagement: b.context_management ? JSON.stringify(b.context_management) : null,
    sampling: ['temperature', 'top_p', 'top_k']
      .filter(k => b[k] !== undefined)
      .map(k => `${k}=${JSON.stringify(b[k])}`),
    topLevelKeys: Object.keys(b).sort(),
    sysBlocks,
    sysChars: sysBlocks.reduce((n: number, s: any) => n + s.chars, 0),
    toolCount: toolNames.length,
    toolNames,
    toolsWithCC,
    toolsChars,
    msgRows,
    ccTotal,
  }
}

function printSummary(label: string, s: ReturnType<typeof summarize>) {
  console.log(`\n=== ${label} ===`)
  console.log(`  model: ${s.model}   betas: ${s.beta ?? '(none)'}`)
  if (s.thinking) console.log(`  thinking: ${s.thinking}`)
  console.log(`  max_tokens: ${s.maxTokens}   output_config: ${s.outputConfig ?? '(none)'}`)
  if (s.contextManagement) console.log(`  context_management: ${s.contextManagement}`)
  console.log(`  sampling params: ${s.sampling.length ? s.sampling.join(' ') : '(none sent)'}`)
  console.log(`  top-level keys: ${s.topLevelKeys.join(', ')}`)
  console.log(`  cache_control markers TOTAL: ${s.ccTotal}`)
  console.log(`  system: ${s.sysBlocks.length} blocks, ${s.sysChars} chars`)
  for (const blk of s.sysBlocks) {
    console.log(`    [${blk.i}] ${String(blk.chars).padStart(6)}ch  cc=${(blk.cc ?? '—').padEnd(14)} "${blk.head}"`)
  }
  console.log(`  tools: ${s.toolCount} (${s.toolsChars} chars)  cc-on-tools=[${s.toolsWithCC.join(',') || '—'}]`)
  console.log(`    order: ${s.toolNames.join(', ')}`)
  console.log(`  messages: ${s.msgRows.length}`)
  for (const m of s.msgRows) console.log(`    [${m.i}] ${m.role} blocks=${m.blocks} cc=${m.cc}`)
}

function diff(a: ReturnType<typeof summarize>, b: ReturnType<typeof summarize>) {
  console.log(`\n${'─'.repeat(72)}\nOFFENDER DIFF (A=${'claude'} vs B=${'claudin'})\n${'─'.repeat(72)}`)
  const line = (k: string, av: any, bv: any) => {
    const same = JSON.stringify(av) === JSON.stringify(bv)
    console.log(`  ${same ? '  ' : '≠ '} ${k.padEnd(22)} A=${String(av).slice(0, 30).padEnd(32)} B=${String(bv).slice(0, 30)}`)
  }
  line('cache_control total', a.ccTotal, b.ccTotal)
  line('system blocks', a.sysBlocks.length, b.sysBlocks.length)
  line('system cc-blocks', a.sysBlocks.filter(s => s.cc).length, b.sysBlocks.filter(s => s.cc).length)
  line('system chars', a.sysChars, b.sysChars)
  line('block0 cc?', a.sysBlocks[0]?.cc ?? '—', b.sysBlocks[0]?.cc ?? '—')
  line('block0 chars', a.sysBlocks[0]?.chars, b.sysBlocks[0]?.chars)
  line('tool count', a.toolCount, b.toolCount)
  line('tools chars', a.toolsChars, b.toolsChars)
  line('cc-on-tools', a.toolsWithCC.length, b.toolsWithCC.length)
  line('betas', a.beta, b.beta)
  line('thinking', a.thinking, b.thinking)
  line('max_tokens', a.maxTokens, b.maxTokens)
  line('output_config', a.outputConfig, b.outputConfig)
  line('context_management', a.contextManagement, b.contextManagement)
  line('sampling params', a.sampling.join(' ') || '(none)', b.sampling.join(' ') || '(none)')
  const aKeys = new Set(a.topLevelKeys)
  const bKeys = new Set(b.topLevelKeys)
  const keyOnlyA = a.topLevelKeys.filter(k => !bKeys.has(k))
  const keyOnlyB = b.topLevelKeys.filter(k => !aKeys.has(k))
  if (keyOnlyA.length) console.log(`     body keys only in A(claude):  ${keyOnlyA.join(', ')}`)
  if (keyOnlyB.length) console.log(`     body keys only in B(claudin): ${keyOnlyB.join(', ')}`)
  const aBetas = new Set((a.beta ?? '').split(',').map(x => x.trim()).filter(Boolean))
  const bBetas = new Set((b.beta ?? '').split(',').map(x => x.trim()).filter(Boolean))
  const betaOnlyA = [...aBetas].filter(x => !bBetas.has(x))
  const betaOnlyB = [...bBetas].filter(x => !aBetas.has(x))
  if (betaOnlyA.length) console.log(`     betas only in A(claude):  ${betaOnlyA.join(', ')}`)
  if (betaOnlyB.length) console.log(`     betas only in B(claudin): ${betaOnlyB.join(', ')}`)
  const aNames = new Set(a.toolNames), bNames = new Set(b.toolNames)
  const onlyA = a.toolNames.filter((n: string) => !bNames.has(n))
  const onlyB = b.toolNames.filter((n: string) => !aNames.has(n))
  if (onlyA.length) console.log(`     tools only in A(claude):  ${onlyA.join(', ')}`)
  if (onlyB.length) console.log(`     tools only in B(claudin): ${onlyB.join(', ')}`)
  console.log(`\n  Read above: a ≠ on "block0 cc?/chars" or "system cc-blocks" or a higher "system chars"/"tools chars" on B`)
  console.log(`  means claudin caches a larger or differently-anchored prefix than Claude Code.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('wire-diff: capture + diff the Anthropic request body of two CLIs (no real API).')
    console.log('  --a=<bin> --b=<bin>  --model=<id>  --raw (dump bodies to /tmp/wire-*.json)')
    console.log('  --full  keep hooks/plugins/MCP (default is --bare, which is deterministic)')
    return
  }
  const srv = await startServer()
  console.log(`mock server on :${PORT} — capturing request bodies (no real API hit)`)
  // reachability self-test
  try {
    const ping = await fetch(`http://localhost:${PORT}/v1/messages`, { method: 'POST', body: '{}' })
    console.log(`  self-test: server reachable (${ping.status}); captured so far ${captures.length}\n`)
  } catch (e) {
    console.log(`  ⚠ self-test failed: ${String(e)}\n`)
  }

  const startA = captures.length
  console.log(`▶ ${args.a} (claude) ...`)
  const ra = await runCli(args.a, args.full)
  const capA = captures.slice(startA)
  console.log(`  exit ${ra.code}, captured ${capA.length} request(s)${ra.code !== 0 ? `  stderr: ${ra.stderr.replace(/\n/g, ' ')}` : ''}`)

  const startB = captures.length
  console.log(`▶ ${args.b} (claudin) ...`)
  const rb = await runCli(args.b, args.full)
  const capB = captures.slice(startB)
  console.log(`  exit ${rb.code}, captured ${capB.length} request(s)${rb.code !== 0 ? `  stderr: ${rb.stderr.replace(/\n/g, ' ')}` : ''}`)
  srv.close()

  // ignore the self-test ping (empty body) — take the first REAL request each captured.
  const firstReal = (arr: Capture[]) => arr.find(c => c.body && Array.isArray(c.body.system)) ?? arr[0]
  const sa = capA.length ? summarize(firstReal(capA)) : null
  const sb = capB.length ? summarize(firstReal(capB)) : null
  if (sa) printSummary(`A: ${args.a}`, sa)
  if (sb) printSummary(`B: ${args.b}`, sb)

  if (sa && sb) diff(sa, sb)
  else console.log(`\n⚠ only ${sa ? args.a : sb ? args.b : 'neither'} captured a request. The other CLI did not honor`
    + ` ANTHROPIC_BASE_URL (likely OAuth/subscription transport). Single-side structure printed above.`)

  if (args.raw) {
    if (sa) writeFileSync('/tmp/wire-A.json', JSON.stringify(firstReal(capA).body, null, 2))
    if (sb) writeFileSync('/tmp/wire-B.json', JSON.stringify(firstReal(capB).body, null, 2))
    console.log('\n  full bodies (captured side only): /tmp/wire-A.json  /tmp/wire-B.json')
  }
}

main()
