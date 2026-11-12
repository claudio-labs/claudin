import { basename, sep } from 'path'
import picomatch from 'picomatch'
import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import type { PermissionDecisionReason } from 'src/permissions/PermissionResult.js'
import { normalizeCaseForComparison } from 'src/permissions/filePermissions/pathCase.js'
import { isClaudeConfigFilePath } from 'src/permissions/filePermissions/internalPaths.js'
import { matchingRuleForInput } from 'src/permissions/filePermissions/rulePatterns.js'
import { permissionRuleValueFromString } from 'src/permissions/permissionRuleParser.js'
import { containsVulnerableUncPath } from 'src/platform/shell/readOnlyCommandValidation.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isENOENT } from 'src/shared/errors.js'
import { getFsImplementation, getPathsForPermissionCheck } from 'src/shared/fs/fsOperations.js'
import { expandPath } from 'src/shared/fs/path.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

/**
 * Dangerous files that should be protected from auto-editing.
 * These files can be used for code execution or data exfiltration.
 */
const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
] as const

/**
 * Dangerous directories that should be protected from auto-editing.
 * These directories contain sensitive configuration or executable files.
 */
const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  '.claudin',
] as const

// Dotenv-shaped names that hold no secrets: templates, and code named after
// its env (`.env.ts`, `.env.d.ts`).
const ENV_NOT_SECRET_SUFFIXES = [
  '.example',
  '.sample',
  '.template',
  '.dist',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const
// Names a glob has to reach for a read to land on a dotenv file.
const ENV_FILE_SAMPLES = ['.env', '.env.local', 'prod.env'] as const
const WILDCARDS_ONLY_RE = /^[*?]+$/

function isEnvFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (ENV_NOT_SECRET_SUFFIXES.some(suffix => lower.endsWith(suffix))) return false
  return lower.startsWith('.env.') || lower.endsWith('.env')
}

function isDirectory(path: string): boolean {
  try {
    return getFsImplementation().statSync(path).isDirectory()
  } catch (e) {
    if (!isENOENT(e)) logForDebugging(`env-file check: cannot stat ${path}: ${e}`)
    return false
  }
}

/**
 * Whether a path is a dotenv file — `.env`, `.env.<stage>` or `<name>.env`,
 * and not a directory (a Python virtualenv named `.env`) — which usually holds
 * secrets that a read would send to the provider. A path that does not exist
 * yet still counts.
 */
export function isSensitiveEnvFile(path: string): boolean {
  return isEnvFileName(basename(path)) && !isDirectory(path)
}

/**
 * Whether a glob's last segment could expand to a dotenv file: `.env*`,
 * `*.env`, `.en?`. A segment of wildcards alone (`*`) names no file, so
 * `ls *` does not count. `dot` follows the caller's matcher: bash leaves a
 * leading dot to the pattern, ripgrep's globs match it.
 */
export function globCouldMatchEnvFile(pattern: string, options: { dot: boolean }): boolean {
  const segment = pattern.slice(pattern.lastIndexOf('/') + 1)
  if (segment === '' || WILDCARDS_ONLY_RE.test(segment)) return false
  const matches = picomatch(segment, { dot: options.dot })
  return ENV_FILE_SAMPLES.some(name => matches(name))
}

// A rule names a .env when its LAST path segment does: `Read(./.env)`,
// `Read(**/.env.*)`. ".env" earlier in the pattern is a directory that only
// contains the letters (`Read(~/.envs/**)`).
function ruleNamesEnvFile(rule: string): boolean {
  const content = permissionRuleValueFromString(rule).ruleContent
  if (!content) return false
  const segment = content.slice(content.lastIndexOf('/') + 1)
  return isEnvFileName(segment) || globCouldMatchEnvFile(segment, { dot: true })
}

/**
 * What every read gate (the Read tool, the Bash and PowerShell path checks)
 * answers for a dotenv file: a safety check no mode and no classifier may
 * approve, so the user is asked even in bypass and auto mode.
 */
export function sensitiveEnvFileReason(
  path: string,
): Extract<PermissionDecisionReason, { type: 'safetyCheck' }> {
  return {
    type: 'safetyCheck',
    reason: `${path} is a .env file, which usually holds secrets; reading it needs your approval.`,
    classifierApprovable: false,
  }
}

/**
 * The read allow rule that lets a dotenv file be read without asking: one
 * whose pattern names a .env. A broad rule — `Read(**)`, `Read(//tmp/**)` —
 * was written for other files and does not count, the way an Edit allow rule
 * does not reach past the dangerous-file check.
 */
export function envFileReadAllowRule(
  path: string,
  context: ToolPermissionContext,
): PermissionRule | null {
  const envRulesOnly = Object.fromEntries(
    Object.entries(context.alwaysAllowRules).map(([source, rules]) => [
      source,
      (rules ?? []).filter(ruleNamesEnvFile),
    ]),
  ) as ToolPermissionContext['alwaysAllowRules']
  return matchingRuleForInput(
    path,
    { ...context, alwaysAllowRules: envRulesOnly },
    'read',
    'allow',
  )
}

