import { join } from 'path'
import { type ConfigKey, findConfigValue } from 'src/vcs/git/gitConfigParser/configSyntax.js'
import type { GitFiles } from 'src/vcs/git/gitFilesystem/gitFiles.js'
import { isAcceptedRefName } from 'src/vcs/git/gitFilesystem/refNames.js'
import { filesRefStore, parseLooseRef, resolveRefToId } from 'src/vcs/git/gitFilesystem/refStore.js'

const ORIGIN_URL: ConfigKey = { section: 'remote', subsection: 'origin', key: 'url' }
const ORIGIN_REFS = 'refs/remotes/origin/'
const ORIGIN_HEAD = `${ORIGIN_REFS}HEAD`
/** Tried in this order when origin/HEAD names no usable branch. */
const CONVENTIONAL_DEFAULTS = ['main', 'master'] as const

export const FALLBACK_DEFAULT_BRANCH = 'main'

async function originUrlIn(dir: string, files: GitFiles): Promise<string | null> {
  const text = await files.readText(join(dir, 'config'))
  return text === null ? null : findConfigValue(text, ORIGIN_URL)
}

/**
 * origin's url as configured: `url.<base>.insteadOf` is not applied. A linked
 * worktree has no config of its own, so the common dir's is read next.
 */
export async function readOriginUrl(
  gitDir: string,
  commonDir: string | null,
  files: GitFiles,
): Promise<string | null> {
  const own = await originUrlIn(gitDir, files)
  if (own) return own
  return commonDir === null ? null : (await originUrlIn(commonDir, files)) || null
}

/** The branch a loose, symbolic origin/HEAD points at inside origin's refs. */
async function originHeadBranch(storeDir: string, files: GitFiles): Promise<string | null> {
  const text = await files.readText(join(storeDir, ORIGIN_HEAD))
  if (text === null) return null
  const record = parseLooseRef(text)
  if (record.kind !== 'symbolic' || !record.target.startsWith(ORIGIN_REFS)) return null
  const branch = record.target.slice(ORIGIN_REFS.length)
  return isAcceptedRefName(branch) ? branch : null
}

/** `storeDir` is the common dir, or the git directory when there is none. */
export async function readDefaultBranch(storeDir: string, files: GitFiles): Promise<string> {
  const pointed = await originHeadBranch(storeDir, files)
  if (pointed !== null) return pointed
  const store = filesRefStore(storeDir, files)
  for (const branch of CONVENTIONAL_DEFAULTS) {
    if ((await resolveRefToId(store, ORIGIN_REFS + branch)) !== null) return branch
  }
  return FALLBACK_DEFAULT_BRANCH
}
