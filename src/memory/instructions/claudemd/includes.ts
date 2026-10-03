import type { Lexer } from 'marked'
import { dirname } from 'path'
import { expandPath } from 'src/shared/fs/path.js'
import type { MarkdownToken } from 'src/memory/instructions/claudemd/types.js'

export const TEXT_FILE_EXTENSIONS = new Set([
  // Markdown and text
  '.md',
  '.txt',
  '.text',
  // Data formats
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Web
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  // JavaScript/TypeScript
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Python
  '.py',
  '.pyi',
  '.pyw',
  // Ruby
  '.rb',
  '.erb',
  '.rake',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java/Kotlin/Scala
  '.java',
  '.kt',
  '.kts',
  '.scala',
  // C/C++
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  // C#
  '.cs',
  // Swift
  '.swift',
  // Shell
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  // Config
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.properties',
  // Database
  '.sql',
  '.graphql',
  '.gql',
  // Protocol
  '.proto',
  // Frontend frameworks
  '.vue',
  '.svelte',
  '.astro',
  // Templating
  '.ejs',
  '.hbs',
  '.pug',
  '.jade',
  // Other languages
  '.php',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.R',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.cljc',
  '.edn',
  '.hs',
  '.lhs',
  '.elm',
  '.ml',
  '.mli',
  '.f',
  '.f90',
  '.f95',
  '.for',
  // Build files
  '.cmake',
  '.make',
  '.makefile',
  '.gradle',
  '.sbt',
  // Documentation
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  // Lock files (often text-based)
  '.lock',
  // Misc
  '.log',
  '.diff',
  '.patch',
])

/** A closed comment; an unclosed `<!--` is left as text. */
const CLOSED_COMMENT_RE = /<!--[\s\S]*?-->/g
const COMMENT_OPEN = '<!--'

/** `@` at the start or after whitespace, then non-space characters, where `\ ` is an escaped space. */
const INCLUDE_REFERENCE_RE = /(?<=^|\s)@((?:\\ |\S)+)/g
/** `./x`, `~/x`, `/x`, or a bare name read as relative. A bare `/` is refused after the fragment goes. */
const ACCEPTED_REFERENCE_RE = /^(?:~\/|\/|[A-Za-z0-9._-])/
const ESCAPED_SPACE_RE = /\\ /g

/** Token types whose text the model sees as code, never as an include. */
const CODE_TOKEN_TYPES: ReadonlySet<string> = new Set(['code', 'codespan'])
/** Containers whose children are blocks rather than inline runs. */
const BLOCK_CONTAINER_TYPES: ReadonlySet<string> = new Set(['blockquote', 'list_item'])

function stripHtmlCommentSpans(raw: string): string {
  return raw.replace(CLOSED_COMMENT_RE, '')
}

/** What survives of an HTML token: the text around a comment's spans, nothing of any other tag. */
export function htmlCommentResidue(raw: string): string | null {
  return raw.trimStart().startsWith(COMMENT_OPEN) ? stripHtmlCommentSpans(raw) : null
}

/**
 * The absolute targets of the `@path` references in the prose of a document,
 * each once, in document order. `basePath` is the including file: relative
 * references resolve against its directory.
 */
export function extractIncludePathsFromTokens(
  tokens: ReturnType<Lexer['lex']>,
  basePath: string,
): string[] {
  const prose = (tokens as MarkdownToken[]).map(token => proseOf(token)).join('\n')
  const baseDir = dirname(basePath)
  const targets = new Set<string>()
  for (const match of prose.matchAll(INCLUDE_REFERENCE_RE)) {
    const reference = referenceTarget(match[1] ?? '')
    if (reference !== null) targets.add(expandPath(reference, baseDir))
  }
  return [...targets]
}

function referenceTarget(written: string): string | null {
  if (!ACCEPTED_REFERENCE_RE.test(written)) return null
  const fragmentAt = written.indexOf('#')
  const path = (fragmentAt === -1 ? written : written.slice(0, fragmentAt)).replace(ESCAPED_SPACE_RE, ' ')
  return path === '' || path === '/' ? null : path
}

/**
 * The text of a token as prose: code is dropped, comments are dropped, and
 * inline runs are glued back from their raw source, so a reference the inline
 * lexer split across tokens (a link, an emphasis marker) comes back whole.
 */
function proseOf(token: MarkdownToken): string {
  if (CODE_TOKEN_TYPES.has(token.type)) return ''
  if (token.type === 'html') return htmlCommentResidue(token.raw ?? '') ?? ''
  if (token.items) return token.items.map(item => proseOf(item)).join('\n')
  if (token.tokens) {
    const separator = BLOCK_CONTAINER_TYPES.has(token.type) ? '\n' : ''
    return token.tokens.map(child => proseOf(child)).join(separator)
  }
  return token.raw ?? token.text ?? ''
}

export const MAX_INCLUDE_DEPTH = 5
