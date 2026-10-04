/**
 * Tiny stdio MCP servers for the doctor suites, written as scripts into a temp
 * directory and run by the same Bun binary that runs the tests.
 *
 * Each script appends its pid to a ledger file the moment it starts, so a test
 * can tell whether the doctor spawned it and whether the process is gone once
 * the doctor returns.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Newline-delimited JSON-RPC. `initialize` is answered with the version the
// client offered, `ping` with an empty result, any other request with
// "method not found"; notifications get no answer.
const HANDSHAKING_SCRIPT = `
import { appendFileSync as note } from 'node:fs'
import readline from 'node:readline'
note(process.argv[2], process.pid + '\\n')
const answer = (id, payload) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id }, payload)) + '\\n')
const handlers = {
  initialize: params => ({ protocolVersion: params.protocolVersion, capabilities: {}, serverInfo: { name: 'doctor-probe', version: '0.1.0' } }),
  ping: () => ({}),
}
readline.createInterface({ input: process.stdin }).on('line', text => {
  const message = JSON.parse(text)
  if (!('id' in message)) return
  const handler = handlers[message.method]
  answer(message.id, handler ? { result: handler(message.params ?? {}) } : { error: { code: -32601, message: 'unknown method ' + message.method } })
})
`

// Records its start, complains on stderr, and leaves before any handshake.
const EARLY_EXIT_SCRIPT = `
require('node:fs').appendFileSync(process.argv[2], process.pid + '\\n')
console.error('doctor-probe: refusing to start')
process.exitCode = 3
`

type StdioEntry = { command: string; args: string[] }

export type ProbeServers = {
  /** A stdio entry that completes the MCP handshake. */
  answering: () => StdioEntry
  /** A stdio entry whose process exits before answering. */
  dying: () => StdioEntry
  /** A stdio entry whose executable does not exist. */
  absent: () => StdioEntry
  /** Pids of every probe process started so far, in start order. */
  started: () => number[]
  /** Waits until none of the started processes is alive; false on timeout. */
  allGone: (timeoutMs?: number) => Promise<boolean>
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function installProbeServers(dir: string): ProbeServers {
  const ledger = join(dir, 'probe-pids.log')
  const scripts = {
    answering: join(dir, 'handshaking-probe.mjs'),
    dying: join(dir, 'early-exit-probe.cjs'),
  }
  writeFileSync(scripts.answering, HANDSHAKING_SCRIPT)
  writeFileSync(scripts.dying, EARLY_EXIT_SCRIPT)

  const viaBun = (script: string): StdioEntry => ({ command: process.execPath, args: [script, ledger] })
  const started = (): number[] =>
    existsSync(ledger)
      ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(Number)
      : []

  return {
    answering: () => viaBun(scripts.answering),
    dying: () => viaBun(scripts.dying),
    absent: () => ({ command: 'claudin-doctor-no-such-binary', args: [] }),
    started,
    allGone: async (timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs
      while (started().some(isRunning)) {
        if (Date.now() >= deadline) return false
        await Bun.sleep(25)
      }
      return true
    },
  }
}

/** Kills whatever probe processes are still alive (test teardown only). */
export function reapProbeServers(servers: ProbeServers | undefined): void {
  for (const pid of servers?.started() ?? []) {
    if (!isRunning(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // exited between the check and the kill
    }
  }
}
