import type { TerminalNotification } from 'src/ink/useTerminalNotification.js'
import { getGlobalConfig } from 'src/services/config/config.js'
import { env } from 'src/utils/env.js'
import { execFileNoThrow } from 'src/utils/proc/execFileNoThrow.js'
import { executeNotificationHooks } from 'src/services/lifecycleHooks/hooks.js'
import { logError } from 'src/utils/log.js'
import { which } from 'src/utils/proc/which.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  appleScriptString,
  buildWindowsToastScript,
  makeDebouncer,
  pickOscChannel,
} from 'src/services/notifierHelpers.js'

export type NotificationOptions = {
  message: string
  title?: string
  notificationType: string
}

const DEFAULT_TITLE = 'Claudin'
const debouncer = makeDebouncer()

function shouldDebounce(opts: NotificationOptions): boolean {
  return debouncer.shouldDebounce(`${opts.title ?? ''}|${opts.message}`)
}

export async function sendNotification(
  notif: NotificationOptions,
  terminal: TerminalNotification,
): Promise<void> {
  // External hooks (Slack, Pushover, etc.) fire on every notification —
  // they are off-device delivery and should never be coalesced by the
  // local debouncer. Only the on-screen channel is debounced below.
  await executeNotificationHooks(notif)

  if (shouldDebounce(notif)) {
    return
  }

  const config = getGlobalConfig()
  const channel = config.preferredNotifChannel

  const methodUsed = await sendToChannel(channel, notif, terminal)

  logEvent('tengu_notification_method_used', {
    configured_channel:
      channel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    method_used:
      methodUsed as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    term: env.terminal as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

async function sendToChannel(
  channel: string,
  opts: NotificationOptions,
  terminal: TerminalNotification,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE

  try {
    switch (channel) {
      case 'auto':
        return await sendAuto(opts, terminal)
      case 'iterm2':
        terminal.notifyITerm2(opts)
        return 'iterm2'
      case 'iterm2_with_bell':
        terminal.notifyITerm2(opts)
        terminal.notifyBell()
        return 'iterm2_with_bell'
      case 'kitty':
        terminal.notifyKitty({ ...opts, title, id: generateKittyId() })
        return 'kitty'
      case 'ghostty':
        terminal.notifyGhostty({ ...opts, title })
        return 'ghostty'
      case 'os_native':
        return await sendOsNative({ ...opts, title })
      case 'terminal_bell':
        terminal.notifyBell()
        return 'terminal_bell'
      case 'notifications_disabled':
        return 'disabled'
      default:
        return 'none'
    }
  } catch (error) {
    logError(error)
    return 'error'
  }
}

async function sendAuto(
  opts: NotificationOptions,
  terminal: TerminalNotification,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE
  const isHeadless = !process.stdout.isTTY
  const sshSession = env.isSSH()

  // In headless mode there is no terminal to receive OSC; jump straight to
  // the desktop backend (still useful for `claudin` running as a daemon).
  if (isHeadless) {
    return sendOsNative({ ...opts, title })
  }

  // OSC channel pick — works for the user's local terminal even over SSH
  // (the sequence travels through the tty back to their machine).
  const oscChannel = pickOscChannel(env.terminal)
  if (oscChannel === 'iterm2') {
    terminal.notifyITerm2(opts)
    return 'iterm2'
  }
  if (oscChannel === 'kitty') {
    terminal.notifyKitty({ ...opts, title, id: generateKittyId() })
    return 'kitty'
  }
  if (oscChannel === 'osc777') {
    terminal.notifyOsc777({ ...opts, title })
    return 'osc777'
  }
  if (oscChannel === 'osc9plain') {
    terminal.notifyOsc9Plain({ ...opts, title })
    return 'osc9plain'
  }

  // Apple_Terminal: prefer OS-native toast, fall back to bell if profile has it.
  if (env.terminal === 'Apple_Terminal') {
    const native = await sendOsNative({ ...opts, title })
    if (native !== 'no_method_available' && native !== 'error') return native
    const bellDisabled = await isAppleTerminalBellDisabled()
    if (!bellDisabled) {
      terminal.notifyBell()
      return 'terminal_bell'
    }
    return 'no_method_available'
  }

  // No matching OSC channel — try desktop backend. Skip when on a remote
  // SSH host: a toast on the server is invisible to the user.
  if (sshSession) {
    return 'ssh_remote_skip'
  }
  return sendOsNative({ ...opts, title })
}

function generateKittyId(): number {
  return Math.floor(Math.random() * 10000)
}

// ---------------------------------------------------------------------------
// OS-native backends (notify-send / osascript / Toast XML)
// ---------------------------------------------------------------------------

const commandAvailability = new Map<string, Promise<boolean>>()

function commandExists(name: string): Promise<boolean> {
  let pending = commandAvailability.get(name)
  if (!pending) {
    pending = which(name)
      .then(p => !!p)
      .catch(() => false)
    commandAvailability.set(name, pending)
  }
  return pending
}

/** @internal test-only */
export function _resetNotifierCachesForTests(): void {
  commandAvailability.clear()
  debouncer.reset()
}

async function sendOsNative(opts: NotificationOptions): Promise<string> {
  // Never spawn a desktop toast on a remote SSH host — nobody is at that
  // machine's screen, and it would just spam syslog.
  if (env.isSSH() && !env.isWslEnvironment()) {
    return 'ssh_remote_skip'
  }

  try {
    if (env.isWslEnvironment()) {
      return await sendWindowsToast(opts, /* viaWslInterop */ true)
    }
    if (env.platform === 'darwin') {
      return await sendMacOsNotification(opts)
    }
    if (env.platform === 'linux') {
      return await sendLinuxNotification(opts)
    }
    if (env.platform === 'win32') {
      return await sendWindowsToast(opts, false)
    }
  } catch (error) {
    logError(error)
    return 'error'
  }
  return 'no_method_available'
}

async function sendMacOsNotification(
  opts: NotificationOptions,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE
  // Prefer terminal-notifier (brew) if installed: stickier in Notification
  // Center, no "Script Editor" branding.
  if (await commandExists('terminal-notifier')) {
    const { code, error } = await execFileNoThrow(
      'terminal-notifier',
      ['-title', title, '-message', opts.message, '-group', 'claudin'],
      { useCwd: false, timeout: 5000 },
    )
    if (code === 0) return 'os_native:terminal-notifier'
    if (error) logError(`terminal-notifier failed: ${error}`)
  }

  // Fallback: osascript. AppleScript string literals only need `"` and `\` escaped.
  const script = `display notification ${appleScriptString(opts.message)} with title ${appleScriptString(title)}`
  const { code, error } = await execFileNoThrow(
    'osascript',
    ['-e', script],
    { useCwd: false, timeout: 5000 },
  )
  if (code === 0) return 'os_native:osascript'
  if (error) logError(`osascript notify failed: ${error}`)
  return 'no_method_available'
}

async function sendLinuxNotification(
  opts: NotificationOptions,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE
  if (await commandExists('notify-send')) {
    const { code, error } = await execFileNoThrow(
      'notify-send',
      [
        '--app-name=Claudin',
        '--category=im.received',
        '--expire-time=5000',
        title,
        opts.message,
      ],
      { useCwd: false, timeout: 5000 },
    )
    if (code === 0) return 'os_native:notify-send'
    if (error) logError(`notify-send failed: ${error}`)
  }
  // kdialog and zenity are common fallbacks on KDE/older distros.
  if (await commandExists('kdialog')) {
    const { code } = await execFileNoThrow(
      'kdialog',
      ['--title', title, '--passivepopup', opts.message, '5'],
      { useCwd: false, timeout: 5000 },
    )
    if (code === 0) return 'os_native:kdialog'
  }
  return 'no_method_available'
}

async function sendWindowsToast(
  opts: NotificationOptions,
  viaWslInterop: boolean,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE
  const psExe = 'powershell.exe'
  // Probe the binary so we can degrade cleanly when running headless WSL
  // without Windows interop (rare but possible).
  if (!(await commandExists(psExe))) return 'no_method_available'

  const script = buildWindowsToastScript(title, opts.message)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { code, error } = await execFileNoThrow(
    psExe,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ],
    { useCwd: false, timeout: 8000 },
  )
  if (code === 0) {
    return viaWslInterop ? 'os_native:wsl-toast' : 'os_native:toast'
  }
  if (error) logError(`Windows toast failed: ${error}`)
  return 'no_method_available'
}

async function isAppleTerminalBellDisabled(): Promise<boolean> {
  try {
    if (env.terminal !== 'Apple_Terminal') {
      return false
    }

    const osascriptResult = await execFileNoThrow('osascript', [
      '-e',
      'tell application "Terminal" to name of current settings of front window',
    ])
    const currentProfile = osascriptResult.stdout.trim()

    if (!currentProfile) {
      return false
    }

    const defaultsOutput = await execFileNoThrow('defaults', [
      'export',
      'com.apple.Terminal',
      '-',
    ])

    if (defaultsOutput.code !== 0) {
      return false
    }

    // Lazy-load plist (~280KB with xmlbuilder+@xmldom) — only hit on
    // Apple_Terminal with auto-channel, which is a small fraction of users.
    const plist = await import('plist')
    const parsed: Record<string, unknown> = plist.parse(defaultsOutput.stdout)
    const windowSettings = parsed?.['Window Settings'] as
      | Record<string, unknown>
      | undefined
    const profileSettings = windowSettings?.[currentProfile] as
      | Record<string, unknown>
      | undefined

    if (!profileSettings) {
      return false
    }

    return profileSettings.Bell === false
  } catch (error) {
    logError(error)
    return false
  }
}