/**
 * The ask every read gate returns before a dotenv file, or null when `path` is
 * not one or an allow rule naming it opts it out. `paths` are `path` and the
 * forms it resolves to (symlinks).
 */
export function sensitiveEnvFileAsk(
  paths: readonly string[],
  path: string,
  context: ToolPermissionContext,
): Extract<PermissionDecisionReason, { type: 'safetyCheck' }> | null {
  if (!paths.some(isSensitiveEnvFile) || envFileReadAllowRule(path, context)) return null
  return sensitiveEnvFileReason(path)
}

/**
 * Check if a file path is dangerous to auto-edit without explicit permission.
 * This includes:
 * - Files in .git directories or .gitconfig files (to prevent git-based data exfiltration and code execution)
 * - Files in .vscode directories (to prevent VS Code settings manipulation and potential code execution)
 * - Files in .idea directories (to prevent JetBrains IDE settings manipulation)
 * - Shell configuration files (to prevent shell startup script manipulation)
 * - UNC paths (to prevent network file access and WebDAV attacks)
 */
function isDangerousFilePathToAutoEdit(path: string): boolean {
  const absolutePath = expandPath(path)
  const pathSegments = absolutePath.split(sep)
  const fileName = pathSegments.at(-1)

  // Check for UNC paths (defense-in-depth to catch any patterns that might not be caught by containsVulnerableUncPath)
  // Block anything starting with \\ or // as these are potentially UNC paths that could access network resources
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return true
  }

  // Check if path is within dangerous directories (case-insensitive to prevent bypasses)
  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i]!
    const normalizedSegment = normalizeCaseForComparison(segment)

    for (const dir of DANGEROUS_DIRECTORIES) {
      if (normalizedSegment !== normalizeCaseForComparison(dir)) {
        continue
      }

      // Special case: .claudin/worktrees/ is a structural path (where Claudin stores
      // git worktrees), not a user-created dangerous directory. Skip the .claudin
      // segment when it's followed by 'worktrees'. Any nested .claudin directories
      // within the worktree (not followed by 'worktrees') are still blocked.
      if (dir === '.claudin') {
        const nextSegment = pathSegments[i + 1]
        if (
          nextSegment &&
          normalizeCaseForComparison(nextSegment) === 'worktrees'
        ) {
          break // Skip this .claudin, continue checking other segments
        }
      }

      return true
    }
  }

  // Check for dangerous configuration files (case-insensitive)
  if (fileName) {
    const normalizedFileName = normalizeCaseForComparison(fileName)
    if (
      (DANGEROUS_FILES as readonly string[]).some(
        dangerousFile =>
          normalizeCaseForComparison(dangerousFile) === normalizedFileName,
      )
    ) {
      return true
    }
  }

  return false
}

/**
 * Detects suspicious Windows path patterns that could bypass security checks.
 * These patterns include:
 * - NTFS Alternate Data Streams (e.g., file.txt::$DATA or file.txt:stream)
 * - 8.3 short names (e.g., GIT~1, CLAUDE~1, SETTIN~1.JSON)
 * - Long path prefixes (e.g., \\?\C:\..., \\.\C:\..., //?/C:/..., //./C:/...)
 * - Trailing dots and spaces (e.g., .git., .claudin , .bashrc...)
 * - DOS device names (e.g., .git.CON, settings.json.PRN, .bashrc.AUX)
 * - Three or more consecutive dots (e.g., .../file.txt, path/.../file, file...txt)
 *
 * When detected, these paths should always require manual approval to prevent
 * bypassing security checks through path canonicalization vulnerabilities.
 *
 * ## Why Check on All Platforms?
 *
 * While these patterns are primarily Windows-specific, NTFS filesystems can be
 * mounted on Linux and macOS (e.g., using ntfs-3g). On these systems, the same
 * bypass techniques would work - an attacker could use short names or long path
 * prefixes to bypass security checks. Therefore, we check for these patterns on
 * all platforms to ensure comprehensive protection. (Note: the ADS colon check
 * is Windows/WSL-only, since colon syntax is only interpreted by the Windows
 * kernel; on Linux/macOS, NTFS ADS is accessed via xattrs, not colon syntax.)
 *
 * ## Why Detection Instead of Normalization?
 *
 * An alternative approach would be to normalize these paths using Windows APIs
 * (e.g., GetLongPathNameW). However, this approach has significant challenges:
 *
 * 1. **Filesystem dependency**: Short path normalization is relative to files that
 *    currently exist on the filesystem. This creates issues when writing to new
 *    files since they don't exist yet and cannot be normalized.
 *
 * 2. **Race conditions**: The filesystem state can change between normalization
 *    and actual file access, creating TOCTOU (Time-Of-Check-Time-Of-Use) vulnerabilities.
 *
 * 3. **Complexity**: Proper normalization requires Windows-specific APIs, handling
 *    multiple edge cases, and dealing with various path formats (UNC, device paths, etc.).
 *
 * 4. **Reliability**: Pattern detection is more predictable and doesn't depend on
 *    external system state.
 *
 * If you are considering adding normalization for these paths, please reach out to
 * AppSec first to discuss the security implications and implementation approach.
 *
 * @param path The path to check for suspicious patterns
 * @returns true if suspicious Windows path patterns are detected
 */
