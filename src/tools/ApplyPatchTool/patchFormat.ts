// Pure port of opencode's Codex `apply_patch` envelope parser + applier
// (packages/opencode/src/patch/index.ts), de-Effected for Claudin's Node
// runtime. Differences from the source, on purpose:
//   - BOM-free: callers read/write through Claudin's encoding+lineEnding utils
//     (src/shared/fs/fileRead.ts / writeTextContent), so this module operates on
//     plain LF-normalized text and never touches a BOM.
//   - No `generateUnifiedDiff` (opencode's is a naive placeholder and unused
//     for display) — the tool computes diffs via src/vcs/git/diff.ts.
//   - No `maybeParseApplyPatch` (Bash-invocation detection) — out of scope.
// The parse + fuzzy-match behavior is otherwise identical to the source.

import {
  bestPartialMatch,
  findAllMatches,
  findContaining,
  ignoreSurroundingWs,
  seekSequence,
} from 'src/tools/shared/fuzzyLineMatch.js'

export type Hunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | {
      type: 'update'
      path: string
      movePath?: string
      chunks: UpdateFileChunk[]
    }

export type ChunkLineKind = 'context' | 'add' | 'remove'

export interface ChunkOp {
  kind: ChunkLineKind
  text: string
}

export interface UpdateFileChunk {
  oldLines: string[]
  newLines: string[]
  /**
   * Line-level operations in patch order. Lets the applier preserve the
   * ORIGINAL file bytes for unchanged context lines that a fuzzy pass located
   * despite whitespace/punctuation drift, instead of clobbering them with the
   * patch's (normalized) text — which silently corrupts indentation in
   * whitespace-sensitive files (Python/YAML/Make). Optional: chunks built
   * directly (e.g. in tests) omit it and fall back to carrying newLines.
   */
  ops?: ChunkOp[]
  changeContext?: string
  isEndOfFile?: boolean
}

const ADD_HEADER = '*** Add File:'
const DELETE_HEADER = '*** Delete File:'
const UPDATE_HEADER = '*** Update File:'
const MOVE_HEADER = '*** Move to:'
const BEGIN_MARKER = '*** Begin Patch'
const END_MARKER = '*** End Patch'
const END_OF_FILE_MARKER = '*** End of File'

// A `***`-prefixed line inside an Add/Update body is only a legitimate body
// terminator when it opens the next section (another file header or the End
// Patch marker). Any other `***` line is a malformed body line — most often a
// context/content line that lost its leading space/`+` (a markdown `*** rule`,
// an ASCII banner, or a separator the model dropped between hunks).
//
// `*** Move to:` is intentionally absent: a Move directive is only valid
// immediately after the `*** Update File:` header, where parsePatchHeader
// consumes it — it is never a mid-body boundary. Listing it here made parsePatch
// silently skip a mid-body Move and drop every following chunk while still
// reporting success; excluding it routes that case to the loud throw instead.
// `*** End of File` is likewise absent: the Update body handles it before this
// guard, and it never appears in an Add body.
function isSectionBoundary(line: string): boolean {
  return (
    line.startsWith(ADD_HEADER) ||
    line.startsWith(DELETE_HEADER) ||
    line.startsWith(UPDATE_HEADER) ||
    line.trim() === END_MARKER
  )
}

// Any of the three section headers, used to recognize a patch body whose
// envelope markers are missing. Module-level per repo regex rule.
const SECTION_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File:/

// A body line carrying one of the three diff prefixes. Used inside a chunk,
// and — for the implicit-`@@` repair — to recognize that a chunk has begun
// without its anchor line.
function isChangeLine(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')
}

