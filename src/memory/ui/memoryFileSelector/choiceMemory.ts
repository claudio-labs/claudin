import { TIDY_VALUE } from 'src/memory/ui/memoryDirRows.js'

type ChoiceMemory = {
  remember: (value: string) => void
  /** The remembered value when it is still offered, else the first one. */
  focusAmong: (values: readonly string[]) => string | undefined
}

/** Tidy is an action, not a place, so reopening the picker never lands on it. */
export function createChoiceMemory(): ChoiceMemory {
  let last: string | undefined
  return {
    remember: value => {
      if (value !== TIDY_VALUE) last = value
    },
    focusAmong: values => (last !== undefined && values.includes(last) ? last : values[0]),
  }
}

// One per process: reopening `/memory`, even after `/clear` or a resume, lands
// on the folder the user was working in.
export const pickerChoice = createChoiceMemory()
