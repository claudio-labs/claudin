// Elision placeholders in an edit's new text: a comment standing in for code
// (`// ... existing code ...`, `# ... rest of the file unchanged`). Edits
// replace text literally, so the line lands in the file and the code it stands
// for is gone. Plandex detects the same markers so its builder model can expand
// them against the original; here the main model writes the edit itself, so
// Edit, Write and Patch refuse it and the model sends the full code.
//
// A line counts only when it is a comment and nothing else, and its body is a
// bare ellipsis or opens/closes with one around a placeholder phrase
// (`existing code`, `rest of the file`, `methods unchanged`, `same as before`,
// `other functions` …) — and the old text does not already hold that line.
// Single words do not count: `// Retry against the other replicas...` is
// prose. Neither do doc-comment continuations (` *`, `///`, `//!`), where an
// ellipsis is an example's body, string literals holding the marker (a test
// fixture), kept comments or prose files. A literal comment gets through
// without its ellipsis, which the refusal says. Killswitch:
// CLAUDIN_ELISION_GUARD=0.
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

/** A line that is a comment and nothing else — not a doc-comment continuation; group 1 is its body. */
const COMMENT_ONLY_RE = /^\s*(?:\/\/(?![/!])|#+|--|;+|\/\*+|<!--|\{\s*\/\*+)(.*)$/
/** Comment closers trailing the body: `*\/`, `-->`, `*\/}`. */
const COMMENT_CLOSER_RE = /\s*(?:\*+\/\s*\}?|-->)\s*$/
const BARE_ELLIPSIS_RE = /^(?:\.{3,}|…)(?:\s*(?:\.{3,}|…))*$/
const EDGE_ELLIPSIS_RE = /^(?:\.{3,}|…)|(?:\.{3,}|…)\)?$/
/** What a placeholder stands for: code, or a kind of member or part of a file. */
const STANDS_FOR =
  '(?:code|implementation|logic|content|jsx|markup|elements|methods|functions|helpers|imports|exports|tests|cases|fields|properties|props|columns|rows|keys|entries|options|styles|rules|sections|lines|handlers|routes|components|body|file|class|module|function|method|component|test|script|config|template|query|schema)'
const PLACEHOLDER_PHRASE_RE = new RegExp(
  `\\b(?:(?:existing|remaining|other|previous) ${STANDS_FOR}|rest of (?:the )?${STANDS_FOR}|${STANDS_FOR} unchanged|(?:remains?|stays?|is|are|left) unchanged|same as before)\\b`,
  'i',
)

function isPlaceholderComment(line: string): boolean {
  const comment = COMMENT_ONLY_RE.exec(line)
  if (!comment) return false
  const body = comment[1]!.replace(COMMENT_CLOSER_RE, '').trim()
  // A closer before the end means code follows the comment on this line.
  if (body.includes('*/') || body.includes('-->')) return false
  if (BARE_ELLIPSIS_RE.test(body)) return true
  return EDGE_ELLIPSIS_RE.test(body) && PLACEHOLDER_PHRASE_RE.test(body)
}

/**
 * The first line of `newText` that is an elision placeholder `oldText` does
 * not already hold, or `null`. `oldText` may be a thunk, read only when a
 * candidate line turns up. `filePath` only says whether the file is prose;
 * prose is never checked.
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
