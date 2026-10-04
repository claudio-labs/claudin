/**
 * The headersHelper fixes of the mcp/auth spec (Findings 3, 4, 5, 6 and 13),
 * and the pure parts the characterization suite reaches only through a real
 * helper: the executable rule, the output parser, the trust decision and the
 * merge.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMcpHeadersFromHelper, getMcpServerHeaders } from 'src/mcp/headersHelper.js'
import { mergeHeaders } from 'src/mcp/headersHelper/mergeHeaders.js'
import { parseHelperOutput } from 'src/mcp/headersHelper/parseOutput.js'
import {
  defaultHeadersHelperDeps,
  HELPER_TIMEOUT_MS,
  type HeadersHelperDeps,
  readHelperHeaders,
  type RemoteServerConfig,
} from 'src/mcp/headersHelper/readHelperHeaders.js'
import { executableProblem, runHelper } from 'src/mcp/headersHelper/runHelper.js'
import { decideHelperTrust } from 'src/mcp/headersHelper/trust.js'
import { getInMemoryErrors } from 'src/shared/log.js'

let work = ''
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC', 'FIX_HH_MULTILINE', 'BASH_FUNC_fixhh%%']

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  work = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-hh-fixes-')))
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(work, { recursive: true, force: true })
})

function script(body: string, name = 'h.sh'): string {
  const file = join(work, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}
const http = (headersHelper: string, extra: Record<string, unknown> = {}): RemoteServerConfig =>
  ({ type: 'http', url: 'https://mcp.example.test/mcp', headersHelper, ...extra }) as RemoteServerConfig

/** Deps that record every log line, running helpers for real unless told otherwise. */
function recording(overrides: Partial<HeadersHelperDeps> = {}) {
  const toServer: string[] = []
  const errors: string[] = []
  const deps: HeadersHelperDeps = {
    ...defaultHeadersHelperDeps,
    logToServer: (_server, message) => toServer.push(message),
    logError: error => errors.push(error.message),
    logDebug: () => {},
    ...overrides,
  }
  return { deps, toServer, errors }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Finding 3: the deadline is a hard limit', () => {
  const quick = { maxOutputBytes: 1024 * 1024, killGraceMs: 200 }

  test('a helper that ignores SIGTERM is given up on at the deadline, and its late answer is not taken', async () => {
    const stubborn = script(`trap '' TERM\nsleep 3\necho '{"Late":"yes"}'`)
    // A grace longer than the helper's own run: only an answer given at the
    // deadline itself, not at the process's end, is fast enough.
    const patient = { maxOutputBytes: 1024 * 1024, killGraceMs: 5000 }
    const started = Date.now()
    const result = await runHelper(stubborn, { env: process.env, timeoutMs: 300, ...patient })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(result.ok).toBe(false)

    const { deps, errors } = recording({
      run: (command, env) => runHelper(command, { env, timeoutMs: 300, ...patient }),
    })
    const viaDeps = Date.now()
    expect(await readHelperHeaders('slow', http(stubborn), deps)).toBeNull()
    expect(Date.now() - viaDeps).toBeLessThan(1500)
    expect(errors.at(-1)).toContain('did not return a valid value')
  })

  test('a background child holding stdout does not hold the call, and the whole group is killed', async () => {
    const pidFile = join(work, 'child.pid')
    const parent = script(`trap '' TERM\nsleep 30 &\necho $! > "${pidFile}"\necho '{"A":"b"}'\nwait`)
    const started = Date.now()
    const result = await runHelper(parent, { env: process.env, timeoutMs: 400, ...quick })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(result.ok).toBe(false)

    const child = Number(readFileSync(pidFile, 'utf8').trim())
    const until = Date.now() + 3000
    while (isAlive(child) && Date.now() < until) await Bun.sleep(50)
    expect(isAlive(child)).toBe(false)
  })

  test('the deadline is ten seconds', () => {
    expect(HELPER_TIMEOUT_MS).toBe(10_000)
  })
})

