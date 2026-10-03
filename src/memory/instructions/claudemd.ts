
import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  getOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { getAutoMemEntrypoint, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'
import { getCurrentProjectConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { normalizePathForComparison } from 'src/shared/fs/file.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { findCanonicalGitRoot, findGitRoot } from 'src/vcs/git/git.js'
import {
  executeInstructionsLoadedHooks,
  hasInstructionsLoadedHook,
  type InstructionsLoadReason,
} from 'src/platform/lifecycleHooks/hooks.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { isSettingSourceEnabled } from 'src/platform/settings/constants.js'
import { safelyReadMemoryFileAsync } from 'src/memory/instructions/claudemd/parsing.js'
import { isInstructionsMemoryType } from 'src/memory/instructions/claudemd/predicates.js'
import { hasExternalClaudeMdIncludes } from 'src/memory/instructions/claudemd/externalIncludes.js'
import { renderInstructionBlock } from 'src/memory/instructions/claudemd/instructionBlock.js'
import {
  loadPlannedReads,
  planInstructionWalk,
  planSessionReads,
} from 'src/memory/instructions/claudemd/sessionSources.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

export type {
  ExternalClaudeMdInclude,
  MemoryFileInfo,
} from 'src/memory/instructions/claudemd/types.js'
export {
  processMdRules,
  processMemoryFile,
} from 'src/memory/instructions/claudemd/processing.js'
export {
  MAX_MEMORY_CHARACTER_COUNT,
  getLargeMemoryFiles,
  isMemoryFilePath,
} from 'src/memory/instructions/claudemd/predicates.js'
export {
  getExternalClaudeMdIncludes,
  hasExternalClaudeMdIncludes,
} from 'src/memory/instructions/claudemd/externalIncludes.js'
export {
  getConditionalRulesForCwdLevelDirectory,
  getManagedAndUserConditionalRules,
  getMemoryFilesForNestedDirectory,
  processConditionedMdRules,
} from 'src/memory/instructions/claudemd/nestedDirectories.js'

const teamMemPaths = feature('TEAMMEM')
  ? (require('src/memory/memdir/teamMemPaths.js') as typeof import('src/memory/memdir/teamMemPaths.js'))
  : null

let hasLoggedInitialLoad = false

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

export const getMemoryFiles = memoize(
  async (forceIncludeExternal: boolean = false): Promise<MemoryFileInfo[]> => {
    const cwd = getOriginalCwd()
    const fs = getFsImplementation()
    const reads = planSessionReads({
      stops: planInstructionWalk({ cwd, gitRoot: findGitRoot(cwd), canonicalRoot: findCanonicalGitRoot(cwd) }),
      addedDirectories: isEnvTruthy(process.env.CLAUDIN_ADDITIONAL_DIRECTORIES_CLAUDE_MD)
        ? getAdditionalDirectoriesForClaudeMd()
        : [],
      isEnabled: isSettingSourceEnabled,
      exists: path => fs.existsSync(path),
    })
    const externalApproved =
      forceIncludeExternal || getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved === true

    const files = await loadPlannedReads(reads, new Set(), externalApproved)
    files.push(...(await loadMemoryIndexes(files)))

    // The approval dialog's forced load is not the session's load.
    if (!forceIncludeExternal) reportInstructionsLoaded(files)
    noteFirstLoad(files)
    return files
  },
  // An absent argument and `false` are the same load, so they share one entry.
  (forceIncludeExternal?: boolean) => forceIncludeExternal === true,
)

type MemoryIndex = { type: MemoryType; path: string }

/** The memory indexes come last, never follow includes, and are skipped when already loaded. */
async function loadMemoryIndexes(loaded: readonly MemoryFileInfo[]): Promise<MemoryFileInfo[]> {
  const indexes: MemoryIndex[] = []
  if (isAutoMemoryEnabled()) indexes.push({ type: 'AutoMem', path: getAutoMemEntrypoint() })
  if (feature('TEAMMEM')) {
    if (teamMemPaths?.isTeamMemoryEnabled()) indexes.push({ type: 'TeamMem', path: teamMemPaths.getTeamMemEntrypoint() })
  }

  const present = new Set(loaded.map(file => normalizePathForComparison(file.path)))
  const found: MemoryFileInfo[] = []
  for (const { type, path } of indexes) {
    if (present.has(normalizePathForComparison(path))) continue
    const { info } = await safelyReadMemoryFileAsync(path, type)
    if (info !== null) found.push(info)
  }
  return found
}

function reportInstructionsLoaded(files: readonly MemoryFileInfo[]): void {
  // Taken even when nobody listens, so a hook registered later never hears a stale reason.
  const reason = consumeNextEagerLoadReason()
  if (reason === undefined || !hasInstructionsLoadedHook()) return
  for (const { path, type, parent, globs } of files) {
    if (!isInstructionsMemoryType(type)) continue
    void executeInstructionsLoadedHooks(path, type, parent === undefined ? reason : 'include', {
      globs,
      parentFilePath: parent,
    }).catch((error: unknown) => {
      logForDebugging(`InstructionsLoaded hook failed for ${path}: ${String(error)}`, { level: 'warn' })
    })
  }
}

function noteFirstLoad(files: readonly MemoryFileInfo[]): void {
  if (hasLoggedInitialLoad) return
  hasLoggedInitialLoad = true
  logForDiagnosticsNoPII('info', 'instruction_files_loaded', {
    file_count: files.length,
    total_chars: files.reduce((sum, file) => sum + file.content.length, 0),
  })
}

let nextEagerLoadReason: InstructionsLoadReason = 'session_start'

let shouldFireHook = true

/** One report is pending at a time; the next unforced load takes it. */
function consumeNextEagerLoadReason(): InstructionsLoadReason | undefined {
  if (!shouldFireHook) return undefined
  shouldFireHook = false
  return nextEagerLoadReason
}

/** Drops every cached load without arming a report: the next load is silent. */
export function clearMemoryFileCaches(): void {
  getMemoryFiles.cache.clear?.()
}

/** Drops every cached load and arms one report, so the next load tells the hooks why it ran. */
export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}

export const getClaudeMds = (
  memoryFiles: MemoryFileInfo[],
  filter?: (type: MemoryType) => boolean,
): string => {
  return renderInstructionBlock(memoryFiles, {
    preamble: MEMORY_INSTRUCTION_PROMPT,
    filter,
    fenceTeamMemory: feature('TEAMMEM') ? true : false,
  })
}

export async function shouldShowClaudeMdExternalIncludesWarning(): Promise<boolean> {
  const config = getCurrentProjectConfig()
  if (config.hasClaudeMdExternalIncludesApproved || config.hasClaudeMdExternalIncludesWarningShown) return false
  return hasExternalClaudeMdIncludes(await getMemoryFiles(true))
}
