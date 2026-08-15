import { createHash, randomUUID, type UUID } from 'crypto'
import { stat } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import { getOriginalCwd, getSessionId } from 'src/bootstrap/state.js'
import type {
  AttributionSnapshotMessage,
  FileAttributionState,
} from 'src/types/logs.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logForDebugging } from 'src/shared/debug.js'
import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { isGeneratedFile } from 'src/shared/fs/generatedFiles.js'
import { getRemoteUrlForDir, resolveGitDir } from 'src/services/git/gitFilesystem.js'
import { findGitRoot, gitExe } from 'src/services/git/git.js'
import { logError } from 'src/shared/log.js'
import { getCanonicalName, type ModelName } from 'src/utils/model/model.js'
import { sequential } from 'src/shared/sequential.js'

/**
 * List of repos where internal model names are allowed in trailers.
 * Includes both SSH and HTTPS URL formats.
 *
 * NOTE: This is intentionally a repo allowlist, not an org-wide check.
 * The anthropics and anthropic-experimental orgs contain PUBLIC repos
 * (e.g. anthropics/claude-code, anthropic-experimental/sandbox-runtime).
 * Undercover mode must stay ON in those to prevent codename leaks.
 * Only add repos here that are confirmed PRIVATE.
 */
const INTERNAL_MODEL_REPOS = [
  'github.com:anthropics/claude-cli-internal',
  'github.com/anthropics/claude-cli-internal',
  'github.com:anthropics/anthropic',
  'github.com/anthropics/anthropic',
  'github.com:anthropics/apps',
  'github.com/anthropics/apps',
  'github.com:anthropics/casino',
  'github.com/anthropics/casino',
  'github.com:anthropics/dbt',
  'github.com/anthropics/dbt',
  'github.com:anthropics/dotfiles',
  'github.com/anthropics/dotfiles',
  'github.com:anthropics/terraform-config',
  'github.com/anthropics/terraform-config',
  'github.com:anthropics/hex-export',
  'github.com/anthropics/hex-export',
  'github.com:anthropics/feedback-v2',
  'github.com/anthropics/feedback-v2',
  'github.com:anthropics/labs',
  'github.com/anthropics/labs',
  'github.com:anthropics/argo-rollouts',
  'github.com/anthropics/argo-rollouts',
  'github.com:anthropics/starling-configs',
  'github.com/anthropics/starling-configs',
  'github.com:anthropics/ts-tools',
  'github.com/anthropics/ts-tools',
  'github.com:anthropics/ts-capsules',
  'github.com/anthropics/ts-capsules',
  'github.com:anthropics/feldspar-testing',
  'github.com/anthropics/feldspar-testing',
  'github.com:anthropics/trellis',
  'github.com/anthropics/trellis',
  'github.com:anthropics/claude-for-hiring',
  'github.com/anthropics/claude-for-hiring',
  'github.com:anthropics/forge-web',
  'github.com/anthropics/forge-web',
  'github.com:anthropics/infra-manifests',
  'github.com/anthropics/infra-manifests',
  'github.com:anthropics/mycro_manifests',
  'github.com/anthropics/mycro_manifests',
  'github.com:anthropics/mycro_configs',
  'github.com/anthropics/mycro_configs',
  'github.com:anthropics/mobile-apps',
  'github.com/anthropics/mobile-apps',
]

/**
 * Get the repo root for attribution operations.
 * Uses getCwd() which respects agent worktree overrides (AsyncLocalStorage),
 * then resolves to git root to handle `cd subdir` case.
 * Falls back to getOriginalCwd() if git root can't be determined.
 */
export function getAttributionRepoRoot(): string {
  const cwd = getCwd()
  return findGitRoot(cwd) ?? getOriginalCwd()
}

// Cache for repo classification result. Primed once per process.
// 'internal' = remote matches INTERNAL_MODEL_REPOS allowlist
// 'external' = has a remote, not on allowlist (public/open-source repo)
// 'none'     = no remote URL (not a git repo, or no remote configured)
let repoClassCache: 'internal' | 'external' | 'none' | null = null


/**
 * Check if the current repo is in the allowlist for internal model names.
 * Memoized - only checks once per process.
 */
