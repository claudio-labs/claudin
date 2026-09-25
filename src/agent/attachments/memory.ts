// biome-ignore-all assist/source/organizeImports: keep grouped by domain
import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/shared/fs/cwd.js'
import {
  type ToolUseContext,
  type ToolPermissionContext,
} from 'src/tools/Tool.js'
import type { Attachment } from 'src/agent/attachments/types.js'
import {
  type MemoryFileInfo,
  getManagedAndUserConditionalRules,
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

export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  const targetDir = dirname(resolve(targetPath))
  const nestedDirs: string[] = []
  let currentDir = targetDir

  while (currentDir !== originalCwd && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(originalCwd)) {
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
        // The text the model was shown, so Edit/Patch can check their
        // needle against it rather than demand a re-Read (fileStateCache.ts).
        injectedView: memoryFile.contentDiffersFromDisk
          ? memoryFile.content
          : undefined,
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

    const managedUserRules = await getManagedAndUserConditionalRules(
      filePath,
      processedPaths,
    )
    attachments.push(
      ...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath),
    )

    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
    )

    for (const dir of nestedDirs) {
      const memoryFiles = await getMemoryFilesForNestedDirectory(
        dir,
        filePath,
        processedPaths,
      )
      attachments.push(
        ...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath),
      )
    }

    for (const dir of cwdLevelDirs) {
      const conditionalRules = await getConditionalRulesForCwdLevelDirectory(
        dir,
        filePath,
        processedPaths,
      )
      attachments.push(
        ...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath),
      )
    }

    // Memories carrying `paths:` ride the same lane as a path-scoped rule —
    // same trigger, same once-per-session dedupe, same reset on compaction.
    // The rule loaders above share `processedPaths` with this call, so a file
    // reached twice in one trigger is still attached once.
    const pathScopedMemories = await getPathScopedMemoryFiles(
      filePath,
      processedPaths,
    )
    attachments.push(
      ...memoryFilesToAttachments(pathScopedMemories, toolUseContext, filePath),
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
