/**
 * Characterization of what `claudin mcp doctor` prints and how it exits, the
 * caller-facing face of src/mcp/doctor.ts. The command's handler
 * (src/platform/headless/handlers/mcp.tsx) turns a doctor report into text or
 * JSON and an exit code; this suite pins those facts against real config and
 * real stdio servers.
 *
 * The handler ends the process, so `process.exit` is the one boundary
 * replaced: the code is recorded instead. Output is captured from
 * `process.stdout.write` and `console.error`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { readFileSync } from 'fs'
import { join } from 'path'
import { registerMcpDoctorCommand } from 'src/commands/mcp/doctorCommand.js'
import type { McpDoctorReport } from 'src/mcp/doctor.js'
import { mcpDoctorHandler } from 'src/platform/headless/handlers/mcp.js'
import {
  enterWorld,
  leaveWorld,
  setLocalServers,
  setUserServers,
  writeManagedMcp,
  writeMcpJson,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'
import {
  installProbeServers,
  reapProbeServers,
  type ProbeServers,
} from 'src/mcp/__testutils__/stdioProbeServers.js'

type Globals = { MACRO?: { VERSION: string } }
const globals = globalThis as unknown as Globals
let macroBefore: Globals['MACRO']

let w: World
let probes: ProbeServers

beforeAll(() => {
  macroBefore = globals.MACRO
  globals.MACRO ??= { VERSION: '0.0.0-doctor-char' }
})

afterAll(() => {
  globals.MACRO = macroBefore
})

beforeEach(() => {
  w = enterWorld()
  probes = installProbeServers(w.root)
})

afterEach(() => {
  reapProbeServers(probes)
  leaveWorld()
})

const DOCTOR_REPORT_FIXTURE = join(import.meta.dir, '__fixtures__', 'rewrite', 'doctor-report.json')

type Run = { stdout: string; stderr: string; exitCodes: Array<number | undefined> }

async function run(name: string | undefined, options: Parameters<typeof mcpDoctorHandler>[1]): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const exitCodes: Array<number | undefined> = []
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  const error = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    err.push(parts.map(String).join(' '))
  })
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code)
  }) as typeof process.exit)
  try {
    await mcpDoctorHandler(name, options)
  } finally {
    write.mockRestore()
    error.mockRestore()
    exit.mockRestore()
  }
  return { stdout: out.join(''), stderr: err.join('\n'), exitCodes }
}

const lines = (text: string) => text.split('\n')

/** The four counts, read back from the text by label (singular or plural). */
function countsIn(text: string): McpDoctorReport['summary'] {
  const read = (label: RegExp) => {
    const match = text.match(new RegExp(`^- (\\d+) ${label.source}$`, 'm'))
    if (!match) throw new Error(`no count line for ${label}`)
    return Number(match[1])
  }
  return {
    totalReports: read(/server reports? generated/),
    healthy: read(/healthy/),
    warnings: read(/warnings?/),
    blocking: read(/blocking issues?/),
  }
}

/** The lines between a server's name line and the next blank line. */
function block(text: string, serverName: string): string[] {
  const all = lines(text)
  const start = all.indexOf(serverName)
  if (start < 0) throw new Error(`no block for ${serverName}`)
  const end = all.indexOf('', start)
  return all.slice(start + 1, end < 0 ? undefined : end)
}

describe('the help text', () => {
  test('warns that servers may be started or contacted, and to trust the directory', () => {
    const parent = new Command('mcp')
    registerMcpDoctorCommand(parent)
    const [doctor] = parent.commands.filter(c => c.name() === 'doctor')
    if (!doctor) throw new Error('doctor subcommand not registered')

    const text = doctor.description()
    expect(text).toMatch(/stdio servers may be spawned/i)
    expect(text).toMatch(/remote servers may be contacted/i)
    expect(text).toContain('--config-only')
    expect(text).toMatch(/trust/i)
  })
})

