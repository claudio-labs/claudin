import { isExpired, localDay } from 'src/memory/memdir/memoryExpires.js'
import { isMemoryHygieneEnabled } from 'src/memory/memdir/memoryHygiene.js'

/**
 * Days elapsed since mtime.  Floor-rounded — 0 for today, 1 for
 * yesterday, 2+ for older.  Negative inputs (future mtime, clock skew)
 * clamp to 0.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/**
 * Plain-text staleness caveat for memories >1 day old.  Returns ''
 * for fresh (today/yesterday) memories — warning there is noise.
 *
 * Motivated by user reports of stale code-state memories (file:line
 * citations to code that has since changed) being asserted as fact —
 * the citation makes the stale claim sound more authoritative, not less.
 */
function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/**
 * What a Read of a memory file knows of it: its mtime, and — when the read saw
 * the frontmatter — its `expires:` date and the memories its `contradicts:`
 * names.
 */
export type MemoryReadFacts = { mtimeMs: number; expires: string | null; contradicts?: readonly string[] }

/**
 * The note a Read of a memory file carries: the age caveat, and — past its
 * `expires:` date — a call to re-verify, and — when it is marked
 * `contradicts:` (memoryHygiene.ts, off under CLAUDIN_MEMORY_HYGIENE=0) — the
 * memories it disagrees with, in one <system-reminder>. '' when none
 * applies. Prefixed to FileReadTool output (resultContent.ts) when
 * the file read lives in a memory directory, and rendered once, when the
 * tool result is mapped, so the day it compares against is the day of the
 * Read and history stays byte-stable.
 */
export function memoryReadNote(facts: MemoryReadFacts, today: string = localDay()): string {
  const parts = [memoryFreshnessText(facts.mtimeMs)]
  if (facts.expires !== null && isExpired(facts.expires, today)) {
    parts.push(
      `Its \`expires:\` date, ${facts.expires}, has passed: re-verify it before relying on it, then move the date or remove the memory.`,
    )
  }
  if (facts.contradicts && facts.contradicts.length > 0 && isMemoryHygieneEnabled()) {
    parts.push(
      `It is marked as contradicting ${facts.contradicts.map(name => `\`${name}\``).join(', ')}: another memory says otherwise and neither settled it. Check the code, or ask, before relying on either.`,
    )
  }
  const text = parts.filter(Boolean).join(' ')
  return text ? `<system-reminder>${text}</system-reminder>\n` : ''
}