export const isInternalModelRepo = sequential(async (): Promise<boolean> => {
  if (repoClassCache !== null) {
    return repoClassCache === 'internal'
  }

  const cwd = getAttributionRepoRoot()
  const remoteUrl = await getRemoteUrlForDir(cwd)

  if (!remoteUrl) {
    repoClassCache = 'none'
    return false
  }
  const isInternal = INTERNAL_MODEL_REPOS.some(repo => remoteUrl.includes(repo))
  repoClassCache = isInternal ? 'internal' : 'external'
  return isInternal
})


// @[MODEL LAUNCH]: Add a mapping for the new model ID so git commit trailers show the public name.
/**
 * Sanitize a model name to its public equivalent.
 * Maps internal variants to their public names based on model family.
 */
export function sanitizeModelName(shortName: string): string {
  // Map internal variants to public equivalents based on model family
  if (shortName.includes('fable-5')) return 'claude-fable-5'
  if (shortName.includes('opus-5')) return 'claude-opus-5'
  if (shortName.includes('opus-4-8')) return 'claude-opus-4-8'
  if (shortName.includes('opus-4-7')) return 'claude-opus-4-7'
  if (shortName.includes('opus-4-6')) return 'claude-opus-4-6'
  if (shortName.includes('opus-4-5')) return 'claude-opus-4-5'
  if (shortName.includes('opus-4-1')) return 'claude-opus-4-1'
  if (shortName.includes('opus-4')) return 'claude-opus-4'
  if (shortName.includes('sonnet-5')) return 'claude-sonnet-5'
  if (shortName.includes('sonnet-4-6')) return 'claude-sonnet-4-6'
  if (shortName.includes('sonnet-4-5')) return 'claude-sonnet-4-5'
  if (shortName.includes('sonnet-4')) return 'claude-sonnet-4'
  if (shortName.includes('sonnet-3-7')) return 'claude-sonnet-3-7'
  if (shortName.includes('haiku-4-5')) return 'claude-haiku-4-5'
  if (shortName.includes('haiku-3-5')) return 'claude-haiku-3-5'
  // Unknown models get a generic name
  return 'claude'
}

/**
 * Attribution state for tracking Claude's contributions to files.
 */
export type AttributionState = {
  // File states keyed by relative path (from cwd)
  fileStates: Map<string, FileAttributionState>
  // Session baseline states for net change calculation
  sessionBaselines: Map<string, { contentHash: string; mtime: number }>
  // Surface from which edits were made
  surface: string
  // HEAD SHA at session start (for detecting external commits)
  startingHeadSha: string | null
  // Total prompts in session (for steer count calculation)
  promptCount: number
  // Prompts at last commit (to calculate steers for current commit)
  promptCountAtLastCommit: number
  // Permission prompt tracking
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  // ESC press tracking (user cancelled permission prompt)
  escapeCount: number
  escapeCountAtLastCommit: number
}

/**
 * Summary of Claude's contribution for a commit.
 */
export type AttributionSummary = {
  claudePercent: number
  claudeChars: number
  humanChars: number
  surfaces: string[]
}

/**
 * Per-file attribution details for git notes.
 */
export type FileAttribution = {
  claudeChars: number
  humanChars: number
  percent: number
  surface: string
}

/**
 * Full attribution data for git notes JSON.
 */
export type AttributionData = {
  version: 1
  summary: AttributionSummary
  files: Record<string, FileAttribution>
  surfaceBreakdown: Record<string, { claudeChars: number; percent: number }>
  excludedGenerated: string[]
  sessions: string[]
}

/**
 * Get the current client surface from environment.
 */
export function getClientSurface(): string {
  return process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'
}


/**
 * Compute SHA-256 hash of content.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Normalize file path to relative path from cwd for consistent tracking.
 * Resolves symlinks to handle /tmp vs /private/tmp on macOS.
 */
export function normalizeFilePath(filePath: string): string {
  const fs = getFsImplementation()
  const cwd = getAttributionRepoRoot()

  if (!isAbsolute(filePath)) {
    return filePath
  }

  // Resolve symlinks in both paths for consistent comparison
  // (e.g., /tmp -> /private/tmp on macOS)
  let resolvedPath = filePath
  let resolvedCwd = cwd

  try {
    resolvedPath = fs.realpathSync(filePath)
  } catch {
    // File may not exist yet, use original path
  }

  try {
    resolvedCwd = fs.realpathSync(cwd)
  } catch {
    // Keep original cwd
  }

  if (
    resolvedPath.startsWith(resolvedCwd + sep) ||
    resolvedPath === resolvedCwd
  ) {
    // Normalize to forward slashes so keys match git diff output on Windows
    return relative(resolvedCwd, resolvedPath).replaceAll(sep, '/')
  }

  // Fallback: try original comparison
  if (filePath.startsWith(cwd + sep) || filePath === cwd) {
    return relative(cwd, filePath).replaceAll(sep, '/')
  }

  return filePath
}

