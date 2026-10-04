/**
 * The answer model of PermissionPrompt, kept free of Ink so it can be tested
 * on its own: where the pointer is, which notes are open, what they say, and
 * what an answer reports.
 *
 * There is one note per kind (`accept`, `reject`), so a note written on an
 * allow can never travel with a deny, nor the other way round.
 */
import type { Key } from 'src/terminal/ink.js'
import type { FeedbackType, PermissionPromptOption } from 'src/permissions/ui/PermissionPrompt.js'

type Note = { open: boolean; text: string }
export type Notes = Readonly<Record<FeedbackType, Note>>

export type PromptState<T extends string> = {
  pointer: T | undefined
  notes: Notes
}

export type PromptEvent<T extends string> =
  | { type: 'point'; value: T }
  | { type: 'toggleNote'; value: T }
  | { type: 'writeNote'; kind: FeedbackType; text: string }

export type PromptAnswer<T extends string> = { type: 'select'; value: T; note: string | undefined } | { type: 'cancel' }

type Options<T extends string> = readonly PermissionPromptOption<T>[]

const CLOSED: Note = { open: false, text: '' }
const NOTE_KINDS: readonly FeedbackType[] = ['accept', 'reject']
const DIGIT = /^[0-9\uFF10-\uFF19]$/

const CANCEL_HINT = 'Esc to cancel'
const AMEND_HINT = ' · Tab to amend'

export function initialPromptState<T extends string>(options: Options<T>): PromptState<T> {
  return { pointer: options[0]?.value, notes: { accept: CLOSED, reject: CLOSED } }
}

function noteKindOf<T extends string>(options: Options<T>, value: T | undefined): FeedbackType | undefined {
  return options.find(option => option.value === value)?.feedbackConfig?.type
}

export function reducePrompt<T extends string>(state: PromptState<T>, event: PromptEvent<T>, options: Options<T>): PromptState<T> {
  switch (event.type) {
    case 'point': {
      // Walking away from a note that holds nothing closes it; a written one stays.
      const kept = noteKindOf(options, event.value)
      const notes = { ...state.notes }
      for (const kind of NOTE_KINDS) {
        if (kind !== kept && notes[kind].open && notes[kind].text === '') notes[kind] = { ...notes[kind], open: false }
      }
      return { pointer: event.value, notes }
    }
    case 'toggleNote': {
      const kind = noteKindOf(options, event.value)
      if (!kind) return state
      const note = state.notes[kind]
      return { ...state, notes: { ...state.notes, [kind]: { ...note, open: !note.open } } }
    }
    case 'writeNote':
      return { ...state, notes: { ...state.notes, [event.kind]: { ...state.notes[event.kind], text: event.text } } }
  }
}

export function isNoteOpen<T extends string>(state: PromptState<T>, options: Options<T>, value: T | undefined): boolean {
  const kind = noteKindOf(options, value)
  return kind !== undefined && state.notes[kind].open
}

/** The answer for choosing `value`: its own kind's note, trimmed, when that note is open. */
export function answerWith<T extends string>(state: PromptState<T>, options: Options<T>, value: T): PromptAnswer<T> {
  const kind = noteKindOf(options, value)
  const text = kind && state.notes[kind].open ? state.notes[kind].text.trim() : ''
  return { type: 'select', value, note: text === '' ? undefined : text }
}

export function hintFor<T extends string>(state: PromptState<T>, options: Options<T>): string {
  const amendable = noteKindOf(options, state.pointer) !== undefined && !isNoteOpen(state, options, state.pointer)
  return amendable ? CANCEL_HINT + AMEND_HINT : CANCEL_HINT
}

/**
 * Keys the option list answers or moves with. A key binding on an option
 * must never fire through one of these, or a binding could answer for an
 * option the pointer is not on (Enter is `confirm:yes` by default).
 */
export function isListKey(input: string, key: Key): boolean {
  return (
    key.return || key.escape || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown || input === ' ' || DIGIT.test(input)
  )
}

/** The option a fired action answers with, if any option is bound to it. */
export function boundOptionFor<T extends string>(options: Options<T>, action: string): PermissionPromptOption<T> | undefined {
  return options.find(option => option.keybinding === action)
}
