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
