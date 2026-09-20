/**
 * The bash-parity hard deny: a removal cmdlet aimed at a system-critical path
 * is refused outright rather than offered to the user for approval.
 */

import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { isDangerousRemovalPath } from 'src/permissions/pathValidation.js'
import { expandTilde } from 'src/tools/PowerShellTool/pathValidation/pathAllowlist.js'

/**
 * Checks the raw user-provided path (pre-realpath) for dangerous removal
 * targets. safeResolvePath/realpathSync canonicalizes in ways that defeat
 * isDangerousRemovalPath: on Windows '/' → 'C:\' (fails the === '/' check);
 * on macOS homedir() may be under /var which realpathSync rewrites to
 * /private/var (fails the === homedir() check). Checking the tilde-expanded,
 * backslash-normalized form catches the dangerous shapes (/, ~, /etc, /usr)
 * as the user typed them.
 */
export function isDangerousRemovalRawPath(filePath: string): boolean {
  const expanded = expandTilde(filePath.replace(/^['"]|['"]$/g, '')).replace(
    /\\/g,
    '/',
  )
  return isDangerousRemovalPath(expanded)
}

export function dangerousRemovalDeny(path: string): PermissionResult {
  return {
    behavior: 'deny',
    message: `Remove-Item on system path '${path}' is blocked. This path is protected from removal.`,
    decisionReason: {
      type: 'other',
      reason: 'Removal targets a protected system path',
    },
  }
}
