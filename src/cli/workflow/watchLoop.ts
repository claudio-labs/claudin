// The "listening" half of the self-hosted background agent (R3).
//
// A thin, outbound-only poll loop: every `intervalSec` it polls a TriggerSource
// (labeled GitHub issues, or an arbitrary URL) and for each NEW item spawns a
// `claudin workflow run … --worktree --pr` subprocess (clean process + isolated
// worktree per job). It captures the child's PR URL and, when the source
// supports it, reports back (e.g. an issue comment). Jobs are processed
// serially in v1 to avoid worktree contention.
//
// No inbound webhook server, no open port — just polling + git + spawn.

import { spawn } from 'node:child_process'

import { logError } from 'src/utils/log.js'

import {
  CommandSource,
  GithubIssueSource,
  UrlSource,
  type TriggerItem,
  type TriggerSource,
} from './sources.js'
import { loadProcessed, saveProcessed } from './watchState.js'

export type WatchLoopOptions = {
  label: string
  workflow: string
  intervalSec: number
  source: string
  base?: string
  url?: string
  command?: string
  match?: string
}

/**
 * Compile the optional `--match` regex. Returns null when no pattern is set,
 * or throws (with a clear message) on an invalid pattern.
 */
export function compileMatcher(pattern: string | undefined): RegExp | null {
  if (!pattern) return null
  return new RegExp(pattern)
}

/**
 * Whether an item passes the `--match` filter. The pattern is tested against
 * the item's `title` and `body` joined by a newline (so it matches either).
 */
export function itemMatches(item: TriggerItem, matcher: RegExp | null): boolean {
  if (!matcher) return true
  return matcher.test(`${item.title}\n${item.body}`)
}

const SCRIPT_ENTRY_RE = /\.(mjs|cjs|js)$/

/**
 * Build the argv for the `claudin workflow run` subprocess (pure).
 *
 * `entry` is `process.argv[1]`: under `node dist/cli.mjs` it is the script and
 * must be forwarded; under a compiled single-file binary it is not a script
 * path, so it is omitted and the subcommand is passed directly.
 */
export function buildRunArgs(
  opts: WatchLoopOptions,
  task: string,
  entry: string | undefined,
): string[] {
  const selfArgs = entry && SCRIPT_ENTRY_RE.test(entry) ? [entry] : []
  return [
    ...selfArgs,
    'workflow',
    'run',
    opts.workflow,
    '--task',
    task,
    '--worktree',
    '--pr',
    ...(opts.base ? ['--base', opts.base] : []),
  ]
}

/**
 * Build the trigger source from CLI options. Returns null (after writing a
 * diagnostic) when the options are invalid.
 */
export function buildSource(opts: WatchLoopOptions): TriggerSource | null {
  switch (opts.source) {
    case 'github':
      return new GithubIssueSource(opts.label)
    case 'url':
      if (!opts.url) {
        process.stderr.write('--source url requires --url <URL>.\n')
        return null
      }
      return new UrlSource(opts.url)
    case 'command':
      if (!opts.command) {
        process.stderr.write('--source command requires --command <cmd>.\n')
        return null
      }
      return new CommandSource(opts.command)
    default:
      process.stderr.write(
        `Unsupported --source "${opts.source}" (supported: "github", "url", "command").\n`,
      )
      return null
  }
}

/** Run the watch loop until the process receives SIGINT/SIGTERM. */
export async function runWatchLoop(opts: WatchLoopOptions): Promise<void> {
  const source = buildSource(opts)
  if (!source) {
    process.exitCode = 2
    return
  }

  let matcher: RegExp | null
  try {
    matcher = compileMatcher(opts.match)
  } catch (e) {
    process.stderr.write(
      `Invalid --match regex: ${e instanceof Error ? e.message : String(e)}\n`,
    )
    process.exitCode = 2
    return
  }

  const intervalMs = Math.max(5, opts.intervalSec) * 1000
  const processed = await loadProcessed()

  let stopping = false
  // Reassigned each cycle so a signal can cut the current sleep short.
  let wake: () => void = () => {}
  const stop = () => {
    stopping = true
    wake()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  process.stdout.write(
    `Watching ${source.describe()} every ${opts.intervalSec}s (workflow: ${opts.workflow}). Ctrl-C to stop.\n`,
  )

  if (matcher) {
    process.stdout.write(`Only items matching /${opts.match}/ will run.\n`)
  }

  while (!stopping) {
    await pollOnce(opts, source, processed, matcher)
    if (stopping) break
    // Ref'd timer — keeps the process alive between polls; resolves early
    // when stop() fires so Ctrl-C doesn't wait out the full interval.
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, intervalMs)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}

async function pollOnce(
  opts: WatchLoopOptions,
  source: TriggerSource,
  processed: Set<string>,
  matcher: RegExp | null,
): Promise<void> {
  const items = await source.poll()
  for (const item of items) {
    // Filtered items are skipped WITHOUT marking them processed, so if the
    // content later changes to match (URL/command) it can still fire.
    if (!itemMatches(item, matcher)) continue
    if (processed.has(item.id)) continue

    process.stdout.write(
      `→ Dispatching workflow for ${item.id}: ${item.title}\n`,
    )
    const prUrl = await dispatchRun(opts, item)

    // Mark processed regardless of outcome so a persistently-failing item
    // isn't retried forever on every poll.
    processed.add(item.id)
    await saveProcessed(processed)

    await source.reportResult?.(item, { prUrl }, opts.workflow)
  }
}

/**
 * Spawn `claudin workflow run` for one item and return the PR URL it printed
 * (the `PR: <url>` line on stdout), or null.
 */
function dispatchRun(
  opts: WatchLoopOptions,
  item: TriggerItem,
): Promise<string | null> {
  const task = `${item.title}\n\n${item.body}`.trim()
  const args = buildRunArgs(opts, task, process.argv[1])

  return new Promise<string | null>(resolve => {
    let stdout = ''
    try {
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
        process.stdout.write(chunk)
      })
      child.on('error', err => {
        logError(
          `failed to spawn workflow run child: ${err instanceof Error ? err.message : String(err)}`,
        )
        resolve(null)
      })
      child.on('close', () => {
        // Anchor to a whole line: the child prints exactly one `PR: <url>`
        // line on success, so don't match a stray `PR:` echoed elsewhere.
        const match = stdout.match(/^PR:\s*(\S+)$/m)
        resolve(match ? match[1]! : null)
      })
    } catch (e) {
      logError(
        `failed to dispatch workflow run: ${e instanceof Error ? e.message : String(e)}`,
      )
      resolve(null)
    }
  })
}
