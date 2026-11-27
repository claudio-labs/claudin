/**
 * `claudin mcp login` end to end: the built CLI against a local OAuth server,
 * in a scratch config dir with no `secret-tool` on PATH (plaintext fallback
 * there). The browser is `/usr/bin/true`, so the authorization is never
 * approved: these tests are about the process waiting for the callback.
 * Requires a build: `bun run build` (CI builds before `bun test`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
const SCRIPT = '/usr/bin/script'

let root: string
let srv: ReturnType<typeof Bun.serve> | undefined
const requests: string[] = []

function env(): Record<string, string> {
  return {
    PATH: join(root, 'bin'),
    HOME: join(root, 'home'),
    CLAUDIN_CONFIG_DIR: join(root, 'config'),
    BROWSER: '/usr/bin/true',
    NO_PROXY: '*',
  }
}

beforeAll(() => {
  if (!existsSync(BUNDLE)) return
  root = mkdtempSync(join(tmpdir(), 'claudin-mcp-login-'))
  for (const dir of ['bin', 'home', 'config', 'cwd']) mkdirSync(join(root, dir))
  symlinkSync(Bun.which('node')!, join(root, 'bin', 'node'))
  srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      requests.push(`${req.method} ${url.pathname}`)
      const origin = `http://127.0.0.1:${srv!.port}`
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        })
      }
      if (url.pathname === '/register') {
        return Response.json({ ...((await req.json()) as object), client_id: 'e2e-client' }, { status: 201 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  const add = Bun.spawnSync(
    ['node', BUNDLE, 'mcp', 'add', '--transport', 'http', '-s', 'user', 'oauthy', `http://127.0.0.1:${srv.port}/mcp`],
    { cwd: join(root, 'cwd'), env: env(), stdin: 'ignore' },
  )
  if (add.exitCode !== 0) throw new Error(`mcp add failed: ${add.stderr.toString()}`)
})

afterAll(() => {
  srv?.stop(true)
  if (root) rmSync(root, { recursive: true, force: true })
})

test('the bundle exists', () => {
  expect(existsSync(BUNDLE) ? 'present' : `MISSING — run \`bun run build\` first: ${BUNDLE}`).toBe('present')
})

describe.skipIf(!existsSync(BUNDLE))('claudin mcp login', () => {
  test('without a terminal it waits for the browser callback instead of exiting', async () => {
    const login = Bun.spawn(['node', BUNDLE, 'mcp', 'login', 'oauthy'], {
      cwd: join(root, 'cwd'),
      env: env(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exited = await Promise.race([login.exited, Bun.sleep(6000).then(() => 'still running')])
    if (exited === 'still running') login.kill()
    const out = await new Response(login.stdout).text()
    expect(requests).toContain('POST /register')
    expect(out).toContain('/authorize?')
    expect(exited).toBe('still running')
  }, 30_000)

  test.skipIf(!existsSync(SCRIPT))('control: on a terminal it keeps waiting after an empty Enter at the paste prompt', async () => {
    const login = Bun.spawn([SCRIPT, '-qfec', `node ${BUNDLE} mcp login oauthy`, '/dev/null'], {
      cwd: join(root, 'cwd'),
      env: env(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await Bun.sleep(3000)
    login.stdin.write('\n')
    login.stdin.flush()
    const exited = await Promise.race([login.exited, Bun.sleep(4000).then(() => 'still running')])
    if (exited === 'still running') login.kill()
    expect(exited).toBe('still running')
  }, 30_000)
})