/** The same file named two ways: an absolute path and the repo-relative one. */
function samePathTarget(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * Where the section bodies start and end. Both markers present is the normal
 * case; a MISSING one is repaired rather than rejected, which is the single
 * biggest parse failure in practice — 14 of 25 measured over 682 sessions on
 * 2026-08-15, 9 having lost the Begin marker and 5 the End one, every body
 * otherwise valid.
 *
 * The repair is safe because a tool call reaches this parser as complete JSON:
 * a model cut off mid-emit never produces a callable `patchText`, so a missing
 * End marker means the marker was forgotten, not that the patch is truncated.
 * It requires a real section header to be present — without one there is no
 * patch here to speak of and the original refusal stands.
 */
function locateEnvelope(lines: string[]): {
  bodyStart: number
  bodyEnd: number
} {
  const beginIdx = lines.findIndex(line => line.trim() === BEGIN_MARKER)
  const endIdx = lines.findIndex(line => line.trim() === END_MARKER)
  if (beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx) {
    return { bodyStart: beginIdx + 1, bodyEnd: endIdx }
  }

  const firstHeader = lines.findIndex(line => SECTION_HEADER_RE.test(line))
  // No section header at all, or both markers present but out of order: this
  // is a malformed envelope, not a forgotten marker.
  if (firstHeader === -1 || (beginIdx !== -1 && endIdx !== -1)) {
    throw new Error('Invalid patch format: missing Begin/End markers')
  }
  const bodyStart =
    beginIdx !== -1 && beginIdx < firstHeader ? beginIdx + 1 : firstHeader
  const bodyEnd = endIdx > firstHeader ? endIdx : lines.length
  if (bodyStart >= bodyEnd) {
    throw new Error('Invalid patch format: missing Begin/End markers')
  }
  return { bodyStart, bodyEnd }
}

// Matches a `cat <<'EOF' ... EOF` / `<<EOF ... EOF` heredoc wrapper, in case a
// model wraps the envelope in one. Module-level per repo regex rule.
const HEREDOC_RE = /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/

function stripHeredoc(input: string): string {
  const match = input.match(HEREDOC_RE)
  return match ? match[2] : input
}

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx]

  // A recognized header with an empty path used to return null, which the
  // parsePatch loop swallowed via `i++; continue` — the whole section (and its
  // body) vanished while the apply still reported success. Throw loudly so a
  // truncated/path-less header can never masquerade as a no-op edit.
  if (line.startsWith(ADD_HEADER)) {
    const filePath = line.slice(ADD_HEADER.length).trim()
    if (!filePath) {
      throw new Error(`Add File header has an empty path: ${JSON.stringify(line)}`)
    }
    return { filePath, nextIdx: startIdx + 1 }
  }

  if (line.startsWith(DELETE_HEADER)) {
    const filePath = line.slice(DELETE_HEADER.length).trim()
    if (!filePath) {
      throw new Error(
        `Delete File header has an empty path: ${JSON.stringify(line)}`,
      )
    }
    return { filePath, nextIdx: startIdx + 1 }
  }

  if (line.startsWith(UPDATE_HEADER)) {
    const filePath = line.slice(UPDATE_HEADER.length).trim()
    if (!filePath) {
      throw new Error(
        `Update File header has an empty path: ${JSON.stringify(line)}`,
      )
    }

    let movePath: string | undefined
    let nextIdx = startIdx + 1

    if (nextIdx < lines.length && lines[nextIdx].startsWith(MOVE_HEADER)) {
      movePath = lines[nextIdx].slice(MOVE_HEADER.length).trim()
      if (!movePath) {
        throw new Error(
          `Move to directive has an empty path: ${JSON.stringify(lines[nextIdx])}`,
        )
      }
      nextIdx++
    }

    return { filePath, movePath, nextIdx }
  }

  return null
}

