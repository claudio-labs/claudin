/**
 * Drive the built TUI under tmux for a live check, one call per step.
 *
 *   bun scripts/dev/tui-probe.ts start <name> [--cwd D] [--size 184x46] [--env K=V]… [--config-dir D] [--fullscreen] [--accept-trust] [-- cmd…]
 *   bun scripts/dev/tui-probe.ts send <name> <text> [--no-wait] [--until RE] [--timeout S]
 *   bun scripts/dev/tui-probe.ts keys <name> <key>… [--until RE] [--timeout S]
 *   bun scripts/dev/tui-probe.ts wait <name> [--until RE] [--timeout S]
 *   bun scripts/dev/tui-probe.ts capture <name> [--ansi] [--lines N]
 *   bun scripts/dev/tui-probe.ts stop <name>
 *
 * Why it exists: in 2026-11-19..26 the TUI was checked by hand with 106 Bash
 * tmux calls and 53 WaitFor polls, 113 of them in one session — new-session,
 * `sleep`, capture-pane, send-keys, `sleep`, capture-pane — and an `until`
 * written to wait for the turn matched the prompt the model had just typed,
 * echoed in the pane. Here `start`, `send` and `keys` wait until the TUI is
 * idle and print the pane, so a check is one call.
 *
 * Idle is the footer's busy hint gone (`esc to interrupt`, shown while a turn
 * runs, `PromptInputFooterLeftSide.tsx`) and the pane unchanged for a second.
 * After a `send` the turn gets three seconds to start before idle can count,
 * so the echo of the prompt is never read as the answer. `--until` reads `^`
 * and `$` the way WaitFor does (`untilPattern.ts`).
 *
 * Everything runs on a private tmux server (`-L claudin-probe`), never the
 * user's. `start` launches `bin/claudin` (the bundle: `bun run build` first)
 * with `CLAUDIN_DISABLE_RULE_MAP_SYNC=1`, so a check from the repo cwd leaves
 * the navigation map alone; `--config-dir` points the app at a scratch config
 * seeded as onboarded and trusting the cwd (team memory
 * `tmux-mouse-click-verification` has the other recipes).
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { compileUntil, untilMatches } from 'src/tools/WaitForTool/untilPattern.js'
import { REPO_ROOT } from '../repoRoot.js'

export const SOCKET = 'claudin-probe'
/** The footer hint while a turn runs: "esc to interrupt", whatever the key is bound to. */
export const BUSY_MARKER = 'to interrupt'
const TRUST_MARKER = 'Yes, I trust this folder'
const PROMPT_MARKER = '❯'
const DEFAULT_SIZE = '184x46'
const DEFAULT_TIMEOUT_S = 120
const SETTLE_MS = 1_000
const START_GRACE_MS = 3_000
const POLL_MS = 250
const SIZE_RE = /^(\d+)x(\d+)$/
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const TRAILING_BLANK_LINES_RE = /\n\s*$/

const USAGE = `usage:
  tui-probe.ts start <name> [--cwd D] [--size 184x46] [--env K=V]… [--config-dir D] [--fullscreen] [--accept-trust] [-- cmd…]
  tui-probe.ts send <name> <text> [--no-wait] [--until RE] [--timeout S]
  tui-probe.ts keys <name> <key>… [--until RE] [--timeout S]
  tui-probe.ts wait <name> [--until RE] [--timeout S]
  tui-probe.ts capture <name> [--ansi] [--lines N]
  tui-probe.ts stop <name>`

export type Command =
  | {
      kind: 'start'
      name: string
      cwd: string
      cols: number
      rows: number
      env: string[]
      configDir: string | null
      fullscreen: boolean
      acceptTrust: boolean
      cmd: string[]
      timeoutS: number
    }
  | { kind: 'send'; name: string; text: string; wait: boolean; until: string | null; timeoutS: number }
  | { kind: 'keys'; name: string; keys: string[]; until: string | null; timeoutS: number }
  | { kind: 'wait'; name: string; until: string | null; timeoutS: number }
  | { kind: 'capture'; name: string; ansi: boolean; lines: number | null }
  | { kind: 'stop'; name: string }

export class UsageError extends Error {}

