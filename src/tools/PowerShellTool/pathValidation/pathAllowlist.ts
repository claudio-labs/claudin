/**
 * Resolving a path and deciding whether it is allowed: tilde expansion, the
 * deny/allow rule lookup, the working-directory allowlist, and the guards for
 * shapes that cannot be statically validated (backtick escapes, provider
 * paths, UNC, shell expansion, globs).
 */

import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import type { PermissionRule } from 'src/shared/types/permissions.js'
import {
  getFsImplementation,
  safeResolvePath,
} from 'src/shared/fs/fsOperations.js'
import { containsPathTraversal } from 'src/shared/fs/path.js'
import {
  checkEditableInternalPath,
  checkPathSafetyForAutoEdit,
  checkReadableInternalPath,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from 'src/permissions/filePermissions.js'
import { isPathInSandboxWriteAllowlist } from 'src/permissions/pathValidation.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import type { FileOperationType } from 'src/tools/PowerShellTool/pathValidation/cmdletPathConfig.js'

// PowerShell wildcards are only * ? [ ] — braces are LITERAL characters
// (no brace expansion). Including {} mis-routed paths like `./{x}/passwd`
// through glob-base truncation instead of full-path symlink resolution.
const GLOB_PATTERN_REGEX = /[*?[\]]/

type PathCheckResult = {
  allowed: boolean
  decisionReason?: import('src/permissions/PermissionResult.js').PermissionDecisionReason
}

type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}

/**
 * Expands tilde (~) at the start of a path to the user's home directory.
 */
export function expandTilde(filePath: string): string {
  if (
    filePath === '~' ||
    filePath.startsWith('~/') ||
    filePath.startsWith('~\\')
  ) {
    return homedir() + filePath.slice(1)
  }
  return filePath
}

/**
 * Checks if a resolved path is allowed for the given operation type.
 * Mirrors the logic in BashTool/pathValidation.ts isPathAllowed.
 */
function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  // 1. Check deny rules first
  const denyRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'deny',
  )
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

  // 2. For write/create operations, check internal editable paths (plan files, scratchpad, agent memory, job dirs)
  // This MUST come before checkPathSafetyForAutoEdit since .claudin is a dangerous directory
  // and internal editable paths live under ~/.claudin/ — matching the ordering in
  // checkWritePermissionForTool (filesystem.ts step 1.5)
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }

  // 2.5. For write/create operations, check safety validations
  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(
      resolvedPath,
      precomputedPathsToCheck,
    )
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safetyCheck.message,
          classifierApprovable: safetyCheck.classifierApprovable,
        },
      }
    }
  }

  // 3. Check if path is in allowed working directory
  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    precomputedPathsToCheck,
  )
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
  }

  // 3.5. For read operations, check internal readable paths
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }

  // 3.7. For write/create operations to paths OUTSIDE the working directory,
  // check the sandbox write allowlist. When the sandbox is enabled, users
  // have explicitly configured writable directories (e.g. /tmp/claude/) —
  // treat these as additional allowed write directories so redirects/Out-File/
  // New-Item don't prompt unnecessarily. Paths IN the working directory are
  // excluded: the sandbox allowlist always seeds '.' (cwd), which would
  // bypass the acceptEdits gate at step 3.
  if (
    operationType !== 'read' &&
    !isInWorkingDir &&
    isPathInSandboxWriteAllowlist(resolvedPath)
  ) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: 'Path is in sandbox write allowlist',
      },
    }
  }

  // 4. Check allow rules
  const allowRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'allow',
  )
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  // 5. Path is not allowed
  return { allowed: false }
}

/**
 * Best-effort deny check for paths obscured by :: or backtick syntax.
 * ONLY checks deny rules — never auto-allows. If the stripped guess
 * doesn't match a deny rule, we fall through to ask as before.
 */
export function checkDenyRuleForGuessedPath(
  strippedPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): { resolvedPath: string; rule: PermissionRule } | null {
  // Red-team P7: null bytes make expandPath throw. Pre-existing but
  // defend here since we're introducing a new call path.
  if (!strippedPath || strippedPath.includes('\0')) return null
  // Red-team P3: `~/.ssh/x strips to ~/.ssh/x but expandTilde only fires
  // on leading ~ — the backtick was in front of it. Re-run here.
  const tildeExpanded = expandTilde(strippedPath)
  const abs = isAbsolute(tildeExpanded)
    ? tildeExpanded
    : resolve(cwd, tildeExpanded)
  const { resolvedPath } = safeResolvePath(getFsImplementation(), abs)
  const permissionType = operationType === 'read' ? 'read' : 'edit'
  const denyRule = matchingRuleForInput(
    resolvedPath,
    toolPermissionContext,
    permissionType,
    'deny',
  )
  return denyRule ? { resolvedPath, rule: denyRule } : null
}

