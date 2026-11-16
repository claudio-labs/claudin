// biome-ignore-all assist/source/organizeImports: keep grouped by domain
import { dirname, join, parse, relative, resolve, sep } from 'path'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { isENOENT } from 'src/shared/errors.js'
import {
  type ToolUseContext,
  type ToolPermissionContext,
} from 'src/tools/Tool.js'
import type { Attachment } from 'src/agent/attachments/types.js'
import {
  type MemoryFileInfo,
  getManagedAndUserConditionalRules,
  getMemoryFiles,
  getMemoryFilesForNestedDirectory,
  getConditionalRulesForCwdLevelDirectory,
} from 'src/memory/instructions/claudemd.js'
import {
  hasInstructionsLoadedHook,
  executeInstructionsLoadedHooks,
  type InstructionsMemoryType,
} from 'src/platform/lifecycleHooks/hooks.js'
import { pathInAllowedWorkingPath } from 'src/permissions/filePermissions.js'
import { logError } from 'src/shared/log.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getPathScopedMemoryFiles } from 'src/memory/memdir/pathScopedMemories.js'
import { worktreesDir } from 'src/vcs/git/worktree/slugNaming.js'

export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  const targetDir = dirname(resolve(targetPath))
  const nestedDirs: string[] = []
  let currentDir = targetDir
  // A path prefix, not a string prefix: /work/app must not claim /work/app-backend.
  const cwdPrefix = originalCwd.endsWith(sep) ? originalCwd : originalCwd + sep

  while (currentDir !== originalCwd && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(cwdPrefix)) {
      nestedDirs.push(currentDir)
    }
    currentDir = dirname(currentDir)
  }

  nestedDirs.reverse()

  const cwdLevelDirs: string[] = []
  currentDir = originalCwd

  while (currentDir !== parse(currentDir).root) {
    cwdLevelDirs.push(currentDir)
    currentDir = dirname(currentDir)
  }

  cwdLevelDirs.reverse()

  return { nestedDirs, cwdLevelDirs }
}

/**
 * The main-checkout path a file inside a worktree mirrors:
 * `<originalCwd>/.claudin/worktrees/<slug>/AGENTS.md` → `<originalCwd>/AGENTS.md`.
 * Null for a path outside the worktrees directory, and for a worktree's root.
 */
export function mainCheckoutCounterpart(
  path: string,
  originalCwd: string,
): string | null {
  const prefix = worktreesDir(originalCwd) + sep
  if (!path.startsWith(prefix)) return null
  // The slug is one segment: a nested one is flattened (slugNaming.ts).
  const insideWorktree = path
    .slice(prefix.length)
    .split(sep)
    .slice(1)
    .filter(segment => segment !== '')
  return insideWorktree.length > 0
    ? join(originalCwd, ...insideWorktree)
    : null
}

function isInstructionsMemoryType(
  type: MemoryFileInfo['type'],
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

export function memoryFilesToAttachments(
  memoryFiles: MemoryFileInfo[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string,
): Attachment[] {
  const attachments: Attachment[] = []
  const shouldFireHook = hasInstructionsLoadedHook()

  for (const memoryFile of memoryFiles) {
    if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) {
      continue
    }
    if (!toolUseContext.readFileState.has(memoryFile.path)) {
      attachments.push({
        type: 'nested_memory',
        path: memoryFile.path,
        content: memoryFile,
        displayPath: relative(getCwd(), memoryFile.path),
      })
      toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)

      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk
          ? (memoryFile.rawContent ?? memoryFile.content)
          : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk,
      })

      if (shouldFireHook && isInstructionsMemoryType(memoryFile.type)) {
        const loadReason = memoryFile.globs
          ? 'path_glob_match'
          : memoryFile.parent
            ? 'include'
            : 'nested_traversal'
        void executeInstructionsLoadedHooks(
          memoryFile.path,
          memoryFile.type,
          loadReason,
          {
            globs: memoryFile.globs,
            triggerFilePath,
            parentFilePath: memoryFile.parent,
          },
        )
      }
    }
  }

  return attachments
}

