/**
 * headersHelper: a command named in an MCP server's config that prints the
 * request headers as JSON. Every case runs a real shell script out of a fresh
 * temp dir, and reads what the script saw (its environment, its directory,
 * how often it ran) from files it leaves behind.
 *
 * Trust is driven through the real global config: a project entry marked as
 * trusted, or none. Interactivity is the session flag the CLI sets at boot.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMcpHeadersFromHelper, getMcpServerHeaders } from 'src/mcp/headersHelper.js'
import type { McpHTTPServerConfig, McpSSEServerConfig, McpWebSocketServerConfig } from 'src/mcp/types.js'
import { getIsInteractive, setIsInteractive } from 'src/platform/bootstrap/state.js'
import {
  getProjectPathForConfig,
  resetTrustDialogAcceptedCacheForTesting,
  saveGlobalConfig,
} from 'src/platform/config/config.js'
import { getInMemoryErrors } from 'src/shared/log.js'

// The build inlines MACRO; under the test runner the refusal path still reads it.
const buildGlobals = globalThis as { MACRO?: Record<string, unknown> }
buildGlobals.MACRO = { ...buildGlobals.MACRO, FEEDBACK_CHANNEL: 'the issue tracker' }

type Remote = McpSSEServerConfig | McpHTTPServerConfig | McpWebSocketServerConfig

let work = ''
let wasInteractive = false
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'PATH', 'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC', 'CHAR_HH_INHERITED']
const startDir = process.cwd()

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  work = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-headers-helper-')))
  mkdirSync(join(work, 'config'))
  mkdirSync(join(work, 'bin'))
  process.env.CLAUDIN_CONFIG_DIR = join(work, 'config')
  wasInteractive = getIsInteractive()
  resetTrustDialogAcceptedCacheForTesting()
})

afterEach(() => {
  process.chdir(startDir)
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  setIsInteractive(wasInteractive)
  saveGlobalConfig(current => ({ ...current, projects: {} }))
  resetTrustDialogAcceptedCacheForTesting()
  rmSync(work, { recursive: true, force: true })
})

/** Writes an executable sh script into the work dir; every run appends to runs.log. */
function helper(body: string, name = 'headers.sh'): string {
  const file = join(work, name)
  writeFileSync(file, `#!/bin/sh\necho run >> "${join(work, 'runs.log')}"\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}
const runs = () => (existsSync(join(work, 'runs.log')) ? readFileSync(join(work, 'runs.log'), 'utf8').split('\n').filter(Boolean).length : 0)
const printing = (stdout: string) => helper(`cat <<'JSON'\n${stdout}\nJSON`)

const http = (headersHelper: string | undefined, extra: Record<string, unknown> = {}): Remote =>
  ({ type: 'http', url: 'https://mcp.example.test/mcp', ...(headersHelper ? { headersHelper } : {}), ...extra }) as Remote

function trustThisProject() {
  saveGlobalConfig(current => ({
    ...current,
    projects: { [getProjectPathForConfig()]: { hasTrustDialogAccepted: true } as never },
  }))
}

/** Failure reasons the module reports, for one server, once error recording is opted into. */
const reportedFor = (server: string) => getInMemoryErrors().map(e => e.error).filter(e => e.includes(`'${server}'`))

describe('a well-behaved helper', () => {
  test('its JSON object on stdout becomes the headers, whitespace and stderr ignored', async () => {
    const cases: [label: string, body: string, out: Record<string, string>][] = [
      ['plain', `echo '{"Authorization":"Bearer t-1","X-Tenant":"acme"}'`, { Authorization: 'Bearer t-1', 'X-Tenant': 'acme' }],
      ['padded and noisy', `echo 'warming up' >&2\nprintf '\\n  {"A":"1"}  \\n\\n'`, { A: '1' }],
      ['empty string value', `echo '{"X-Empty":""}'`, { 'X-Empty': '' }],
      ['an empty object', `echo '{}'`, {}],
      ['reads stdin to its end without hanging', `cat >/dev/null\necho '{"B":"2"}'`, { B: '2' }],
    ]
    for (const [label, body, out] of cases) {
      expect(await getMcpHeadersFromHelper('docs', http(helper(body))), label).toEqual(out)
    }
  })

  test('it runs again on every call, so a rotating token is picked up', async () => {
    const counter = join(work, 'n')
    writeFileSync(counter, '0')
    const cfg = http(helper(`n=$(($(cat "${counter}") + 1)); echo $n > "${counter}"; echo "{\\"X-Seq\\":\\"$n\\"}"`))
    expect(await getMcpHeadersFromHelper('docs', cfg)).toEqual({ 'X-Seq': '1' })
    expect(await getMcpHeadersFromHelper('docs', cfg)).toEqual({ 'X-Seq': '2' })
    expect(await getMcpServerHeaders('docs', cfg)).toEqual({ 'X-Seq': '3' })
    expect(runs()).toBe(3)
  })

  test('without a helper configured nothing runs and the answer is null', async () => {
    for (const cfg of [http(undefined), http(''), http(undefined, { headers: { A: 'b' } })]) {
      expect(await getMcpHeadersFromHelper('docs', cfg)).toBeNull()
    }
  })
})

describe('how the helper is launched', () => {
  test('it inherits the environment plus the server name and URL, for every remote transport', async () => {
    process.env.CHAR_HH_INHERITED = 'from-parent'
    const dump = join(work, 'env.txt')
    const script = helper(`env > "${dump}"\necho '{}'`)
    const configs: Remote[] = [
      { type: 'sse', url: 'https://sse.example.test/events', headersHelper: script },
      { type: 'http', url: 'https://http.example.test/mcp?tenant=a', headersHelper: script },
      { type: 'ws', url: 'wss://ws.example.test/socket', headersHelper: script },
    ]
    for (const cfg of configs) {
      expect(await getMcpHeadersFromHelper(`srv-${cfg.type}`, cfg)).toEqual({})
      const seen = Object.fromEntries(
        readFileSync(dump, 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
      expect(seen.CLAUDIN_MCP_SERVER_NAME, cfg.type).toBe(`srv-${cfg.type}`)
      expect(seen.CLAUDIN_MCP_SERVER_URL, cfg.type).toBe(cfg.url)
      expect(seen.CHAR_HH_INHERITED, cfg.type).toBe('from-parent')
      expect(seen.CLAUDIN_CONFIG_DIR, cfg.type).toBe(join(work, 'config'))
    }
  })

  test('it runs in the process working directory, where a relative path is resolved', async () => {
    const nested = join(work, 'project')
    mkdirSync(nested)
    writeFileSync(join(nested, 'rel.sh'), `#!/bin/sh\npwd > "${join(work, 'pwd.txt')}"\necho '{"Where":"project"}'\n`)
    chmodSync(join(nested, 'rel.sh'), 0o755)
    process.chdir(nested)
    expect(await getMcpHeadersFromHelper('docs', http('./rel.sh'))).toEqual({ Where: 'project' })
    expect(readFileSync(join(work, 'pwd.txt'), 'utf8').trim()).toBe(nested)
  })

  test('a bare name is looked up on PATH', async () => {
    writeFileSync(join(work, 'bin', 'char-hh-print'), `#!/bin/sh\necho '{"Via":"path"}'\n`)
    chmodSync(join(work, 'bin', 'char-hh-print'), 0o755)
    process.env.PATH = `${join(work, 'bin')}:${process.env.PATH ?? ''}`
    expect(await getMcpHeadersFromHelper('docs', http('char-hh-print'))).toEqual({ Via: 'path' })
  })

  test('the value is one executable, never a shell line: arguments and shell syntax mean nothing runs', async () => {
    const script = helper(`echo '{"A":"b"}'`)
    const marker = join(work, 'pwned')
    for (const line of [`${script} --flag`, `sh -c "touch ${marker}"`, `touch ${marker}`, `echo hi; touch ${marker}`, `$(touch ${marker})`]) {
      expect(await getMcpHeadersFromHelper('docs', http(line)), line).toBeNull()
    }
    expect(runs()).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  test('a helper still running after ten seconds is killed and yields null', async () => {
    const cfg = http(helper(`exec sleep 30`))
    const started = Date.now()
    expect(await getMcpHeadersFromHelper('docs', cfg)).toBeNull()
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(9_500)
    expect(took).toBeLessThan(13_000)
  }, 20_000)

  test('a helper that answers within the limit is waited for', async () => {
    expect(await getMcpHeadersFromHelper('docs', http(helper(`sleep 2\necho '{"Slow":"ok"}'`)))).toEqual({ Slow: 'ok' })
  }, 10_000)
})

