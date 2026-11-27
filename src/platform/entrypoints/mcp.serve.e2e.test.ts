/**
 * `claudin mcp serve` end to end: the built CLI over stdio JSON-RPC, the way an
 * MCP client drives it. The handlers live inside startMCPServer and are only
 * reachable through a transport, so the bundle is what this suite runs.
 * Requires a build: `bun run build` (CI builds before `bun test`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')

type Reply = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } }

let root: string
let replies: Map<number, Reply>

// One server process answers the whole exchange; each test reads its reply by id.
async function exchange(cwd: string, configDir: string, requests: object[]): Promise<Map<number, Reply>> {
  const proc = Bun.spawn(['node', BUNDLE, 'mcp', 'serve'], {
    cwd,
    env: { ...process.env, CLAUDIN_CONFIG_DIR: configDir, CLAUDE_CONFIG_DIR: configDir },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  proc.stdin.write(requests.map(r => JSON.stringify(r)).join('\n') + '\n')
  proc.stdin.flush()
  const wanted = requests.filter(r => 'id' in r).length
  const got = new Map<number, Reply>()
  const reader = proc.stdout.getReader()
  let buffered = ''
  const deadline = Date.now() + 25_000
  while (got.size < wanted && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += new TextDecoder().decode(value)
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('{')) continue
      const reply = JSON.parse(line) as Reply
      if (typeof reply.id === 'number') got.set(reply.id, reply)
    }
  }
  proc.kill()
  await proc.exited
  return got
}

beforeAll(async () => {
  if (!existsSync(BUNDLE)) return
  root = mkdtempSync(join(tmpdir(), 'claudin-mcp-serve-'))
  const cwd = join(root, 'project')
  const configDir = join(root, 'config')
  await Bun.write(join(cwd, 'hello.txt'), 'hi\n')
  await Bun.write(join(configDir, '.keep'), '')
  replies = await exchange(cwd, configDir, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'Glob', arguments: { pattern: '*.txt' } } },
  ])
}, 30_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test('the bundle exists', () => {
  expect(existsSync(BUNDLE) ? 'present' : `MISSING — run \`bun run build\` first: ${BUNDLE}`).toBe('present')
})

describe.skipIf(!existsSync(BUNDLE))('claudin mcp serve', () => {
  test('control: the handshake names the server claudin', () => {
    const info = replies.get(1)?.result?.serverInfo as { name?: string } | undefined
    expect(info?.name).toBe('claudin')
  })

  test('tools/list answers the tool list', () => {
    const reply = replies.get(2)
    expect(reply?.error?.message).toBeUndefined()
    const names = ((reply?.result?.tools ?? []) as Array<{ name: string }>).map(t => t.name)
    expect(names).toContain('Glob')
    expect(names).toContain('Read')
  })

  test('control: tools/call runs a tool', () => {
    const reply = replies.get(3)
    expect(reply?.result?.isError).toBe(false)
    expect(JSON.stringify(reply?.result?.content)).toContain('hello.txt')
  })
})
