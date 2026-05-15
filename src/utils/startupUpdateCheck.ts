import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'

export const RESPAWN_SENTINEL = '_CLAUDIO_RESPAWNED_AFTER_UPDATE'
const THROTTLE_MS = 6 * 60 * 60 * 1000 // 6h
const NPM_VIEW_TIMEOUT_MS = 3000
const SANITY_CHECK_TIMEOUT_MS = 5000

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
 * Pure pre-check: returns a skip reason if startup update should not even
 * attempt to call npm. Tested in isolation; no module-graph side effects.
 */
export function getEarlySkipReason(argv: string[]): string | null {
  if (process.env[RESPAWN_SENTINEL] === '1') return 'already-respawned'
  if (process.env.CLAUDIO_SKIP_STARTUP_UPDATE === '1') return 'env-skip'
  if (!process.stdout.isTTY) return 'not-tty'
  // Only argv[0] can be a subcommand. Checking the whole argv would false-
  // positive on flag values like `claudio -p "tell me about the update flow"`.
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

function bundleOutputsExpectedVersion(
  stdout: string | undefined,
  expected: string,
): boolean {
  if (!stdout) return false
  return stdout.includes(expected)
}

/**
 * Blocks startup briefly to check npm for a newer published version of
 * @claudiolabs/claudio. If one exists, installs it, sanity-checks the new
 * bundle, and respawns the process with the same argv so the user lands on
 * the new version before the TUI mounts.
 *
 * Fail-open: any error here is swallowed so a broken update path never
 * prevents the CLI from starting.
 */
export async function runStartupUpdateCheck(argv: string[]): Promise<void> {
  try {
    if (getEarlySkipReason(argv)) return

    // Heavy imports are lazy so the early skip path stays cheap (and so the
    // test for getEarlySkipReason doesn't need to resolve the full module
    // graph). All names below are runtime-imported.
    const [
      { isAutoUpdaterDisabled },
      { getCurrentInstallationType },
      {
        getLatestVersion,
        installGlobalPackage,
        shouldSkipVersion,
      },
      { logForDebugging },
      { getClaudioConfigHomeDir },
      { isENOENT },
      { gt },
      { getInitialSettings },
    ] = await Promise.all([
      import('src/utils/config.js'),
      import('src/utils/doctorDiagnostic.js'),
      import('src/utils/autoUpdater.js'),
      import('src/utils/debug.js'),
      import('src/utils/envUtils.js'),
      import('src/utils/errors.js'),
      import('src/utils/log.js'),
      import('src/utils/semver.js'),
      import('src/utils/settings/settings.js'),
    ])

    type InstallStatus = Awaited<ReturnType<typeof installGlobalPackage>>

    if (isAutoUpdaterDisabled()) return

    const getThrottleFilePath = (): string =>
      join(getClaudioConfigHomeDir(), 'last-update-check')

    const isThrottled = async (): Promise<boolean> => {
      if (process.env.CLAUDIO_FORCE_UPDATE_CHECK === '1') return false
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
            await mkdir(getClaudioConfigHomeDir(), { recursive: true })
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

    const installType = await getCurrentInstallationType()
    if (
      installType === 'development' ||
      installType === 'native' ||
      installType === 'package-manager' ||
      installType === 'unknown'
    ) {
      // 'unknown' means we cannot reliably tell which package manager owns the
      // current binary (e.g. bun-global installs, custom prefixes). Triggering
      // `npm install -g` in that case can install into a different prefix than
      // the one on PATH, leaving the user on the old version forever — skip
      // and let the user run `claudio update` manually.
      logForDebugging(
        `startup-update: skipping for installType=${installType}`,
      )
      return
    }

    if (await isThrottled()) return

    const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
    const current = MACRO.DISPLAY_VERSION
    if (!current) return

    const latest = await getLatestVersion(channel, {
      timeoutMs: NPM_VIEW_TIMEOUT_MS,
    })
    // Record timestamp only when the npm view call returned a value (success
    // or "no version" parse). A null result from a network error shouldn't
    // burn the 6h throttle budget.
    if (latest !== null) {
      await recordCheckTimestamp()
    }
    if (!latest) return
    if (!gt(latest, current)) return
    if (shouldSkipVersion(latest)) return
    if (isCrossMajor(current, latest)) {
      process.stdout.write(
        chalk.yellow(
          `\nClaudio ${latest} is available (major upgrade from ${current}).\n` +
            `Run \`claudio update\` to upgrade manually.\n\n`,
        ),
      )
      return
    }

    process.stdout.write(
      chalk.dim(`\nClaudio: updating ${current} → ${latest}...\n`),
    )

    let status: InstallStatus
    if (installType === 'npm-local') {
      const { installOrUpdateClaudePackage } = await import(
        'src/utils/localInstaller.js'
      )
      status = await installOrUpdateClaudePackage(channel)
    } else {
      status = await installGlobalPackage(latest)
    }

    if (status !== 'success') {
      if (status === 'no_permissions') {
        const launcherPath = process.argv[1] || ''
        const isBunInstall =
          launcherPath.includes('/.bun/install/global/') ||
          (process.env.BUN_INSTALL
            ? launcherPath.startsWith(process.env.BUN_INSTALL)
            : false)
        const manualCmd = isBunInstall
          ? `bun install -g ${MACRO.PACKAGE_URL}@latest`
          : `sudo npm install -g ${MACRO.PACKAGE_URL}@latest`
        process.stdout.write(
          chalk.yellow(
            `\nUpdate to ${latest} failed: insufficient permissions.\n` +
              `Run manually:\n`,
          ) + chalk.bold(`  ${manualCmd}\n\n`),
        )
      } else {
        process.stdout.write(
          chalk.yellow(
            `Update to ${latest} failed (${status}). Continuing with ${current}.\n`,
          ),
        )
      }
      return
    }

    // Sanity check: ensure the new bundle on disk actually reports the new
    // version. If something went sideways during install (partial write,
    // wrong symlink, etc.) we don't want to respawn into a broken binary.
    const launcher = process.argv[1]
    if (typeof launcher !== 'string' || launcher.length === 0) {
      logForDebugging('startup-update: no argv[1], skipping respawn')
      return
    }

    const sanity = spawnSync(process.argv[0], [launcher, '--version'], {
      encoding: 'utf8',
      timeout: SANITY_CHECK_TIMEOUT_MS,
      env: { ...process.env, [RESPAWN_SENTINEL]: '1' },
    })
    if (
      sanity.status !== 0 ||
      !bundleOutputsExpectedVersion(sanity.stdout, latest)
    ) {
      process.stdout.write(
        chalk.yellow(
          `\nUpdate installed but new bundle did not report ${latest}. ` +
            `Continuing with ${current}.\n`,
        ),
      )
      logForDebugging(
        `startup-update: sanity check failed. status=${sanity.status} ` +
          `stdout=${(sanity.stdout || '').trim()}`,
      )
      return
    }

    process.stdout.write(
      chalk.green(`✓ Updated to ${latest}. Restarting...\n\n`),
    )

    const result = spawnSync(
      process.argv[0],
      [...process.execArgv, launcher, ...argv],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          [RESPAWN_SENTINEL]: '1',
          CLAUDIO_NO_CLEAR_ON_START: '1',
        },
      },
    )
    process.exit(result.status ?? 0)
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