describe('a helper that misbehaves yields null, never an exception', () => {
  test('bad output, a failing exit and a missing program', async () => {
    process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
    const missing = join(work, 'not-there.sh')
    const notExecutable = join(work, 'plain.txt')
    writeFileSync(notExecutable, `echo '{"A":"b"}'`)
    type Case = [server: string, command: () => string, reason: string]
    const cases: Case[] = [
      ['exit-nonzero', () => helper(`echo '{"A":"b"}'\nexit 3`), 'did not return a valid value'],
      ['silent', () => helper('true'), 'did not return a valid value'],
      ['blank', () => printing('   '), ''],
      ['not-json', () => printing('Authorization: Bearer x'), ''],
      ['array', () => printing('[["A","b"]]'), 'must return a JSON object with string key-value pairs'],
      ['null', () => printing('null'), 'must return a JSON object with string key-value pairs'],
      ['string', () => printing('"Bearer x"'), 'must return a JSON object with string key-value pairs'],
      ['number', () => printing('42'), 'must return a JSON object with string key-value pairs'],
      ['numeric-value', () => printing('{"A":"b","X-Port":8080}'), 'returned non-string value for key "X-Port": number'],
      ['nested-value', () => printing('{"A":{"b":"c"}}'), 'returned non-string value for key "A": object'],
      ['null-value', () => printing('{"A":null}'), 'returned non-string value for key "A": object'],
      ['bool-value', () => printing('{"A":true}'), 'returned non-string value for key "A": boolean'],
      ['too-much-output', () => helper(`head -c 1100000 /dev/zero | tr '\\0' a`), 'did not return a valid value'],
      ['missing', () => missing, 'did not return a valid value'],
      ['not-executable', () => notExecutable, 'did not return a valid value'],
    ]
    for (const [server, command, reason] of cases) {
      expect(await getMcpHeadersFromHelper(server, http(command())), server).toBeNull()
      const reported = reportedFor(server)
      expect(reported.length, server).toBeGreaterThan(0)
      expect(reported.at(-1), server).toContain(`headersHelper for server '${server}'`)
      if (reason) expect(reported.at(-1), server).toContain(reason)
    }
  })
})

