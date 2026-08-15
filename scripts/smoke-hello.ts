/**
 * smoke:hello — end-to-end check that the bundle boots AND completes a real
 * round trip with a provider.
 *
 * `bun run smoke` only proves the bundle loads (`--version`, `--help`). It
 * cannot catch a transport-level regression: a changed User-Agent, a renamed
 * header or a stray body field 400s at the provider and every unit test stays
 * green. This script sends one trivial prompt and asserts a non-empty answer
 * came back.
 *
 * Usage:
 *   bun run smoke:hello                  # the active profile only
 *   bun run smoke:hello --all            # every configured profile
 *   bun run smoke:hello --profile <id>   # one profile (repeatable; id or name)
 *   bun run smoke:hello --keep           # leave the temp dirs for inspection
 *
 * Isolation, and why each piece is needed:
 *   - `--provider` cannot select a profile (it is rejected outright in
 *     src/platform/entrypoints/cli.tsx), so switching providers means writing
 *     `activeProviderProfileId`. We never touch the real config: each run gets
 *     a COPY of config.json in a temp CLAUDIN_CONFIG_DIR. OAuth tokens live in
 *     the OS keychain, which is keyed by service name rather than by config
 *     dir, so a token refresh during the run still lands where it should.
 *   - The child runs from a temp cwd, not from the repo. That keeps this
 *     project's session index and AGENTS.md/rules out of the run, and it also
 *     makes profile selection deterministic: getActiveProviderProfile() checks
 *     the per-project override FIRST (providerProfiles.ts:485), and a directory
 *     with no project entry has none.
 *   - `--tools ""` is the only flag that actually removes tools; --allowedTools
 *     merely narrows permissions and leaves them advertised to the model.
 *   - `--strict-mcp-config` keeps a broken MCP server from failing the smoke,
 *     `--no-session-persistence` keeps the run out of the session store, and
 *     `--max-turns 1` stops a talkative model from turning this into a loop.
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ENTRY = resolve('dist/cli.mjs')
const NODE = process.env.CLAUDIN_SMOKE_NODE ?? 'node'
const DEFAULT_PROMPT = 'Responda apenas com a palavra: olá'
const DEFAULT_TIMEOUT_MS = 120_000

type ProviderProfile = {
  id: string
  name?: string
  provider?: string
  transport?: string
  model?: string
  apiKey?: string
  extras?: { githubToken?: string }
}

type GlobalConfig = {
  providerProfiles?: ProviderProfile[]
  activeProviderProfileId?: string
}

type ResultMessage = {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  duration_ms?: number
  total_cost_usd?: number
  modelUsage?: Record<string, unknown>
}

type Outcome = {
  label: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
  durationMs: number
  model?: string
  costUsd?: number
}

function parseArgs(argv: string[]): {
  all: boolean
  profiles: string[]
  keep: boolean
  prompt: string
  timeoutMs: number
} {
  const profiles: string[] = []
  let all = false
  let keep = false
  let prompt = DEFAULT_PROMPT
  let timeoutMs = DEFAULT_TIMEOUT_MS

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') all = true
    else if (arg === '--keep') keep = true
    else if (arg === '--profile') profiles.push(argv[++i] ?? '')
    else if (arg === '--prompt') prompt = argv[++i] ?? DEFAULT_PROMPT
    else if (arg === '--timeout') timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return { all, profiles: profiles.filter(Boolean), keep, prompt, timeoutMs }
}

function getConfigDir(): string {
  return process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
}

function readGlobalConfig(configDir: string): GlobalConfig {
  const path = join(configDir, 'config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GlobalConfig
  } catch (e) {
    console.error(`Could not parse ${path}: ${(e as Error).message}`)
    process.exit(2)
  }
}

function describeProfile(profile: ProviderProfile): string {
  const parts = [profile.name ?? profile.id]
  const meta = [profile.provider, profile.transport, profile.model].filter(Boolean)
  if (meta.length > 0) parts.push(`(${meta.join(' · ')})`)
  return parts.join(' ')
}

/** Pick the profiles to exercise. Empty result means "run with the config as-is". */
function selectProfiles(
  config: GlobalConfig,
  opts: { all: boolean; profiles: string[] },
): ProviderProfile[] {
  const available = config.providerProfiles ?? []
  if (available.length === 0) return []

  if (opts.all) return available

  if (opts.profiles.length > 0) {
    const selected: ProviderProfile[] = []
    for (const wanted of opts.profiles) {
      const match = available.find(p => p.id === wanted || p.name === wanted)
      if (!match) {
        console.error(
          `No provider profile matches "${wanted}". Available: ${available
            .map(p => p.name ?? p.id)
            .join(', ')}`,
        )
        process.exit(2)
      }
      selected.push(match)
    }
    return selected
  }

  const activeId = config.activeProviderProfileId
  const active = available.find(p => p.id === activeId) ?? available[0]
  return active ? [active] : []
}