/** A read error means "not the same bytes": the copy is then attached. */
async function hasSameBytesOnDisk(
  file: MemoryFileInfo,
  counterpart: string,
): Promise<boolean> {
  const onDisk = file.contentDiffersFromDisk
    ? (file.rawContent ?? file.content)
    : file.content
  try {
    const counterpartBytes = await getFsImplementation().readFile(counterpart, {
      encoding: 'utf-8',
    })
    return counterpartBytes === onDisk
  } catch (error) {
    // No counterpart is the ordinary case of a rule only this branch has.
    if (!isENOENT(error)) logError(error)
    return false
  }
}

/**
 * Leaves out the worktree copies of instruction files the session already
 * carries. A worktree is a second checkout under the original cwd, so a Read
 * inside it finds that checkout's own AGENTS.md and rules, and the dedupe in
 * memoryFilesToAttachments is by path: the same text was attached again under
 * another name (8 attachments, ~14K chars, in the 2026-11-16 census).
 *
 * Conservative on purpose: a worktree on another branch can carry a rule the
 * main checkout lacks or has changed. A copy is dropped only when its
 * main-checkout counterpart has the same bytes AND is in context — loaded
 * eagerly, attached or read earlier, or about to be attached by this same
 * trigger (a main rule with an unanchored glob matches a worktree file too).
 */
async function dropMainCheckoutCopies(
  memoryFiles: MemoryFileInfo[],
  originalCwd: string,
  toolUseContext: ToolUseContext,
): Promise<MemoryFileInfo[]> {
  const counterparts = new Map<MemoryFileInfo, string>()
  for (const file of memoryFiles) {
    const counterpart = mainCheckoutCounterpart(file.path, originalCwd)
    if (counterpart) counterparts.set(file, counterpart)
  }
  // Nearly every trigger: nothing was loaded from a worktree.
  if (counterparts.size === 0) return memoryFiles

  try {
    const inContext = new Set<string>(memoryFiles.map(file => file.path))
    for (const file of await getMemoryFiles()) inContext.add(file.path)

    const kept: MemoryFileInfo[] = []
    for (const file of memoryFiles) {
      const counterpart = counterparts.get(file)
      const isCopy =
        counterpart !== undefined &&
        (inContext.has(counterpart) ||
          toolUseContext.loadedNestedMemoryPaths?.has(counterpart) === true ||
          toolUseContext.readFileState.has(counterpart)) &&
        (await hasSameBytesOnDisk(file, counterpart))
      if (!isCopy) kept.push(file)
    }
    return kept
  } catch (error) {
    // A copy attached twice costs tokens; a rule lost costs behaviour.
    logError(error)
    return memoryFiles
  }
}

export async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  try {
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments
    }

    const processedPaths = new Set<string>()
    const originalCwd = getOriginalCwd()
    // Loaded in full before anything is attached: whether a worktree copy is
    // redundant depends on what the later loaders bring (dropMainCheckoutCopies).
    const memoryFiles: MemoryFileInfo[] = []

    memoryFiles.push(
      ...(await getManagedAndUserConditionalRules(filePath, processedPaths)),
    )

    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
    )

    for (const dir of nestedDirs) {
      memoryFiles.push(
        ...(await getMemoryFilesForNestedDirectory(
          dir,
          filePath,
          processedPaths,
        )),
      )
    }

    for (const dir of cwdLevelDirs) {
      memoryFiles.push(
        ...(await getConditionalRulesForCwdLevelDirectory(
          dir,
          filePath,
          processedPaths,
        )),
      )
    }

    // Memories carrying `paths:` ride the same lane as a path-scoped rule —
    // same trigger, same once-per-session dedupe, same reset on compaction.
    // The rule loaders above share `processedPaths` with this call, so a file
    // reached twice in one trigger is still attached once.
    memoryFiles.push(
      ...(await getPathScopedMemoryFiles(filePath, processedPaths)),
    )

    attachments.push(
      ...memoryFilesToAttachments(
        await dropMainCheckoutCopies(memoryFiles, originalCwd, toolUseContext),
        toolUseContext,
        filePath,
      ),
    )
  } catch (error) {
    logError(error)
  }

  return attachments
}

export async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []

  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(
      filePath,
      toolUseContext,
      appState,
    )
    attachments.push(...nestedAttachments)
  }

  toolUseContext.nestedMemoryAttachmentTriggers.clear()

  return attachments
}
