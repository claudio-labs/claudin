/**
 * smoke:binary — boots a compiled binary all the way to one answered request.
 *
 * `--version` and `--help` are answered by the entry's fast path, before the
 * main chunk loads, so a binary that dies at startup still passes both. #310
 * did: the SDK started importing a package `build.ts` kept in `external`, the
 * standalone binary could not resolve it, and `-p` crashed in `enableConfigs`
 * while `--version` exited 0. This runs one `-p` against a local mock of the
 * Messages API and passes only if the text the mock streamed comes back.
 *
 * Usage:
 *   bun run smoke:binary dist/bin/<platform>/claudin[.exe]
 *
 * The binary runs as a copy in a temp dir, from a temp cwd and with a fresh
 * CLAUDIN_CONFIG_DIR, because that is where a user's binary runs: nowhere near
 * the checkout's node_modules, and with no config of this machine. The config
 * and env are the ones src/agent/cache/__testutils__/mockAnthropic.ts gives
 * the wire e2e: an env ANTHROPIC_API_KEY alone answers "Not logged in".
 */

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 90_000
/** The session running this leaks its own; they would pick the provider. */
const HOST_ENV_RE = /^(?:CLAUDECODE$|CLAUDE_CODE_|_?CLAUDIN_|ANTHROPIC_|GIT_)/

function messagesStream(text: string): string {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  return [
    event('message_start', {
      message: {
        id: 'msg_smoke',
        type: 'message',
        role: 'assistant',
        model: 'claude-smoke',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
    event('message_stop', {}),
  ].join('')
}

// A crash dumps the minified source line it died on, which can be megabytes.
function tail(output: string): string {
  return output
    .trim()
    .split('\n')
    .slice(-12)
    .map(line => (line.length > 300 ? `${line.slice(0, 300)}…` : line))
    .join('\n')
}

export async function smokeBinary(
  binary: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string }> {
  const answer = `smoke-${crypto.randomUUID()}`
  let requests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/v1/messages')) {
        requests++
        return new Response(messagesStream(answer), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return Response.json({}, { status: 404 })
    },
  })
  const dir = mkdtempSync(join(tmpdir(), 'claudin-smoke-binary-'))
  try {
    const copy = join(dir, basename(binary))
    copyFileSync(resolve(binary), copy)
    if (process.platform !== 'win32') chmodSync(copy, 0o755)
    const cwd = join(dir, 'cwd')
    const configDir = join(dir, 'config')
    mkdirSync(cwd)
    mkdirSync(configDir)
    const baseUrl = `http://127.0.0.1:${server.port}`
    const profile = {
      id: 'smoke-binary',
      name: 'smoke-binary mock',
      provider: 'anthropic',
      baseUrl,
      model: 'claude-smoke',
      apiKey: 'sk-smoke',
    }
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        providerProfiles: [profile],
        activeProviderProfileId: profile.id,
        hasCompletedOnboarding: true,
      }),
    )

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !HOST_ENV_RE.test(k)) env[k] = v
    }
    const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, '127.0.0.1', 'localhost']
      .filter(Boolean)
      .join(',')

    const child = Bun.spawn(
      [
        copy,
        '-p',
        'hi',
        '--model',
        'claude-smoke',
        '--tools',
        '',
        '--strict-mcp-config',
        '--max-turns',
        '1',
        '--no-session-persistence',
      ],
      {
        cwd,
        env: {
          ...env,
          CLAUDIN_CONFIG_DIR: configDir,
          ANTHROPIC_BASE_URL: baseUrl,
          DISABLE_AUTOUPDATER: '1',
          NO_PROXY: noProxy,
          no_proxy: noProxy,
        },
        // stdin closed: headless waits 3s for stdin data it will never get.
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timer)

    if (code === 0 && stdout.includes(answer)) {
      return { ok: true, detail: `answered (${requests} request(s) to the mock)` }
    }
    const why = timedOut
      ? `timed out after ${timeoutMs} ms`
      : code === 0
        ? 'exit 0 without the mock’s answer'
        : `exit ${code}`
    return {
      ok: false,
      detail: `${why}, ${requests} request(s) to the mock\n--- stdout\n${tail(stdout)}\n--- stderr\n${tail(stderr)}`,
    }
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
}

if (import.meta.main) {
  const binary = process.argv[2]
  if (!binary) {
    console.error('Usage: bun run smoke:binary <path-to-compiled-binary>')
    process.exit(2)
  }
  const result = await smokeBinary(binary)
  console.log(`${result.ok ? '✓' : '✗'} smoke:binary ${binary}: ${result.detail}`)
  process.exit(result.ok ? 0 : 1)
}