/**
 * A throwaway CLAUDIN_CONFIG_DIR holding a copy of config.json with the wanted
 * profile made active. Returns null when no switch is needed, so the common
 * single-profile case runs against the real config dir and copies nothing.
 */
function makeConfigOverlay(
  configDir: string,
  config: GlobalConfig,
  profileId: string,
): string | null {
  if (config.activeProviderProfileId === profileId) return null

  const overlay = mkdtempSync(join(tmpdir(), 'claudin-smoke-cfg-'))
  writeFileSync(
    join(overlay, 'config.json'),
    JSON.stringify({ ...config, activeProviderProfileId: profileId }, null, 2),
  )
  const settings = join(configDir, 'settings.json')
  if (existsSync(settings)) copyFileSync(settings, join(overlay, 'settings.json'))
  return overlay
}

/**
 * Whether an overlay can carry this profile's credentials. An inline API key
 * lives in config.json and is copied along; anything backed by the credential
 * store (OAuth web logins — Codex, Kimi, xAI, Anthropic sign-in) is not, and
 * cannot be, because getSecureStorageServiceName() hashes the config dir into
 * the keychain service name (macOsKeychainHelpers.ts:41). A temp overlay is by
 * definition a non-default dir, so it always looks at an empty namespace.
 */
function overlayCanCarryCredentials(profile: ProviderProfile): boolean {
  return Boolean(profile.apiKey || profile.extras?.githubToken)
}

/**
 * `overlayDir` is null for the common single-profile case, and then
 * CLAUDIN_CONFIG_DIR is left ALONE rather than set to the path it already
 * resolves to. That is not cosmetic: getSecureStorageServiceName() hashes the
 * config dir into the keychain service name whenever the variable is merely
 * DEFINED (macOsKeychainHelpers.ts:37), so exporting it — even with the default
 * path — moves the keychain namespace and the run reports "Not logged in".
 */
