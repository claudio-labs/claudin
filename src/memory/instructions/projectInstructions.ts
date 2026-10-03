import { dirname, join } from 'path'

export const PRIMARY_PROJECT_INSTRUCTION_FILE = 'AGENTS.md'
const FALLBACK_PROJECT_INSTRUCTION_FILE = 'CLAUDE.md'

export function getProjectInstructionFilePaths(dir: string): string[] {
  return [PRIMARY_PROJECT_INSTRUCTION_FILE, FALLBACK_PROJECT_INSTRUCTION_FILE].map(name => join(dir, name))
}

/**
 * Any `AGENTS.md` entry, even an empty file or a directory, claims the slot, so
 * the fallback is returned whether it exists or not.
 */
export function getProjectInstructionFilePath(
  dir: string,
  existsSync: (path: string) => boolean,
): string {
  const [primary, fallback] = getProjectInstructionFilePaths(dir) as [string, string]
  return existsSync(primary) ? primary : fallback
}

function hasProjectInstructionFile(
  dir: string,
  existsSync: (path: string) => boolean,
): boolean {
  return getProjectInstructionFilePaths(dir).some(candidate => existsSync(candidate))
}

export function findProjectInstructionFilePathInAncestors(
  startDir: string,
  existsSync: (path: string) => boolean,
): string | null {
  for (let dir = startDir; ; ) {
    if (hasProjectInstructionFile(dir, existsSync)) return getProjectInstructionFilePath(dir, existsSync)
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

export function isProjectInstructionFileName(name: string): boolean {
  return name === PRIMARY_PROJECT_INSTRUCTION_FILE || name === FALLBACK_PROJECT_INSTRUCTION_FILE
}
