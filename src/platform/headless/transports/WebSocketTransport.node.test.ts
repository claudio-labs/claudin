/**
 * The transport's Node branch, run under Node with the real `ws` package.
 *
 * `bun test` never takes that branch (`typeof Bun` is defined), and inside
 * Bun `import('ws')` is Bun's shim, which emits no `upgrade` event. So this
 * test bundles `__testutils__/transportNodeDriver.ts` for `target: 'node'`
 * and runs it with `node`; the driver prints a JSON summary of what its
 * `ws` server saw.
 *
 * Known bug pinned here: `onNodeOpen` reads `ws.upgradeReq`, which ws 8 does
 * not have, so after a reconnect on Node the unconfirmed messages are never
 * replayed — the server's `x-last-request-id` is ignored and nothing is
 * resent. The Bun path replays the whole buffer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TransportNodeDriverResult } from './__testutils__/transportNodeDriver.js'

const DRIVER = join(import.meta.dir, '__testutils__', 'transportNodeDriver.ts')

let outDir = ''
let result: TransportNodeDriverResult

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'ws-transport-node-'))
  // Bun 1.3 quirk: the FIRST Bun.build inside a `bun test` process ignores
  // the tsconfig `src/*` paths ("Could not resolve: src/shared/debug.js"),
  // even with an explicit `tsconfig` option; every later build resolves
  // them. Resolving one aliased specifier first loads the paths into the
  // resolver, so the build works whether or not this file runs first.
  Bun.resolveSync('src/shared/debug.js', import.meta.dir)
  const build = await Bun.build({
    entrypoints: [DRIVER],
    target: 'node',
    outdir: outDir,
  })
  if (!build.success) {
    throw new Error(`driver bundle failed:\n${build.logs.join('\n')}`)
  }
  const proc = Bun.spawn(['node', build.outputs[0]!.path], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const last = stdout.trim().split('\n').at(-1) ?? ''
  if (code !== 0 || !last.startsWith('{')) {
    throw new Error(`driver exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`)
  }
  result = JSON.parse(last) as TransportNodeDriverResult
}, 20_000)

afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true })
})

describe('WebSocketTransport under Node (real ws)', () => {
  test('the driver ran the Node branch and reconnected', () => {
    expect(result.error).toBeUndefined()
    expect(result.runtime.startsWith('node ')).toBe(true)
    expect(result.connections).toBe(2)
    expect(result.firstConnection).toEqual(['u1', 'u2', 'u3'])
    // The reconnect advertises the last id it sent; the server answers with
    // the last id it confirmed.
    expect(result.requestLastIds).toEqual([null, 'u3'])
    expect(result.responseLastIds).toEqual([null, 'u1'])
  })

  test('after a reconnect, replays the messages after the server-confirmed id', () => {
    expect(result.afterReconnect).toEqual(['u2', 'u3'])
  })
})
