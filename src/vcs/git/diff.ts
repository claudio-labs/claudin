import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { addToTotalLinesChanged } from 'src/platform/bootstrap/state.js'
import { convertLeadingTabsToSpaces } from 'src/shared/fs/file.js'
import type { FileEdit } from 'src/tools/FileEditTool/types.js'
import { countAddDel } from 'src/vcs/git/diffStat.js'

export const CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 5_000

/** Context wide enough to put every line of a file this long in one hunk. */
const WHOLE_FILE_CONTEXT = 100_000

type ContentsPatchRequest = {
  filePath: string
  oldContent: string
  newContent: string
  ignoreWhitespace?: boolean
  singleHunk?: boolean
}

type DisplayPatchRequest = {
  filePath: string
  fileContents: string
  edits: FileEdit[]
  ignoreWhitespace?: boolean
}

/** The hunks between two texts, exactly as the texts hold them. */
export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
}: ContentsPatchRequest): StructuredPatchHunk[] {
  const patch = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: singleHunk ? WHOLE_FILE_CONTEXT : CONTEXT_LINES,
    ignoreWhitespace,
    timeout: DIFF_TIMEOUT_MS,
  })
  // A diff that runs out of time yields no patch; showing no change beats
  // holding up the dialog that asked for it.
  return patch?.hunks ?? []
}

/**
 * The file as the edits leave it, against the file as it is. Leading tabs are
 * shown as two spaces each, in the file and in the edits alike, so an edit
 * written with spaces still finds a tab-indented line.
 */
export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace = false,
}: DisplayPatchRequest): StructuredPatchHunk[] {
  const before = convertLeadingTabsToSpaces(fileContents)
  const after = edits.reduce((text, edit) => applyEdit(text, asDisplayed(edit)), before)
  return getPatchFromContents({ filePath, oldContent: before, newContent: after, ignoreWhitespace })
}

function asDisplayed(edit: FileEdit): FileEdit {
  return {
    old_string: convertLeadingTabsToSpaces(edit.old_string),
    new_string: convertLeadingTabsToSpaces(edit.new_string),
    replace_all: edit.replace_all,
  }
}

function applyEdit(text: string, { old_string, new_string, replace_all }: FileEdit): string {
  // Through a function, the new text stays literal: `$&`, `$1` and `$$` are
  // not replacement patterns here.
  const replacement = (): string => new_string
  return replace_all ? text.replaceAll(old_string, replacement) : text.replace(old_string, replacement)
}

export function adjustHunkLineNumbers(hunks: StructuredPatchHunk[], offset: number): StructuredPatchHunk[] {
  if (offset === 0) return hunks
  return hunks.map(hunk => ({ ...hunk, oldStart: hunk.oldStart + offset, newStart: hunk.newStart + offset }))
}

/**
 * Adds a change to the session's lines-added and lines-removed totals. With
 * no hunks, a written file counts all of its lines as added.
 */
export function countLinesChanged(patch: StructuredPatchHunk[], newFileContent?: string): void {
  const { additions, deletions } =
    patch.length > 0 ? countAddDel(patch) : { additions: countLines(newFileContent ?? ''), deletions: 0 }
  if (additions > 0 || deletions > 0) addToTotalLinesChanged(additions, deletions)
}

/** A final newline ends the last line; it does not start one more. */
function countLines(text: string): number {
  if (text === '') return 0
  let breaks = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) breaks += 1
  return text.endsWith('\n') ? breaks : breaks + 1
}