function runOne(
  label: string,
  overlayDir: string | null,
  opts: { prompt: string; timeoutMs: number },
): Outcome {
  const cwd = mkdtempSync(join(tmpdir(), 'claudin-smoke-cwd-'))
  const startedAt = Date.now()

  // `node`, never process.execPath: this script is launched by bun, and
  // running the bundle under bun dies on undici's webidl shim
  // ("markAsUncloneable is not a function") before it reaches the provider.
  // The launcher and `bun run dev` both run the bundle under node too.
  const child = spawnSync(
    NODE,
    [
      ENTRY,
      '-p',
      opts.prompt,
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--max-turns',
      '1',
      '--no-session-persistence',
    ],
    {
      cwd,
      timeout: opts.timeoutMs,
      encoding: 'utf8',
      // stdin closed, not piped: headless waits 3s for stdin data it will
      // never get, and an inherited TTY would make it wait for a human.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: overlayDir
        ? { ...process.env, CLAUDIN_CONFIG_DIR: overlayDir }
        : process.env,
    },
  )

  const durationMs = Date.now() - startedAt
  rmSync(cwd, { recursive: true, force: true })

  const fail = (detail: string): Outcome => ({
    label,
    status: 'fail',
    detail,
    durationMs,
  })

  if (child.error) {
    const timedOut = (child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    return fail(timedOut ? `timed out after ${opts.timeoutMs} ms` : child.error.message)
  }
  if (child.status !== 0) {
    // stderr first, then stdout: a provider error is usually reported on one
    // or the other depending on how far the run got.
    const output = [child.stderr, child.stdout]
      .map(s => (s ?? '').trim())
      .filter(Boolean)
      .join(' | ')
    const tail = output.split('\n').slice(-3).join(' | ').slice(0, 300)
    return fail(`exit ${child.status}${tail ? ` — ${tail}` : ' — no output'}`)
  }

  let parsed: ResultMessage
  try {
    parsed = JSON.parse(child.stdout ?? '') as ResultMessage
  } catch {
    const head = (child.stdout ?? '').trim().slice(0, 160)
    return fail(`stdout is not JSON — ${head || '(empty)'}`)
  }

  if (parsed.is_error || parsed.subtype !== 'success') {
    return fail(`${parsed.subtype ?? 'unknown'} — ${(parsed.result ?? '').slice(0, 160)}`)
  }
  // Deliberately not matching the word "olá": a model answering in another
  // language is not a transport failure. Any non-empty text proves the trip.
  const text = (parsed.result ?? '').trim()
  if (text.length === 0) return fail('empty response text')

  return {
    label,
    status: 'pass',
    detail: text.replace(/\s+/g, ' ').slice(0, 60),
    durationMs,
    model: Object.keys(parsed.modelUsage ?? {})[0],
    costUsd: parsed.total_cost_usd,
  }
}

const args = parseArgs(process.argv.slice(2))

if (!existsSync(ENTRY)) {
  console.error(`ERROR: ${ENTRY} not found. Run 'bun run build' first.`)
  process.exit(1)
}

const configDir = getConfigDir()
const globalConfig = readGlobalConfig(configDir)
const targets = selectProfiles(globalConfig, args)
const overlays: string[] = []
const outcomes: Outcome[] = []

if (targets.length === 0) {
  console.log('No provider profiles configured — running with the config as-is.')
  console.log('')
  outcomes.push(runOne('(config as-is)', null, args))
} else {
  console.log(`Saying hello through ${targets.length} profile(s)...`)
  console.log('')
  for (const profile of targets) {
    const overlay = makeConfigOverlay(configDir, globalConfig, profile.id)
    if (overlay && !overlayCanCarryCredentials(profile)) {
      rmSync(overlay, { recursive: true, force: true })
      outcomes.push({
        label: describeProfile(profile),
        status: 'skip',
        detail:
          'credentials live in the credential store, which a temp config dir cannot reach — make it the active profile and re-run',
        durationMs: 0,
      })
      continue
    }
    if (overlay) overlays.push(overlay)
    outcomes.push(runOne(describeProfile(profile), overlay, args))
  }
}

for (const outcome of outcomes) {
  const status = outcome.status.toUpperCase()
  const timing =
    outcome.status === 'skip' ? '' : ` — ${(outcome.durationMs / 1000).toFixed(1)}s`
  const model = outcome.model ? ` · ${outcome.model}` : ''
  const cost =
    outcome.costUsd !== undefined ? ` · $${outcome.costUsd.toFixed(4)}` : ''
  console.log(`  ${status}: ${outcome.label}${timing}${model}${cost}`)
  console.log(`        ${outcome.detail}`)
}

if (args.keep) {
  for (const overlay of overlays) console.log(`  kept config overlay: ${overlay}`)
} else {
  for (const overlay of overlays) rmSync(overlay, { recursive: true, force: true })
}

const failed = outcomes.filter(o => o.status === 'fail').length
const answered = outcomes.filter(o => o.status === 'pass').length
const skipped = outcomes.filter(o => o.status === 'skip').length
const skippedNote = skipped > 0 ? `, ${skipped} skipped` : ''
console.log('')
if (failed === 0) {
  console.log(`✓ ${answered} profile(s) answered${skippedNote}`)
} else {
  console.log(
    `✗ FAILED — ${failed} of ${outcomes.length} profile(s) did not answer${skippedNote}`,
  )
}

process.exit(failed === 0 ? 0 : 1)
