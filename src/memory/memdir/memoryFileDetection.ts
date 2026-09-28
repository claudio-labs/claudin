/**
 * Which paths, directories, shell commands and search patterns count as the
 * agent's own memory. The Read tool and the transcript's read/search
 * collapsing ask; the answers come from the predicates in detection/, fed
 * the current session.
 */
import { feature } from 'bun:bundle'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import { isAgentMemoryPath } from 'src/tools/AgentTool/agentMemory.js'
import {
  isAutoManagedMemoryFileIn,
  isAutoManagedMemoryPatternIn,
  isAutoMemFileIn,
  isMemoryDirectoryIn,
  isShellCommandTargetingMemoryIn,
  type MemoryDetectionContext,
} from 'src/memory/memdir/detection/memoryDetection.js'
import {
  getAutoMemPath,
  getMemoryBaseDir,
  isAutoMemoryEnabled,
  isAutoMemPath,
} from 'src/memory/memdir/paths.js'
import {
  isTeamMemoryEnabled,
  isTeamMemPath,
} from 'src/memory/memdir/teamMemPaths.js'

function sessionContext(): MemoryDetectionContext {
  return {
    platform: getPlatform() === 'windows' ? 'windows' : 'posix',
    configHome: getClaudinConfigHomeDir(),
    memoryBase: getMemoryBaseDir(),
    autoMemoryEnabled: isAutoMemoryEnabled(),
    autoMemDir: () => getAutoMemPath(),
    teamBuild: feature('TEAMMEM') ? true : false,
    teamMemoryEnabled: () => isTeamMemoryEnabled(),
    isAutoMemPath: path => isAutoMemPath(path),
    isTeamMemPath: path => isTeamMemPath(path),
    isAgentMemoryPath: path => isAgentMemoryPath(path),
  }
}

export function isAutoMemFile(filePath: string): boolean {
  return isAutoMemFileIn(sessionContext(), filePath)
}

export function isAutoManagedMemoryFile(filePath: string): boolean {
  return isAutoManagedMemoryFileIn(sessionContext(), filePath)
}

export function isMemoryDirectory(dirPath: string): boolean {
  return isMemoryDirectoryIn(sessionContext(), dirPath)
}

export function isShellCommandTargetingMemory(command: string): boolean {
  return isShellCommandTargetingMemoryIn(sessionContext(), command)
}

export function isAutoManagedMemoryPattern(pattern: string): boolean {
  return isAutoManagedMemoryPatternIn(sessionContext(), pattern)
}
