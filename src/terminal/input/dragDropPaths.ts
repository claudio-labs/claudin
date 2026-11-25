import { existsSync } from 'fs'
import { isAbsolute } from 'path'

// Inlined to avoid pulling the full `imagePaste.ts` module (which imports
// `bun:bundle`) into this file's dependency graph. Must stay in sync with
// `IMAGE_EXTENSION_REGEX` in `./imagePaste.ts`.
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

// A space followed by an absolute path, Unix or Windows, optionally quoted.
// Spaces inside an unquoted path are escaped (`file\ name`), so this is the
// boundary between two dropped paths.
const PASTED_PATH_BOUNDARY = / (?=["']?(?:\/|[A-Za-z]:\\))/

// The start of an absolute path the boundary above recognizes.
const ABSOLUTE_PATH_START = /^(?:\/|[A-Za-z]:\\)/
const SHELL_ESCAPE = /\\(.)/g

/**
 * Split pasted text into the paths a terminal drop delivers, space- or
 * newline-separated. Segments come back untrimmed and may be empty; the image
 * paste handler in usePasteHandler and extractDraggedFilePaths both split here.
 */
export function splitPastedPaths(text: string): string[] {
  return text.split(PASTED_PATH_BOUNDARY).flatMap(part => part.split('\n'))
}

function stripOuterQuotes(segment: string): string {
  return (segment.startsWith('"') && segment.endsWith('"')) ||
    (segment.startsWith("'") && segment.endsWith("'"))
    ? segment.slice(1, -1)
    : segment
}

// Strip outer quotes and shell-escape backslashes from one dropped segment.
function cleanDroppedPath(segment: string): string {
  const p = stripOuterQuotes(segment)
  return process.platform !== 'win32' ? p.replace(SHELL_ESCAPE, '$1') : p
}

/**
 * Whether split paste segments read as dropped paths rather than prose. One
 * segment always does: VS Code pastes a bare image filename, which the image
 * handler resolves. Several do only when every one is an absolute path — prose
 * that quotes one, `convert "/tmp/in.png" -resize 50% "/tmp/out.png"`, splits
 * too and must stay text.
 */
export function isDroppedPathList(segments: string[]): boolean {
  const parts = segments.map(s => s.trim()).filter(Boolean)
  return (
    parts.length <= 1 ||
    // Unescaping would eat a Windows path's backslashes on Unix.
    parts.every(part => ABSOLUTE_PATH_START.test(stripOuterQuotes(part)))
  )
}

/**
 * Detect absolute file paths in pasted text (typically from drag-and-drop).
 * Returns the cleaned paths if ALL segments are existing non-image files,
 * or an empty array otherwise.
 */
export function extractDraggedFilePaths(text: string): string[] {
  const segments = splitPastedPaths(text)
    .map(s => s.trim())
    .filter(Boolean)

  if (segments.length === 0) return []

  const cleaned: string[] = []

  for (const raw of segments) {
    const p = cleanDroppedPath(raw)

    // Image files are handled by the upstream image paste handler.
    // Check against the cleaned path so quoted/escaped image paths like
    // `"/foo/shot.png"` or `/foo/my\ shot.png` are reliably excluded.
    if (IMAGE_EXTENSION_REGEX.test(p)) return []
    if (!isAbsolute(p)) return []
    // Verify the path actually exists on disk. Plain `fs.existsSync` is
    // used intentionally here instead of the wrapped `getFsImplementation`
    // to keep this module free of the heavy `fsOperations` dependency
    // chain — this is a pure existence check with no permission semantics.
    if (!existsSync(p)) return []
    cleaned.push(p)
  }

  return cleaned
}
