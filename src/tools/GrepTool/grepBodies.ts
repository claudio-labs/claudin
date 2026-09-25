/**
 * `bodies` on Grep's symbols mode — CLAUDIN_GREP_BODIES=1, off by default.
 *
 * A search and the read of what it found are two requests when the read waits
 * for the search: in the real corpus a Grep followed by a Read of a file it
 * matched is 4.2% of all API calls, 5.8% of a sub-agent's (team memory
 * `request-count-levers-2026-09-24`, round 4). With `bodies`, the symbols mode
 * returns each matched symbol's body as well, numbered the way Read numbers
 * it, and registers it the way a served region is registered
 * (`tools/shared/servedRegion.ts`), so a Patch or Edit can follow without a
 * Read.
 *
 * The result must reach the model whole, since what it registers as read is
 * what the model was shown: the budget keeps it under Grep's 20k persistence
 * threshold, and the tool-result summarizer passes a bodies result through
 * (`isGrepBodiesResult`).
 */
import { z } from 'zod/v4'
import { semanticBoolean } from 'src/shared/data/semanticBoolean.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

export const GREP_BODIES_ENV = 'CLAUDIN_GREP_BODIES'

/** Read per call; the schema reads it once, when it is built. */
export function isGrepBodiesEnabled(): boolean {
  return isEnvTruthy(process.env[GREP_BODIES_ENV])
}

/** What the bodies may add; with the signatures, the result stays under Grep's 20k. */
export const BODIES_BUDGET_CHARS = 12_000

/** A symbol longer than this comes back as its signature and a pointer to Read(symbol=). */
export const MAX_BODY_LINES = 120

const bodiesField = () =>
  semanticBoolean(z.boolean().optional()).describe(
    `With output_mode "symbols": also return the body of each matched symbol, numbered the way Read numbers it (up to ~${BODIES_BUDGET_CHARS / 1000}k chars; a symbol over ${MAX_BODY_LINES} lines gets a pointer instead) — the search and the read in one call. A body shown here counts as read, so a Patch or Edit can follow without a Read.`,
  )

/**
 * The `bodies` field for Grep's input schema. With the flag off it is absent
 * at runtime, so the schema sent to the API and the strict parse are what they
 * were; the static type always carries it, as an optional field nothing sets.
 */
export function bodiesSchemaFields(): { bodies: ReturnType<typeof bodiesField> } {
  return (isGrepBodiesEnabled() ? { bodies: bodiesField() } : {}) as {
    bodies: ReturnType<typeof bodiesField>
  }
}

/** Appended to the symbols header when the bodies are in the result. */
export const BODIES_HEADER_SUFFIX = ', with their bodies'

const BODIES_HEADER_RE = /^Found \d+ matched symbols? across \d+ files?, with their bodies/

/** A Grep result that carries bodies, which the summarizer must pass through whole. */
export function isGrepBodiesResult(text: string): boolean {
  return BODIES_HEADER_RE.test(text)
}