function parseUpdateFileChunks(
  lines: string[],
  startIdx: number,
  filePath: string,
): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = []
  let i = startIdx

  while (i < lines.length && !lines[i].startsWith('***')) {
    const hasAnchor = lines[i].startsWith('@@')
    // A chunk may open WITHOUT its `@@` line — the model emits the change lines
    // straight after the `*** Update File:` header, or straight after the
    // previous chunk. The anchor is only a search CURSOR, so a missing one is
    // exactly a bare `@@`: the chunk's own lines still have to match the file,
    // and a hunk that matches nowhere is refused by computeReplacements just
    // the same. Rejecting the whole patch bought no safety over that.
    if (hasAnchor || isChangeLine(lines[i])) {
      let changeContext: string | undefined
      if (hasAnchor) {
        changeContext = lines[i].substring(2).trim() || undefined
        i++
      }

      const oldLines: string[] = []
      const newLines: string[] = []
      const ops: ChunkOp[] = []
      let isEndOfFile = false

      while (i < lines.length && !lines[i].startsWith('@@')) {
        const changeLine = lines[i]

        // `*** End of File` ends the chunk and flags the EOF anchor. It must be
        // checked before the generic `***` section-terminator guard below,
        // since the marker itself starts with `***` (in opencode this check was
        // unreachable, leaving the EOF anchor dead — fixed here).
        if (changeLine === END_OF_FILE_MARKER) {
          isEndOfFile = true
          i++
          break
        }

        if (changeLine.startsWith('***')) {
          // A `***` line that opens the next section legitimately ends this
          // chunk; hand control back to parsePatch. Any other `***` line is a
          // malformed body line (a context line missing its leading space — a
          // markdown rule, a banner, a between-hunk separator, or a stray
          // `*** Move to:` that only belongs right after the Update header) that
          // used to silently terminate the section and drop every following
          // chunk while reporting success. Fail loudly, mirroring the
          // unprefixed-line guard below.
          if (isSectionBoundary(changeLine)) {
            break
          }
          throw new Error(
            `Update File '${filePath}' has a body line starting with '***' that is not a section marker (a context line must begin with a space): ${JSON.stringify(
              changeLine,
            )}`,
          )
        }

        if (changeLine.startsWith(' ')) {
          // Context line — present in both old and new.
          const content = changeLine.substring(1)
          oldLines.push(content)
          newLines.push(content)
          ops.push({ kind: 'context', text: content })
        } else if (changeLine.startsWith('-')) {
          const content = changeLine.substring(1)
          oldLines.push(content)
          ops.push({ kind: 'remove', text: content })
        } else if (changeLine.startsWith('+')) {
          const content = changeLine.substring(1)
          newLines.push(content)
          ops.push({ kind: 'add', text: content })
        } else {
          // A body line whose leading space was stripped — a blank line, or the
          // `}` that closes the hunk, which is by far the most common shape (6
          // of 25 parse failures measured on 2026-08-15). Take it as context,
          // WHOLE: nothing is dropped (opencode dropped it, which silently
          // degrades a replacement into an EOF insertion), and the line still
          // has to be in the file — so a `+` the model forgot fails loudly at
          // apply time, with the divergence point named, instead of rejecting
          // an otherwise-correct N-file patch at parse time.
          oldLines.push(changeLine)
          newLines.push(changeLine)
          ops.push({ kind: 'context', text: changeLine })
        }

        i++
      }

      chunks.push({
        oldLines,
        newLines,
        ops,
        changeContext,
        isEndOfFile: isEndOfFile || undefined,
      })
    } else if (lines[i].trim() === '') {
      // A blank line outside any chunk (incidental formatting after the header
      // or after an `*** End of File` marker). Harmless — skip it.
      i++
    } else {
      // A non-blank line that is not part of any `@@` chunk — almost always
      // prose the model emitted between the `*** Update File:` header and the
      // first `@@` (e.g. "Here is my change:"), a line carrying a diff prefix
      // having opened an implicit chunk above. opencode (and our original port)
      // silently skipped these via `i++` while reporting a successful apply, so
      // the text never reached the file. Fail loudly, mirroring the
      // unprefixed-body-line guard above.
      throw new Error(
        `Update File '${filePath}' has a line that is not part of any @@ chunk (text before the first '@@'?): ${JSON.stringify(
          lines[i],
        )}`,
      )
    }
  }

  return { chunks, nextIdx: i }
}

