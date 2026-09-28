/** A working tree's changes, named relative to the repository root. */
export type GitFileStatus = {
  tracked: string[]
  untracked: string[]
}

const UNTRACKED_CODE = '??'
const MIN_ENTRY_LENGTH = 4 // two status columns, a space, a name of at least one character
const RENAME_OR_COPY_RE = /[RC]/

/**
 * Splits `git status --porcelain -z`. That form never quotes, so names come
 * through exactly as on disk. A rename or copy is one tracked entry under its
 * new name; the source name follows it as an extra field and is skipped.
 */
export function parseStatusPorcelain(output: string): GitFileStatus {
  const status: GitFileStatus = { tracked: [], untracked: [] }
  const fields = output.split('\0')
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index] ?? ''
    if (entry.length < MIN_ENTRY_LENGTH) continue
    const code = entry.slice(0, 2)
    const name = entry.slice(3)
    if (code === UNTRACKED_CODE) status.untracked.push(name)
    else status.tracked.push(name)
    if (RENAME_OR_COPY_RE.test(code)) index++
  }
  return status
}
