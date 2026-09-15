/**
 * The /insights usage report — barrel over ./insights/.
 *
 * One call site imports from here and it does so dynamically:
 * `src/commands/commands.ts` runs
 * `(await import('src/commands/insights.js')).default` to defer this whole
 * subtree until /insights is actually invoked. Neither tsc nor the build's
 * import pre-scan follows a dynamic import, so the `default` re-export below is
 * load-bearing and invisible to every gate except the tests — a barrel that
 * lists the four named symbols and forgets it breaks the command at runtime and
 * nowhere earlier.
 *
 * Splitting layout:
 *   types.ts     — every shape the stages exchange, plus isValidSessionFacets.
 *                  Imports nothing, so it sits under all of them
 *   constants.ts — the five lookup tables: extensions, display labels, the
 *                  seven section prompts, and the two fixed chart orderings
 *   store.ts     — the on-disk half: the three directories, the facet and
 *                  session-meta caches, and the metadata-only session scan
 *   extract.ts   — one log to facts: the tool/token/timing tally, SessionMeta,
 *                  branch dedup, transcript formatting, facet extraction
 *   aggregate.ts — many sessions to one number set: multi-clauding detection,
 *                  AggregatedData, and the export payload for the upload
 *   narrative.ts — the model calls that write the prose sections, fanned out in
 *                  parallel and then summarized by a second pass
 *   charts.ts    — the five HTML fragment builders the report is assembled from
 *   html.ts      — generateHtmlReport, the 631-line document assembler
 *   command.ts   — generateUsageReport, the only place the stages meet, and the
 *                  Command object that is this module's default export
 *
 * Dependencies run strictly down that list, with no cycles. Everything not
 * re-exported here is private to the directory and was private before the
 * split, and there is deliberately no index.ts beside these modules — with
 * insights.ts in place it would give the resolver two candidates for the same
 * specifier.
 */

export type { InsightsExport } from 'src/commands/insights/types.js'
export {
  buildExportData,
  detectMultiClauding,
} from 'src/commands/insights/aggregate.js'
export { deduplicateSessionBranches } from 'src/commands/insights/extract.js'
export {
  default,
  generateUsageReport,
} from 'src/commands/insights/command.js'
