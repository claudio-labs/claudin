/**
 * `claudin mcp serve` driven by a real SDK Client over stdio, against the
 * built bundle (the handlers are only reachable through a transport).
 * Requires a build: `bun run build` (CI builds before `bun test`).
 *
 * - A client that cancels a tools/call (notifications/cancelled) must stop
 *   the running tool.
 * - A tool listed with an outputSchema must return structuredContent: the SDK
 *   client rejects the call otherwise (-32600), so Glob failed for every
 *   SDK-based client.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')

let root: string
let cwd: string
let client: Client

beforeAll(async () => {
  if (!existsSync(BUNDLE)) return
  root = mkdtempSync(join(tmpdir(), 'claudin-mcp-serve-gaps-'))
  cwd = join(root, 'project')
  const configDir = join(root, 'config')
  await Bun.write(join(cwd, 'hello.txt'), 'hi\n')
  await Bun.write(join(configDir, '.keep'), '')
  client = new Client({ name: 'serve-gaps', version: '0' }, { capabilities: {} })
  await client.connect(
    new StdioClientTransport({
      command: 'node',
      args: [BUNDLE, 'mcp', 'serve'],
      cwd,
      env: { ...(process.env as Record<string, string>), CLAUDIN_CONFIG_DIR: configDir },
      stderr: 'ignore',
    }),
  )
}, 30_000)

afterAll(async () => {
  await client?.close().catch(() => undefined)
  if (root) rmSync(root, { recursive: true, force: true })
})

const bashCall = (marker: string) => ({
  name: 'Bash',
  arguments: { command: `sleep 2 && echo done > ${marker}`, description: 'write a marker after 2s' },
})

describe.skipIf(!existsSync(BUNDLE))('claudin mcp serve — cancellation', () => {
  test('control: an uncancelled Bash call runs to completion', async () => {
    const marker = join(cwd, 'marker-control')
    const result = await client.callTool(bashCall(marker), CallToolResultSchema, { timeout: 20_000 })
    expect(result.isError).toBe(false)
    expect(existsSync(marker)).toBe(true)
  }, 25_000)

  test('a call cancelled by the client stops the running tool', async () => {
    const marker = join(cwd, 'marker-cancelled')
    const controller = new AbortController()
    const call = client
      .callTool(bashCall(marker), CallToolResultSchema, { signal: controller.signal, timeout: 20_000 })
      .catch((e: Error) => e)
    await Bun.sleep(500)
    controller.abort('user cancelled')
    expect(await call).toBeInstanceOf(Error)
    await Bun.sleep(3_000)
    expect(existsSync(marker) ? 'the tool kept running and wrote the marker' : 'stopped').toBe('stopped')
  }, 25_000)
})

describe.skipIf(!existsSync(BUNDLE))('claudin mcp serve — structured results', () => {
  test('control: Glob is listed with an object outputSchema', async () => {
    const { tools } = await client.listTools()
    expect(tools.find(t => t.name === 'Glob')?.outputSchema?.type).toBe('object')
  }, 20_000)

  test('tools/call Glob returns structuredContent', async () => {
    await client.listTools() // the SDK client checks results against the listed output schemas
    const outcome = await client
      .callTool({ name: 'Glob', arguments: { pattern: '*.txt' } }, CallToolResultSchema, { timeout: 20_000 })
      .then(
        r => ({ structuredContent: r.structuredContent !== undefined, isError: r.isError }),
        (e: Error) => ({ error: e.message }),
      )
    expect(outcome).toEqual({ structuredContent: true, isError: false })
  }, 25_000)
})