function parseAddFileContent(
  lines: string[],
  startIdx: number,
  filePath: string,
): { content: string; nextIdx: number } {
  let content = ''
  let i = startIdx

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('***')) {
      // A `***` line that opens the next section ends this Add body. Any other
      // `***` line is malformed (a content line that lost its leading `+`, an
      // ASCII banner, a markdown rule). opencode (and our original port) stopped
      // the collector on the *first* `***` of any kind, silently truncating the
      // new file at that point while reporting success. Fail loudly instead,
      // mirroring the Update body guard.
      if (isSectionBoundary(line)) break
      throw new Error(
        `Add File '${filePath}' has a body line starting with '***' that is not a section marker (content lines must begin with '+'): ${JSON.stringify(
          line,
        )}`,
      )
    }

    if (line.startsWith('+')) {
      content += line.substring(1) + '\n'
    } else if (line === '') {
      // A blank content line whose single leading `+` was stripped (a common
      // whitespace artifact). Preserve it as an empty line rather than dropping
      // it, matching the Update body's handling of a stripped blank context line.
      content += '\n'
    } else {
      // Any other unprefixed body line is malformed. opencode silently dropped
      // it, truncating the created file while still reporting success. Fail
      // loudly, mirroring the Update body's unprefixed-line guard.
      throw new Error(
        `Add File '${filePath}' has a content line without a '+' prefix: ${JSON.stringify(
          line,
        )}`,
      )
    }

    i++
  }

  if (content.endsWith('\n')) {
    content = content.slice(0, -1)
  }

  return { content, nextIdx: i }
}

export function parsePatch(patchText: string): { hunks: Hunk[] } {
  const cleaned = stripHeredoc(patchText.trim())
  const lines = cleaned.split('\n')
  const hunks: Hunk[] = []

  const { bodyStart, bodyEnd } = locateEnvelope(lines)

  let i = bodyStart
  while (i < bodyEnd) {
    const header = parsePatchHeader(lines, i)
    if (!header) {
      if (lines[i].trim() === '') {
        // A blank line between sections (or right after the Begin marker) is
        // incidental formatting — skip it.
        i++
        continue
      }
      // A non-blank line where a section header was expected. The usual cause is
      // a header that lost its `*** ` prefix (e.g. `Update File: x`): opencode
      // (and our original port) silently skipped it via `i++; continue` — and
      // then skipped every following body line for the same reason — so the
      // entire edit vanished while the apply reported success. Fail loudly.
      throw new Error(
        `Invalid patch: expected a section header (\`*** Add File:\`, \`*** Update File:\`, or \`*** Delete File:\`) but found: ${JSON.stringify(
          lines[i],
        )}`,
      )
    }

    if (lines[i].startsWith(ADD_HEADER)) {
      const { content, nextIdx } = parseAddFileContent(
        lines,
        header.nextIdx,
        header.filePath,
      )
      hunks.push({ type: 'add', path: header.filePath, contents: content })
      i = nextIdx
    } else if (lines[i].startsWith(DELETE_HEADER)) {
      hunks.push({ type: 'delete', path: header.filePath })
      i = header.nextIdx
    } else if (lines[i].startsWith(UPDATE_HEADER)) {
      const { chunks, nextIdx } = parseUpdateFileChunks(
        lines,
        header.nextIdx,
        header.filePath,
      )
      if (chunks.length === 0) {
        // A chunk-less Update header immediately followed by another Update
        // header for the SAME file is the model naming the path twice — the
        // absolute one, then the repo-relative one — and the body belongs to
        // the second. Drop this header instead of rejecting the patch.
        const next = nextIdx < bodyEnd ? lines[nextIdx] : undefined
        if (
          next?.startsWith(UPDATE_HEADER) &&
          samePathTarget(
            header.filePath,
            next.slice(UPDATE_HEADER.length).trim(),
          )
        ) {
          i = nextIdx
          continue
        }
        // Otherwise: opencode silently produces an empty update (a no-op write)
        // when an Update section has no `@@` chunks; we fail loudly instead so
        // a malformed hunk never masquerades as a successful edit.
        throw new Error(
          `Update File '${header.filePath}' has no @@ chunks (expected a "@@" context line before the changes)`,
        )
      }
      hunks.push({
        type: 'update',
        path: header.filePath,
        movePath: header.movePath,
        chunks,
      })
      i = nextIdx
    } else {
      // Unreachable: parsePatchHeader only returns a header for Add/Delete/Update
      // lines, all handled above. Throw rather than silently skip so the
      // invariant can never regress into a dropped section.
      throw new Error(
        `Invalid patch: unhandled section header: ${JSON.stringify(lines[i])}`,
      )
    }
  }

  return { hunks }
}

