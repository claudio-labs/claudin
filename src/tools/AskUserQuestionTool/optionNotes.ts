import type { Question } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'

/** The notes the user wrote on a question's options, keyed by option label. */
export type OptionNotes = Record<string, string>

const WHITESPACE_RUN_RE = /\s+/g

/** A note as it is shown and sent: one line, whitespace runs collapsed. */
export function normalizeNote(note: string): string {
  return note.replace(WHITESPACE_RUN_RE, ' ').trim()
}

/**
 * A question's notes as `annotations[question].notes` carries them to the
 * model: one `"<label>": <note>` line per commented option, in option order.
 * A note on an option the question no longer has is dropped.
 */
export function formatOptionNotes(
  question: Question,
  notes: OptionNotes | undefined,
): string | undefined {
  if (!notes) return undefined
  const lines = question.options.flatMap(option => {
    const note = normalizeNote(notes[option.label] ?? '')
    return note ? [`"${option.label}": ${note}`] : []
  })
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** The lines of a formatted `notes` string, for the review and the transcript. */
export function noteLines(notes: string | undefined): string[] {
  return notes ? notes.split('\n').filter(line => line.trim() !== '') : []
}
