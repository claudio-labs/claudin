/**
 * Reads one skills directory. Each directory below it that holds a SKILL.md
 * is a skill, named after its path with `:` for each separator, at any depth
 * and through symlinked directories. Files directly in the skills directory,
 * and any other markdown, are not skills.
 */
import type { Dirent } from 'fs'
import { readdir, readFile, realpath, stat } from 'fs/promises'
import { basename, join, relative, sep } from 'path'

import type { SettingSource } from 'src/platform/settings/constants.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isENOENT, isFsInaccessible } from 'src/shared/errors.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'
import { logError } from 'src/shared/log.js'
import { parseSkillFrontmatterFields } from 'src/skills/loading/frontmatterFields.js'
import { parseSkillPaths } from 'src/skills/loading/pathScope.js'
import { createSkillCommand, type SkillCommand } from 'src/skills/loading/skillCommand.js'

export type LoadedSkill = {
  command: SkillCommand
  /** The file it came from, as reached; the listing drops a file seen twice. */
  filePath: string
}

type SkillFile = { skillDir: string; filePath: string }

const SKILL_FILE_NAME_RE = /^skill\.md$/i
const NAME_SEPARATOR = ':'

export async function readSkillsDirectory(
  skillsDir: string,
  source: SettingSource,
): Promise<LoadedSkill[]> {
  const files: SkillFile[] = []
  await collectSkillFiles(skillsDir, 0, new Set(), files)
  files.sort((a, b) => comparePlain(a.filePath, b.filePath))
  const skills = await Promise.all(
    files.map(file => loadSkill(skillsDir, file, source)),
  )
  return skills.filter((skill): skill is LoadedSkill => skill !== undefined)
}

export function isSkillFileName(name: string): boolean {
  return SKILL_FILE_NAME_RE.test(name)
}

/** `path` relative to `root`, with `:` for each separator. */
export function namespacedName(root: string, path: string): string {
  const relativePath = relative(root, path)
  // Only a legacy SKILL.md placed directly in a commands directory is its own
  // root; it is named after that directory.
  return relativePath === ''
    ? basename(path)
    : relativePath.split(sep).join(NAME_SEPARATOR)
}

/** Undefined when the path does not resolve: missing, dangling or looping. */
export async function realPathOf(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error) {
    logUnlessInaccessible(error, `cannot resolve ${path}`)
    return undefined
  }
}

/**
 * `ancestors` holds the real paths above `dir`, so a symlink back up the tree
 * ends the walk at once. Without it the operating system's link limit would
 * end it, after a time that grows exponentially with each looping link.
 */
async function collectSkillFiles(
  dir: string,
  depth: number,
  ancestors: ReadonlySet<string>,
  found: SkillFile[],
): Promise<void> {
  const realDir = await realPathOf(dir)
  if (realDir === undefined || ancestors.has(realDir)) return
  const entries = await readEntries(dir)
  const skillFile = depth > 0 ? skillFileAmong(dir, entries) : undefined
  if (skillFile !== undefined) found.push({ skillDir: dir, filePath: skillFile })
  const lineage = new Set(ancestors).add(realDir)
  const subdirectories = await subdirectoriesAmong(dir, entries)
  await Promise.all(
    subdirectories.map(subdirectory =>
      collectSkillFiles(subdirectory, depth + 1, lineage, found),
    ),
  )
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    logUnlessInaccessible(error, `cannot read ${dir}`)
    return []
  }
}

/** Whatever its type: reading it decides whether it is a skill. */
function skillFileAmong(dir: string, entries: readonly Dirent[]): string | undefined {
  const names = entries
    .map(entry => entry.name)
    .filter(isSkillFileName)
    .sort(comparePlain)
  const [first] = names
  if (names.length > 1) {
    logForDebugging(`[skills] ${dir} holds ${names.join(' and ')}; using ${first}`)
  }
  return first === undefined ? undefined : join(dir, first)
}

async function subdirectoriesAmong(
  dir: string,
  entries: readonly Dirent[],
): Promise<string[]> {
  const subdirectories = await Promise.all(
    entries.map(async entry => {
      const path = join(dir, entry.name)
      return (await isDirectoryEntry(entry, path)) ? path : undefined
    }),
  )
  return subdirectories.filter((path): path is string => path !== undefined)
}

async function isDirectoryEntry(entry: Dirent, path: string): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    // A dangling link, or one that loops on itself: nothing to walk.
    logUnlessInaccessible(error, `cannot follow ${path}`)
    return false
  }
}

async function loadSkill(
  skillsDir: string,
  file: SkillFile,
  source: SettingSource,
): Promise<LoadedSkill | undefined> {
  const markdown = await readSkillFile(file.filePath)
  if (markdown === undefined) return undefined
  try {
    const command = skillCommandOf(skillsDir, file, markdown, source)
    return { command, filePath: file.filePath }
  } catch (error) {
    // One broken skill must not take the rest of the listing with it.
    logError(error)
    return undefined
  }
}

function skillCommandOf(
  skillsDir: string,
  file: SkillFile,
  markdown: string,
  source: SettingSource,
): SkillCommand {
  const { frontmatter, content } = parseFrontmatter(markdown, file.filePath)
  const skillName = namespacedName(skillsDir, file.skillDir)
  return createSkillCommand({
    ...parseSkillFrontmatterFields(frontmatter, content, skillName),
    skillName,
    markdownContent: content,
    source,
    baseDir: file.skillDir,
    loadedFrom: 'skills',
    paths: parseSkillPaths(frontmatter.paths),
  })
}

async function readSkillFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    // Not found is a dangling link, or a file removed during the walk.
    if (!isENOENT(error)) {
      logForDebugging(`[skills] skipping ${filePath}: ${errorMessage(error)}`, {
        level: 'warn',
      })
    }
    return undefined
  }
}

function logUnlessInaccessible(error: unknown, what: string): void {
  if (!isFsInaccessible(error)) {
    logForDebugging(`[skills] ${what}: ${errorMessage(error)}`)
  }
}

/** Code-unit order: the same on every machine and in every locale. */
function comparePlain(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
