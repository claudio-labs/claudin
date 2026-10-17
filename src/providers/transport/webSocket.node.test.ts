import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// openWebSocket's Node branch is what `bin/claudin` runs, and nothing inside
// `bun test` can stand in for it: Bun's `ws` shim emits neither `upgrade` nor
// `unexpected-response`, and the real package fails inside Bun ("Unexpected
// server response: 101"). So the driver is bundled for node and run there.
const node = Bun.which('node')
let outDir: string
let report: Record<string, unknown> = {}

beforeAll(async () => {
  if (!node) return
  outDir = mkdtempSync(join(tmpdir(), 'ws-node-driver-'))
  // The CLI, not Bun.build: in-process under `bun test`, Bun.build fails to
  // resolve some `src/…` aliases that the CLI resolves.
  const build = Bun.spawnSync([process.execPath, 'build', join(import.meta.dir, '__testutils__', 'webSocketNodeDriver.ts'), '--target=node', '--outdir', outDir])
  if (build.exitCode !== 0) throw new Error(`bundling the node driver failed: ${build.stderr.toString()}`)
  const proc = Bun.spawn([node, join(outDir, 'webSocketNodeDriver.js')], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const line = stdout.trim().split('\n').at(-1) ?? '{}'
  report = JSON.parse(line) as Record<string, unknown>
  if (code !== 0) throw new Error(`node driver exited ${code}: ${stderr}\n${stdout}`)
}, 30_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

test.skipIf(!node)('upgrade headers, subprotocol, text, bytes, ping and close under node', () => {
  expect(report.upgradeLastId).toBe('abc')
  expect(report.serverAuthorization).toBe('Bearer t0k')
  expect(report.serverProtocol).toBe('mcp')
  expect(report.clientBytes).toEqual([[1, 2, 3]])
  expect(report.serverBytes).toEqual([9, 8])
  expect(report.roundTripEvents).toEqual(['upgrade', 'open', 'sent', 'message:echo:ok', 'pong', 'close:4001:bye now'])
})

test.skipIf(!node)('a refused upgrade reports its status and body, then closes, with no error', () => {
  expect(report.refusedEvents).toEqual(['refused:403:go away', 'close:1006'])
})

test.skipIf(!node)('detach drops every later event', () => {
  expect(report.detachEvents).toEqual(['open'])
})

test.skipIf(!node)('the upgrade goes through HTTPS_PROXY', () => {
  expect((report.proxyConnects as string[]).length).toBe(1)
  expect(report.proxiedMessage).toBe('hello')
})