describe('exit codes', () => {
  test.each([
    ['a healthy server', (p: ProbeServers) => setLocalServers({ s: p.answering() }), 0],
    ['nothing configured', () => {}, 0],
    ['warnings only (shadowing)', (p: ProbeServers) => {
      setLocalServers({ s: p.answering() })
      setUserServers({ s: p.answering() })
    }, 0],
    ['warnings only (pending project server)', (p: ProbeServers) => writeMcpJson({ mcpServers: { s: p.answering() } }), 0],
    ['a failing server', (p: ProbeServers) => setLocalServers({ s: p.dying() }), 1],
    ['a missing command', (p: ProbeServers) => setLocalServers({ s: p.absent() }), 1],
    ['a healthy and a failing server', (p: ProbeServers) => setLocalServers({ a: p.answering(), b: p.dying() }), 1],
    ['a broken managed-mcp.json', () => writeManagedMcp('{'), 1],
  ])('all servers, %s → %i', async (_why, arrange, code) => {
    arrange(probes)

    const result = await run(undefined, {})

    expect(result.exitCodes).toEqual([code])
    expect(result.stderr).toBe('')
  })

  test('a named server that is not configured → 1', async () => {
    setLocalServers({ other: probes.answering() })

    const result = await run('ghost', {})

    expect(result.exitCodes).toEqual([1])
  })

  test('config-only exits 0 for a server that would fail live', async () => {
    setLocalServers({ s: probes.dying() })

    const result = await run(undefined, { configOnly: true })

    expect(result.exitCodes).toEqual([0])
    expect(probes.started()).toEqual([])
  })

  test('an unknown scope is an error on stderr, exit 1, and nothing on stdout', async () => {
    setLocalServers({ s: probes.answering() })

    const result = await run(undefined, { scope: 'galaxy' })

    expect(result.exitCodes).toEqual([1])
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('galaxy')
    for (const scope of ['local', 'user', 'project', 'enterprise']) expect(result.stderr).toContain(scope)
    expect(probes.started()).toEqual([])
  })

  test('a known scope is passed through as the filter', async () => {
    setLocalServers({ mine: probes.answering() })
    setUserServers({ theirs: probes.answering() })

    const result = await run(undefined, { scope: 'user', json: true })
    const report = JSON.parse(result.stdout) as McpDoctorReport

    expect(report.scopeFilter).toBe('user')
    expect(report.servers.map(s => s.serverName)).toEqual(['theirs'])
  })
})

