import type { ParseInput } from '../types.js'

/**
 * Last-resort text scrape, used only when no parser recognised the output.
 *
 * It deliberately produces a COUNT and no diagnostics: inventing file/line
 * positions from unrecognised text would feed the baseline fingerprints that
 * cannot be reproduced, and a baseline poisoned once stays wrong until the next
 * clean-tree capture. A degraded run says "I could not read this" and shows a
 * raw tail instead.
 */

const ERROR_LINE_RE = /(?:^|\s)(?:error|ERROR)\b/
const WARNING_LINE_RE = /(?:^|\s)(?:warning|WARNING)\b/
/** Summary lines double-count what they summarise. */
const SUMMARY_LINE_RE = /^\s*(?:Found|Total|\d+\s+(?:error|warning)s?\s+(?:found|generated))\b/i

export type HeuristicCounts = {
  errors: number
  warnings: number
}

export function scrapeCounts(input: ParseInput): HeuristicCounts {
  let errors = 0
  let warnings = 0
  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    if (SUMMARY_LINE_RE.test(line)) continue
    if (ERROR_LINE_RE.test(line)) errors++
    else if (WARNING_LINE_RE.test(line)) warnings++
  }
  // A non-zero exit with nothing recognisable still failed; reporting zero
  // errors would render as a clean check.
  if (errors === 0 && input.exitCode !== 0) errors = 1
  return { errors, warnings }
}