/**
 * Builds the replacement segment for a matched region using the chunk's
 * line-level ops. Context lines emit the ORIGINAL file bytes
 * (`originalLines[found + oldPtr]`) rather than the patch's text, so a fuzzy
 * match (trim/Unicode pass) that located a line despite whitespace drift does
 * not rewrite that unchanged line's indentation. Added lines emit the patch
 * text; removed lines consume an original line and emit nothing.
 *
 * `oldLen` is the matched region length (after any trailing-blank trim). A
 * trailing context/remove op beyond `oldLen` is the trimmed blank line and is
 * skipped, mirroring the pattern/newSlice trim in `computeReplacements`.
 */
function rebuildSegment(
  ops: ChunkOp[],
  originalLines: string[],
  found: number,
  oldLen: number,
): string[] {
  const segment: string[] = []
  let oldPtr = 0
  for (const op of ops) {
    if (op.kind === 'add') {
      segment.push(op.text)
    } else if (op.kind === 'remove') {
      if (oldPtr < oldLen) oldPtr++
    } else {
      // context: preserve the original file's bytes for the matched line.
      if (oldPtr < oldLen) {
        segment.push(originalLines[found + oldPtr])
        oldPtr++
      }
    }
  }
  return segment
}

const MAX_ERROR_LINE_CHARS = 200

function excerpt(line: string): string {
  return line.length > MAX_ERROR_LINE_CHARS
    ? `${line.slice(0, MAX_ERROR_LINE_CHARS)}\u2026`
    : line
}

/**
 * Explains a failed old-lines search by naming the point where the model's block
 * stopped agreeing with the file. The previous message echoed the block back,
 * which tells the model only what it already sent — the recovery observed in
 * practice was a blind re-send. The divergence point, plus the file's actual
 * line there, is what makes it a one-shot fix: a dropped intervening line is by
 * far the most common cause.
 */
function describeLineMismatch(
  originalLines: string[],
  pattern: string[],
  searchStart: number,
  filePath: string,
): string {
  const head = `Failed to find expected lines in ${filePath}`
  const best = bestPartialMatch(originalLines, pattern, searchStart)
  if (!best) {
    return (
      `${head}: none of the ${pattern.length} line(s) below appear at or after line ` +
      `${searchStart + 1}. Read the file again and copy the context verbatim — a block ` +
      `that matches nowhere usually means it was written from memory, or aimed at the ` +
      `wrong file.\n${pattern.map(excerpt).join('\n')}`
    )
  }
  const divergedAt = best.index + best.matched
  const fileLine = originalLines[divergedAt]
  return (
    `${head}: line(s) 1-${best.matched} of your hunk match starting at line ` +
    `${best.index + 1}, then line ${best.matched + 1} diverges.\n` +
    `  your line ${best.matched + 1}: ${excerpt(pattern[best.matched])}\n` +
    (fileLine === undefined
      ? '  the file ends there\n'
      : `  file line ${divergedAt + 1}: ${excerpt(fileLine)}\n`) +
    'Re-read that region and copy every line in between — a dropped intervening ' +
    'line is the usual cause.'
  )
}