/** The subcommand and its options; throws UsageError on anything it cannot read. */
export function parseCommand(argv: readonly string[], cwd: string): Command {
  const [kind, name, ...rest] = argv
  if (!kind || !name) throw new UsageError('a subcommand and a session name are required')
  const dashDash = rest.indexOf('--')
  const own = dashDash === -1 ? rest : rest.slice(0, dashDash)
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  const VALUED = new Set(['--cwd', '--size', '--env', '--config-dir', '--until', '--timeout', '--lines'])
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!
    if (VALUED.has(arg)) {
      const value = own[++i]
      if (value === undefined) throw new UsageError(`${arg} needs a value`)
      flags.set(arg, [...(flags.get(arg) ?? []), value])
    } else if (arg.startsWith('--')) {
      flags.set(arg, [])
    } else {
      positional.push(arg)
    }
  }
  const one = (flag: string): string | null => flags.get(flag)?.at(-1) ?? null
  const timeoutS = Number(one('--timeout') ?? DEFAULT_TIMEOUT_S)
  if (!(timeoutS > 0)) throw new UsageError('--timeout must be a positive number of seconds')
  const until = one('--until')
  if (until !== null) compileUntil(until)
  switch (kind) {
    case 'start': {
      const size = SIZE_RE.exec(one('--size') ?? DEFAULT_SIZE)
      if (!size) throw new UsageError('--size is COLSxROWS, e.g. 184x46')
      const env = flags.get('--env') ?? []
      const badEnv = env.find(e => !ENV_RE.test(e))
      if (badEnv !== undefined) throw new UsageError(`--env takes K=V, got ${badEnv}`)
      const configDir = one('--config-dir')
      return {
        kind,
        name,
        cwd: resolve(cwd, one('--cwd') ?? '.'),
        cols: Number(size[1]),
        rows: Number(size[2]),
        env,
        configDir: configDir === null ? null : resolve(cwd, configDir),
        fullscreen: flags.has('--fullscreen'),
        acceptTrust: flags.has('--accept-trust'),
        cmd: dashDash === -1 ? [join(REPO_ROOT, 'bin', 'claudin')] : rest.slice(dashDash + 1),
        timeoutS,
      }
    }
    case 'send':
      if (positional.length !== 1) throw new UsageError('send takes one text argument (quote it)')
      return { kind, name, text: positional[0]!, wait: !flags.has('--no-wait'), until, timeoutS }
    case 'keys':
      if (positional.length === 0) throw new UsageError('keys takes one or more tmux key names')
      return { kind, name, keys: positional, until, timeoutS }
    case 'wait':
      return { kind, name, until, timeoutS }
    case 'capture': {
      const lines = one('--lines')
      if (lines !== null && !(Number(lines) > 0)) throw new UsageError('--lines must be a positive number')
      return { kind, name, ansi: flags.has('--ansi'), lines: lines === null ? null : Number(lines) }
    }
    case 'stop':
      return { kind, name }
    default:
      throw new UsageError(`unknown subcommand ${kind}`)
  }
}

/** Quote one argument for the shell tmux runs a session's command in. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/** The tmux arguments that start a session, after `-L <socket>`. */
export function startArgs(c: Extract<Command, { kind: 'start' }>): string[] {
  const env = [
    'CLAUDIN_DISABLE_RULE_MAP_SYNC=1',
    ...(c.fullscreen ? ['CLAUDIN_NO_FLICKER=1'] : []),
    ...(c.configDir ? [`CLAUDIN_CONFIG_DIR=${c.configDir}`] : []),
    ...c.env,
  ]
  return [
    'new-session', '-d', '-s', c.name, '-x', String(c.cols), '-y', String(c.rows), '-c', c.cwd,
    ...env.flatMap(e => ['-e', e]),
    c.cmd.map(shellQuote).join(' '),
  ]
}

/** What a scratch config dir needs for the TUI to open on the prompt in `cwd`. */
export function seededConfig(cwd: string): string {
  return `${JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } }, null, 2)}\n`
}

export function isBusy(pane: string): boolean {
  return pane.includes(BUSY_MARKER)
}

export type Watch = { last: string; stableSince: number; sawBusy: boolean; startedAt: number }

/**
 * One poll of a wait. Idle once the busy hint is gone, the pane has held still
 * for SETTLE_MS, and the turn had its chance to start: it showed the hint, or
 * `graceMs` went by without it (a slash command never shows one).
 */
export function observe(w: Watch, pane: string, now: number, graceMs: number): { watch: Watch; idle: boolean } {
  const busy = isBusy(pane)
  const watch = { ...w, last: pane, stableSince: pane === w.last ? w.stableSince : now, sawBusy: w.sawBusy || busy }
  const started = watch.sawBusy || now - w.startedAt >= graceMs
  return { watch, idle: !busy && started && now - watch.stableSince >= SETTLE_MS }
}

