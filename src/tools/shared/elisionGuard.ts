// Elision placeholders in an edit's new text: a comment standing in for code
// (`// ... existing code ...`, `# ... rest of the file unchanged`). Edits
// replace text literally, so the line lands in the file and the code it stands
// for is gone. Plandex detects the same markers so its builder model can expand
// them against the original; here the main model writes the edit itself, so
// Edit, Write and Patch refuse it and the model sends the full code.
//
// A line counts only when it is a comment and nothing else, and its body is a
// bare ellipsis or opens/closes with one while naming what it stands for — and
// the old text does not already hold that line. A kept comment, a string
// literal holding the marker (a test fixture) and prose files never trip it;
// a literal comment gets through without its ellipsis, which the refusal says.
// Killswitch: CLAUDIN_ELISION_GUARD=0.
import { extname } from 'path'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export type ElisionPlaceholder = {
  /** 1-based line of the placeholder in the new text. */
  line: number
  text: string
}

const PROSE_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
  '.org',
])

/** A line that is a comment and nothing else; group 1 is the comment's body. */
const COMMENT_ONLY_RE = /^\s*(?:\/\/+|#+|--|;+|\/\*+|\*|<!--|\{\s*\/\*+)(.*)$/
/** Comment closers trailing the body: `*\/`, `-->`, `*\/}`. */
const COMMENT_CLOSER_RE = /\s*(?:\*+\/\s*\}?|-->)\s*$/
const BARE_ELLIPSIS_RE = /^(?:\.{3,}|…)(?:\s*(?:\.{3,}|…))*$/
const EDGE_ELLIPSIS_RE = /^(?:\.{3,}|…)|(?:\.{3,}|…)\)?$/
const PLACEHOLDER_WORD_RE =
  /\b(?:existing|rest of|remaining|unchanged|same|previous|other|omitted|elided|as before|etc)\b/i

function isPlaceholderComment(line: string): boolean {
  const comment = COMMENT_ONLY_RE.exec(line)
  if (!comment) return false
  const body = comment[1]!.replace(COMMENT_CLOSER_RE, '').trim()
  // A closer before the end means code follows the comment on this line.
  if (body.includes('*/') || body.includes('-->')) return false
  if (BARE_ELLIPSIS_RE.test(body)) return true
  return EDGE_ELLIPSIS_RE.test(body) && PLACEHOLDER_WORD_RE.test(body)
}

/**
 * The first line of `newText` that is an elision placeholder `oldText` does
 * not already hold, or `null`. `oldText` may be a thunk, read only when a
 * candidate line turns up. `filePath` only decides whether the file is prose,
 * which is never checked.
 */
export function findElisionPlaceholder(
  newText: string,
  oldText: string | (() => string),
  filePath: string,
): ElisionPlaceholder | null {
  if (isEnvDefinedFalsy(process.env.CLAUDIN_ELISION_GUARD)) return null
  if (PROSE_EXTENSIONS.has(extname(filePath).toLowerCase())) return null
  const lines = newText.split('\n')
  let oldLines: Set<string> | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!isPlaceholderComment(line)) continue
    oldLines ??= new Set(
      (typeof oldText === 'function' ? oldText() : oldText)
        .split('\n')
        .map(l => l.trim()),
    )
    if (oldLines.has(line.trim())) continue
    return { line: i + 1, text: line.trim() }
  }
  return null
}

/** The refusal: `subject` names where the line sits ("Edit refused: new_string line 14"). */
export function elisionRefusal(
  subject: string,
  found: ElisionPlaceholder,
): string {
  return (
    `${subject} is an elision placeholder:\n    ${found.text}\n` +
    'Edits replace text literally — this line would be written into the file and the code it stands for deleted. ' +
    'Write the full code instead. If the comment is meant literally, write it without the ellipsis.'
  )
}
