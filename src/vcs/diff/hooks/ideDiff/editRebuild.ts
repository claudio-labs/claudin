import type { StructuredPatchHunk } from 'diff'
import type { FileEdit } from 'src/tools/FileEditTool/types.js'
import { getPatchFromContents } from 'src/vcs/git/diff.js'

/** The whole text as one edit: what the file-write dialog writes back. */
export function wholeTextEdit(oldText: string, newText: string): FileEdit[] {
  return [{ old_string: oldText, new_string: newText, replace_all: false }]
}

/**
 * One edit per changed region, each with the unified diff's context lines.
 * A region that reaches the end of a text keeps that text's final newline, so
 * a change to the final newline alone survives the round trip (finding 3).
 */
export function regionEdits(filePath: string, oldText: string, newText: string): FileEdit[] {
  if (oldText === newText) return []
  const hunks = getPatchFromContents({ filePath, oldContent: oldText, newContent: newText })
  // A diff that timed out has no hunks; the whole text is still a correct edit.
  if (hunks.length === 0) return wholeTextEdit(oldText, newText)

  const oldSide = textSide(oldText)
  const newSide = textSide(newText)
  return hunks.map(hunk => ({
    old_string: oldSide.render(linesOf(hunk, '-'), hunk.oldStart, hunk.oldLines),
    new_string: newSide.render(linesOf(hunk, '+'), hunk.newStart, hunk.newLines),
    replace_all: false,
  }))
}

/** The hunk's lines as one side reads them: context plus that side's changes. */
function linesOf(hunk: StructuredPatchHunk, marker: '-' | '+'): string[] {
  const kept: string[] = []
  for (const line of hunk.lines) {
    if (line.startsWith(' ') || line.startsWith(marker)) kept.push(line.slice(1))
  }
  return kept
}

type TextSide = {
  render(lines: string[], start: number, count: number): string
}

function textSide(text: string): TextSide {
  const endsWithNewline = text.endsWith('\n')
  const total = text === '' ? 0 : text.split('\n').length - (endsWithNewline ? 1 : 0)
  return {
    render(lines, start, count) {
      const reachesEnd = count > 0 && start + count - 1 >= total
      return lines.join('\n') + (reachesEnd && endsWithNewline ? '\n' : '')
    },
  }
}