/**
 * Expand a relative path to absolute path.
 */
export function expandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath
  }
  return join(getAttributionRepoRoot(), filePath)
}

/**
 * Create an empty attribution state for a new session.
 */
export function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(),
    sessionBaselines: new Map(),
    surface: getClientSurface(),
    startingHeadSha: null,
    promptCount: 0,
    promptCountAtLastCommit: 0,
    permissionPromptCount: 0,
    permissionPromptCountAtLastCommit: 0,
    escapeCount: 0,
    escapeCountAtLastCommit: 0,
  }
}

/**
 * Compute the character contribution for a file modification.
 * Returns the FileAttributionState to store, or null if tracking failed.
 */
function computeFileModificationState(
  existingFileStates: Map<string, FileAttributionState>,
  filePath: string,
  oldContent: string,
  newContent: string,
  mtime: number,
): FileAttributionState | null {
  const normalizedPath = normalizeFilePath(filePath)

  try {
    // Calculate Claude's character contribution
    let claudeContribution: number

    if (oldContent === '' || newContent === '') {
      // New file or full deletion - contribution is the content length
      claudeContribution =
        oldContent === '' ? newContent.length : oldContent.length
    } else {
      // Find actual changed region via common prefix/suffix matching.
      // This correctly handles same-length replacements (e.g., "Esc" → "esc")
      // where Math.abs(newLen - oldLen) would be 0.
      const minLen = Math.min(oldContent.length, newContent.length)
      let prefixEnd = 0
      while (
        prefixEnd < minLen &&
        oldContent[prefixEnd] === newContent[prefixEnd]
      ) {
        prefixEnd++
      }
      let suffixLen = 0
      while (
        suffixLen < minLen - prefixEnd &&
        oldContent[oldContent.length - 1 - suffixLen] ===
          newContent[newContent.length - 1 - suffixLen]
      ) {
        suffixLen++
      }
      const oldChangedLen = oldContent.length - prefixEnd - suffixLen
      const newChangedLen = newContent.length - prefixEnd - suffixLen
      claudeContribution = Math.max(oldChangedLen, newChangedLen)
    }

    // Get current file state if it exists
    const existingState = existingFileStates.get(normalizedPath)
    const existingContribution = existingState?.claudeContribution ?? 0

    return {
      contentHash: computeContentHash(newContent),
      claudeContribution: existingContribution + claudeContribution,
      mtime,
    }
  } catch (error) {
    logError(error as Error)
    return null
  }
}


/**
 * Track a file modification by Claude.
 * Called after Edit/Write tool completes.
 */
export function trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
  _userModified: boolean,
  mtime: number = Date.now(),
): AttributionState {
  const normalizedPath = normalizeFilePath(filePath)
  const newFileState = computeFileModificationState(
    state.fileStates,
    filePath,
    oldContent,
    newContent,
    mtime,
  )
  if (!newFileState) {
    return state
  }

  const newFileStates = new Map(state.fileStates)
  newFileStates.set(normalizedPath, newFileState)

  logForDebugging(
    `Attribution: Tracked ${newFileState.claudeContribution} chars for ${normalizedPath}`,
  )

  return {
    ...state,
    fileStates: newFileStates,
  }
}


// --


/**
 * Get the size of changes for a file from git diff.
 * Returns the number of characters added/removed (absolute difference).
 * For new files, returns the total file size.
 * For deleted files, returns the size of the deleted content.
 */
export async function getGitDiffSize(filePath: string): Promise<number> {
  const cwd = getAttributionRepoRoot()

  try {
    // Use git diff --stat to get a summary of changes
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--stat', '--', filePath],
      { cwd, timeout: 5000 },
    )

    if (result.code !== 0 || !result.stdout) {
      return 0
    }

    // Parse the stat output to extract additions and deletions
    // Format: " file | 5 ++---" or " file | 10 +"
    const lines = result.stdout.split('\n').filter(Boolean)
    let totalChanges = 0

    for (const line of lines) {
      // Skip the summary line (e.g., "1 file changed, 3 insertions(+), 2 deletions(-)")
      if (line.includes('file changed') || line.includes('files changed')) {
        const insertMatch = line.match(/(\d+) insertions?/)
        const deleteMatch = line.match(/(\d+) deletions?/)

        // Use line-based changes and approximate chars per line (~40 chars average)
        const insertions = insertMatch ? parseInt(insertMatch[1]!, 10) : 0
        const deletions = deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0
        totalChanges += (insertions + deletions) * 40
      }
    }

    return totalChanges
  } catch {
    return 0
  }
}

