// On Windows (bash only) a hook naming a .sh script would open it in the
// default file handler instead of running it, so `bash` is prepended.
// PowerShell runs .ps1 files natively and never comes through here.
const SH_SCRIPT_RE = /\.sh(\s|$|")/

export function getWindowsBashHookCommand(command: string): string {
  const trimmed = command.trim()
  if (SH_SCRIPT_RE.test(trimmed) && !trimmed.startsWith('bash ')) {
    return `bash ${command}`
  }
  return command
}
