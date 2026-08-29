/**
 * The generic floor — the stages every Bash result gets, whatever it ran.
 *
 * ## Why this exists
 *
 * `applyPipeline` already implements every stage here, and none of them knows
 * anything about the command: `stripAnsi` strips escapes, `collapseRuns`
 * collapses adjacent identical lines. They simply never ran unless a registered
 * spec turned them on, and `findFilterForCommand` resolves a spec for only a
 * minority of what the agent actually types.
 *
 * Measured by replaying 19,060 recorded Bash calls
 * (`scripts/bench/tokens/measure-bash-filter-replay.test.ts`): the filter
 * covered 5.8% of calls and removed 2.3% of pre-filter characters. The gate that
 * blocked the rest is not a missing spec — it is the SHAPE of the command.
 * 51.9% of the characters come from a command with a non-reducer pipe, 10.3%
 * from a chain whose segments resolve to different filters, 3.6% from a subshell
 * or a `for` loop. `registry.ts` bypasses all three by construction, and
 * correctly so: it cannot know which segment produced which line, so it cannot
 * pick one segment's spec. The floor does not need to know. It is the answer to
 * "what can be said about output when nothing is known about the command".
 *
 * Re-measured 2026-08-29 over a fresh 60-day corpus (18,310 calls, 20.4M
 * chars) and the shape census barely moved: 50.7% of characters behind a
 * non-reducer pipe, 10.2% behind a chain with disagreeing heads, 4.2% behind a
 * subshell or `for`. Only 6.8% sits in `atomic, no filter registered` — the one
 * bucket a MISSING SPEC can explain, and therefore the whole ceiling of any
 * round that adds matching rules. Widening the execution-prefix layer
 * (`pipeline.ts`) to cover `bundle exec`, `conda run`, container `exec` and
 * path-prefixed binaries moved this corpus by +4 calls and +333 characters:
 * the forms it adds belong to ecosystems this corpus does not contain. That is
 * an argument for keeping the coverage and against expecting a number from it
 * here — not a reason to go after the shape buckets, which stay out of reach
 * for the attribution reason above.
 *
 * ## Why these stages and not the others
 *
 * Every stage in the floor has to be safe on output nobody has looked at:
 *
 * - `dedupGlobal` is excluded. Removing non-adjacent duplicate lines destroys a
 *   table whose column repeats, a list with legitimate repeats, and any format
 *   where line position carries meaning. A spec can opt in because its author
 *   knows the format; the floor does not. Priced anyway, so the safety decision
 *   has a number on it: it would take the floor from 1.8% to 3.3%.
 * - `truncateLineAt` is excluded. Cutting a long line mid-way turns a one-line
 *   JSON document or a base64 blob into something the model can neither read nor
 *   repair, which is strictly worse than sending it whole.
 * - `collapseRuns` is safe: the run's first line survives verbatim, gains a
 *   ` (×N)` count, and nothing that was not literally repeated is touched.
 * - `collapseDigitTemplates` is included, but FENCED — twice, and the second
 *   fence was added after a review found the first one insufficient. It needs a
 *   run of five or more ADJACENT lines identical except for their digits, so it
 *   cannot reorder or reach across the output the way `dedupGlobal` does — and
 *   progress output is exactly that shape. It is genuinely lossy: `[1/10]
 *   Compiling` through `[10/10] Compiling` becomes one line and which items
 *   those were is gone. Unfenced it is worth 1.8% and it eats pretty-printed
 *   JSON whole — `"key_0": 0` through `"key_799": 799` is one template, so 800
 *   lines become one.
 *
 *   "Progress noise" is the assumption, and it fails on the output that shares
 *   the shape without sharing the property: 98 lines of
 *   `src/f12.ts(34,5): error TS2322: …` differ only in their digits too, and
 *   collapsing them returns ONE line labelled `(98 updates)`. Every one of those
 *   named a different file. So the shape test is not enough — the body must also
 *   not read as a list of distinct places or diagnostics
 *   (`looksLikeLocationList`, `looksLikeDiagnostics`).
 * - `stripAnsi` is safe: escape sequences are display instructions, and the
 *   model is not a terminal.
 * - `groupMatchLines` is lossless — every match line survives in its original
 *   order, only the repeated `path:` prefix is hoisted — and is fenced anyway,
 *   for a different reason than the digit collapse: a reshape that fired on
 *   output it misread would be worse than one that never fires. It reads the
 *   BODY rather than the command because the `grep-rg` spec reaches only 0.14%
 *   of grep traffic; see its own doc comment. Worth 0.7% marginally over the cap.
 *
 * ## The cap is a different kind of thing
 *
 * A head/tail cap can delete the line that mattered, which none of the above
 * can. It is the largest arm by an order of magnitude — 18.0% of recorded
 * characters at 60 lines, against 1.8% for the whole floor — and it is fenced
 * accordingly: only where NO spec matched, never on a body that looks
 * structured, never when the caller does its own budgeting, and off entirely
 * under either of its two switches — `CLAUDIN_DISABLE_BASH_FILTER_CAP` or
 * `bashOutputFilterCapEnabled: false`. It gets its own switch rather than
 * riding the filter's master toggle because the two answer different questions:
 * turning the filter off gives up the lossless stages too, and someone who
 * distrusts only the cut should not have to.
 *
 * "Only where no spec matched" used to be justified here by `tsc`, which omits
 * `maxLines` because every error line counts. That justification did not hold as
 * written: the spec fence protects `bunx tsc --noEmit` and protects nothing when
 * the same compiler runs as `./scripts/check.sh` or behind a pipe, which is how
 * the registry sees most of it. A command fence cannot carry a claim about
 * output. So the claim is enforced where it is true — on the body
 * (`looksLikeDiagnostics`), whatever produced it.
 *
 * ## Where it may and may not be applied
 *
 * ONLY in `applyBashFilterToStdout`, never in `planBashFilter`. The plan gates
 * the reducer-pipe strip on having resolved a filter (`index.ts`), so a floor
 * that made `plan.filter` always truthy would rewrite every `cmd | tail -20`
 * into a bare `cmd` and execute THAT — running the full command the model asked
 * to trim. The floor is a property of the output, not of the command.
 */