/**
 * Validates a file system path, handling tilde expansion.
 */
export function validatePath(
  filePath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // Remove surrounding quotes if present
  const cleanPath = expandTilde(filePath.replace(/^['"]|['"]$/g, ''))

  // SECURITY: PowerShell Core normalizes backslashes to forward slashes on all
  // platforms, but path.resolve on Linux/Mac treats them as literal characters.
  // Normalize before resolution so traversal patterns like dir\..\..\etc\shadow
  // are correctly detected.
  const normalizedPath = cleanPath.replace(/\\/g, '/')

  // SECURITY: Backtick (`) is PowerShell's escape character. It is a no-op in
  // many positions (e.g., `/ === /) but defeats Node.js path checks like
  // isAbsolute(). Redirection targets use raw .Extent.Text which preserves
  // backtick escapes. Treat any path containing a backtick as unvalidatable.
  if (normalizedPath.includes('`')) {
    // Red-team P3: backtick is already resolved for StringConstant args
    // (parser uses .value); this guard primarily fires for redirection
    // targets which use raw .Extent.Text. Strip is a no-op for most special
    // escapes (`n → n) but that's fine — wrong guess → no deny match →
    // falls to ask.
    const backtickStripped = normalizedPath.replace(/`/g, '')
    const denyHit = checkDenyRuleForGuessedPath(
      backtickStripped,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Backtick escape characters in paths cannot be statically validated and require manual approval',
      },
    }
  }

  // SECURITY: Block module-qualified provider paths. PowerShell allows
  // `Microsoft.PowerShell.Core\FileSystem::/etc/passwd` which resolves to
  // `/etc/passwd` via the FileSystem provider. The `::` is the provider
  // path separator and doesn't match the simple `^[a-z]{2,}:` regex.
  if (normalizedPath.includes('::')) {
    // Strip everything up to and including the first :: — handles both
    // FileSystem::/path and Microsoft.PowerShell.Core\FileSystem::/path.
    // Double-:: (Foo::Bar::/x) strips first only → 'Bar::/x' → resolve
    // makes it {cwd}/Bar::/x → won't match real deny rules → falls to ask.
    // Safe.
    const afterProvider = normalizedPath.slice(normalizedPath.indexOf('::') + 2)
    const denyHit = checkDenyRuleForGuessedPath(
      afterProvider,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Module-qualified provider paths (::) cannot be statically validated and require manual approval',
      },
    }
  }

  // SECURITY: Block UNC paths — they can trigger network requests and
  // leak NTLM/Kerberos credentials
  if (
    normalizedPath.startsWith('//') ||
    /DavWWWRoot/i.test(normalizedPath) ||
    /@SSL@/i.test(normalizedPath)
  ) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'UNC paths are blocked because they can trigger network requests and credential leakage',
      },
    }
  }

  // SECURITY: Reject paths containing shell expansion syntax
  if (normalizedPath.includes('$') || normalizedPath.includes('%')) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: 'Variable expansion syntax in paths requires manual approval',
      },
    }
  }

  // SECURITY: Block non-filesystem provider paths (env:, HKLM:, alias:, function:, etc.)
  // These paths access non-filesystem resources and must require manual approval.
  // This catches colon-syntax like -Path:env:HOME where the extracted value is 'env:HOME'.
  //
  // Platform split (findings #21/#28):
  // - Windows: require 2+ letters before ':' so native drive letters (C:, D:)
  //   pass through to path.win32.isAbsolute/resolve which handle them correctly.
  // - POSIX: ANY <letters>: prefix is a PowerShell PSDrive — single-letter drive
  //   paths have no native meaning on Linux/macOS. `New-PSDrive -Name Z -Root /etc`
  //   then `Get-Content Z:/secrets` would otherwise resolve via
  //   path.posix.resolve(cwd, 'Z:/secrets') → '{cwd}/Z:/secrets' → inside cwd →
  //   allowed, bypassing Read(/etc/**) deny rules. We cannot statically know what
  //   filesystem root a PSDrive maps to, so treat all drive-prefixed paths on
  //   POSIX as unvalidatable.
  // Include digits in PSDrive name (bug #23): `New-PSDrive -Name 1 ...`
  // creates drive `1:` — a valid PSDrive path prefix.
  // Windows regex requires 2+ chars to exclude single-letter native drive letters
  // (C:, D:). Use a single character class [a-z0-9] to catch mixed alphanumeric
  // PSDrive names like `a1:`, `1a:` — the previous alternation `[a-z]{2,}|[0-9]+`
  // missed those since `a1` is neither pure letters nor pure digits.
  const providerPathRegex =
    getPlatform() === 'windows' ? /^[a-z0-9]{2,}:/i : /^[a-z0-9]+:/i
  if (providerPathRegex.test(normalizedPath)) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: `Path '${normalizedPath}' uses a non-filesystem provider and requires manual approval`,
      },
    }
  }

  // SECURITY: Block glob patterns in write/create operations
  if (GLOB_PATTERN_REGEX.test(normalizedPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        resolvedPath: normalizedPath,
        decisionReason: {
          type: 'other',
          reason:
            'Glob patterns are not allowed in write operations. Please specify an exact file path.',
        },
      }
    }

    // For read operations with path traversal (e.g., /project/*/../../../etc/shadow),
    // resolve the full path (including glob chars) and validate that resolved path.
    // This catches patterns that escape the working directory via `..` after the glob.
    if (containsPathTraversal(normalizedPath)) {
      const absolutePath = isAbsolute(normalizedPath)
        ? normalizedPath
        : resolve(cwd, normalizedPath)
      const { resolvedPath, isCanonical } = safeResolvePath(
        getFsImplementation(),
        absolutePath,
      )
      const result = isPathAllowed(
        resolvedPath,
        toolPermissionContext,
        operationType,
        isCanonical ? [resolvedPath] : undefined,
      )
      return {
        allowed: result.allowed,
        resolvedPath,
        decisionReason: result.decisionReason,
      }
    }

    // SECURITY (finding #15): Glob patterns for read operations cannot be
    // statically validated. getGlobBaseDirectory returns the directory before
    // the first glob char; only that base is realpathed. Anything matched by
    // the glob (including symlinks) is never examined. Example:
    //   /project/*/passwd with symlink /project/link → /etc
    // Base dir is /project (allowed), but runtime expands * to 'link' and
    // reads /etc/passwd. We cannot validate symlinks inside glob expansion
    // without actually expanding the glob (requires filesystem access and
    // still races with attacker creating symlinks post-validation).
    //
    // Still check deny rules on the base directory so explicit Read(/project/**)
    // deny rules fire. If no deny matches, force ask.
    const basePath = getGlobBaseDirectory(normalizedPath)
    const absoluteBasePath = isAbsolute(basePath)
      ? basePath
      : resolve(cwd, basePath)
    const { resolvedPath } = safeResolvePath(
      getFsImplementation(),
      absoluteBasePath,
    )
    const permissionType = operationType === 'read' ? 'read' : 'edit'
    const denyRule = matchingRuleForInput(
      resolvedPath,
      toolPermissionContext,
      permissionType,
      'deny',
    )
    if (denyRule !== null) {
      return {
        allowed: false,
        resolvedPath,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }
    return {
      allowed: false,
      resolvedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Glob patterns in paths cannot be statically validated — symlinks inside the glob expansion are not examined. Requires manual approval.',
      },
    }
  }

  // Resolve path
  const absolutePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(cwd, normalizedPath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absolutePath,
  )

  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

function getGlobBaseDirectory(filePath: string): string {
  const globMatch = filePath.match(GLOB_PATTERN_REGEX)
  if (!globMatch || globMatch.index === undefined) {
    return filePath
  }
  const beforeGlob = filePath.substring(0, globMatch.index)
  const lastSepIndex = Math.max(
    beforeGlob.lastIndexOf('/'),
    beforeGlob.lastIndexOf('\\'),
  )
  if (lastSepIndex === -1) return '.'
  return beforeGlob.substring(0, lastSepIndex + 1) || '/'
}
