import { pathInOriginalCwd } from 'src/memory/instructions/claudemd/parsing.js'
import type {
  ExternalClaudeMdInclude,
  MemoryFileInfo,
} from 'src/memory/instructions/claudemd/types.js'

export function getExternalClaudeMdIncludes(
  files: MemoryFileInfo[],
): ExternalClaudeMdInclude[] {
  const externals: ExternalClaudeMdInclude[] = []
  for (const { path, parent, type } of files) {
    // User files may include anything, so their includes never need approval.
    if (parent === undefined || type === 'User' || pathInOriginalCwd(path)) continue
    externals.push({ path, parent })
  }
  return externals
}

export function hasExternalClaudeMdIncludes(files: MemoryFileInfo[]): boolean {
  return getExternalClaudeMdIncludes(files).length > 0
}
