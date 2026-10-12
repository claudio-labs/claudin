// Read-before-edit, by the kind of write (`.claudin/rules/cache.md`):
//   - a whole-file write (FileWriteTool) and a cell write (NotebookEditTool)
//     need the file read whole and unchanged since — `satisfiesReadGate`, then
//     the staleness check and `needsWholeFileRead`;
//   - an in-place write (Patch, FileEditTool) needs any read of the file, or
//     none when its old side sits in the file exactly once — see IN-PLACE
//     WRITES below.
// Every refusal's wording comes from here, so the tools agree about the same
// file state — before this module they did not, which is how the same
// `isPartialView` entry produced "has not been read yet" from Write while Edit
// explained the real problem.
//
// `isPartialView` covers two situations with different causes, and the old
// single message told the model something false about both: it claims the file
// was never read, when in fact the model DID read it and only saw an outline,
// a symbol, or a range. That falsehood costs real round-trips, because a plain
// re-Read of a large code file pivots straight back to an outline
// (AUTO_OUTLINE_ON_ELISION, FileReadTool.ts:2191) and the gate refuses again.
//
// `view='full'` is the remedy for BOTH partial states. It is the one input that
// skips every path that would hand back another outline:
//   - the auto-outline pivot        (FileReadTool.ts:2195, `view === undefined`)
//   - the sticky clip-pin replay    (FileReadTool.ts:763,  `view === undefined`)
//   - the dedup stand-down          (FileReadTool.ts:827,  excludes isPartialView)
// and it writes a clean entry with no `isPartialView` (FileReadTool.ts:2227).
//
// The clip case gets its own wording only because the model needs to know why
// the body it already read is gone — NOT because the remedy differs. An earlier
// version of this module claimed a plain re-Read would "re-arm the real body"
// there; that is wrong and actively harmful. The sticky marker replays the same
// outline for STICKY_REPLAY_BUDGET (= 3) reads before falling through, so
// following that advice means outline → refusal, three times over — the exact
// give-up-and-edit-one-file-at-a-time loop these messages exist to prevent.

import type { FileState, SeenRange } from 'src/shared/fs/fileStateCache.js'

export type ReadGateReason =
  | 'never-read'
  | 'partial-view'
  | 'clipped'
  | 'changed-too-large'

/**
 * The gate of a whole-file or cell write. A type predicate so callers keep
 * their narrowing: every call site touches `state.timestamp` for the
 * staleness check right after.
 */
export function satisfiesReadGate(
  state: FileState | undefined,
): state is FileState {
  return state !== undefined && !state.isPartialView
}

/** Why the gate failed. Only meaningful once `satisfiesReadGate` returned false. */
export function readGateReasonFor(
  state: FileState | undefined,
): ReadGateReason {
  if (!state) return 'never-read'
  if (state.refreshFailed === 'too-large') return 'changed-too-large'
  return state.standDownOutline ? 'clipped' : 'partial-view'
}

/**
 * `subject` is what the tool calls the file ("File", or a display path);
 * `action` completes "before …" ("writing to it", "patching it").
 */
export function readGateMessage(
  reason: ReadGateReason,
  subject: string,
  action: string,
): string {
  switch (reason) {
    case 'never-read':
      return `${subject} has not been read yet. Read it first before ${action}.`
    case 'partial-view':
      return `${subject} has only been seen as an outline or a partial view, not its body. Read it again with view='full' before ${action}.`
    case 'clipped':
      return `${subject} was read, but that Read was clipped out of the transcript, so its body is no longer in context. Read it again with view='full' before ${action} — a plain re-Read can replay the outline instead of the body.`
    case 'changed-too-large':
      return `${subject} changed on disk after you read it and is too large to re-read whole. Read the lines you are changing (offset/limit, or symbol=) before ${action}.`
  }
}

