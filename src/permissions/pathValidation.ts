import { homedir } from 'os'
import { resolve } from 'path'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import {
  getFsImplementation,
  safeResolvePath,
} from 'src/shared/fs/fsOperations.js'
import { containsPathTraversal } from 'src/shared/fs/path.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import { containsVulnerableUncPath } from 'src/platform/shell/readOnlyCommandValidation.js'
import {
  checkEditableInternalPath,
  checkPathSafetyForAutoEdit,
  checkReadableInternalPath,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
  pathInWorkingPath,
} from 'src/permissions/filePermissions.js'
import {
  formsOf,
  settledFormsOf,
  type PathForms,
} from 'src/permissions/filePermissions/pathForms.js'
import type { PermissionDecisionReason } from 'src/permissions/PermissionResult.js'

export type FileOperationType = 'read' | 'write' | 'create'

export type PathCheckResult = {
  allowed: boolean
  decisionReason?: PermissionDecisionReason
}

export type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}

// ─── Small helpers the callers share ────────────────────────────────────────

const LISTED_DIRECTORY_LIMIT = 5

export function formatDirectoryList(directories: string[]): string {
  const listed = directories
    .slice(0, LISTED_DIRECTORY_LIMIT)
    .map(directory => `'${directory}'`)
    .join(', ')
  const unlisted = directories.length - LISTED_DIRECTORY_LIMIT
  return unlisted > 0 ? `${listed}, and ${unlisted} more` : listed
}

const GLOB_CHARACTERS: ReadonlySet<string> = new Set(['*', '?', '[', ']', '{', '}'])

function firstGlobIndex(path: string): number {
  for (let index = 0; index < path.length; index++) {
    if (GLOB_CHARACTERS.has(path.charAt(index))) return index
  }
  return -1
}

function hasGlob(path: string): boolean {
  return firstGlobIndex(path) !== -1
}

function isSeparator(character: string): boolean {
  return character === '/' || (character === '\\' && getPlatform() === 'windows')
}

/** The literal directory a glob expands in. */
export function getGlobBaseDirectory(path: string): string {
  const globAt = firstGlobIndex(path)
  if (globAt === -1) return path
  let cut = globAt - 1
  while (cut >= 0 && !isSeparator(path.charAt(cut))) cut--
  if (cut === -1) return '.'
  if (cut === 0) return '/'
  return path.slice(0, cut)
}

/** Only the forms every shell agrees on: `~` and `~/`. */
export function expandTilde(path: string): string {
  if (path === '~') return homedir()
  const homeRelative =
    path.startsWith('~/') ||
    (process.platform === 'win32' && path.startsWith('~\\'))
  return homeRelative ? homedir() + path.slice(1) : path
}

// ─── rm / Remove-Item guard ─────────────────────────────────────────────────

function collapseSeparators(path: string): string {
  return path.replace(/[\\/]+/g, '/')
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** A target whose removal wipes a root, a home or a top-level directory. */
export function isDangerousRemovalPath(resolvedPath: string): boolean {
  const path = collapseSeparators(resolvedPath)
  if (path === '*' || path.endsWith('/*')) return true

  const target = withoutTrailingSlash(path)
  const home = withoutTrailingSlash(collapseSeparators(homedir()))
  if (target === '/' || target === home) return true

  const topLevel = /^\/[^/]+$/
  const driveRoot = /^[a-z]:$/i
  const driveTopLevel = /^[a-z]:\/[^/]+$/i
  return [topLevel, driveRoot, driveTopLevel].some(shape => shape.test(target))
}

// ─── OS sandbox write allowlist ─────────────────────────────────────────────

/** The part of the sandbox's write config this check reads. */
type SandboxWriteLists = {
  readonly allowOnly: readonly string[]
  readonly denyWithinAllow: readonly string[]
}

function sandboxAllowsWrite(forms: PathForms): boolean {
  if (forms.length === 0) return false
  const config: SandboxWriteLists = SandboxManager.getFsWriteConfig()
  const allowed = config.allowOnly.flatMap(settledFormsOf)
  const denied = config.denyWithinAllow.flatMap(settledFormsOf)
  return forms.every(
    form =>
      allowed.some(entry => pathInWorkingPath(form, entry)) &&
      !denied.some(entry => pathInWorkingPath(form, entry)),
  )
}

export function isPathInSandboxWriteAllowlist(resolvedPath: string): boolean {
  if (!SandboxManager.isSandboxingEnabled()) return false
  return sandboxAllowsWrite(formsOf(resolvedPath))
}

// ─── The decision ───────────────────────────────────────────────────────────

type AccessRequest = {
  readonly path: string
  readonly context: ToolPermissionContext
  readonly writes: boolean
  readonly ruleTool: 'read' | 'edit'
  /** The caller's forms, which replace resolving `path`. */
  readonly forms: readonly string[] | undefined
  readonly insideWorkingDirectory: () => boolean
}

/** A verdict, or undefined for "no opinion: ask the next check". */
type DecisionStep = (request: AccessRequest) => PathCheckResult | undefined

const SANDBOX_ALLOWLIST_REASON =
  'The path is inside the sandbox write allowlist'

const denyRule: DecisionStep = request => {
  const rule = matchingRuleForInput(
    request.path,
    request.context,
    request.ruleTool,
    'deny',
  )
  return rule ? { allowed: false, decisionReason: { type: 'rule', rule } } : undefined
}

const harnessWrite: DecisionStep = request => {
  if (!request.writes) return undefined
  const result = checkEditableInternalPath(request.path, {})
  return result.behavior === 'allow'
    ? { allowed: true, decisionReason: result.decisionReason }
    : undefined
}

const protectedPath: DecisionStep = request => {
  if (!request.writes) return undefined
  const safety = checkPathSafetyForAutoEdit(request.path, request.forms)
  if (safety.safe) return undefined
  return {
    allowed: false,
    decisionReason: {
      type: 'safetyCheck',
      reason: safety.message,
      classifierApprovable: safety.classifierApprovable,
    },
  }
}

const workingDirectory: DecisionStep = request => {
  if (!request.insideWorkingDirectory()) return undefined
  const opened = !request.writes || request.context.mode === 'acceptEdits'
  return opened ? { allowed: true } : undefined
}

const harnessRead: DecisionStep = request => {
  if (request.writes) return undefined
  const result = checkReadableInternalPath(request.path, {})
  return result.behavior === 'allow'
    ? { allowed: true, decisionReason: result.decisionReason }
    : undefined
}

// Inside a working directory the acceptEdits gate decides alone; the
// allowlist only widens what lies outside every working directory.
const sandboxAllowlist: DecisionStep = request => {
  if (!request.writes || request.insideWorkingDirectory()) return undefined
  if (!SandboxManager.isSandboxingEnabled()) return undefined
  const forms = request.forms ?? formsOf(request.path)
  return sandboxAllowsWrite(forms)
    ? { allowed: true, decisionReason: { type: 'other', reason: SANDBOX_ALLOWLIST_REASON } }
    : undefined
}

const allowRule: DecisionStep = request => {
  const rule = matchingRuleForInput(
    request.path,
    request.context,
    request.ruleTool,
    'allow',
  )
  return rule ? { allowed: true, decisionReason: { type: 'rule', rule } } : undefined
}

/** Precedence, first to last. A deny rule outranks every opening. */
const DECISION_STEPS: readonly DecisionStep[] = [
  denyRule,
  harnessWrite,
  protectedPath,
  workingDirectory,
  harnessRead,
  sandboxAllowlist,
  allowRule,
]

function once<T>(compute: () => T): () => T {
  let settled: { value: T } | undefined
  return () => {
    settled ??= { value: compute() }
    return settled.value
  }
}

export function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  const writes = operationType !== 'read'
  const request: AccessRequest = {
    path: resolvedPath,
    context,
    writes,
    ruleTool: writes ? 'edit' : 'read',
    forms: precomputedPathsToCheck,
    insideWorkingDirectory: once(() =>
      pathInAllowedWorkingPath(resolvedPath, context, precomputedPathsToCheck),
    ),
  }
  for (const step of DECISION_STEPS) {
    const verdict = step(request)
    if (verdict !== undefined) return verdict
  }
  return { allowed: false }
}

