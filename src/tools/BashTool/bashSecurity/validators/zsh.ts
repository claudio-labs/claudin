/**
 * Zsh-specific dangerous commands, plus `fc -e`.
 */

import { logEvent } from 'src/platform/analytics/index.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { BASH_SECURITY_CHECK_IDS } from 'src/tools/BashTool/bashSecurity/checkIds.js'
import type { ValidationContext } from 'src/tools/BashTool/bashSecurity/context.js'

// Zsh-specific dangerous commands that can bypass security checks.
// These are checked against the base command (first word) of each command segment.
export const ZSH_DANGEROUS_COMMANDS = new Set([
  // zmodload is the gateway to many dangerous module-based attacks:
  // zsh/mapfile (invisible file I/O via array assignment),
  // zsh/system (sysopen/syswrite two-step file access),
  // zsh/zpty (pseudo-terminal command execution),
  // zsh/net/tcp (network exfiltration via ztcp),
  // zsh/files (builtin rm/mv/ln/chmod that bypass binary checks)
  'zmodload',
  // emulate with -c flag is an eval-equivalent that executes arbitrary code
  'emulate',
  // Zsh module builtins that enable dangerous operations.
  // These require zmodload first, but we block them as defense-in-depth
  // in case zmodload is somehow bypassed or the module is pre-loaded.
  'sysopen', // Opens files with fine-grained control (zsh/system)
  'sysread', // Reads from file descriptors (zsh/system)
  'syswrite', // Writes to file descriptors (zsh/system)
  'sysseek', // Seeks on file descriptors (zsh/system)
  'zpty', // Executes commands on pseudo-terminals (zsh/zpty)
  'ztcp', // Creates TCP connections for exfiltration (zsh/net/tcp)
  'zsocket', // Creates Unix/TCP sockets (zsh/net/socket)
  'mapfile', // Not actually a command, but the associative array is set via zmodload
  'zf_rm', // Builtin rm from zsh/files
  'zf_mv', // Builtin mv from zsh/files
  'zf_ln', // Builtin ln from zsh/files
  'zf_chmod', // Builtin chmod from zsh/files
  'zf_chown', // Builtin chown from zsh/files
  'zf_mkdir', // Builtin mkdir from zsh/files
  'zf_rmdir', // Builtin rmdir from zsh/files
  'zf_chgrp', // Builtin chgrp from zsh/files
])

/**
 * Validates that the command doesn't use Zsh-specific dangerous commands that
 * can bypass security checks. These commands provide capabilities like loading
 * kernel modules, raw file I/O, network access, and pseudo-terminal execution
 * that circumvent normal permission checks.
 *
 * Also catches `fc -e` which can execute arbitrary editors on command history,
 * and `emulate` which with `-c` is an eval-equivalent.
 */
export function validateZshDangerousCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // Extract the base command from the original command, stripping leading
  // whitespace, env var assignments, and Zsh precommand modifiers.
  // e.g., "FOO=bar command builtin zmodload" -> "zmodload"
  const ZSH_PRECOMMAND_MODIFIERS = new Set([
    'command',
    'builtin',
    'noglob',
    'nocorrect',
  ])
  const trimmed = originalCommand.trim()
  const tokens = trimmed.split(/\s+/)
  let baseCmd = ''
  for (const token of tokens) {
    // Skip env var assignments (VAR=value)
    if (/^[A-Za-z_]\w*=/.test(token)) continue
    // Skip Zsh precommand modifiers (they don't change what command runs)
    if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue
    baseCmd = token
    break
  }

  if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: `Command uses Zsh-specific '${baseCmd}' which can bypass security checks`,
    }
  }

  // Check for `fc -e` which allows executing arbitrary commands via editor
  // fc without -e is safe (just lists history), but -e specifies an editor
  // to run on the command, effectively an eval
  if (baseCmd === 'fc' && /\s-\S*e/.test(trimmed)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        "Command uses 'fc -e' which can execute arbitrary commands via editor",
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No Zsh dangerous commands',
  }
}
