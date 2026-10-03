import { Lexer } from 'marked'
import { extname } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { truncateEntrypointContent } from 'src/memory/memdir/memdir.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { pathInWorkingPath } from 'src/permissions/filePermissions.js'
import { inspectRuleFrontmatter } from 'src/memory/instructions/ruleFrontmatter.js'
import {
  TEXT_FILE_EXTENSIONS,
  extractIncludePathsFromTokens,
  htmlCommentResidue,
} from 'src/memory/instructions/claudemd/includes.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

type ParsedMemoryFile = { info: MemoryFileInfo | null; includePaths: string[] }

const nothingRead = (): ParsedMemoryFile => ({ info: null, includePaths: [] })

/** The memory indexes are capped, so they get the index truncation. */
const INDEX_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>(['AutoMem', 'TeamMem'])

/** An absent file, or a directory where a file was expected, is an ordinary miss. */
const ORDINARY_MISSES: ReadonlySet<string> = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])

const COMMENT_OPEN = '<!--'
const INCLUDE_MARK = '@'

export function pathInOriginalCwd(path: string): boolean {
  return pathInWorkingPath(path, getOriginalCwd())
}

function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  const { content, paths } = inspectRuleFrontmatter(rawContent)
  return paths === undefined ? { content } : { content, paths }
}


/**
 * The document rebuilt from its tokens with every comment-led HTML block
 * reduced to what follows its comments. Rebuilding normalizes line ends, so
 * the caller keeps the original text when nothing was stripped.
 */
function stripHtmlCommentsFromTokens(tokens: ReturnType<Lexer['lex']>): {
  content: string
  stripped: boolean
} {
  let stripped = false
  const pieces = tokens.map(token => {
    if (token.type !== 'html') return token.raw
    const residue = htmlCommentResidue(token.raw)
    if (residue === null || residue === token.raw) return token.raw
    stripped = true
    return residue
  })
  return { content: pieces.join(''), stripped }
}

function parseMemoryFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): ParsedMemoryFile {
  const { content: body, paths } = parseFrontmatterPaths(rawContent)
  const hasComment = body.includes(COMMENT_OPEN)
  const wantsIncludes = includeBasePath !== undefined && body.includes(INCLUDE_MARK)

  let content = body
  let includePaths: string[] = []
  if (hasComment || wantsIncludes) {
    const tokens = new Lexer({ gfm: true }).lex(body)
    if (hasComment) {
      const result = stripHtmlCommentsFromTokens(tokens)
      if (result.stripped) content = result.content
    }
    if (includeBasePath !== undefined && wantsIncludes) {
      includePaths = extractIncludePathsFromTokens(tokens, includeBasePath)
    }
  }
  if (INDEX_TYPES.has(type)) content = truncateEntrypointContent(content).content

  const differs = content !== rawContent
  const info: MemoryFileInfo = {
    path: filePath,
    type,
    content,
    ...(paths === undefined ? {} : { globs: paths }),
    contentDiffersFromDisk: differs,
    ...(differs ? { rawContent } : {}),
  }
  return { info, includePaths }
}

function handleMemoryFileReadError(error: unknown, filePath: string): void {
  const code = getErrnoCode(error)
  if (code !== undefined && ORDINARY_MISSES.has(code)) return
  logForDebugging(`Instruction file not loaded: ${filePath} (${code ?? String(error)})`, { level: 'warn' })
}

function hasTextExtension(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return extension === '' || TEXT_FILE_EXTENSIONS.has(extension)
}

/**
 * Reads one instruction file into an entry. `includeBasePath` is the path its
 * `@` references resolve next to; without it they are not collected. Blank
 * content still gives an entry: dropping it is the caller's call.
 */
export async function safelyReadMemoryFileAsync(
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): Promise<{ info: MemoryFileInfo | null; includePaths: string[] }> {
  if (!hasTextExtension(filePath)) return nothingRead()
  let rawContent: string
  try {
    rawContent = await getFsImplementation().readFile(filePath, { encoding: 'utf-8' })
  } catch (error) {
    handleMemoryFileReadError(error, filePath)
    return nothingRead()
  }
  return parseMemoryFileContent(rawContent, filePath, type, includeBasePath)
}
