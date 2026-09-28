import { join } from 'path'
import { findConfigValue } from 'src/vcs/git/gitConfigParser/configSyntax.js'
import { diskGitFiles } from 'src/vcs/git/gitFilesystem/gitFiles.js'

/**
 * One value from `<gitDir>/config`, read afresh on every call, or null when
 * the file or the key is not there. Only the repository's own file is read:
 * a value set through an include, or in the global, system or per-worktree
 * config, reads as null, which callers take as "not configured".
 */
export async function parseGitConfigValue(
  gitDir: string,
  section: string,
  subsection: string | null,
  key: string,
): Promise<string | null> {
  const text = await diskGitFiles.readText(join(gitDir, 'config'))
  return text === null ? null : findConfigValue(text, { section, subsection, key })
}