describe('Finding 4: the environment is passed as it is', () => {
  test('an inherited value holding a newline no longer stops the helper', async () => {
    process.env.FIX_HH_MULTILINE = 'line one\nline two'
    process.env['BASH_FUNC_fixhh%%'] = '() {  echo hi\n}'
    const seen = join(work, 'seen.txt')
    const helper = script(`printf '%s' "$FIX_HH_MULTILINE" > "${seen}"\necho '{"Ran":"yes"}'`)
    expect(await getMcpHeadersFromHelper('docs', http(helper))).toEqual({ Ran: 'yes' })
    expect(readFileSync(seen, 'utf8')).toBe('line one\nline two')
  })
})

describe('Finding 5: a refusal before trust is reported', () => {
  test('the server log says the helper waits for workspace trust, and nothing runs', async () => {
    let ran = 0
    const { deps, toServer, errors } = recording({
      isInteractive: () => true,
      isWorkspaceTrusted: () => false,
      run: async () => {
        ran += 1
        return { ok: true, stdout: '{}' }
      },
    })
    for (const scope of ['project', 'local']) {
      expect(await readHelperHeaders('team-docs', http('./h.sh', { scope }), deps), scope).toBeNull()
    }
    expect(ran).toBe(0)
    expect(toServer).toHaveLength(2)
    for (const line of toServer) {
      expect(line).toContain("'team-docs'")
      expect(line).toContain('workspace trust')
      expect(line).not.toMatch(/feedback|issue tracker/i)
    }
    expect(errors).toEqual([])
  })

  test('a server that may run logs no refusal', async () => {
    const { deps, toServer } = recording({
      isInteractive: () => true,
      isWorkspaceTrusted: () => true,
      run: async () => ({ ok: true, stdout: '{"A":"b"}' }),
    })
    expect(await readHelperHeaders('docs', http('./h.sh', { scope: 'project' }), deps)).toEqual({ A: 'b' })
    expect(toServer).toEqual([])
  })
})

describe('Finding 6: header names merge case-insensitively', () => {
  test('a helper header replaces a static one of any case, with the helper spelling', async () => {
    const helper = script(`echo '{"Authorization":"Bearer fresh"}'`)
    const headers = { authorization: 'Bearer static', 'X-Keep': '1' }
    const merged = await getMcpServerHeaders('docs', http(helper, { headers }))
    expect(merged).toEqual({ Authorization: 'Bearer fresh', 'X-Keep': '1' })
    expect(headers).toEqual({ authorization: 'Bearer static', 'X-Keep': '1' })
  })

  test('mergeHeaders', () => {
    const cases: [base: Record<string, string>, overlay: Record<string, string>, out: Record<string, string>][] = [
      [{}, {}, {}],
      [{ A: '1' }, {}, { A: '1' }],
      [{}, { B: '2' }, { B: '2' }],
      [{ 'x-token': 'old', Keep: 'k' }, { 'X-TOKEN': 'new' }, { 'X-TOKEN': 'new', Keep: 'k' }],
      [{ Accept: 'a', accept: 'b' }, { ACCEPT: 'c' }, { ACCEPT: 'c' }],
      [{ A: '1' }, { a: '' }, { a: '' }],
    ]
    for (const [base, overlay, out] of cases) {
      const merged = mergeHeaders(base, overlay)
      expect(merged, JSON.stringify([base, overlay])).toEqual(out)
      expect(Object.keys(merged).sort()).toEqual(Object.keys(out).sort())
    }
  })
})

