/**
 * A batch Read's tool_result, read back one file at a time — for the code
 * that walks a transcript instead of running the tool: the resume's
 * read-state rebuild (queryHelpers.ts), the post-compact restore and the
 * plan dossier.
 *
 * batchRead.ts writes one block per file it showed: a `==> <path> <==`
 * header line, then the text a Read of that file returns (a symbol list's
 * bodies a blank line apart). The blocks are a blank line apart, and the
 * note lines come last: symbols not found, media sent to a Read of their
 * own, files past the budget. A line of a file never reads as a header,
 * because every line of a file is numbered.
 *
 * A header counts only when it matches a path the tool_use itself named. It
 * is never resolved into a path of its own, so nothing a result says can make
 * a reader credit a file the call did not name; a header that matches none of
 * them is dropped with its text.
 *
 * A glob the call named (readGlobs.ts) names every file it matches, so a
 * header counts under it when the file's absolute path is one of those
 * matches — the glob decides, never the header — and the file is credited by
 * that absolute path.
 */
import { isAbsolute, join, sep } from 'path'
import picomatch from 'picomatch'
import { logForDebugging } from 'src/shared/debug.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { expandPath } from 'src/shared/fs/path.js'
import { isReadGlob } from 'src/tools/FileReadTool/readGlobs.js'

type BatchFileText = {
  /**
   * The path as the tool_use named it — one of the `paths` given — or, for a
   * file one of its globs matched, that file's absolute path.
   */
  path: string
  /** What a Read of that one file returned, as the batch put it under its header. */
  text: string
}

type NamedFile = {
  path: string
  absolute: string
  /** Set for a glob: whether an absolute path is one of its matches. */
  glob?: (absolute: string) => boolean
}

const HEADER_RE = /^==> (.+) <==$/
// The lines readBatch writes after the last file (batchRead.ts).
const NOTE_LINE_RE = /^(?:Symbol not found: |Not read — |Not shown — )/

/**
 * Each file a batch result shows, in the order it shows them. `paths` are
 * the ones the tool_use named (readPathsOf); `cwd` resolves the relative ones
 * among them, as expandPath would.
 */
export function splitBatchReadResult(
  result: string,
  paths: readonly string[],
  cwd: string = getCwd(),
): BatchFileText[] {
  const named = namedFiles(paths, cwd)
  const blocks: { path: string | undefined; lines: string[] }[] = []
  for (const line of result.split('\n')) {
    const header = HEADER_RE.exec(line)
    if (!header) {
      blocks.at(-1)?.lines.push(line)
      continue
    }
    // The blank line that set the block before apart from this one.
    const previous = blocks.at(-1)?.lines
    if (previous?.at(-1) === '') previous.pop()
    blocks.push({ path: matchHeader(header[1]!, named, cwd), lines: [] })
  }
  const last = blocks.at(-1)
  if (last) dropNotes(last.lines)
  return blocks.flatMap(({ path, lines }) =>
    path === undefined ? [] : [{ path, text: lines.join('\n') }],
  )
}

/**
 * Each distinct file the call named: the batch reads a path named twice once.
 * A glob resolves against `cwd` as a path does, the way the Read expanded it.
 */
function namedFiles(paths: readonly string[], cwd: string): NamedFile[] {
  const seen = new Set<string>()
  const named: NamedFile[] = []
  for (const path of paths) {
    let absolute: string
    try {
      absolute = expandPath(path, cwd)
    } catch (e) {
      // expandPath refuses a path with a null byte, and so did the tool.
      logForDebugging(`batch Read result: skipping an unusable path: ${e}`)
      continue
    }
    if (seen.has(absolute)) continue
    seen.add(absolute)
    named.push(
      isReadGlob(path) ? { path, absolute, glob: globMatcher(absolute) } : { path, absolute },
    )
  }
  return named
}

/** The glob as the Read listed it: `*` stops at a `/`, and dotfiles match. */
function globMatcher(pattern: string): (absolute: string) => boolean {
  try {
    return picomatch(pattern, { dot: true })
  } catch (e) {
    // picomatch refuses a pattern past 65,536 characters. The Read's own
    // listing matches with picomatch too (glob.ts, respectGitignore), so that
    // call was refused and read nothing to credit.
    logForDebugging(`batch Read result: skipping an unusable glob: ${e}`)
    return () => false
  }
}

/**
 * The named file a header stands for. batchRead.ts labels a file relative to
 * the working directory it ran in, and absolute outside it. That directory
 * may have moved since — a `cd`, a resume from elsewhere — so a relative
 * label that does not resolve here matches by its tail, and only when a
 * single named file ends with it. A glob matches a label only where it
 * resolves, never by its tail.
 */
function matchHeader(
  label: string,
  named: readonly NamedFile[],
  cwd: string,
): string | undefined {
  const globbed = isAbsolute(label) ? label : join(cwd, label)
  if (named.some(f => f.glob?.(globbed))) return globbed
  if (isAbsolute(label)) return named.find(f => f.absolute === label)?.path
  const here = join(cwd, label)
  const exact = named.find(f => f.absolute === here)
  if (exact) return exact.path
  const byTail = named.filter(f => !f.glob && f.absolute.endsWith(sep + label))
  return byTail.length === 1 ? byTail[0]!.path : undefined
}

/**
 * The note lines that close a result, and the blank line before them. Left
 * alone unless that blank line is there: then they are not the notes.
 */
function dropNotes(lines: string[]): void {
  let end = lines.length
  while (end > 0 && NOTE_LINE_RE.test(lines[end - 1]!)) end--
  if (end < lines.length && end > 0 && lines[end - 1] === '') {
    lines.length = end - 1
  }
}
