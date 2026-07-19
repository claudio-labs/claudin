#!/usr/bin/env bun
/**
 * Capture a V8 heap snapshot from a live Node process over CDP (Chrome DevTools Protocol).
 *
 * Prereq: the target process must have the inspector open. For a running Node process,
 * that means you already ran: `kill -USR1 <pid>` on the host.
 *
 * Usage:
 *   bun scripts/profile/take-heap-snapshot-cdp.ts --pid=46962 --out=/path/to/snapshot.heapsnapshot
 *   bun scripts/profile/take-heap-snapshot-cdp.ts --ws=ws://127.0.0.1:9229/<id> --out=/path/...
 *
 * It connects to the inspector, calls HeapProfiler.takeHeapSnapshot with reportProgress,
 * streams the JSON chunks to disk, and prints final stats.
 */

import { createWriteStream } from 'fs'
import { stat } from 'fs/promises'

type Args = { pid?: string; ws?: string; out: string; port?: string }

function parseArgs(): Args {
  const out: Partial<Args> = {}
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=')
    if (k === 'pid') out.pid = v
    else if (k === 'ws') out.ws = v
    else if (k === 'out') out.out = v
    else if (k === 'port') out.port = v
  }
  if (!out.out) {
    console.error('Missing --out=<path>')
    process.exit(1)
  }
  return out as Args
}

async function findWsUrl(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`inspector /json/list failed: ${res.status}`)
  const list = (await res.json()) as Array<{
    webSocketDebuggerUrl?: string
    type?: string
    title?: string
  }>
  const target = list.find((t) => t.webSocketDebuggerUrl) ?? list[0]
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`no debuggable target on port ${port}: ${JSON.stringify(list)}`)
  }
  console.log(`  target title: ${target.title}`)
  return target.webSocketDebuggerUrl
}

async function main() {
  const args = parseArgs()

  let wsUrl = args.ws
  if (!wsUrl) {
    const port = args.port ? Number(args.port) : 9229
    console.log(`Discovering inspector on port ${port} ...`)
    wsUrl = await findWsUrl(port)
  }
  console.log(`Connecting to ${wsUrl}`)

  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map<number, (r: unknown) => void>()

  function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 120_000)
    })
  }

  const file = createWriteStream(args.out, { flags: 'w' })
  let chunks = 0
  let bytes = 0
  let progressPct = 0

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (ev) => reject(new Error(`ws error: ${String(ev)}`)))
  })
  console.log('Connected.')

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { message: string }
    }
    // Only dispatch replies to ids we issued (small sequential integers) —
    // anything else from the wire is ignored.
    if (typeof msg.id === 'number' && Number.isInteger(msg.id) && msg.id >= 1 && msg.id < nextId) {
      const cb = pending.get(msg.id)
      if (cb) {
        pending.delete(msg.id)
        if (msg.error) throw new Error(`CDP error: ${msg.error.message}`)
        cb(msg.result)
      }
      return
    }
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
      const chunk = (msg.params?.chunk as string) ?? ''
      chunks++
      bytes += chunk.length
      file.write(chunk)
      if (chunks % 200 === 0) process.stdout.write(`\r  received ${chunks} chunks, ${(bytes / (1 << 20)).toFixed(1)} MB`)
    } else if (msg.method === 'HeapProfiler.reportHeapSnapshotProgress') {
      const done = msg.params?.done as number
      const total = msg.params?.total as number
      if (total > 0) {
        const pct = Math.floor((done / total) * 100)
        if (pct !== progressPct) {
          progressPct = pct
          process.stdout.write(`\r  progress: ${pct}% (${done}/${total})        `)
        }
      }
    }
  })

  console.log('Enabling HeapProfiler ...')
  await send('HeapProfiler.enable')

  console.log('Taking snapshot (reportProgress=true, captureNumericValue=false) ...')
  const t0 = Date.now()
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: true, captureNumericValue: false })
  const elapsed = Date.now() - t0

  file.end()
  await new Promise<void>((r) => file.on('close', () => r()))

  const info = await stat(args.out)
  console.log(`\n\nDone in ${(elapsed / 1000).toFixed(1)}s`)
  console.log(`  chunks received: ${chunks}`)
  console.log(`  snapshot file: ${args.out}`)
  console.log(`  file size: ${(info.size / (1 << 20)).toFixed(1)} MB`)

  ws.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
