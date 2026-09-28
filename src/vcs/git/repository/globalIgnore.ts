import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { isENOENT } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logError } from 'src/shared/log.js'
import { dirIsInGitRepo } from 'src/vcs/git/repository/gitRoot.js'
import { isPathGitignored } from 'src/vcs/git/repository/ignoreCheck.js'
import { runGit } from 'src/vcs/git/repository/runGit.js'

// Whether git ignores a directory is asked about a file inside it: a rule like
// `plans/*` ignores everything in the directory but not the directory's name.
const FILE_INSIDE_DIRECTORY = 'placeholder'
const RULE_PREFIX = '**/'

/** Git's default global excludes file, `<home>/.config/git/ignore`. */
export function getGlobalGitignorePath(): string {
  return join(homedir(), '.config', 'git', 'ignore')
}

// Makes git ignore `filename` in every repository by adding the rule
// `**/<filename>` to the global excludes file, unless git already ignores it as
// seen from `cwd`. Does nothing outside a repository, and never throws.
export async function addFileGlobRuleToGitignore(
  filename: string,
  cwd: string = getCwd(),
): Promise<void> {
  await ignoreInEveryRepository(filename, cwd).catch(logError)
}

/** The work behind addFileGlobRuleToGitignore. It may reject; the caller logs. */
async function ignoreInEveryRepository(filename: string, cwd: string): Promise<void> {
  const inRepository = await dirIsInGitRepo(cwd)
  if (!inRepository) return
  const asked = filename.endsWith('/') ? `${filename}${FILE_INSIDE_DIRECTORY}` : filename
  if (await isPathGitignored(asked, cwd)) return
  const target = await resolveGlobalExcludesFile(cwd)
  if (target !== null) await addRuleToFile(target, `${RULE_PREFIX}${filename}`)
}

/**
 * The file git reads for global excludes, determined from the user's global
 * git configuration and the environment only. The repository's own config is
 * never consulted: a cloned repository controls it, and could aim the write
 * at any file. Null when `core.excludesFile` is relative, since that names a
 * different file in every repository and no single one is right.
 */
export async function resolveGlobalExcludesFile(cwd: string): Promise<string | null> {
  const configured = await runGit(
    ['config', '--global', '--includes', '--path', '--get', 'core.excludesFile'],
    { cwd: { dir: cwd } },
  )
  const target = chooseGlobalExcludesFile({
    configured: configured.ok ? configured.stdout.trim() : '',
    xdgConfigHome: process.env.XDG_CONFIG_HOME ?? '',
    fallback: getGlobalGitignorePath(),
  })
  if (target === null) logForDebugging('core.excludesFile is relative; no global ignore rule added')
  return target
}

/** Git's order: `core.excludesFile`, then `$XDG_CONFIG_HOME/git/ignore`, then the default. */
export function chooseGlobalExcludesFile(sources: {
  configured: string
  xdgConfigHome: string
  fallback: string
}): string | null {
  if (sources.configured !== '') {
    return isAbsolute(sources.configured) ? sources.configured : null
  }
  if (isAbsolute(sources.xdgConfigHome)) return join(sources.xdgConfigHome, 'git', 'ignore')
  return sources.fallback
}

/**
 * The file's content with `rule` on a line of its own, or null when a whole
 * line already holds it. A missing file (null) becomes the rule alone; an
 * existing one gets a newline, then the rule.
 */
export function withRule(content: string | null, rule: string): string | null {
  if (content === null) return `${rule}\n`
  if (content.split('\n').some(line => line.trimEnd() === rule)) return null
  return `${content}\n${rule}\n`
}

async function addRuleToFile(target: string, rule: string): Promise<void> {
  const next = withRule(await readIfPresent(target), rule)
  if (next === null) return
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, next, 'utf8')
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
}