describe('Finding 13: output that is not JSON stays out of the error log', () => {
  test('the report says the output is not JSON and quotes none of it', async () => {
    process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
    const leaky = script(`echo 'Authorization: Bearer sekrit-1234'`)
    const { deps, toServer, errors } = recording()
    expect(await readHelperHeaders('leaky', http(leaky), deps)).toBeNull()
    expect(await getMcpHeadersFromHelper('leaky-real', http(leaky))).toBeNull()
    const logged = getInMemoryErrors().map(e => e.error).filter(e => e.includes("'leaky-real'"))
    for (const line of [...toServer, ...errors, ...logged]) {
      expect(line).toContain('did not print valid JSON')
      expect(line).not.toMatch(/Authorization|Bearer|sekrit/)
    }
    expect(toServer.length + errors.length + logged.length).toBe(3)
  })
})

describe('reports and the runner, beyond the characterization suite', () => {
  test('an empty headersHelper is no helper: nothing runs and nothing is reported', async () => {
    let ran = 0
    const { deps, toServer, errors } = recording({
      run: async () => {
        ran += 1
        return { ok: false, failure: 'x' }
      },
    })
    expect(await readHelperHeaders('docs', http(''), deps)).toBeNull()
    expect([ran, toServer, errors]).toEqual([0, [], []])
  })

  test('each rejection has its reason, in the server log and the error log alike', async () => {
    const cases: [stdout: string, reason: string][] = [
      ['  \n', "headersHelper for MCP server 'docs' did not return a valid value"],
      ['[1]', "headersHelper for MCP server 'docs' must return a JSON object with string key-value pairs"],
      ['{"K":1}', `headersHelper for MCP server 'docs' returned non-string value for key "K": number`],
      ['nope', "headersHelper for MCP server 'docs' did not print valid JSON"],
    ]
    for (const [stdout, reason] of cases) {
      const { deps, toServer, errors } = recording({ run: async () => ({ ok: true, stdout }) })
      expect(await readHelperHeaders('docs', http('./h.sh'), deps), stdout).toBeNull()
      const line = `Error getting MCP headers from headersHelper for server 'docs': ${reason}`
      expect([toServer, errors], stdout).toEqual([[line], [line]])
    }
  })

  test('the helper is asked to stop with SIGTERM before it is killed', async () => {
    const marker = join(work, 'got-term')
    const polite = script(`trap 'echo term > "${marker}"; exit 0' TERM\nsleep 30 &\nwait`)
    const result = await runHelper(polite, { env: process.env, timeoutMs: 300, maxOutputBytes: 1024, killGraceMs: 1000 })
    expect(result.ok).toBe(false)
    const until = Date.now() + 2000
    while (!existsSync(marker) && Date.now() < until) await Bun.sleep(25)
    expect(existsSync(marker)).toBe(true)
  })

  test('stderr counts toward the output limit', async () => {
    const noisy = script(`head -c 5000 /dev/zero >&2\necho '{"A":"b"}'`)
    const limits = { env: process.env, timeoutMs: 5000, killGraceMs: 100 }
    expect(await runHelper(noisy, { ...limits, maxOutputBytes: 100_000 })).toEqual({ ok: true, stdout: '{"A":"b"}\n' })
    expect(await runHelper(noisy, { ...limits, maxOutputBytes: 4000 })).toEqual({ ok: false, failure: 'more than 4000 bytes of output' })
  })

  test('a program that cannot be started is a failure, not an exception', async () => {
    const opts = { env: process.env, timeoutMs: 2000, maxOutputBytes: 1024, killGraceMs: 100 }
    const plain = join(work, 'plain.txt')
    writeFileSync(plain, 'not a program')
    for (const command of [join(work, 'absent.sh'), plain, 'fix-hh-no-such-program']) {
      const result = await runHelper(command, opts)
      expect(result.ok, command).toBe(false)
    }
    const ok = script(`echo '{}'`)
    expect((await runHelper(ok, { ...opts, env: { A: 'nul\0inside' } })).ok).toBe(false)
  })

  test('a dependency that throws still ends in null and a report', async () => {
    const { deps, toServer, errors } = recording({
      run: async () => {
        throw new Error('runner exploded')
      },
    })
    expect(await readHelperHeaders('docs', http('./h.sh'), deps)).toBeNull()
    expect(toServer).toEqual(["Error getting MCP headers from headersHelper for server 'docs': runner exploded"])
    expect(errors).toHaveLength(1)
  })
})