/**
 * Explains an `@@` anchor that never resolved. The out-of-order case is worth
 * separating: naming one function signature as the anchor of several hunks is a
 * natural reading of the format, and the cursor only moves forward, so the
 * second hunk's anchor is "missing" only in the sense of being behind it.
 */
function describeContextMismatch(
  originalLines: string[],
  anchor: string,
  searchStart: number,
  filePath: string,
): string {
  const head = `Failed to find context '${anchor}' in ${filePath}`
  const earlier = searchStart > 0 ? seekSequence(originalLines, [anchor], 0) : -1
  if (earlier !== -1 && earlier < searchStart) {
    return (
      `${head}: it matches line ${earlier + 1}, which is before the previous hunk — the ` +
      `search resumes at line ${searchStart + 1}. Hunks apply top-to-bottom, so each '@@' ` +
      `must sit at or after the one before it. Give this hunk its own nearby anchor, or a ` +
      `bare '@@'.`
    )
  }
  return (
    `${head}: no line matches it at or after line ${searchStart + 1}. '@@' is matched ` +
    `against a WHOLE line — copy one verbatim from the file, or write a bare '@@' and let ` +
    `the hunk's own context lines locate it.`
  )
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = []
  let lineIndex = 0

  for (const chunk of chunks) {
    // The `@@` line is a one-line search CURSOR, not a unified-diff header: the
    // hunk's own old lines still have to match wherever it lands. Every rescue
    // below therefore only WIDENS where the search may start — none of them
    // relocates an edit that the anchor had already placed.
    let anchorIdx = -1
    if (chunk.changeContext) {
      anchorIdx = seekSequence(originalLines, [chunk.changeContext], lineIndex)
      if (anchorIdx === -1) {
        // The anchor was truncated to a fragment of the real line
        // (`@@ function foo(` for `export function foo(x: T): R {`). Accept it
        // only when exactly one line contains the fragment — with several
        // candidates there is no way to tell which was meant.
        const containing = findContaining(
          originalLines,
          chunk.changeContext,
          lineIndex,
        )
        if (containing.length === 1) anchorIdx = containing[0]
      }
    }

    const searchStart = anchorIdx === -1 ? lineIndex : anchorIdx + 1
    if (anchorIdx !== -1) lineIndex = searchStart

    // Pure insertion (no removed lines). With an explicit `@@` anchor, insert
    // right after the anchored line (lineIndex now points just past it).
    // Without an anchor, append at EOF (before any trailing blank line).
    // Previously the anchor was ignored and every pure insertion landed at EOF.
    // An anchor that did NOT resolve is fatal here: there are no old lines to
    // fall back on, so appending at EOF would report success for an edit that
    // landed nowhere near the target.
    if (chunk.oldLines.length === 0) {
      if (chunk.changeContext && anchorIdx === -1) {
        throw new Error(
          describeContextMismatch(
            originalLines,
            chunk.changeContext,
            lineIndex,
            filePath,
          ),
        )
      }
      const insertionIdx = chunk.changeContext
        ? searchStart
        : originalLines.length > 0 &&
            originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length
      replacements.push([insertionIdx, 0, chunk.newLines])
      continue
    }

    let pattern = chunk.oldLines
    let newSlice = chunk.newLines
    let found = seekSequence(
      originalLines,
      pattern,
      searchStart,
      chunk.isEndOfFile,
    )

    // Retry without a trailing empty line if the first match failed.
    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1)
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1)
      }
      found = seekSequence(originalLines, pattern, searchStart, chunk.isEndOfFile)
    }

    // The anchor restated as the hunk's first line — `@@ foo` followed by ` foo`,
    // the habit unified diff teaches. `searchStart` sits one line PAST the
    // anchor, so that shape demands the anchored line twice in a row. Retrying
    // from the anchor itself adds exactly one candidate start, and it can only
    // match when the hunk's first line IS the anchored line.
    if (found === -1 && anchorIdx !== -1) {
      found = seekSequence(originalLines, pattern, anchorIdx, chunk.isEndOfFile)
    }

    if (found === -1) {
      throw new Error(
        chunk.changeContext && anchorIdx === -1
          ? describeContextMismatch(
              originalLines,
              chunk.changeContext,
              lineIndex,
              filePath,
            )
          : describeLineMismatch(
              originalLines,
              pattern,
              anchorIdx === -1 ? searchStart : anchorIdx,
              filePath,
            ),
      )
    }

    // The anchor never resolved, so this match was located WITHOUT it. Accept it
    // only when it is the sole candidate: an anchor nobody can find cannot have
    // been disambiguating anything, but silently picking one of several regions
    // would be a wrong edit reported as success.
    if (chunk.changeContext && anchorIdx === -1) {
      const candidates = findAllMatches(
        originalLines,
        pattern,
        ignoreSurroundingWs,
      )
      if (candidates.filter(i => i >= lineIndex).length > 1) {
        throw new Error(
          describeContextMismatch(
            originalLines,
            chunk.changeContext,
            lineIndex,
            filePath,
          ),
        )
      }
    }

    const segment = chunk.ops
      ? rebuildSegment(chunk.ops, originalLines, found, pattern.length)
      : newSlice
    replacements.push([found, pattern.length, segment])
    lineIndex = found + pattern.length
  }

  replacements.sort((a, b) => a[0] - b[0])

  // Adjacent replacements must not overlap. Sequential chunks normally can't —
  // each searches past the previous match — but a pure insertion's index is
  // computed independently (EOF / @@ anchor) without advancing the search
  // cursor, so it can land inside a later chunk's removal span. applyReplacements
  // splices each range independently in reverse, so an overlap would let the
  // wider removal silently swallow the inserted lines while reporting success.
  // Treat conflicting hunks as a hard error instead.
  for (let k = 1; k < replacements.length; k++) {
    const [prevStart, prevLen] = replacements[k - 1]
    const [currStart] = replacements[k]
    if (currStart < prevStart + prevLen) {
      throw new Error(
        `Overlapping edits in ${filePath}: a chunk at line ${currStart + 1} ` +
          `falls inside an earlier chunk's span (lines ${prevStart + 1}-${
            prevStart + prevLen
          }). The patch's hunks conflict — often a pure insertion colliding ` +
          `with a nearby removal.`,
      )
    }
  }

  return replacements
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const result = [...lines]

  // Apply in reverse so earlier indices stay valid as we splice.
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i]
    result.splice(startIdx, oldLen)
    for (let j = 0; j < newSegment.length; j++) {
      result.splice(startIdx + j, 0, newSegment[j])
    }
  }

  return result
}

/**
 * Applies an Update hunk's chunks to the original file text (LF-normalized,
 * no BOM) and returns the new content with a trailing newline. Throws if any
 * chunk's context/old lines can't be located (after the 4-pass fuzzy match).
 */
export function deriveNewContentsFromChunks(
  filePath: string,
  chunks: UpdateFileChunk[],
  originalText: string,
): string {
  const originalLines = originalText.split('\n')

  // Drop a trailing empty element so line counting matches the source.
  if (
    originalLines.length > 0 &&
    originalLines[originalLines.length - 1] === ''
  ) {
    originalLines.pop()
  }

  const replacements = computeReplacements(originalLines, filePath, chunks)
  const newLines = applyReplacements(originalLines, replacements)

  // Ensure a trailing newline (last element becomes '').
  if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
    newLines.push('')
  }

  return newLines.join('\n')
}
