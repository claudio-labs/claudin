# Notifications

Claudio surfaces "needs attention" events (input required, long task finished, hook-driven custom events) through whatever channel the host environment supports. The router lives in `src/services/notifier.ts`; the in-band terminal sequences live in `src/ink/useTerminalNotification.ts`; pure helpers are in `src/services/notifierHelpers.ts`.

## Channels

Configured via `preferredNotifChannel` in `~/.claudio/settings.json` (`/config` → "Notifications").

| Channel | What it does |
|---|---|
| `auto` | Pick the best available channel for the detected terminal/OS (default). |
| `iterm2` | iTerm2 proprietary OSC 9 sub-protocol. |
| `iterm2_with_bell` | iTerm2 OSC 9 + raw BEL. |
| `kitty` | Kitty OSC 99 (3-part: title/body/focus). |
| `ghostty` | Ghostty OSC 777 `notify;...`. |
| `os_native` | Desktop toast via `notify-send` / `osascript` / Windows Toast XML. |
| `terminal_bell` | Raw `\x07` BEL. |
| `notifications_disabled` | No-op. |

## `auto` resolution

1. **Headless** (`!process.stdout.isTTY`) → `os_native` (no terminal to talk to).
2. **OSC channel** from the terminal map (see table below) if one matches.
3. **Apple_Terminal** → try `os_native` (toast), else BEL if the user's Profile has Bell enabled.
4. **SSH session without WSL** → `ssh_remote_skip` for the desktop-toast step only. Terminal-side OSC paths above still work normally — those escapes travel over the tty back to the user's local emulator, so iTerm2/kitty/wezterm/etc. keep notifying as expected.
5. Else → `os_native`.

Identical (title,message) pairs sent within 2s are coalesced **on the local on-screen channel only**. External hooks (Slack/Pushover/ntfy) still fire on every event — see *Hooks* below.

## Terminal → channel matrix

| Terminal | Channel chosen by `auto` |
|---|---|
| iTerm2 | `iterm2` |
| kitty | `kitty` |
| ghostty | `osc777` |
| wezterm | `osc777` |
| foot (Wayland) | `osc777` |
| urxvt / rxvt | `osc777` |
| Windows Terminal | `osc9plain` (WT renders raw OSC 9 as a toast) |
| ConEmu | `osc9plain` |
| Apple_Terminal | `os_native` (osascript) → fallback BEL |
| Alacritty | `os_native` |
| GNOME Terminal / Konsole / Terminator / Tilix / xterm | `os_native` |
| anything else | `os_native` (best-effort) |

## `os_native` backends

| Platform | Primary | Fallback |
|---|---|---|
| macOS | `terminal-notifier` (if installed, brew) | `osascript -e 'display notification ...'` |
| Linux | `notify-send` (libnotify) | `kdialog --passivepopup` |
| Windows 10/11 | `powershell.exe` Toast XML via `-EncodedCommand` (built-in WinRT, no module dep) | — |
| WSL | same Toast XML over `powershell.exe` interop | — |

The PowerShell payload is built by `buildWindowsToastScript()` and base64-encoded as UTF-16LE before being passed to `powershell.exe -EncodedCommand` — that avoids both XML and shell-quoting pitfalls. AppleScript and XML payloads are escaped via `appleScriptString()` and `xmlEscape()` respectively.

## Hooks

The orchestrator fires `executeNotificationHooks()` **before** the debounce check, so users can wire any custom backend (Slack, Pushover, ntfy) via `~/.claudio/settings.json` hook config and trust that off-device delivery is never silently coalesced. The channel above runs in addition to, not instead of, the hook.
