import ignore from 'ignore'
import { homedir } from 'os'
import { posix } from 'path'
import type { PermissionRule, PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import { getRuleByContentsForToolName } from 'src/permissions/permissions.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getSettingsRootPathForSource } from 'src/platform/settings/settings.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { expandPath, relativePath } from 'src/shared/fs/path.js'
import { windowsPathToPosixPath } from 'src/shared/fs/windowsPaths.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

// Always use / as the path separator per gitignore spec
// https://git-scm.com/docs/gitignore
const DIR_SEP = posix.sep

function rootPathForSource(source: PermissionRuleSource): string {
  switch (source) {
    case 'cliArg':
    case 'command':
    case 'session':
      return expandPath(getOriginalCwd())
    case 'userSettings':
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings':
    case 'flagSettings':
      return getSettingsRootPathForSource(source)
  }
}

function prependDirSep(path: string): string {
  return posix.join(DIR_SEP, path)
}

function normalizePatternToPath({
  patternRoot,
  pattern,
  rootPath,
}: {
  patternRoot: string
  pattern: string
  rootPath: string
}): string | null {
  // If the pattern root + pattern combination starts with our reference root
  const fullPattern = posix.join(patternRoot, pattern)
  if (patternRoot === rootPath) {
    // If the pattern root exactly matches our reference root no need to change
    return prependDirSep(pattern)
  } else if (fullPattern.startsWith(`${rootPath}${DIR_SEP}`)) {
    // Extract the relative part
    const relativePart = fullPattern.slice(rootPath.length)
    return prependDirSep(relativePart)
  } else {
    // Handle patterns that are inside the reference root but not starting with it
    const relativePath = posix.relative(rootPath, patternRoot)
    if (
      !relativePath ||
      relativePath.startsWith(`..${DIR_SEP}`) ||
      relativePath === '..'
    ) {
      // Pattern is outside the reference root, so it can be skipped
      return null
    } else {
      const relativePattern = posix.join(relativePath, pattern)
      return prependDirSep(relativePattern)
    }
  }
}

export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  // null root means the pattern can match anywhere
  const result = new Set(patternsByRoot.get(null) ?? [])

  for (const [patternRoot, patterns] of patternsByRoot.entries()) {
    if (patternRoot === null) {
      // already added
      continue
    }

    // Check each pattern to see if the full path starts with our reference root
    for (const pattern of patterns) {
      const normalizedPattern = normalizePatternToPath({
        patternRoot,
        pattern,
        rootPath: root,
      })
      if (normalizedPattern) {
        result.add(normalizedPattern)
      }
    }
  }
  return Array.from(result)
}

/**
 * Collects all deny rules for file read permissions and returns their ignore patterns
 * Each pattern must be resolved relative to its root (map key)
 * Null keys are used for patterns that don't have a root
 *
 * This is used to hide files that are blocked by Read deny rules.
 *
 * @param toolPermissionContext
 */
export function getFileReadIgnorePatterns(
  toolPermissionContext: ToolPermissionContext,
): Map<string | null, string[]> {
  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    'read',
    'deny',
  )
  const result = new Map<string | null, string[]>()
  for (const [patternRoot, patternMap] of patternsByRoot.entries()) {
    result.set(patternRoot, Array.from(patternMap.keys()))
  }

  return result
}