describe('the pure parts', () => {
  test('parseHelperOutput', () => {
    const cases: [stdout: string, verdict: unknown][] = [
      ['{"A":"1"}', { ok: true, headers: { A: '1' } }],
      ['\n  {}  \n', { ok: true, headers: {} }],
      ['', { ok: false, problem: 'empty' }],
      [' \n\t', { ok: false, problem: 'empty' }],
      ['Bearer x', { ok: false, problem: 'not-json' }],
      ['{"A":', { ok: false, problem: 'not-json' }],
      ['[]', { ok: false, problem: 'not-object' }],
      ['null', { ok: false, problem: 'not-object' }],
      ['"s"', { ok: false, problem: 'not-object' }],
      ['7', { ok: false, problem: 'not-object' }],
      ['{"A":"1","B":2}', { ok: false, problem: 'non-string-value', key: 'B', valueType: 'number' }],
      ['{"A":null}', { ok: false, problem: 'non-string-value', key: 'A', valueType: 'object' }],
      ['{"A":[]}', { ok: false, problem: 'non-string-value', key: 'A', valueType: 'object' }],
      ['{"A":false}', { ok: false, problem: 'non-string-value', key: 'A', valueType: 'boolean' }],
    ]
    for (const [stdout, verdict] of cases) expect(parseHelperOutput(stdout), stdout).toEqual(verdict as never)
  })

  test('a "__proto__" key stays an ordinary header', () => {
    const verdict = parseHelperOutput('{"__proto__":"x","A":"1"}')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(Object.keys(verdict.headers)).toEqual(['__proto__', 'A'])
      expect(Object.getPrototypeOf(verdict.headers)).toBe(Object.prototype)
    }
  })

  test('executableProblem', () => {
    const cases: [command: string, refused: boolean][] = [
      ['helper', false],
      ['my-helper_2.sh', false],
      ['./rel.sh', false],
      ['/abs/path/with space.sh', false],
      ['', true],
      ['   ', true],
      ['helper --flag', true],
      ['echo hi; id', true],
      ['$(id)', true],
      ['a\nb', true],
      ['./a\rb', true],
    ]
    for (const [command, refused] of cases) {
      expect(executableProblem(command) !== undefined, JSON.stringify(command)).toBe(refused)
    }
  })

  test('a refused command never reaches spawn', async () => {
    const marker = join(work, 'ran')
    script(`touch "${marker}"`, 'probe')
    const result = await runHelper('probe extra', { env: process.env, timeoutMs: 1000, maxOutputBytes: 1024, killGraceMs: 100 })
    expect(result).toEqual({ ok: false, failure: expect.stringContaining('bare command name') })
    expect(existsSync(marker)).toBe(false)
  })

  test('decideHelperTrust', () => {
    const cases: [scope: string | undefined, interactive: boolean, trusted: boolean, out: 'run' | 'refuse'][] = [
      ['project', true, false, 'refuse'],
      ['local', true, false, 'refuse'],
      ['project', true, true, 'run'],
      ['local', true, true, 'run'],
      ['project', false, false, 'run'],
      ['user', true, false, 'run'],
      ['dynamic', true, false, 'run'],
      [undefined, true, false, 'run'],
    ]
    for (const [scope, interactive, trusted, out] of cases) {
      expect(decideHelperTrust(scope, interactive, () => trusted), `${scope} ${interactive} ${trusted}`).toBe(out)
    }
  })

  test('trust is only asked about when it matters', () => {
    let asked = 0
    const ask = () => {
      asked += 1
      return false
    }
    decideHelperTrust('user', true, ask)
    decideHelperTrust('project', false, ask)
    expect(asked).toBe(0)
  })
})
