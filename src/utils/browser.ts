import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFileNoThrow } from 'src/utils/proc/execFileNoThrow.js'
import { logForDebugging } from './debug.js'
import { getGlobalConfig } from 'src/services/config/config.js'

function validateUrl(url: string): void {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch (_error) {
    throw new Error(`Invalid URL format: ${url}`)
  }

  // Validate URL protocol for security
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Invalid URL protocol: must use http:// or https://, got ${parsedUrl.protocol}`,
    )
  }
}

/**
 * Open a file or folder path using the system's default handler.
 * Uses `open` on macOS, `explorer` on Windows, `xdg-open` on Linux.
 */
export async function openPath(path: string): Promise<boolean> {
  try {
    const platform = process.platform
    if (platform === 'win32') {
      const { code } = await execFileNoThrow('explorer', [path])
      return code === 0
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const { code } = await execFileNoThrow(command, [path])
    return code === 0
  } catch (_) {
    return false
  }
}

// Field-code stripper for `.desktop` Exec= lines per
// https://specifications.freedesktop.org/desktop-entry-spec/desktop-entry-spec-latest.html#exec-variables
const DESKTOP_FIELD_CODE_RE = /%[fFuUdDnNickvm]/g
// Common Linux browsers tried (in order) when xdg-settings detection fails.
const LINUX_BROWSER_PROBE_LIST = [
  'brave-browser',
  'brave',
  'firefox',
  'chromium',
  'google-chrome',
  'microsoft-edge',
]
const DETECT_TIMEOUT_MS = 2000

let cachedLinuxBrowser: string | null | undefined = undefined

function getDesktopFileSearchDirs(): string[] {
  const xdgDataHome =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0
      ? process.env.XDG_DATA_HOME
      : path.join(homedir(), '.local', 'share')
  return [
    path.join(xdgDataHome, 'applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
    '/var/lib/snapd/desktop/applications',
    '/var/lib/flatpak/exports/share/applications',
  ]
}

/**
 * Parse the first `Exec=` line in a `.desktop` file (under the
 * `[Desktop Entry]` group) and return the bare binary token, with field codes
 * stripped and `%%` collapsed. Returns null if no Exec line is found.
 *
 * Exported for unit tests.
 */
export function parseDesktopExec(contents: string): string | null {
  const lines = contents.split('\n')
  let inDesktopEntry = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inDesktopEntry = line === '[Desktop Entry]'
      continue
    }
    if (!inDesktopEntry) continue
    if (!line.startsWith('Exec=')) continue
    const cleaned = line
      .slice('Exec='.length)
      .replace(DESKTOP_FIELD_CODE_RE, '')
      .replace(/%%/g, '%')
      .trim()
    if (cleaned.length === 0) return null
    // First whitespace-separated token, respecting simple double-quoting.
    const match = cleaned.match(/^"([^"]+)"|^(\S+)/)
    if (!match) return null
    return match[1] ?? match[2] ?? null
  }
  return null
}

async function readFirstExistingDesktopFile(
  name: string,
): Promise<string | null> {
  for (const dir of getDesktopFileSearchDirs()) {
    const full = path.join(dir, name)
    try {
      return await fs.readFile(full, 'utf8')
    } catch (_) {
      // Try the next search dir
    }
  }
  return null
}

async function whichBinary(bin: string): Promise<boolean> {
  const { code } = await execFileNoThrow('which', [bin], {
    timeout: DETECT_TIMEOUT_MS,
    useCwd: false,
  })
  return code === 0
}

async function detectXdgDefaultBrowser(): Promise<string | null> {
  const { code, stdout } = await execFileNoThrow(
    'xdg-settings',
    ['get', 'default-web-browser'],
    { timeout: DETECT_TIMEOUT_MS, useCwd: false },
  )
  if (code !== 0) return null
  const desktopFile = stdout.trim()
  if (desktopFile.length === 0 || !desktopFile.endsWith('.desktop')) return null
  const contents = await readFirstExistingDesktopFile(desktopFile)
  if (contents == null) return null
  return parseDesktopExec(contents)
}

async function probeKnownBrowsers(): Promise<string | null> {
  for (const bin of LINUX_BROWSER_PROBE_LIST) {
    if (await whichBinary(bin)) return bin
  }
  return null
}

/**
 * Resolve a Linux browser command, trying xdg-settings then a probe list.
 * Memoized per-process. Exported for tests.
 */
export async function resolveLinuxBrowser(): Promise<string | null> {
  if (cachedLinuxBrowser !== undefined) return cachedLinuxBrowser
  try {
    const detected = await detectXdgDefaultBrowser()
    if (detected) {
      cachedLinuxBrowser = detected
      return detected
    }
  } catch (e) {
    logForDebugging(`browser: xdg-settings detection failed: ${String(e)}`)
  }
  try {
    const probed = await probeKnownBrowsers()
    cachedLinuxBrowser = probed
    return probed
  } catch (e) {
    logForDebugging(`browser: probe list failed: ${String(e)}`)
    cachedLinuxBrowser = null
    return null
  }
}


async function tryExec(bin: string, url: string): Promise<boolean> {
  const { code } = await execFileNoThrow(bin, [url])
  return code === 0
}

export async function openBrowser(url: string): Promise<boolean> {
  try {
    // Parse and validate the URL
    validateUrl(url)

    const browserEnv = process.env.BROWSER
    const platform = process.platform

    if (platform === 'win32') {
      if (browserEnv) {
        // browsers require shell, else they will treat this as a file:/// handle
        const { code } = await execFileNoThrow(browserEnv, [`"${url}"`])
        return code === 0
      }
      const { code } = await execFileNoThrow(
        'rundll32',
        ['url,OpenURL', url],
        {},
      )
      return code === 0
    }

    if (platform === 'darwin') {
      const command = browserEnv || 'open'
      const { code } = await execFileNoThrow(command, [url])
      return code === 0
    }

    // Linux (and other Unixes): priority chain
    // 1. $BROWSER
    if (browserEnv) {
      if (await tryExec(browserEnv, url)) return true
    }

    // 2. settings.oauthBrowser
    let configured: string | undefined
    try {
      configured = getGlobalConfig().oauthBrowser
    } catch (e) {
      logForDebugging(`browser: failed to read oauthBrowser setting: ${String(e)}`)
    }
    if (configured && configured.length > 0) {
      if (await tryExec(configured, url)) return true
    }

    // 3 & 4. Detected default → probe list
    const detected = await resolveLinuxBrowser()
    if (detected) {
      if (await tryExec(detected, url)) return true
    }

    // 5. xdg-open fallback
    const { code } = await execFileNoThrow('xdg-open', [url])
    return code === 0
  } catch (_) {
    return false
  }
}
