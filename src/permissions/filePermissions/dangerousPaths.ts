import { normalizeCaseForComparison } from 'src/permissions/filePermissions/pathCase.js'
import { isClaudeConfigFilePath } from 'src/permissions/filePermissions/internalPaths.js'
import { formsOf } from 'src/permissions/filePermissions/pathForms.js'
import { containsVulnerableUncPath } from 'src/platform/shell/readOnlyCommandValidation.js'
import { getPlatform, type Platform } from 'src/shared/proc/platform.js'

/** Directories whose contents configure a tool that runs code. Folded. */
const PROTECTED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.claudin',
  '.claude',
  '.git',
  '.idea',
  '.vscode',
])

/** File names that are sourced or executed by a shell, git or an agent. Folded. */
const PROTECTED_FILE_NAMES: ReadonlySet<string> = new Set([
  '.bash_profile',
  '.bashrc',
  '.profile',
  '.zprofile',
  '.zshrc',
  '.gitconfig',
  '.gitmodules',
  '.ripgreprc',
  '.claude.json',
  '.mcp.json',
])

/** Agent worktrees live under `.claudin/worktrees/` and are ordinary checkouts. */
const WORKTREES_DIRECTORY = 'worktrees'
const AGENT_DIRECTORY = '.claudin'

type PlatformScope = 'everywhere' | 'windowsAndWsl' | 'windowsOnly'

type WindowsPathPattern = {
  readonly name: string
  readonly scope: PlatformScope
  readonly matches: (path: string) => boolean
}

const DEVICE_PREFIXES = ['\\\\?\\', '\\\\.\\', '//?/', '//./'] as const

/**
 * Spellings that Windows resolves differently from what a string comparison
 * sees, so a protected file could be reached under another name.
 */
const WINDOWS_PATH_PATTERNS: readonly WindowsPathPattern[] = [
  {
    name: 'alternate data stream',
    scope: 'windowsAndWsl',
    matches: path => path.indexOf(':', 2) !== -1,
  },
  {
    name: '8.3 short name',
    scope: 'everywhere',
    matches: path => /~\d/.test(path),
  },
  {
    name: 'long-path or device prefix',
    scope: 'everywhere',
    matches: path => DEVICE_PREFIXES.some(prefix => path.startsWith(prefix)),
  },
  {
    name: 'trailing dot or whitespace',
    scope: 'everywhere',
    matches: path => /[.\s]$/.test(path),
  },
  {
    name: 'DOS device suffix',
    scope: 'everywhere',
    matches: path => /\.(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(path),
  },
  {
    name: 'component of three or more dots',
    scope: 'everywhere',
    matches: path => splitComponents(path).some(part => /^\.{3,}$/.test(part)),
  },
  {
    name: 'UNC path',
    scope: 'windowsOnly',
    matches: path => containsVulnerableUncPath(path),
  },
]

function scopeIncludes(scope: PlatformScope, platform: Platform): boolean {
  switch (scope) {
    case 'everywhere':
      return true
    case 'windowsAndWsl':
      return platform === 'windows' || platform === 'wsl'
    case 'windowsOnly':
      return platform === 'windows'
  }
}

function splitComponents(path: string): string[] {
  return path.split(/[\\/]/)
}

export function hasSuspiciousWindowsPathPattern(path: string): boolean {
  const platform = getPlatform()
  return WINDOWS_PATH_PATTERNS.some(
    pattern => scopeIncludes(pattern.scope, platform) && pattern.matches(path),
  )
}

/**
 * A protected directory anywhere in the path, a protected file name at its
 * end, or a network path. The one directory exemption is `.claudin` directly
 * above `worktrees`; every later component is still checked.
 */
function isSensitivePath(path: string): boolean {
  if (path.startsWith('\\\\') || path.startsWith('//')) return true

  const parts = splitComponents(path).map(normalizeCaseForComparison)
  const leaf = parts[parts.length - 1] ?? ''
  if (PROTECTED_FILE_NAMES.has(leaf)) return true

  return parts.some(
    (part, index) =>
      PROTECTED_DIRECTORIES.has(part) &&
      !(part === AGENT_DIRECTORY && parts[index + 1] === WORKTREES_DIRECTORY),
  )
}

type RefusalKind = 'windowsPattern' | 'config' | 'sensitive'

type AutoEditRefusal = {
  readonly kind: RefusalKind
  readonly classifierApprovable: boolean
  readonly appliesTo: (form: string) => boolean
  readonly explain: (path: string) => string
}

/** In precedence order: the first kind any form matches is the answer. */
const AUTO_EDIT_REFUSALS: readonly AutoEditRefusal[] = [
  {
    kind: 'windowsPattern',
    classifierApprovable: false,
    appliesTo: form => hasSuspiciousWindowsPathPattern(form),
    explain: path =>
      `Claudin wants to write to ${path}, a path with a suspicious Windows path pattern. That needs manual approval.`,
  },
  {
    kind: 'config',
    classifierApprovable: true,
    appliesTo: form => isClaudeConfigFilePath(form),
    explain: path =>
      `Claudin wants to write to ${path}, and you haven't granted it permission for this file yet.`,
  },
  {
    kind: 'sensitive',
    classifierApprovable: true,
    appliesTo: form => isSensitivePath(form),
    explain: path =>
      `Claudin wants to edit ${path}, which is a sensitive file.`,
  },
]

export function checkPathSafetyForAutoEdit(
  path: string,
  precomputedPathsToCheck?: readonly string[],
):
  | { safe: true }
  | { safe: false; message: string; classifierApprovable: boolean } {
  const forms = precomputedPathsToCheck ?? formsOf(path)
  const refusal = AUTO_EDIT_REFUSALS.find(candidate =>
    forms.some(candidate.appliesTo),
  )
  if (refusal === undefined) return { safe: true }
  return {
    safe: false,
    message: refusal.explain(path),
    classifierApprovable: refusal.classifierApprovable,
  }
}
