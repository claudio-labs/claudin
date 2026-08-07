/**
 * A fake `gh` on PATH, for the Git tool's forge tests.
 *
 * `gh` needs the network and an authenticated account, so the tests drive a
 * stand-in instead: `installFakeGh` writes an executable `gh` into a temp
 * directory and hands back an env whose PATH starts there. Each invocation is
 * matched against a rule list (declared per test, editable at runtime via
 * `setRules`) and replays the stdout/stderr/exit code that rule declares.
 *
 * Every call is recorded, so a test can assert not only what came back but what
 * was asked — which is how "the tool appended `--json`" gets verified.
 *
 * An invocation that matches no rule fails loudly (exit 1 with the argv in
 * stderr) rather than returning empty success: a silently-empty `gh` would let
 * a parser test pass while parsing nothing.
 */
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'

export type FakeGhRule = {
  /** Substring of the joined argv, or a regex source when `regex` is set. */
  match: string
  regex?: boolean
  stdout?: string
  stderr?: string
  /** Defaults to 0. */
  exitCode?: number
}

export type FakeGh = {
  /** Directory holding the fake executable; prepended to PATH. */
  binDir: string
  /** The PATH value to run commands with. */
  path: string
  /** `process.env` with PATH replaced — pass this to the spawn under test. */
  env: NodeJS.ProcessEnv
  /** Replace the rule list without reinstalling. */
  setRules(rules: readonly FakeGhRule[]): void
  /** Every argv the fake was called with, oldest first. */
  invocations(): string[][]
  clearInvocations(): void
  cleanup(): void
}

const MANIFEST_FILE = 'manifest.json'
const INVOCATIONS_FILE = 'invocations.jsonl'

/**
 * Used when no declared rule matches. It carries no stderr of its own so the
 * fake can supply the argv-bearing diagnostic; a caller-supplied fallback with
 * its own stderr (e.g. GH_NOT_AUTHENTICATED) suppresses that noise.
 */
const LOUD_FALLBACK: FakeGhRule = {
  match: '',
  exitCode: 1,
}

/**
 * Real `gh` text for a missing credential, down to the exit code: `gh` uses 4
 * for auth failures, and the tool's error classifier keys off this wording.
 */
export const GH_NOT_AUTHENTICATED: FakeGhRule = {
  match: '',
  stderr:
    'To get started with GitHub CLI, please run:  gh auth login\n' +
    'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
  exitCode: 4,
}

/** `gh api` on a throttled account. */
export const GH_RATE_LIMITED: FakeGhRule = {
  match: '',
  stderr:
    'gh: API rate limit exceeded for user ID 4242. ' +
    'If you reach out to GitHub Support for help, please include the request ID. (HTTP 403)\n',
  exitCode: 1,
}

/** `gh pr view --json …` — the shape `mapGhJson` consumes. */
export function ghPrViewRule(pr: Record<string, unknown>): FakeGhRule {
  return { match: 'pr view', stdout: `${JSON.stringify(pr)}\n` }
}

/** `gh pr list --json …` */
export function ghPrListRule(prs: readonly Record<string, unknown>[]): FakeGhRule {
  return { match: 'pr list', stdout: `${JSON.stringify(prs)}\n` }
}


/** `gh run view --log` — the CI dump that is the third-largest recorded shape. */
export function ghRunViewLogRule(log: string): FakeGhRule {
  return { match: 'run view', stdout: log.endsWith('\n') ? log : `${log}\n` }
}

/** Single-quote a string for POSIX sh. */
function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/**
 * The fake's body, as ESM run by whatever binary is running the tests. Written
 * as an array of lines so nothing in it needs escaping against the TypeScript
 * template it would otherwise live in.
 */
const FAKE_GH_SOURCE: readonly string[] = [
  "import { appendFileSync, readFileSync, writeSync } from 'node:fs'",
  "import { join } from 'node:path'",
  '',
  'const dir = process.env.CLAUDIN_FAKE_GH_DIR',
  'if (!dir) {',
  "  writeSync(2, 'fake gh: CLAUDIN_FAKE_GH_DIR is not set\\n')",
  '  process.exit(70)',
  '}',
  'const argv = process.argv.slice(2)',
  "const joined = argv.join(' ')",
  "appendFileSync(join(dir, 'invocations.jsonl'), JSON.stringify(argv) + '\\n')",
  'let manifest',
  'try {',
  "  manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))",
  '} catch (e) {',
  "  writeSync(2, 'fake gh: unreadable manifest: ' + String(e) + '\\n')",
  '  process.exit(70)',
  '}',
  'const rules = Array.isArray(manifest.rules) ? manifest.rules : []',
  'const matched = rules.find(r =>',
  '  r.regex ? new RegExp(r.match).test(joined) : joined.includes(r.match),',
  ')',
  'const rule = matched || manifest.fallback || {}',
  'if (rule.stdout) writeSync(1, rule.stdout)',
  'if (rule.stderr) writeSync(2, rule.stderr)',
  "if (!matched && !rule.stderr) writeSync(2, 'fake gh: no rule matched: ' + joined + '\\n')",
  "process.exit(typeof rule.exitCode === 'number' ? rule.exitCode : 0)",
]

const installed: FakeGh[] = []

export function installFakeGh(
  rules: readonly FakeGhRule[] = [],
  options: { fallback?: FakeGhRule } = {},
): FakeGh {
  const binDir = mkdtempSync(join(tmpdir(), 'claudin-fake-gh-'))
  const scriptPath = join(binDir, 'fake-gh.mjs')
  const ghPath = join(binDir, 'gh')

  writeFileSync(scriptPath, `${FAKE_GH_SOURCE.join('\n')}\n`)
  writeFileSync(
    ghPath,
    [
      '#!/bin/sh',
      `CLAUDIN_FAKE_GH_DIR=${shQuote(binDir)}`,
      'export CLAUDIN_FAKE_GH_DIR',
      `exec ${shQuote(process.execPath)} ${shQuote(scriptPath)} "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(ghPath, 0o755)

  const manifestPath = join(binDir, MANIFEST_FILE)
  const invocationsPath = join(binDir, INVOCATIONS_FILE)
  const fallback = options.fallback ?? LOUD_FALLBACK

  function writeManifest(next: readonly FakeGhRule[]): void {
    writeFileSync(manifestPath, JSON.stringify({ rules: next, fallback }))
  }
  writeManifest(rules)
  appendFileSync(invocationsPath, '')

  const path = `${binDir}${delimiter}${process.env.PATH ?? ''}`
  const fake: FakeGh = {
    binDir,
    path,
    env: { ...process.env, PATH: path },
    setRules(next) {
      writeManifest(next)
    },
    invocations() {
      if (!existsSync(invocationsPath)) return []
      return readFileSync(invocationsPath, 'utf8')
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as string[])
    },
    clearInvocations() {
      writeFileSync(invocationsPath, '')
    },
    cleanup() {
      rmSync(binDir, { recursive: true, force: true })
    },
  }
  installed.push(fake)
  return fake
}


/** Removes every fake this module installed. Safe to call more than once. */
export function cleanupAllFakeGh(): void {
  while (installed.length > 0) {
    const fake = installed.pop()
    if (fake === undefined) continue
    fake.cleanup()
  }
}
