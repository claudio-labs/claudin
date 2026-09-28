import type { StructuredPatchHunk } from 'diff'
import { MAX_FILES, MAX_LINES_PER_FILE, MAX_SECTION_BYTES } from 'src/vcs/git/gitDiff/limits.js'

const SECTION_START = 'diff --git '
const NEXT_SECTION = `\n${SECTION_START}`

/**
 * `<c>/<path> <c>/<path>`, split at the first space that is followed by one
 * character and a slash; the key is what follows the second prefix. The Git
 * tool derives its own file keys by this rule and looks hunks up by them, so a
 * change here breaks that lookup.
 */
const HEADER_PATHS = /^.\/.+? .\/(.+)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

type FileHunks = { key: string; hunks: StructuredPatchHunk[] }

/** Unified diff text to hunks per file, in the order of the text. */
export function parseGitDiff(stdout: string): Map<string, StructuredPatchHunk[]> {
  const files = new Map<string, StructuredPatchHunk[]>()
  for (const section of fileSections(stdout)) {
    if (files.size >= MAX_FILES) break
    if (Buffer.byteLength(section, 'utf8') > MAX_SECTION_BYTES) continue
    const file = parseFileSection(section)
    if (file !== null && file.hunks.length > 0) files.set(file.key, file.hunks)
  }
  return files
}

/** Each file's text, from after its `diff --git ` through its final newline. */
function* fileSections(text: string): Generator<string> {
  let headerAt = text.startsWith(SECTION_START) ? 0 : lineAfter(text.indexOf(NEXT_SECTION))
  while (headerAt !== -1) {
    const bodyAt = headerAt + SECTION_START.length
    const breakAt = text.indexOf(NEXT_SECTION, bodyAt)
    if (breakAt === -1) {
      yield text.slice(bodyAt)
      return
    }
    yield text.slice(bodyAt, breakAt + 1)
    headerAt = breakAt + 1
  }
}

function lineAfter(breakAt: number): number {
  return breakAt === -1 ? -1 : breakAt + 1
}

function parseFileSection(section: string): FileHunks | null {
  const lines = section.split('\n')
  // The newline that closes the section ends its last line; it is not a
  // blank line of the last hunk.
  if (section.endsWith('\n')) lines.pop()
  const key = HEADER_PATHS.exec(lines[0] ?? '')?.[1]
  return key === undefined ? null : { key, hunks: collectHunks(lines.slice(1)) }
}

/**
 * Before the first hunk header come git's own lines (index, modes, renames,
 * the `---`/`+++` pair); after it, a line that starts with a space, `+` or `-`
 * is content, whatever follows that first character.
 */
function collectHunks(lines: readonly string[]): StructuredPatchHunk[] {
  const hunks: StructuredPatchHunk[] = []
  let current: StructuredPatchHunk | undefined
  let kept = 0
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      current = hunkFromHeader(header)
      hunks.push(current)
    } else if (current !== undefined && isHunkLine(line) && kept < MAX_LINES_PER_FILE) {
      current.lines.push(line)
      kept += 1
    }
  }
  return hunks
}

/** A blank line is a context line whose space diff.suppressBlankEmpty left out. */
function isHunkLine(line: string): boolean {
  return line === '' || line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')
}

function hunkFromHeader(header: RegExpExecArray): StructuredPatchHunk {
  return {
    oldStart: Number(header[1]),
    oldLines: rangeLength(header[2]),
    newStart: Number(header[3]),
    newLines: rangeLength(header[4]),
    lines: [],
  }
}

/** A range printed without a count is one line long. */
function rangeLength(count: string | undefined): number {
  return count === undefined ? 1 : Number(count)
}
