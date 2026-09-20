import { pathInOriginalCwd } from 'src/memory/instructions/claudemd/parsing.js'
import type {
  ExternalClaudeMdInclude,
  MemoryFileInfo,
} from 'src/memory/instructions/claudemd/types.js'

export function getExternalClaudeMdIncludes(
  files: MemoryFileInfo[],
): ExternalClaudeMdInclude[] {
  const externals: ExternalClaudeMdInclude[] = []
  for (const file of files) {
    if (file.type !== 'User' && file.parent && !pathInOriginalCwd(file.path)) {
      externals.push({ path: file.path, parent: file.parent })
    }
  }
  return externals
}

export function hasExternalClaudeMdIncludes(files: MemoryFileInfo[]): boolean {
  return getExternalClaudeMdIncludes(files).length > 0
}
