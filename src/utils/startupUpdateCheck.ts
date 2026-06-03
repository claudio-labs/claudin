import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const THROTTLE_MS = 6 * 60 * 60 * 1000 // 6h
const NPM_VIEW_TIMEOUT_MS = 3000

const SKIP_SUBCOMMANDS = new Set([
  'update',
  'upgrade',
  'install',
  'doctor',
  'completion',
  'mcp',
])

const SKIP_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V'])

const NPX_PATH_RE = /[/\\]_npx[/\\]/
const MAJOR_RE = /^(\d+)\./

export function isCrossMajor(current: string, next: string): boolean {
  const cur = current.match(MAJOR_RE)
  const nxt = next.match(MAJOR_RE)
  if (!cur || !nxt) return false
  return cur[1] !== nxt[1]
}

/**
 * Pure pre-check: returns a skip reason if the startup version check should
 * not even attempt to call npm. Tested in isolation; no module-graph side
 * effects.
 */
export function getEarlySkipReason(argv: string[]): string | null {
  if (process.env.CLAUDIN_SKIP_STARTUP_UPDATE === '1') return 'env-skip'
  if (!process.stdout.isTTY) return 'not-tty'
  // Only argv[0] can be a subcommand. Checking the whole argv would false-
  // positive on flag values like `claudin -p "tell me about the update flow"`.
  if (argv[0] && SKIP_SUBCOMMANDS.has(argv[0])) return 'subcommand'
  // Flags (--help/--version/-h/-v/-V) can appear anywhere.
  if (argv.some(a => SKIP_FLAGS.has(a))) return 'flag'
  if (
    typeof process.argv[1] === 'string' &&
    NPX_PATH_RE.test(process.argv[1])
  ) {
    return 'npx'
  }
  return null
}

/**
 * Check npm for a newer published version of @claudinlabs/claudin and
 * persist the result to `~/.claudin/latest-version.json` so the startup
 * banner can show a "new version available" hint on the next render.
 *
 * This function NEVER installs anything and NEVER respawns the process.
 * The user updates manually via `claudin update`.
 *
 * Fail-open: any error here is swallowed so a broken update path never
 * prevents the CLI from starting.
 */
export async function runStartupUpdateCheck(argv: string[]): Promise<void> {
  try {
    if (getEarlySkipReason(argv)) return

    // Heavy imports are lazy so the early-skip path stays cheap (and so the
    // test for getEarlySkipReason doesn't need to resolve the full module
    // graph). All names below are runtime-imported.
    const [
      { isAutoUpdaterDisabled },
      { getCurrentInstallationType },
      { getLatestVersion },
      { logForDebugging },
      { getClaudinConfigHomeDir },
      { isENOENT },
      { writeLatestVersion },
      { getInitialSettings },
    ] = await Promise.all([
      import('src/utils/config.js'),
      import('src/utils/doctorDiagnostic.js'),
      import('src/utils/autoUpdater.js'),
      import('src/utils/debug.js'),
      import('src/utils/envUtils.js'),
      import('src/utils/errors.js'),
      import('src/utils/latestVersionCache.js'),
      import('src/utils/settings/settings.js'),
    ])

    // Respect the user's opt-out — same flag the legacy auto-updater honored.
    // Disabling the auto-updater means "no npm network calls on startup".
    if (isAutoUpdaterDisabled()) return

    // Skip in development (claudindev / source-tree runs). For every other
    // install type we still surface the notice; the message is generic
    // (`run: claudin update`) so it makes sense for npm, native, brew, etc.
    const installType = await getCurrentInstallationType()
    if (installType === 'development') {
      logForDebugging(
        `startup-update: skipping for installType=${installType}`,
      )
      return
    }

    const getThrottleFilePath = (): string =>
      join(getClaudinConfigHomeDir(), 'last-update-check')

    const isThrottled = async (): Promise<boolean> => {
      if (process.env.CLAUDIN_FORCE_UPDATE_CHECK === '1') return false
      try {
        const raw = await readFile(getThrottleFilePath(), 'utf8')
        const last = Number.parseInt(raw.trim(), 10)
        if (!Number.isFinite(last)) return false
        return Date.now() - last < THROTTLE_MS
      } catch (err) {
        if (isENOENT(err)) return false
        logForDebugging(`[startup-update] throttle read failed: ${String(err)}`)
        return false
      }
    }

    const recordCheckTimestamp = async (): Promise<void> => {
      const path = getThrottleFilePath()
      try {
        await writeFile(path, String(Date.now()), 'utf8')
      } catch (err) {
        if (isENOENT(err)) {
          try {
            await mkdir(getClaudinConfigHomeDir(), { recursive: true })
            await writeFile(path, String(Date.now()), 'utf8')
          } catch (e) {
            logForDebugging(
              `startup-update: failed to record timestamp: ${e}`,
            )
          }
          return
        }
        logForDebugging(`startup-update: failed to record timestamp: ${err}`)
      }
    }

    if (await isThrottled()) return

    const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
    const current = MACRO.DISPLAY_VERSION
    if (!current) return

    const latest = await getLatestVersion(channel, {
      timeoutMs: NPM_VIEW_TIMEOUT_MS,
    })
    // Record timestamp only when the npm view call returned a usable version.
    // A null result (network error) or empty string (empty stdout) shouldn't
    // burn the 6h throttle budget — next launch should retry.
    if (!latest) return
    await recordCheckTimestamp()

    // Always update the cache (even when latest <= current) so a stale cache
    // pointing at an old "available" version doesn't keep the banner shouting.
    try {
      await writeLatestVersion({
        latest,
        checkedAt: Date.now(),
        current,
      })
    } catch (e) {
      logForDebugging(`startup-update: failed to persist cache: ${e}`)
    }
  } catch (err) {
    // Fail-open: never block startup because of an update bug. Use dynamic
    // imports here in case the failure was in the bulk import above.
    try {
      const { logError } = await import('src/utils/log.js')
      const { logForDebugging } = await import('src/utils/debug.js')
      logError(err as Error)
      logForDebugging(`startup-update: unhandled error, continuing: ${err}`)
    } catch {
      // Last-resort: swallow silently rather than crash startup.
    }
  }
}
