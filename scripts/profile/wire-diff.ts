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
//   bun run scripts/profile/wire-diff.ts                       # claude vs claudindev
//   bun run scripts/profile/wire-diff.ts --a=claude --b=claudindev
//   bun run scripts/profile/wire-diff.ts --raw                 # also dump raw bodies to /tmp

import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const PORT = 8799
const MODEL = 'claude-sonnet-4-6'

type Args = { a: string; b: string; raw: boolean; help: boolean }
function parseArgs(argv: string[]): Args {
  const o: Args = { a: 'claude', b: 'claudindev', raw: false, help: false }
  for (const x of argv) {
    if (x === '--help' || x === '-h') o.help = true
    else if (x === '--raw') o.raw = true
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
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(PORT, () => resolveStart({ close: () => server.close() }))
  })
}

function runCli(bin: string, _isClaudin: boolean) {
  // Use the CLI's REAL config (so its active provider/creds are intact) and only
  // redirect the DESTINATION to our localhost mock via ANTHROPIC_BASE_URL — which the
  // Anthropic SDK reads natively and claudin does not override for the anthropic
  // transport. Sandbox stays ON: if the override is ignored the request goes to the
  // real API and is BLOCKED (hangs, we kill it) — it can never actually be charged.
  const env: Record<string, string> = {
    ...process.env,
    HOME: process.env.HOME ?? '',                 // REAL home → config present, no onboarding hang
    ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
    ANTHROPIC_API_KEY: 'sk-mock-capture-key',     // force api-key transport (which honors base URL)
    ANTHROPIC_MODEL: MODEL,
  }
  const res = spawnSync(bin, ['-p', 'hi', '--model', MODEL, '--output-format', 'text'], {
    encoding: 'utf8',
    timeout: 35_000,
    maxBuffer: 32 * 1024 * 1024,
    env,
  })
  return { code: res.status ?? -1, stderr: (res.stderr ?? '').slice(-400) }
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
    console.log('  --a=<bin> --b=<bin>  --raw (dump bodies to /tmp/wire-*.json)')
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
  const ra = runCli(args.a, false)
  const capA = captures.slice(startA)
  console.log(`  exit ${ra.code}, captured ${capA.length} request(s)${ra.code !== 0 ? `  stderr: ${ra.stderr.replace(/\n/g, ' ')}` : ''}`)

  const startB = captures.length
  console.log(`▶ ${args.b} (claudin) ...`)
  const rb = runCli(args.b, true)
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