// ─── Parsing a shell path ───────────────────────────────────────────────────

function isNetworkShaped(path: string): boolean {
  return path.startsWith('//') || path.startsWith('\\\\')
}

/**
 * Anchors `path` at `cwd` and follows its symlinks when it exists, then
 * judges it. A canonical path is its own only form. A network-shaped path is
 * left as written, so resolving it can never reach the network.
 */
function judgeOnDisk(
  path: string,
  cwd: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  const anchored = isNetworkShaped(path) ? path : resolve(cwd, path)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    anchored,
  )
  const verdict = isPathAllowed(
    resolvedPath,
    context,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return { ...verdict, resolvedPath }
}

export function validateGlobPattern(
  cleanPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // A `..` can carry the expansion anywhere, so the base directory proves
  // nothing: judge the whole pattern where it lands.
  const judged = containsPathTraversal(cleanPath)
    ? cleanPath
    : getGlobBaseDirectory(cleanPath)
  return judgeOnDisk(judged, cwd, toolPermissionContext, operationType)
}

type HumanApprovalRule = {
  readonly applies: (cleanPath: string, operationType: FileOperationType) => boolean
  readonly reason: string
}

/** Paths the validator will not interpret; the first that applies wins. */
const NEEDS_A_HUMAN: readonly HumanApprovalRule[] = [
  {
    applies: path => containsVulnerableUncPath(path),
    reason: 'UNC network paths need manual approval',
  },
  {
    // `~user`, `~+`, `~-` and `~N` expand differently per shell.
    applies: path => path.startsWith('~'),
    reason: 'Tilde expansion variants (~user, ~+, ~-, ~N) in a path need manual approval',
  },
  {
    applies: path =>
      path.includes('$') || path.includes('%') || path.startsWith('='),
    reason:
      'Shell expansion syntax ($VAR, %VAR%, =cmd) in a path needs manual approval',
  },
  {
    applies: (path, operationType) => operationType !== 'read' && hasGlob(path),
    reason:
      'Writes cannot target a glob pattern; name an exact file path instead',
  },
]

function stripOneQuotePerEnd(path: string): string {
  const head = path.startsWith('"') || path.startsWith("'") ? 1 : 0
  const rest = path.slice(head)
  const tail = rest.endsWith('"') || rest.endsWith("'") ? 1 : 0
  return rest.slice(0, rest.length - tail)
}

export function validatePath(
  path: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  const cleanPath = expandTilde(stripOneQuotePerEnd(path))

  const refusal = NEEDS_A_HUMAN.find(rule => rule.applies(cleanPath, operationType))
  if (refusal !== undefined) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: { type: 'other', reason: refusal.reason },
    }
  }

  if (hasGlob(cleanPath)) {
    return validateGlobPattern(cleanPath, cwd, toolPermissionContext, operationType)
  }
  return judgeOnDisk(cleanPath, cwd, toolPermissionContext, operationType)
}
