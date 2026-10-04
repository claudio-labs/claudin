import React, { type ReactNode, useCallback, useMemo, useReducer, useRef } from 'react'
import {
  answerWith,
  hintFor,
  initialPromptState,
  isNoteOpen,
  type Notes,
  type PromptEvent,
  type PromptState,
  reducePrompt,
} from 'src/permissions/ui/prompt/answerModel.js'
import { useBoundOptions } from 'src/permissions/ui/prompt/useBoundOptions.js'
import { type OptionWithDescription, Select } from 'src/terminal/custom-select/select.js'
import { Box, Text } from 'src/terminal/ink.js'
import type { KeybindingAction } from 'src/terminal/keybindings/types.js'
import { type AppState, useSetAppState } from 'src/terminal/state/AppState.js'

export type FeedbackType = 'accept' | 'reject'

export type PermissionPromptOption<T extends string> = {
  value: T
  label: ReactNode
  feedbackConfig?: {
    type: FeedbackType
    placeholder?: string
  }
  keybinding?: KeybindingAction
}

export type ToolAnalyticsContext = {
  toolName: string
  isMcp: boolean
}

export type PermissionPromptProps<T extends string> = {
  options: PermissionPromptOption<T>[]
  onSelect: (value: T, feedback?: string) => void
  onCancel?: () => void
  question?: string | ReactNode
  toolAnalyticsContext?: ToolAnalyticsContext
}

const DEFAULT_QUESTION = 'Do you want to proceed?'

// User hooks may match on this wording, so it changes only with the dialogs' own.
const NOTE_PROMPTS: Record<FeedbackType, string> = {
  accept: 'tell Claude what to do next',
  reject: 'tell Claude what to do differently',
}

function countEscape(state: AppState): AppState {
  return { ...state, attribution: { ...state.attribution, escapeCount: state.attribution.escapeCount + 1 } }
}

/** An option whose note is open becomes a text field showing `<label>, <note>`; any other stays a plain row. */
function toListOption<T extends string>(
  option: PermissionPromptOption<T>,
  notes: Notes,
  dispatch: (event: PromptEvent<T>) => void,
): OptionWithDescription<T> {
  const note = option.feedbackConfig
  if (!note || !notes[note.type].open) return { value: option.value, label: option.label }
  return {
    type: 'input',
    value: option.value,
    label: option.label,
    placeholder: note.placeholder ?? NOTE_PROMPTS[note.type],
    onChange: text => dispatch({ type: 'writeNote', kind: note.type, text }),
    // Enter on an empty note answers with the option; it never cancels.
    allowEmptySubmitToCancel: true,
    showLabelWithValue: true,
  }
}

/**
 * The question, its numbered options and the key hints. Enter or a digit
 * answers; Esc counts an escape and cancels; Tab opens a note on an option
 * that takes one.
 */
export function PermissionPrompt<T extends string>({
  options,
  onSelect,
  onCancel,
  question = DEFAULT_QUESTION,
}: PermissionPromptProps<T>): React.ReactNode {
  const setAppState = useSetAppState()
  const [state, dispatch] = useReducer(
    (current: PromptState<T>, event: PromptEvent<T>) => reducePrompt(current, event, options),
    options,
    initialPromptState,
  )
  // Select calls back from key handlers bound at an earlier render; answer from the latest notes.
  const latest = useRef(state)
  latest.current = state

  const choose = useCallback(
    (value: T) => {
      const answer = answerWith(latest.current, options, value)
      if (answer.type === 'select') onSelect(answer.value, answer.note)
    },
    [options, onSelect],
  )

  const cancel = useCallback(() => {
    setAppState(countEscape)
    onCancel?.()
  }, [setAppState, onCancel])

  const point = useCallback((value: T) => dispatch({ type: 'point', value }), [])
  const toggleNote = useCallback((value: T) => dispatch({ type: 'toggleNote', value }), [])

  const listOptions = useMemo(() => options.map(option => toListOption(option, state.notes, dispatch)), [options, state.notes])

  useBoundOptions(options, choose, !isNoteOpen(state, options, state.pointer))

  return (
    <Box flexDirection="column">
      {typeof question === 'string' ? <Text>{question}</Text> : question}
      <Select
        options={listOptions}
        visibleOptionCount={options.length}
        onChange={choose}
        onCancel={cancel}
        onFocus={point}
        onInputModeToggle={toggleNote}
      />
      <Box marginTop={1}>
        <Text dimColor>{hintFor(state, options)}</Text>
      </Box>
    </Box>
  )
}