function tmux(args: readonly string[]): { ok: boolean; out: string; err: string } {
  const run = spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' })
  if (run.error) throw new UsageError(`tmux did not run: ${run.error.message}`)
  return { ok: run.status === 0, out: run.stdout, err: run.stderr.trim() }
}

function capture(name: string, ansi = false): string {
  const run = tmux(['capture-pane', '-p', ...(ansi ? ['-e'] : []), '-t', name])
  if (!run.ok) throw new UsageError(`no probe session ${name}: ${run.err}`)
  return run.out.replace(TRAILING_BLANK_LINES_RE, '\n')
}

async function waitFor(name: string, opts: { until: string | null; timeoutS: number; graceMs: number; ready?: (pane: string) => boolean }): Promise<{ pane: string; status: string }> {
  const until = opts.until === null ? null : compileUntil(opts.until)
  const startedAt = Date.now()
  let watch: Watch = { last: '', stableSince: startedAt, sawBusy: false, startedAt }
  for (;;) {
    const pane = capture(name)
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (until && untilMatches(until, pane)) return { pane, status: `[tui-probe: match after ${secs}s]` }
    const step = observe(watch, pane, Date.now(), opts.graceMs)
    watch = step.watch
    if (!until && step.idle && (opts.ready?.(pane) ?? true)) return { pane, status: `[tui-probe: idle after ${secs}s]` }
    if (Date.now() - startedAt >= opts.timeoutS * 1000) {
      return { pane, status: `[tui-probe: timeout after ${secs}s${isBusy(pane) ? ', still busy' : ''}]` }
    }
    await Bun.sleep(POLL_MS)
  }
}

async function run(c: Command): Promise<string> {
  switch (c.kind) {
    case 'start': {
      if (c.cmd[0] === join(REPO_ROOT, 'bin', 'claudin') && !existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))) {
        throw new UsageError('dist/cli.mjs is missing: run `bun run build` first')
      }
      if (c.configDir && !existsSync(join(c.configDir, 'config.json'))) {
        mkdirSync(c.configDir, { recursive: true })
        writeFileSync(join(c.configDir, 'config.json'), seededConfig(c.cwd))
      }
      const started = tmux(startArgs(c))
      if (!started.ok) throw new UsageError(`tmux new-session failed: ${started.err}`)
      const ready = (pane: string) => pane.includes(PROMPT_MARKER) || pane.includes(TRUST_MARKER)
      let shown = await waitFor(c.name, { until: null, timeoutS: c.timeoutS, graceMs: 0, ready })
      if (c.acceptTrust && shown.pane.includes(TRUST_MARKER)) {
        tmux(['send-keys', '-t', c.name, 'Enter'])
        shown = await waitFor(c.name, { until: null, timeoutS: c.timeoutS, graceMs: 0, ready: pane => pane.includes(PROMPT_MARKER) })
      }
      return `${shown.pane}${shown.status}`
    }
    case 'send': {
      tmux(['send-keys', '-t', c.name, '-l', c.text])
      tmux(['send-keys', '-t', c.name, 'Enter'])
      if (!c.wait) return `[tui-probe: sent to ${c.name}]`
      const shown = await waitFor(c.name, { until: c.until, timeoutS: c.timeoutS, graceMs: START_GRACE_MS })
      return `${shown.pane}${shown.status}`
    }
    case 'keys': {
      const sent = tmux(['send-keys', '-t', c.name, ...c.keys])
      if (!sent.ok) throw new UsageError(`no probe session ${c.name}: ${sent.err}`)
      const shown = await waitFor(c.name, { until: c.until, timeoutS: c.timeoutS, graceMs: 0 })
      return `${shown.pane}${shown.status}`
    }
    case 'wait': {
      const shown = await waitFor(c.name, { until: c.until, timeoutS: c.timeoutS, graceMs: 0 })
      return `${shown.pane}${shown.status}`
    }
    case 'capture': {
      const pane = capture(c.name, c.ansi)
      return c.lines === null ? pane : `${pane.trimEnd().split('\n').slice(-c.lines).join('\n')}\n`
    }
    case 'stop': {
      const stopped = tmux(['kill-session', '-t', c.name])
      return stopped.ok ? `[tui-probe: stopped ${c.name}]` : `[tui-probe: no session ${c.name}]`
    }
  }
}

async function main(): Promise<void> {
  try {
    console.log(await run(parseCommand(process.argv.slice(2), process.cwd())))
  } catch (e) {
    if (!(e instanceof UsageError) && !(e instanceof SyntaxError)) throw e
    console.error(`${e.message}\n${USAGE}`)
    process.exit(2)
  }
}

if (import.meta.main) await main()
