/**
 * The deprecated `.claudin/commands` directories, read through the shared
 * markdown loader. A directory holding a SKILL.md is one command named after
 * the directory; any other `.md` file is a command named after its path.
 */
import { basename, dirname } from 'path'

import {
  loadMarkdownFilesForSubdir,
  type MarkdownFile,
} from 'src/memory/instructions/markdownConfigLoader.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import { parseSkillFrontmatterFields } from 'src/skills/loading/frontmatterFields.js'
import { createSkillCommand } from 'src/skills/loading/skillCommand.js'
import {
  isSkillFileName,
  type LoadedSkill,
  namespacedName,
} from 'src/skills/loading/skillsDirectory.js'

const MARKDOWN_EXTENSION_RE = /\.md$/

export async function readLegacyCommands(cwd: string): Promise<LoadedSkill[]> {
  const files = await loadCommandFiles(cwd)
  const skillFiles = skillFileByDirectory(files)
  return files.flatMap(file => {
    const dir = dirname(file.filePath)
    const skillFile = skillFiles.get(dir)
    if (skillFile === undefined) return legacyCommandOf(file, undefined)
    // The SKILL.md stands for its whole directory. Subdirectories are
    // directories of their own, so their files are unaffected.
    return skillFile === file ? legacyCommandOf(file, dir) : []
  })
}

export function clearLegacyCommandsCache(): void {
  loadMarkdownFilesForSubdir.cache.clear?.()
}

async function loadCommandFiles(cwd: string): Promise<MarkdownFile[]> {
  try {
    return await loadMarkdownFilesForSubdir('commands', cwd)
  } catch (error) {
    logError(error)
    return []
  }
}

/** On a case-sensitive disk a directory may hold two; the first one wins. */
function skillFileByDirectory(
  files: readonly MarkdownFile[],
): Map<string, MarkdownFile> {
  const byDirectory = new Map<string, MarkdownFile>()
  for (const file of files) {
    if (!isSkillFileName(basename(file.filePath))) continue
    const dir = dirname(file.filePath)
    const chosen = byDirectory.get(dir)
    if (chosen === undefined) {
      byDirectory.set(dir, file)
    } else {
      logForDebugging(`[skills] ${dir} holds more than one SKILL.md; using ${chosen.filePath}`)
    }
  }
  return byDirectory
}

function legacyCommandOf(
  file: MarkdownFile,
  skillDir: string | undefined,
): LoadedSkill[] {
  const skillName =
    skillDir === undefined
      ? namespacedName(file.baseDir, file.filePath.replace(MARKDOWN_EXTENSION_RE, ''))
      : namespacedName(file.baseDir, skillDir)
  try {
    const command = createSkillCommand({
      ...parseSkillFrontmatterFields(
        file.frontmatter,
        file.content,
        skillName,
        'Custom command',
      ),
      // `name:` never renames a legacy command.
      displayName: undefined,
      skillName,
      markdownContent: file.content,
      source: file.source,
      baseDir: skillDir,
      loadedFrom: 'commands_DEPRECATED',
      // Path scoping belongs to skills directories: a legacy command is
      // never held back.
      paths: undefined,
    })
    return [{ command, filePath: file.filePath }]
  } catch (error) {
    // One broken command must not take the rest of the listing with it.
    logError(error)
    return []
  }
}