// The whole-file write tools (Write, NotebookEdit) share one phrasing, and
// Edit's never-read refusal opens with the first: FileEditTool/UI.tsx matches
// FILE_NOT_READ_ERROR to render its friendly one-liner, so these stay
// exported as values rather than built per call site.
export const FILE_NOT_READ_ERROR = readGateMessage(
  'never-read',
  'File',
  'writing to it',
)
export const FILE_PARTIAL_VIEW_ERROR = readGateMessage(
  'partial-view',
  'File',
  'writing to it',
)
export const FILE_CLIPPED_VIEW_ERROR = readGateMessage(
  'clipped',
  'File',
  'writing to it',
)
export const FILE_CHANGED_TOO_LARGE_ERROR = readGateMessage(
  'changed-too-large',
  'File',
  'writing to it',
)

/** Refusal text for a write-family tool whose gate already failed. */
export function writeFamilyReadGateError(state: FileState | undefined): string {
  switch (readGateReasonFor(state)) {
    case 'never-read':
      return FILE_NOT_READ_ERROR
    case 'clipped':
      return FILE_CLIPPED_VIEW_ERROR
    case 'changed-too-large':
      return FILE_CHANGED_TOO_LARGE_ERROR
    case 'partial-view':
      return FILE_PARTIAL_VIEW_ERROR
  }
}

// ---------------------------------------------------------------------------
// IN-PLACE WRITES
//
// A write that replaces text inside a file — Patch's hunks, Edit's
// `old_string` — is checked where it lands: its old side has to be in the file
// as it is then. So any earlier read of the file authorizes it (an outline, a
// range, a symbol, a clipped Read, an injected file, a file changed since),
// and a file never read at all is written only when its old side sits in it
// exactly and in one place: the model wrote those bytes, so it has seen them.
// The result then says the file had not been read.
//
// Patch took this rule on 2026-09-24/29 and Edit on 2026-10-12. Edit's own
// lanes — partial view, staleness, coverage — had refused 19 edits in the week
// before, every one an exact match, and 14 came back byte-identical; the
// coverage lane also refused an `old_string` ending with the newline of the
// last line read, twice in a row (edit-write-error-census-2026-10-12).

/**
 * The never-read refusal of an in-place write whose old side does not sit in
 * the file exactly once: `mismatch` says what did not match, `verb` what the
 * write would have done ("patched", "edited").
 */
export function unreadRefusal(neverRead: string, mismatch: string, verb: string): string {
  return `${neverRead} ${mismatch}, so it was not ${verb} unread.`
}

/** The line a result carries when it wrote a file never read. */
export function appliedUnreadNote(names: string, how: string): string {
  return `Note: ${names} had not been read — ${how}.`
}

// ---------------------------------------------------------------------------
// WHOLE-FILE COVERAGE
//
// `satisfiesReadGate` answers "has the model seen this file at all", and a
// Read of a range writes an entry with NO `isPartialView` (FileReadTool.ts,
// and the same for `symbol=`). A Write over an existing file replaces all of
// it, so it also needs the entry to stand for the whole file — or the unread
// remainder would be dropped. In-place writes are not held to this: their old
// side is matched against the file when they land.
//
// This is deliberately NOT implemented by marking range reads
// `isPartialView`. A `symbol=` read IS a range read, and makeUnfoldData
// (FileReadTool.ts) keeps those entries editable on purpose — the outline →
// symbol → edit flow is the whole point of the auto-outline pivot.
//
// Killswitch: CLAUDIN_DISABLE_READ_COVERAGE_GATE=1.
//
// NotebookEdit is out of scope, unlike in the gate above: it addresses cells
// by id, so there is no whole file to replace.

export function coverageGateEnabled(): boolean {
  return process.env.CLAUDIN_DISABLE_READ_COVERAGE_GATE !== '1'
}

/**
 * The entry stands for the whole file: a full Read (`offset === 1`, no limit)
 * or a post-write entry, which Edit/Write/stagedWrite/BashTool all store with
 * `offset: undefined` and the complete new content.
 */
export function isWholeFileView(state: FileState): boolean {
  return (
    (state.offset === undefined || state.offset === 1) &&
    state.limit === undefined
  )
}

