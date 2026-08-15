import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const THROTTLE_MS = 60 * 60 * 1000 // 1h
const NPM_VIEW_TIMEOUT_MS = 3000

// Process-scoped guard so the CLAUDIN_FORCE_UPDATE_CHECK footgun warning
// fires at most once per launch even though `runStartupUpdateCheck` itself
// is called once per process — the flag exists so a future caller that
// invokes the function multiple times (e.g. a watch-mode reload) doesn't
// spam stderr on every iteration.
let forceCheckWarned = false

// Test-only: reset the process-scoped one-shot guard so each test can
// observe the warning independently of declaration order.
export function __resetForceCheckWarnedForTesting(): void {
  forceCheckWarned = false
}

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
 * Check npm for a newer published version of @claudiolabs/claudin and
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
      { getAutoUpdaterDisabledReason },
      { getCurrentInstallationType },
      { getLatestVersion },
      { logForDebugging },
      { getClaudinConfigHomeDir },
      { isENOENT },
      { writeLatestVersion },
      { getInitialSettings },
    ] = await Promise.all([
      import('src/platform/config/config.js'),
      import('src/platform/doctor/doctorDiagnostic.js'),
      import('src/platform/install/autoUpdater.js'),
      import('src/shared/debug.js'),
      import('src/shared/envUtils.js'),
      import('src/shared/errors.js'),
      import('src/platform/install/latestVersionCache.js'),
      import('src/platform/settings/settings.js'),
    ])

    // Dev override: setting CLAUDIN_FORCE_UPDATE_CHECK=1 bypasses the
    // settings opt-out, dev-install gate, and throttle (see isThrottled
    // below) so a developer can validate the banner notice without
    // installing the npm release. NOTE: the earlier `getEarlySkipReason()`
    // (non-TTY, npx, --version/--help, subcommands) still applies — the
    // override is only for the runtime gates, not the static skip set.
    // The cache write stays async; with the StartupBanner subscriber the
    // notice now also pops in mid-session once npm view lands.
    const forceCheck = process.env.CLAUDIN_FORCE_UPDATE_CHECK === '1'
    if (forceCheck && !forceCheckWarned) {
      forceCheckWarned = true
      // One-shot diagnostic to stderr so a user who accidentally persisted
      // the flag (e.g. in ~/.bashrc) notices they're hammering the npm
      // registry on every launch. logForDebugging alone would be silent
      // for non-debug runs. stderr (not stdout) so Ink's stdout-bound
      // alt-screen render isn't disturbed.
      // eslint-disable-next-line no-console
      console.error(
        '[claudin] CLAUDIN_FORCE_UPDATE_CHECK=1 honored — every launch will hit the npm registry. Unset to restore normal throttling.',
      )
    }

    // Respect *explicit* opt-outs — DISABLE_AUTOUPDATER, an explicitly-set
    // *_DISABLE_NONESSENTIAL_TRAFFIC env var, or `autoUpdates: false` in
    // config — same gates the legacy auto-updater honored. The Claudin
    // *default* essential-traffic privacy level is exempt: it exists to
    // suppress Anthropic-backend startup probes, while this is a throttled,
    // provider-agnostic npm registry lookup that never installs anything
    // (see header comment). Gating on the default made the version notice
    // dead code for every default-config user.
    if (
      !forceCheck &&
      getAutoUpdaterDisabledReason({ ignoreClaudinDefaultPrivacy: true }) !==
        null
    ) {
      return
    }

    // Skip in development (claudindev / source-tree runs). For every other
    // install type we still surface the notice; the message is generic
    // (`run: claudin update`) so it makes sense for npm, native, brew, etc.
    const installType = await getCurrentInstallationType()
    if (!forceCheck && installType === 'development') {
      logForDebugging(
        `startup-update: skipping for installType=${installType}`,
      )
      return
    }

    const getThrottleFilePath = (): string =>
      join(getClaudinConfigHomeDir(), 'last-update-check')

    const isThrottled = async (): Promise<boolean> => {
      if (forceCheck) return false
      try {
        const raw = await readFile(getThrottleFilePath(), 'utf8')
        const last = Number.parseInt(raw.trim(), 10)
        if (!Number.isFinite(last)) return false
        const now = Date.now()
        // Reject future timestamps (clock skew, NFS, restored backups):
        // otherwise `now - last < THROTTLE_MS` would be true for any
        // future `last`, disabling the update check until the clock
        // catches up. Treat as not-throttled so the caller re-records.
        if (last > now) return false
        return now - last < THROTTLE_MS
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
    // burn the 1h throttle budget — next launch should retry.
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
      const { logError } = await import('src/shared/log.js')
      const { logForDebugging } = await import('src/shared/debug.js')
      logError(err as Error)
      logForDebugging(`startup-update: unhandled error, continuing: ${err}`)
    } catch {
      // Last-resort: swallow silently rather than crash startup.
    }
  }
}