import { isEnvTruthy } from "src/shared/envUtils.js";
import { getGlobalConfig } from "src/platform/config/config.js";
import type { FilterSpec } from "src/tools/shared/outputFilter/Bash/types.js";
import { groupMatchLines } from "src/tools/shared/outputFilter/Bash/groupMatchLines.js";

/** Matches nothing: the floor is applied directly, never resolved by name. */
const NEVER_RE = /(?!)/;

/**
 * Above this many lines, unmatched output keeps its head and tail and loses the
 * middle. Chosen from the corpus sweep in
 * `scripts/bench/tokens/measure-bash-cap-sizing.test.ts`, not from taste: 60
 * lines takes 18.0% of characters over 1,061 of 13,575 eligible results, where
 * 100 takes 8.1% over 328 and 200 is inert here at 0.9% over 25.
 */
export const FLOOR_CAP_LINES = 60;

/** Read once at module load, like the sibling filter kill-switch in BashTool. */
const CAP_DISABLED = isEnvTruthy(process.env.CLAUDIN_DISABLE_BASH_FILTER_CAP);

/**
 * The two switches are read at different times because they change at different
 * times. The environment is fixed for the life of the process, so reading it
 * once at load is the whole story. The config key is not: the user flips it in
 * `/config` and expects the next command to obey, so it is read per call —
 * `getGlobalConfig` is memoized, and this runs once per Bash result.
 */
export function isFloorCapEnabled(): boolean {
  return !CAP_DISABLED && getGlobalConfig().bashOutputFilterCapEnabled !== false;
}

/**
 * Whether a head/tail cap may cut this body at all.
 *
 * A single line has no middle to remove, and a JSON document survives neither
 * half — half a document is not a smaller document, it is an unparseable one,
 * which is worse for the model than the whole thing. Deliberately a shape test
 * on the first non-blank character rather than a parse: running `JSON.parse`
 * over every megabyte of command output to decide whether to trim it costs more
 * than the trim saves.
 */
export function isCappableBody(text: string): boolean {
  const first = text.trimStart()[0];
  if (first === "{" || first === "[") return false;
  return text.trimEnd().includes("\n");
}

// ---------------------------------------------------------------------------
// What the body is, for the two stages that cannot be decided by shape alone
// ---------------------------------------------------------------------------

/**
 * A line naming a place: `src/a.ts:12:`, `src/a.ts(12,5):`, `./main.go:12:2:`.
 *
 * Requires an extension before the separator, which is what keeps it off
 * ordinary prose containing a colon and a number.
 */