/** True when a whole-file write must be refused for this entry. */
export function needsWholeFileRead(state: FileState): boolean {
  return coverageGateEnabled() && !isWholeFileView(state)
}

/**
 * Whether the reads of this file version, taken together, hold every line of
 * `fileText`. A whole Read followed by a range Read leaves a range entry that
 * carries the whole one (`carrySeenRanges`), and so do two ranges that meet:
 * the model has seen it all, and `needsWholeFileRead` alone refused it as
 * "only read in part (lines 1-275)" of a 275-line file.
 */
export function seenWholeFile(state: FileState, fileText: string): boolean {
  const total = sliceLines(fileText).length
  const first = coveredSegments(state)[0]
  return total === 0 || (first?.offset === 1 && first.lines.length >= total)
}

/**
 * The lines a slice holds, with the trailing newline's phantom line dropped —
 * the reading `seenRangeLabel` has always used.
 *
 * It is genuinely ambiguous: content ending in `\n` is either N lines whose
 * last one is blank, or N-1 lines plus a terminator. Taking it as a terminator
 * under-counts by one when the slice really did end on a blank line, which can
 * split an adjacency into a gap and refuse a write it should have allowed —
 * 1 of 40 refusals in the corpus replay. The other reading would instead claim
 * coverage of a line nobody read, so the miss stays on the safe side.
 */
function sliceLines(content: string): string[] {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  return body === '' ? [] : body.split('\n')
}

/** A maximal run of consecutive lines the model has been shown. */
export type SeenSegment = { offset: number; lines: string[] }

/**
 * Everything the model has seen of this file version, as contiguous runs: the
 * entry's own slice plus the earlier ones `carrySeenRanges` kept
 * (`fileStateCache.ts`), merged by line number.
 *
 * Merging is what keeps the accumulation honest. Two slices join only when
 * they touch or overlap, so a hole between them stays a hole — the
 * alternative, concatenating the slices, would invent adjacency the model
 * never saw.
 */
export function coveredSegments(state: FileState): SeenSegment[] {
  const slices: SeenRange[] = [
    ...(state.seenRanges ?? []),
    { offset: state.offset ?? 1, content: state.content },
  ]
  const sorted = slices
    .map(slice => ({ offset: slice.offset, lines: sliceLines(slice.content) }))
    .filter(slice => slice.lines.length > 0)
    .sort((a, b) => a.offset - b.offset)

  const merged: SeenSegment[] = []
  for (const slice of sorted) {
    const last = merged[merged.length - 1]
    if (!last || slice.offset > last.offset + last.lines.length) {
      merged.push({ offset: slice.offset, lines: [...slice.lines] })
      continue
    }
    // Touching or overlapping: append only the part past what `last` already
    // covers. A slice entirely inside `last` contributes nothing.
    const overlap = last.offset + last.lines.length - slice.offset
    last.lines.push(...slice.lines.slice(Math.max(0, overlap)))
  }
  return merged
}

/**
 * "lines 266-273", or "lines 1-40, 266-273" once the entry carries earlier
 * reads. Listing every segment is not cosmetic: the refusal tells the model
 * what it has already been shown, and naming only the last read would send it
 * to re-read lines it is holding.
 */
export function seenRangeLabel(state: FileState): string {
  const segments = coveredSegments(state)
  if (segments.length === 0) return 'no lines'
  const spans = segments.map(({ offset, lines }) =>
    lines.length === 1 ? `${offset}` : `${offset}-${offset + lines.length - 1}`,
  )
  const singular = segments.length === 1 && segments[0]!.lines.length === 1
  return `${singular ? 'line' : 'lines'} ${spans.join(', ')}`
}

/** `operation` names the write in the third person ("Writing to it"). */
export function wholeFileRequiredMessage(
  subject: string,
  operation: string,
  state: FileState,
): string {
  return `${subject} was only read in part (${seenRangeLabel(state)}). ${operation} replaces the whole file, so read all of it with view='full' first.`
}
