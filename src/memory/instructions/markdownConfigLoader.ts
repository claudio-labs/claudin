/**
 * The markdown files that configure the CLI from `.claudin/<subdir>`
 * directories (agents, legacy commands, output styles, skills, workflows),
 * and the frontmatter helpers every loader of such files shares. The work
 * lives in `markdownConfig/`.
 */
import type { ClaudeConfigDirectory } from 'src/memory/instructions/markdownConfig/configDirectories.js'
import { type CachedLoad, cacheSuccessfulLoads } from 'src/memory/instructions/markdownConfig/loadCache.js'
import {
  loadMarkdownFiles,
  type MarkdownFile,
} from 'src/memory/instructions/markdownConfig/loadMarkdownFiles.js'
import {
  projectWalkDeps,
  walkProjectConfigDirs,
} from 'src/memory/instructions/markdownConfig/projectDirectories.js'

export {
  CLAUDE_CONFIG_DIRECTORIES,
  type ClaudeConfigDirectory,
} from 'src/memory/instructions/markdownConfig/configDirectories.js'
export { extractDescriptionFromMarkdown } from 'src/memory/instructions/markdownConfig/description.js'
export type { MarkdownFile } from 'src/memory/instructions/markdownConfig/loadMarkdownFiles.js'
export {
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
} from 'src/memory/instructions/markdownConfig/toolLists.js'

/** The project's `.claudin/<subdir>` directories from `cwd` upward, nearest first. */
export function getProjectDirsUpToHome(subdir: ClaudeConfigDirectory, cwd: string): string[] {
  return walkProjectConfigDirs(subdir, cwd, projectWalkDeps)
}

/** Cached per subdirectory and cwd, as given, until `cache.clear()`. */
export const loadMarkdownFilesForSubdir: CachedLoad<
  [subdir: ClaudeConfigDirectory, cwd: string],
  MarkdownFile[]
> = cacheSuccessfulLoads(loadMarkdownFiles, (subdir, cwd) => `${subdir}\0${cwd}`)