describe('workspace trust', () => {
  const marker = () => join(work, 'ran')
  const watched = () => helper(`touch "${marker()}"\necho '{"From":"helper"}'`)

  test('in an interactive session, project and local servers wait for the trust dialog; other scopes do not', async () => {
    setIsInteractive(true)
    type Case = [scope: string | undefined, runsUntrusted: boolean]
    const cases: Case[] = [
      ['project', false],
      ['local', false],
      ['user', true],
      ['dynamic', true],
      ['enterprise', true],
      ['claudeai', true],
      ['managed', true],
      [undefined, true],
    ]
    for (const [scope, runsUntrusted] of cases) {
      rmSync(marker(), { force: true })
      const cfg = http(watched(), scope ? { scope, headers: { Static: 's' } } : { headers: { Static: 's' } })
      const got = await getMcpHeadersFromHelper('docs', cfg)
      expect(got, String(scope)).toEqual(runsUntrusted ? { From: 'helper' } : null)
      expect(existsSync(marker()), String(scope)).toBe(runsUntrusted)
      expect(await getMcpServerHeaders('docs', cfg), String(scope)).toEqual(
        runsUntrusted ? { Static: 's', From: 'helper' } : { Static: 's' },
      )
    }
  })

  test('once this project is trusted, project and local helpers run', async () => {
    setIsInteractive(true)
    trustThisProject()
    for (const scope of ['project', 'local']) {
      rmSync(marker(), { force: true })
      expect(await getMcpHeadersFromHelper('docs', http(watched(), { scope })), scope).toEqual({ From: 'helper' })
      expect(existsSync(marker()), scope).toBe(true)
    }
  })

  test('trust given mid-session is honoured on the next call', async () => {
    setIsInteractive(true)
    const cfg = http(watched(), { scope: 'project' })
    expect(await getMcpHeadersFromHelper('docs', cfg)).toBeNull()
    trustThisProject()
    expect(await getMcpHeadersFromHelper('docs', cfg)).toEqual({ From: 'helper' })
  })

  test('a non-interactive session runs a project helper with no trust at all', async () => {
    setIsInteractive(false)
    for (const scope of ['project', 'local']) {
      rmSync(marker(), { force: true })
      expect(await getMcpHeadersFromHelper('docs', http(watched(), { scope })), scope).toEqual({ From: 'helper' })
      expect(existsSync(marker()), scope).toBe(true)
    }
  })
})

describe('getMcpServerHeaders', () => {
  test('static headers, overridden key by key by the helper, and kept alone when it fails', async () => {
    type Case = [label: string, headers: Record<string, string> | undefined, command: () => string | undefined, out: Record<string, string>]
    const cases: Case[] = [
      ['neither', undefined, () => undefined, {}],
      ['static only', { A: '1', B: '2' }, () => undefined, { A: '1', B: '2' }],
      ['helper only', undefined, () => printing('{"C":"3"}'), { C: '3' }],
      ['helper wins per key', { A: '1', B: '2' }, () => printing('{"B":"x","C":"y"}'), { A: '1', B: 'x', C: 'y' }],
      ['failing helper', { A: '1' }, () => helper('exit 1'), { A: '1' }],
      ['bad output', { A: '1' }, () => printing('[]'), { A: '1' }],
    ]
    for (const [label, headers, command, out] of cases) {
      const cmd = command()
      const cfg = http(cmd, headers ? { headers } : {})
      expect(await getMcpServerHeaders('docs', cfg), label).toEqual(out)
    }
  })

  test('the static headers in the config are not modified', async () => {
    const headers = { A: '1' }
    await getMcpServerHeaders('docs', http(printing('{"A":"2","B":"3"}'), { headers }))
    expect(headers).toEqual({ A: '1' })
  })
})
