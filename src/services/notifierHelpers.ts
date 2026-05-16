/**
 * Pure helpers for `notifier.ts`. Kept in their own module so tests can
 * exercise them without dragging in the React/Ink-heavy import graph that
 * the orchestrator pulls (hooks, attachments, MCP, etc.).
 */

/**
 * Heuristic mapping from detected terminal to in-band OSC channel.
 * Returns null when the terminal has no known notification escape sequence
 * and we should fall back to `os_native`.
 */
export function pickOscChannel(terminal: string | null): string | null {
  if (!terminal) return null
  switch (terminal) {
    case 'iTerm.app':
      return 'iterm2'
    case 'kitty':
      return 'kitty'
    case 'ghostty':
    case 'WezTerm':
    case 'foot':
    case 'rxvt':
    case 'urxvt':
      return 'osc777'
    case 'windows-terminal':
    case 'conemu':
      return 'osc9plain'
  }
  if (terminal.startsWith('xterm-kitty')) return 'kitty'
  if (terminal.includes('foot')) return 'osc777'
  if (terminal.includes('wezterm')) return 'osc777'
  if (terminal.includes('rxvt')) return 'osc777'
  return null
}

/** Quote a string as an AppleScript string literal. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const XML_ESCAPE_RE = /[<>&'"]/g
const XML_ENTITIES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
}

export function xmlEscape(value: string): string {
  return value.replace(XML_ESCAPE_RE, ch => XML_ENTITIES[ch] ?? ch)
}

/**
 * PowerShell script that pops a Win10/11 toast using the built-in WinRT API.
 * Caller is responsible for base64-encoding (UTF-16LE) and passing via
 * `powershell.exe -EncodedCommand` to avoid quoting issues.
 */
export function buildWindowsToastScript(
  title: string,
  message: string,
): string {
  const safeTitle = xmlEscape(title)
  const safeMessage = xmlEscape(message)
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${safeTitle}</text><text>${safeMessage}</text></binding></visual></toast>')`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claudio")',
    '$notifier.Show($toast)',
  ].join('; ')
}

export const DEBOUNCE_WINDOW_MS = 2000

export function makeDebouncer(windowMs = DEBOUNCE_WINDOW_MS) {
  const lastSendAt = new Map<string, number>()
  function shouldDebounce(key: string): boolean {
    const now = Date.now()
    const last = lastSendAt.get(key) ?? 0
    if (now - last < windowMs) return true
    lastSendAt.set(key, now)
    if (lastSendAt.size > 64) {
      for (const [k, t] of lastSendAt) {
        if (now - t > windowMs * 4) lastSendAt.delete(k)
      }
    }
    return false
  }
  function reset(): void {
    lastSendAt.clear()
  }
  return { shouldDebounce, reset }
}
