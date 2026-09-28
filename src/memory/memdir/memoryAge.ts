const DAY_MS = 86_400_000

/**
 * A reminder put in front of a memory older than a day, so the model treats
 * what it says about the code as a claim to check. Empty otherwise.
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  return memoryFreshnessNoteAt(mtimeMs, Date.now())
}

export function memoryFreshnessNoteAt(mtimeMs: number, nowMs: number): string {
  // A future mtime (clock skew, a restored backup) counts as written today.
  const days = Math.max(0, Math.floor((nowMs - mtimeMs) / DAY_MS))
  if (days <= 1) return ''
  return `<system-reminder>This memory is ${days} days old. It records what held when it was written and is not a live view: what it says about how the code behaves, and any file:line it cites, may have changed since. Verify it against the current code before you state any of it as fact.</system-reminder>\n`
}
