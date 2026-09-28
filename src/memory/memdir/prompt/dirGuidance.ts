// Without these, models spend a turn on `mkdir -p` or `ls` before the first
// write. Other prompts embed them as they are.
export const DIR_EXISTS_GUIDANCE =
  'The directory already exists: create files in it straight away with the Write tool, with no `mkdir` and no existence check beforehand.'

export const DIRS_EXIST_GUIDANCE =
  'Both directories already exist: create files in them straight away with the Write tool, with no `mkdir` and no existence check beforehand.'