describe('the text report', () => {
  test('opens with a title and the four counts, which match the report', async () => {
    setLocalServers({ ok: probes.answering(), broken: probes.dying() })
    setUserServers({ ok: probes.answering() })

    const text = (await run(undefined, {})).stdout
    const json = JSON.parse((await run(undefined, { json: true })).stdout) as McpDoctorReport

    expect(lines(text)[0]).toBe('MCP Doctor')
    expect(lines(text)).toContain('Summary')
    expect(countsIn(text)).toEqual({ totalReports: 2, healthy: 0, warnings: 2, blocking: 1 })
    expect(countsIn(text)).toEqual(json.summary)
    expect(text).not.toMatch(/^- target:/m)
    expect(text.endsWith('\n')).toBe(true)
  })

  test('a healthy server: its source, transport and live result, and nothing else', async () => {
    setLocalServers({ ok: probes.answering() })

    const text = (await run(undefined, {})).stdout

    expect(countsIn(text)).toEqual({ totalReports: 1, healthy: 1, warnings: 0, blocking: 0 })
    expect(block(text, 'ok')).toEqual(['- Active source: local', '- Transport: stdio', '- Live check: connected'])
  })

  test('a failing server: the error, each finding, and its fix', async () => {
    setLocalServers({ bad: probes.absent() })

    const run1 = await run('bad', {})
    const report = JSON.parse((await run('bad', { json: true })).stdout) as McpDoctorReport
    const body = block(run1.stdout, 'bad')
    const finding = report.servers[0]!.findings[0]!

    expect(lines(run1.stdout)).toContain('- target: bad')
    expect(body).toContain('- Live check: failed')
    expect(body).toContain(`- Error: ${report.servers[0]!.liveCheck.error}`)
    expect(body).toContain(`- ${finding.message}`)
    expect(body).toContain(`- Fix: ${finding.remediation}`)
    expect(body.indexOf(`- ${finding.message}`)).toBe(body.indexOf(`- Fix: ${finding.remediation}`) - 1)
  })

  test('a shadowed server lists the definitions that do not run', async () => {
    writeManagedMcp({ mcpServers: { s: probes.answering() } })
    setLocalServers({ s: probes.answering() })
    setUserServers({ s: probes.answering() })

    const body = block((await run('s', { configOnly: true })).stdout, 's')

    expect(body.slice(0, 3)).toEqual([
      '- Active source: enterprise',
      '- Transport: stdio',
      '- Additional definitions: local, user',
    ])
  })

  test.each([
    ['config-only', { configOnly: true }, () => setLocalServers({ s: probes.answering() }), '- State: skipped'],
    ['pending approval', {}, () => writeMcpJson({ mcpServers: { s: probes.answering() } }), '- State: pending'],
  ])('%s is shown as a state, not a live check', async (_why, options, arrange, line) => {
    arrange()

    const body = block((await run('s', options)).stdout, 's')

    expect(body).toContain(line)
    expect(body.some(l => l.startsWith('- Live check:'))).toBe(false)
  })

  test('a server with no running definition has no source or transport line', async () => {
    writeMcpJson({ mcpServers: { s: probes.answering() } })

    const body = block((await run('s', {})).stdout, 's')

    expect(body.some(l => l.startsWith('- Active source:'))).toBe(false)
    expect(body.some(l => l.startsWith('- Transport:'))).toBe(false)
  })

  test('global findings come last, under their own heading', async () => {
    setLocalServers({ s: probes.answering() })
    writeMcpJson('{ nope')

    const result = await run(undefined, { configOnly: true })
    const all = lines(result.stdout)
    const heading = all.indexOf('Global findings')

    expect(heading).toBeGreaterThan(all.indexOf('s'))
    expect(all[heading + 1]).toMatch(/^- .*JSON/)
    expect(all[heading + 2]).toMatch(/^- Fix: /)
    expect(result.exitCodes).toEqual([1])
  })

  test('no global findings, no heading', async () => {
    setLocalServers({ s: probes.answering() })

    expect((await run(undefined, { configOnly: true })).stdout).not.toContain('Global findings')
  })
})

describe('--json', () => {
  test('prints the report as indented JSON on one write, and nothing else', async () => {
    setLocalServers({ s: probes.answering() })

    const result = await run('s', { json: true })
    const report = JSON.parse(result.stdout) as McpDoctorReport

    expect(result.stdout).toBe(`${JSON.stringify(report, null, 2)}\n`)
    expect(report).toMatchObject({
      targetName: 's',
      configOnly: false,
      summary: { totalReports: 1, healthy: 1, warnings: 0, blocking: 0 },
    })
    expect(report.servers[0]!.liveCheck.result).toBe('connected')
    expect(result.stdout).not.toContain('MCP Doctor')
    expect(result.exitCodes).toEqual([0])
  })
})

describe('the --json bytes', () => {
  test('match the fixture once run-specific values and wording are masked', async () => {
    writeManagedMcp('{ "mcpServers": ')
    setLocalServers({ shared: { command: 'shared-local', args: ['--port', '0'] } })
    setUserServers({ shared: { type: 'http', url: 'https://user.example/mcp' } })
    writeMcpJson({ mcpServers: { repo: { command: 'repo-server' } } })

    const { stdout } = await run(undefined, { configOnly: true, json: true })
    const report = JSON.parse(stdout) as McpDoctorReport
    const userFile = report.servers
      .flatMap(s => s.definitions)
      .find(d => d.sourceType === 'user')!.sourcePath!
    const masked = stdout
      .replaceAll(report.generatedAt, '<generated-at>')
      .replaceAll(userFile, '<user-config-file>')
      .replaceAll(w.root, '<world>')
      // Wording is free; its facts are pinned elsewhere. The codes are the contract.
      .replace(/"(message|remediation)": "(?:[^"\\]|\\.)*"/g, '"$1": "<text>"')

    expect(masked).toBe(readFileSync(DOCTOR_REPORT_FIXTURE, 'utf8'))
  })
})
