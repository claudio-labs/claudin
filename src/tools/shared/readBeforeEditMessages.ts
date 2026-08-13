// Read-before-edit refusals, shared by the four tools `.claudin/rules/cache.md`
// names as bound by the invariant: FileEditTool, FileWriteTool, applyPatch and
// NotebookEditTool. They must agree about the same file state — before this
// module they did not, which is how the same `isPartialView` entry produced
// "has not been read yet" from Write while Edit explained the real problem.
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

import type { FileState } from '../../utils/fileStateCache.js'

export type ReadGateReason = 'never-read' | 'partial-view' | 'clipped'

/**
 * The gate itself — the condition `.claudin/rules/cache.md` binds all four
 * tools to. A type predicate so callers keep their narrowing: every call site
 * touches `state.timestamp` for the staleness check right after.
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
  }
}

// The write-tool family (Edit / Write / NotebookEdit) shares one phrasing.
// FileEditTool/UI.tsx matches on these exact constants to render its friendly
// one-liner, so they stay exported as values rather than built per call site.
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

/** Refusal text for a write-family tool whose gate already failed. */
export function writeFamilyReadGateError(state: FileState | undefined): string {
  switch (readGateReasonFor(state)) {
    case 'never-read':
      return FILE_NOT_READ_ERROR
    case 'clipped':
      return FILE_CLIPPED_VIEW_ERROR
    case 'partial-view':
      return FILE_PARTIAL_VIEW_ERROR
  }
}

// ---------------------------------------------------------------------------
// COVERAGE LANE
//
// The gate above answers "has the model seen this file at all". It does not
// answer "has it seen the lines it is about to change", and those came apart
// in practice: a Read of a range writes an entry with NO `isPartialView`
// (FileReadTool.ts:2268, and :1886 for `symbol=`), so eight lines of a
// 2,200-line file authorized a patch anywhere in it. Measured on 2026-08-12
// (session 9825fb93): a three-file "has not been read yet" refusal was
// answered with three token-sized range Reads — `offset 1 limit 5`,
// `offset 266 limit 8`, `offset 98 limit 8` — and the identical patch then
// applied. Four round-trips, no read-before-edit guarantee bought.
//
// So: a line-scoped write (an apply_patch Update hunk, Edit's `old_string`)
// must land inside the bytes the entry actually carries, and a whole-file
// write (apply_patch's Delete File, Write over an existing file) needs an
// entry that stands for the whole file.
//
// This is deliberately NOT implemented by marking range reads
// `isPartialView`. A `symbol=` read IS a range read, and makeUnfoldData
// (FileReadTool.ts:1868-1873) keeps those entries editable on purpose — the
// outline → symbol → edit flow is the whole point of the auto-outline pivot,
// and sending it back through `view='full'` would re-read entire 2k-line
// files to change one function. What the model saw is the right unit here,
// not how it asked to see it.
//
// Killswitch: CLAUDIN_DISABLE_READ_COVERAGE_GATE=1.
//
// NotebookEdit is out of scope, unlike in the gate above: it addresses cells
// by id, so there is no run of text to locate in what was read.

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

// Sentinel-wrapped, per-line-trimmed form, so `includes` can only match on
// line boundaries. Trimming is on purpose: the callers' own matchers are
// whitespace-tolerant (Edit re-indents a fuzzy match, patchFormat has a fuzzy
// context pass), and this lane must never be the stricter of the two — its
// question is "did you see this region", not "does this text apply".
function lineBlock(text: string): string {
  return `\n${text
    .split('\n')
    .map(line => line.trim())
    .join('\n')}\n`
}

/**
 * Does what the model actually read contain this run of lines? `needed` is the
 * OLD side of the write: an Update chunk's context+removed lines, or Edit's
 * `old_string` split into lines.
 */
export function seenRegionCovers(
  state: FileState,
  needed: string[],
): boolean {
  if (!coverageGateEnabled()) return true
  // A whole-file entry carries the file, so containment would pass anyway —
  // except for a read the byte cap truncated, or a needle Edit's quote
  // normalization rewrote. Short-circuit rather than turn either into a
  // refusal the model cannot act on.
  if (isWholeFileView(state)) return true
  if (needed.length === 0) return true
  // Blank lines localize nothing; refusing on them would be noise.
  if (needed.every(line => line.trim() === '')) return true
  return lineBlock(state.content).includes(lineBlock(needed.join('\n')))
}

/** "lines 266-273" — what the entry's content actually spans. */
export function seenRangeLabel(state: FileState): string {
  const body = state.content.endsWith('\n')
    ? state.content.slice(0, -1)
    : state.content
  const count = body === '' ? 0 : body.split('\n').length
  if (count === 0) return 'no lines'
  const start = state.offset ?? 1
  return count === 1
    ? `line ${start}`
    : `lines ${start}-${start + count - 1}`
}

/**
 * `subject` is what the tool calls the file ("File", or a display path);
 * `action` completes "before …" ("patching it", "editing it").
 */
export function unseenRegionMessage(
  subject: string,
  action: string,
  state: FileState,
): string {
  return `${subject} was only read in part (${seenRangeLabel(state)}), and the lines you are changing are not in what you read. Read the lines you are changing — or the whole file with view='full' — before ${action}.`
}

/** `operation` names the write in the third person ("Deleting it"). */
export function wholeFileRequiredMessage(
  subject: string,
  operation: string,
  state: FileState,
): string {
  return `${subject} was only read in part (${seenRangeLabel(state)}). ${operation} replaces the whole file, so read all of it with view='full' first.`
}