/**
 * Check if a file was deleted in the staged changes.
 */
export async function isFileDeleted(filePath: string): Promise<boolean> {
  const cwd = getAttributionRepoRoot()

  try {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--name-status', '--', filePath],
      { cwd, timeout: 5000 },
    )

    if (result.code === 0 && result.stdout) {
      // Format: "D\tfilename" for deleted files
      return result.stdout.trim().startsWith('D\t')
    }
  } catch {
    // Ignore errors
  }

  return false
}


// formatAttributionTrailer moved to attributionTrailer.ts for tree-shaking
// (contains excluded strings that should not be in external builds)


/**
 * Convert attribution state to snapshot message for persistence.
 */
export function stateToSnapshotMessage(
  state: AttributionState,
  messageId: UUID,
): AttributionSnapshotMessage {
  const fileStates: Record<string, FileAttributionState> = {}

  for (const [path, fileState] of state.fileStates) {
    fileStates[path] = fileState
  }

  return {
    type: 'attribution-snapshot',
    messageId,
    surface: state.surface,
    fileStates,
    promptCount: state.promptCount,
    promptCountAtLastCommit: state.promptCountAtLastCommit,
    permissionPromptCount: state.permissionPromptCount,
    permissionPromptCountAtLastCommit: state.permissionPromptCountAtLastCommit,
    escapeCount: state.escapeCount,
    escapeCountAtLastCommit: state.escapeCountAtLastCommit,
  }
}

/**
 * Restore attribution state from snapshot messages.
 */
export function restoreAttributionStateFromSnapshots(
  snapshots: AttributionSnapshotMessage[],
): AttributionState {
  const state = createEmptyAttributionState()

  // Snapshots are full-state dumps (see stateToSnapshotMessage), not deltas.
  // The last snapshot has the most recent count for every path — fileStates
  // never shrinks. Iterating and SUMMING counts across snapshots causes
  // quadratic growth on restore (837 snapshots × 280 files → 1.15 quadrillion
  // "chars" tracked for a 5KB file over a 5-day session).
  const lastSnapshot = snapshots[snapshots.length - 1]
  if (!lastSnapshot) {
    return state
  }

  state.surface = lastSnapshot.surface
  for (const [path, fileState] of Object.entries(lastSnapshot.fileStates)) {
    state.fileStates.set(path, fileState)
  }

  // Restore prompt counts from the last snapshot (most recent state)
  state.promptCount = lastSnapshot.promptCount ?? 0
  state.promptCountAtLastCommit = lastSnapshot.promptCountAtLastCommit ?? 0
  state.permissionPromptCount = lastSnapshot.permissionPromptCount ?? 0
  state.permissionPromptCountAtLastCommit =
    lastSnapshot.permissionPromptCountAtLastCommit ?? 0
  state.escapeCount = lastSnapshot.escapeCount ?? 0
  state.escapeCountAtLastCommit = lastSnapshot.escapeCountAtLastCommit ?? 0

  return state
}

/**
 * Restore attribution state from log snapshots on session resume.
 */
export function attributionRestoreStateFromLog(
  attributionSnapshots: AttributionSnapshotMessage[],
  onUpdateState: (newState: AttributionState) => void,
): void {
  const state = restoreAttributionStateFromSnapshots(attributionSnapshots)
  onUpdateState(state)
}

/**
 * Increment promptCount and save an attribution snapshot.
 * Used to persist the prompt count across compaction.
 *
 * @param attribution - Current attribution state
 * @param saveSnapshot - Function to save the snapshot (allows async handling by caller)
 * @returns New attribution state with incremented promptCount
 */
export function incrementPromptCount(
  attribution: AttributionState,
  saveSnapshot: (snapshot: AttributionSnapshotMessage) => void,
): AttributionState {
  const newAttribution = {
    ...attribution,
    promptCount: attribution.promptCount + 1,
  }
  const snapshot = stateToSnapshotMessage(newAttribution, randomUUID())
  saveSnapshot(snapshot)
  return newAttribution
}