const LOCATION_RE = /[\w./\\-]*[\w-]\.[A-Za-z]\w*[:(]\d+/;

/**
 * A compiler or linter diagnostic: `error TS2322:`, `error[E0308]:`,
 * `warning: unused`. The bounded gap is what stops it matching a sentence that
 * happens to contain the word and, far later, a colon.
 */
const DIAGNOSTIC_RE = /\b(?:error|warning)\b[^\n]{0,40}?[:[]/i;

/** Enough lines to characterise a body without walking a megabyte of it. */
const SAMPLE_LINES = 200;

/**
 * A majority rather than "any line", because one stray `error:` in a log is not
 * a diagnostic dump, and a majority rather than "all" because real output ends
 * with a summary line that matches nothing.
 */
function majorityOfLines(text: string, re: RegExp): boolean {
  let total = 0;
  let hits = 0;
  for (const line of text.split("\n", SAMPLE_LINES)) {
    if (line.trim() === "") continue;
    total++;
    if (re.test(line)) hits++;
  }
  return total > 0 && hits / total >= 0.6;
}

/**
 * Whether the body reads as a list of distinct locations — grep hits, a file
 * enumeration, a stack of frames.
 *
 * Only `collapseDigitTemplates` asks. Such a body is the worst case for it and
 * the BEST case for `groupMatchLines`, which is why these two stages stopped
 * sharing one option: `src/a.ts:1:x` through `src/a.ts:98:x` is one digit
 * template and 98 distinct answers.
 */
export function looksLikeLocationList(text: string): boolean {
  return majorityOfLines(text, LOCATION_RE);
}

/**
 * Whether the body reads as compiler or linter diagnostics.
 *
 * Both lossy stages ask, and it is the only body-level veto the CAP has: a
 * diagnostic list is precisely the output where the line that mattered is as
 * likely to be the 40th as the 1st or the 98th, and where the model cannot
 * recover what was cut without re-running the build.
 */
export function looksLikeDiagnostics(text: string): boolean {
  return majorityOfLines(text, DIAGNOSTIC_RE);
}

/** The floor as a standalone spec, for output that matched no registered spec. */
export const GENERIC_FLOOR: FilterSpec = {
  name: "generic-floor",
  matchCommand: NEVER_RE,
  stripAnsi: true,
  collapseRuns: true,
};

/**
 * The floor for a FAILING command — `collapseRuns` and nothing else.
 *
 * `stripAnsi` is dropped here, and the reason is that this string has two
 * readers. Everywhere else the output is model-facing and an escape sequence is
 * a display instruction the model is not a terminal for. An error string is
 * printed VERBATIM to the user's terminal by the error renderers, where the red
 * on `ERROR` is doing its job. Stripping it would trade a real saving of 0.2%
 * for a worse-looking failure, which is the wrong way round.
 *
 * Everything lossier is out for a sharper reason: on a failure the reader is
 * looking for what broke. A spec's `keepLinesMatching` was written for a
 * successful run and would drop the traceback, a `matchOutput` sentinel would
 * replace the body with "✓ ok", and a head/tail cap would cut whichever end the
 * cause happened to be at. Collapsing a run of literally identical lines is the
 * one edit that cannot hide the cause — the first of them survives verbatim.
 */
export const ERROR_FLOOR: FilterSpec = {
  name: "error-floor",
  matchCommand: NEVER_RE,
  collapseRuns: true,
};

/**
 * The spec to actually run: `spec` with the floor filling in what it left unset,
 * or the floor alone when nothing matched.
 *
 * The merge only fills gaps — a spec that explicitly sets `stripAnsi: false`
 * keeps it. That matters because the floor applies to MATCHED specs too, which
 * is the half of this that fixes existing filters rather than new traffic: on
 * the recorded corpus, of 2,717 calls that resolved a spec, exactly one had its
 * output changed. `git-diff`, `grep-rg`, `bun-test`, `find` and `tsc` all
 * matched and removed nothing.
 *
 * Only the two always-safe stages reach a matched spec. The rest are properties
 * of the OUTPUT and the call site rather than of the spec, so the caller decides
 * them and they apply to unmatched output alone:
 *
 * - `groupMatches` — hoist the repeated `path:` prefix (lossless, declines on
 *   anything it cannot account for).
 * - `collapseTemplates` — a run of digit-identical lines is progress noise
 *   rather than a list of distinct things.
 * - `cap` — the destructive head/tail cut is allowed here at all.
 *
 * `groupMatches` and `collapseTemplates` were one option until a review showed
 * they want OPPOSITE answers on the same body: a page of `path:line:` is what
 * the first exists for and what the second destroys.
 */
export function withGenericFloor(
  spec: FilterSpec | null,
  opts?: { groupMatches?: boolean; collapseTemplates?: boolean; cap?: boolean },
): FilterSpec {
  if (spec) {
    return {
      ...spec,
      stripAnsi: spec.stripAnsi ?? true,
      collapseRuns: spec.collapseRuns ?? true,
    };
  }
  const groupMatches = opts?.groupMatches === true;
  const collapseTemplates = opts?.collapseTemplates === true;
  const cap = opts?.cap === true;
  if (!groupMatches && !collapseTemplates && !cap) return GENERIC_FLOOR;
  return {
    ...GENERIC_FLOOR,
    ...(collapseTemplates ? { collapseDigitTemplates: true } : {}),
    ...(groupMatches ? { renderBody: groupMatchLines } : {}),
    ...(cap ? { maxLines: FLOOR_CAP_LINES } : {}),
  };
}
