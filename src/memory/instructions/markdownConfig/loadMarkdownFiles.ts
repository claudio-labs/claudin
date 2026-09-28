/**
 * One uncached load: every markdown file of the enabled sources for a
 * subdirectory, parsed, in source order, each physical file once.
 */
import { readFile } from 'fs/promises'

import type { ClaudeConfigDirectory } from 'src/memory/instructions/markdownConfig/configDirectories.js'
import {
  type SourceDirectory,
  sourceDirectoriesFor,
} from 'src/memory/instructions/markdownConfig/configSources.js'
import {
  fileIdentityOf,
  type IdentifiedFile,
  keepFirstOfEachFile,
} from 'src/memory/instructions/markdownConfig/fileIdentity.js'
import { findMarkdownFiles } from 'src/memory/instructions/markdownConfig/markdownSearch.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { type FrontmatterData, parseFrontmatter } from 'src/shared/frontmatterParser.js'

export type MarkdownFile = {
  filePath: string
  /** The source directory searched, however deep the file sits below it. */
  baseDir: string
  frontmatter: FrontmatterData
  content: string
  source: SettingSource
}

type LoadedFile = IdentifiedFile & { file: MarkdownFile }

export async function loadMarkdownFiles(
  subdir: ClaudeConfigDirectory,
  cwd: string,
): Promise<MarkdownFile[]> {
  const perDirectory = await Promise.all(sourceDirectoriesFor(subdir, cwd).map(readSourceDirectory))
  return keepFirstOfEachFile(perDirectory.flat()).map(loaded => loaded.file)
}

async function readSourceDirectory(directory: SourceDirectory): Promise<LoadedFile[]> {
  const paths = await findMarkdownFiles(directory.baseDir)
  const loaded = await Promise.all(paths.map(filePath => readMarkdownFile(filePath, directory)))
  return loaded.filter((file): file is LoadedFile => file !== undefined)
}

async function readMarkdownFile(
  filePath: string,
  { baseDir, source }: SourceDirectory,
): Promise<LoadedFile | undefined> {
  try {
    const [text, identity] = await Promise.all([readFile(filePath, 'utf8'), fileIdentityOf(filePath)])
    const { frontmatter, content } = parseFrontmatter(text, filePath)
    return { filePath, identity, file: { filePath, baseDir, frontmatter, content, source } }
  } catch (error) {
    logForDebugging(`[markdown config] leaving out ${filePath}: ${errorMessage(error)}`)
    return undefined
  }
}
