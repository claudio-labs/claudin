// Why a block of lines was not found in a file, said so that the next call can
// be right: where the block stopped agreeing with the file, and what the file
// has there. Patch's hunks (patchFormat.ts) and Edit's old_string share it.
// Echoing the block back told the model only what it had sent, and the
// recovery observed was a blind re-send; the divergence point, plus the file's
// line there, is what makes it a one-shot fix — a dropped intervening line is
// by far the most common cause.
import { bestPartialMatch } from 'src/tools/shared/fuzzyLineMatch.js'

const MAX_ERROR_LINE_CHARS = 200

/** One line of a block or of the file, cut to fit an error message. */
export function excerpt(line: string): string {
  return line.length > MAX_ERROR_LINE_CHARS
    ? `${line.slice(0, MAX_ERROR_LINE_CHARS)}\u2026`
    : line
}

/** What to do about a block that matches nowhere in the file. */
export const NOWHERE_REMEDY =
  'Read the file again and copy the context verbatim — a block that matches nowhere usually means it was written from memory, or aimed at the wrong file.'

/**
 * Where `block` stops agreeing with `fileLines`: the longest prefix of it found
 * at or after `searchStart`, the line of it that diverges, and the file's line
 * there. `noun` names the block ("hunk", "old_string"). `null` when not even
 * its first line is in the file, or when nothing diverges.
 */
export function describeDivergence(
  fileLines: string[],
  block: string[],
  searchStart: number,
  noun: string,
): string | null {
  const best = bestPartialMatch(fileLines, block, searchStart)
  if (!best || best.matched >= block.length) return null
  const divergedAt = best.index + best.matched
  const fileLine = fileLines[divergedAt]
  return (
    `line(s) 1-${best.matched} of your ${noun} match starting at line ` +
    `${best.index + 1}, then line ${best.matched + 1} diverges.\n` +
    `  your line ${best.matched + 1}: ${excerpt(block[best.matched]!)}\n` +
    (fileLine === undefined
      ? '  the file ends there\n'
      : `  file line ${divergedAt + 1}: ${excerpt(fileLine)}\n`) +
    'Re-read that region and copy every line in between — a dropped intervening ' +
    'line is the usual cause.'
  )
}