export function hasSuspiciousWindowsPathPattern(path: string): boolean {
  // Check for NTFS Alternate Data Streams
  // Look for ':' after position 2 to skip drive letters (e.g., C:\)
  // Examples: file.txt::$DATA, .bashrc:hidden, settings.json:stream
  // Note: ADS colon syntax is only interpreted by the Windows kernel. On WSL,
  // DrvFs mounts route file operations through the Windows kernel, so colon
  // syntax is still interpreted as ADS separators. On Linux/macOS (non-WSL),
  // even when NTFS is mounted, ADS is accessed via xattrs (ntfs-3g) not colon
  // syntax, and colons are valid filename characters.
  if (getPlatform() === 'windows' || getPlatform() === 'wsl') {
    const colonIndex = path.indexOf(':', 2)
    if (colonIndex !== -1) {
      return true
    }
  }

  // Check for 8.3 short names
  // Look for '~' followed by a digit
  // Examples: GIT~1, CLAUDE~1, SETTIN~1.JSON, BASHRC~1
  if (/~\d/.test(path)) {
    return true
  }

  // Check for long path prefixes (both backslash and forward slash variants)
  // Examples: \\?\C:\Users\..., \\.\C:\..., //?/C:/..., //./C:/...
  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('//?/') ||
    path.startsWith('//./')
  ) {
    return true
  }

  // Check for trailing dots and spaces that Windows strips during path resolution
  // Examples: .git., .claudin , .bashrc..., settings.json.
  // This can bypass string matching if ".git" is blocked but ".git." is used
  if (/[.\s]+$/.test(path)) {
    return true
  }

  // Check for DOS device names that Windows treats as special devices
  // Examples: .git.CON, settings.json.PRN, .bashrc.AUX
  // Device names: CON, PRN, AUX, NUL, COM1-9, LPT1-9
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) {
    return true
  }

  // Check for three or more consecutive dots (...) when used as a path component
  // This pattern can be used to bypass security checks or create confusion
  // Examples: .../file.txt, path/.../file
  // Only block when dots are preceded AND followed by path separators (/ or \)
  // This allows legitimate uses like Next.js catch-all routes [...]name]
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) {
    return true
  }

  // Check for UNC paths (on all platforms for defense-in-depth)
  // Examples: \\server\share, \\foo.com\file, //server/share, \\192.168.1.1\share
  // UNC paths can access remote resources, leak credentials, and bypass working directory restrictions
  if (containsVulnerableUncPath(path)) {
    return true
  }

  return false
}

/**
 * Checks if a path is safe for auto-editing (acceptEdits mode).
 * Returns information about why the path is unsafe, or null if all checks pass.
 *
 * This function performs comprehensive safety checks including:
 * - Suspicious Windows path patterns (NTFS streams, 8.3 names, long path prefixes, etc.)
 * - Claudin config files (.claudin/settings.json, .claudin/commands/, .claudin/agents/)
 * - MCP CLI state files (managed internally by Claudin)
 * - Dangerous files (.bashrc, .gitconfig, .git/, .vscode/, .idea/, etc.)
 *
 * IMPORTANT: This function checks BOTH the original path AND resolved symlink paths
 * to prevent bypasses via symlinks pointing to protected files.
 *
 * @param path The path to check for safety
 * @returns Object with safe=false and message if unsafe, or { safe: true } if all checks pass
 */
export function checkPathSafetyForAutoEdit(
  path: string,
  precomputedPathsToCheck?: readonly string[],
):
  | { safe: true }
  | { safe: false; message: string; classifierApprovable: boolean } {
  // Get all paths to check (original + symlink resolved paths)
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // Check for suspicious Windows path patterns on all paths
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to write to ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        classifierApprovable: false,
      }
    }
  }

  // Check for Claude config files on all paths
  for (const pathToCheck of pathsToCheck) {
    if (isClaudeConfigFilePath(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
        classifierApprovable: true,
      }
    }
  }

  // Check for dangerous files on all paths
  for (const pathToCheck of pathsToCheck) {
    if (isDangerousFilePathToAutoEdit(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to edit ${path} which is a sensitive file.`,
        classifierApprovable: true,
      }
    }
  }

  // All safety checks passed
  return { safe: true }
}