function patternWithRoot(
  pattern: string,
  source: PermissionRuleSource,
): {
  relativePattern: string
  root: string | null
} {
  if (pattern.startsWith(`${DIR_SEP}${DIR_SEP}`)) {
    // Patterns starting with // resolve relative to /
    const patternWithoutDoubleSlash = pattern.slice(1)

    // On Windows, check if this is a POSIX-style drive path like //c/Users/...
    // Note: UNC paths (//server/share) will not match this regex and will be treated
    // as root-relative patterns, which may need separate handling in the future
    if (
      getPlatform() === 'windows' &&
      patternWithoutDoubleSlash.match(/^\/[a-z]\//i)
    ) {
      // Convert POSIX path to Windows format
      // The pattern is like /c/Users/... so we convert it to C:\Users\...
      const driveLetter = patternWithoutDoubleSlash[1]?.toUpperCase() ?? 'C'
      // Keep the pattern in POSIX format since relativePath returns POSIX paths
      const pathAfterDrive = patternWithoutDoubleSlash.slice(2)

      // Extract the drive root (C:\) and the rest of the pattern
      const driveRoot = `${driveLetter}:\\`
      const relativeFromDrive = pathAfterDrive.startsWith('/')
        ? pathAfterDrive.slice(1)
        : pathAfterDrive

      return {
        relativePattern: relativeFromDrive,
        root: driveRoot,
      }
    }

    return {
      relativePattern: patternWithoutDoubleSlash,
      root: DIR_SEP,
    }
  } else if (pattern.startsWith(`~${DIR_SEP}`)) {
    // Patterns starting with ~/ resolve relative to homedir
    return {
      relativePattern: pattern.slice(1),
      root: homedir().normalize('NFC'),
    }
  } else if (pattern.startsWith(DIR_SEP)) {
    // Patterns starting with / resolve relative to the directory where settings are stored (without .claudin/)
    return {
      relativePattern: pattern,
      root: rootPathForSource(source),
    }
  }
  // No root specified, put it with all the other patterns
  // Normalize patterns that start with "./" to remove the prefix
  // This ensures that patterns like "./.env" match files like ".env"
  let normalizedPattern = pattern
  if (pattern.startsWith(`.${DIR_SEP}`)) {
    normalizedPattern = pattern.slice(2)
  }
  return {
    relativePattern: normalizedPattern,
    root: null,
  }
}

function getPatternsByRoot(
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): Map<string | null, Map<string, PermissionRule>> {
  const toolName = (() => {
    switch (toolType) {
      case 'edit':
        // Apply Edit tool rules to any tool editing files
        return FILE_EDIT_TOOL_NAME
      case 'read':
        // Apply Read tool rules to any tool reading files
        return FILE_READ_TOOL_NAME
    }
  })()

  const rules = getRuleByContentsForToolName(
    toolPermissionContext,
    toolName,
    behavior,
  )
  // Resolve rules relative to path based on source
  const patternsByRoot = new Map<string | null, Map<string, PermissionRule>>()
  for (const [pattern, rule] of rules.entries()) {
    const { relativePattern, root } = patternWithRoot(pattern, rule.source)
    let patternsForRoot = patternsByRoot.get(root)
    if (patternsForRoot === undefined) {
      patternsForRoot = new Map<string, PermissionRule>()
      patternsByRoot.set(root, patternsForRoot)
    }
    // Store the rule keyed by the root
    patternsForRoot.set(relativePattern, rule)
  }
  return patternsByRoot
}

export function matchingRuleForInput(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  let fileAbsolutePath = expandPath(path)

  // On Windows, convert to POSIX format to match against permission patterns
  if (getPlatform() === 'windows' && fileAbsolutePath.includes('\\')) {
    fileAbsolutePath = windowsPathToPosixPath(fileAbsolutePath)
  }

  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    toolType,
    behavior,
  )

  // Check each root for a matching pattern
  for (const [root, patternMap] of patternsByRoot.entries()) {
    // Transform patterns for the ignore library
    const patterns = Array.from(patternMap.keys()).map(pattern => {
      let adjustedPattern = pattern

      // Remove /** suffix - ignore library treats 'path' as matching both
      // the path itself and everything inside it
      if (adjustedPattern.endsWith('/**')) {
        adjustedPattern = adjustedPattern.slice(0, -3)
      }

      return adjustedPattern
    })

    const ig = ignore().add(patterns)

    // Use cross-platform relative path helper for POSIX-style patterns
    const relativePathStr = relativePath(
      root ?? getCwd(),
      fileAbsolutePath ?? getCwd(),
    )

    if (relativePathStr.startsWith(`..${DIR_SEP}`)) {
      // The path is outside the root, so ignore it
      continue
    }

    // Important: ig.test throws if you give it an empty string
    if (!relativePathStr) {
      continue
    }

    const igResult = ig.test(relativePathStr)

    if (igResult.ignored && igResult.rule) {
      // Map the matched pattern back to the original rule
      const originalPattern = igResult.rule.pattern

      // Check if this was a /** pattern we simplified
      const withWildcard = originalPattern + '/**'
      if (patternMap.has(withWildcard)) {
        return patternMap.get(withWildcard) ?? null
      }

      return patternMap.get(originalPattern) ?? null
    }
  }

  // No matching rule found
  return null
}
