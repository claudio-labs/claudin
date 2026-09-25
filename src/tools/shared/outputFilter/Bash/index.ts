import { ClaudeError } from "src/shared/errors.js";
import { isEnvTruthy } from "src/shared/envUtils.js";
import { logError } from "src/shared/log.js";
import {
  ALREADY_WRAPPED_RE,
  prependRewriteNote,
  wrapFileRead,
  wrapStdoutWithMarkers,
} from "src/tools/shared/outputFilter/Bash/markers.js";
import {
  applyPipeline,
  hasCompound,
  maybeRewrite,
  splitTrailingReducerPipe,
} from "src/tools/shared/outputFilter/Bash/pipeline.js";
import {
  BOUNDED_READ_MAX_LINES,
  ERROR_FLOOR,
  FLOOR_CAP_LINES,
  isCapKeepBoundedEnabled,
  isCappableBody,
  isFloorCapEnabled,
  looksLikeDiagnostics,
  looksLikeLocationList,
  withGenericFloor,
} from "src/tools/shared/outputFilter/Bash/floor.js";
import {
  isPureFileRead,
  parsePureFileRead,
  type ReadWord,
} from "src/tools/shared/outputFilter/Bash/fileReadShape.js";
import { commandLineBound } from "src/tools/shared/outputFilter/Bash/lineBound.js";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";
import type { PipelineResult, PreExecPlan } from "src/tools/shared/outputFilter/Bash/types.js";

export type { MatchOutputRule, ReplaceRule, RewriteContext } from "src/tools/shared/outputFilter/types.js";
export type { DroppedReducer, FilterSpec, PipelineResult, PreExecPlan } from "src/tools/shared/outputFilter/Bash/types.js";

// ---------------------------------------------------------------------------
// Safe apply — fail-open wrapper (architecture §13)
// ---------------------------------------------------------------------------

function safeApply<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    logError(new ClaudeError(`bash-output-filter: ${label} failed, falling back`, { cause: e }));
    return fallback;
  }
}

/** Last `n` lines of `body`, preserving a trailing newline if there was one. */
function keepLastLines(body: string, n: number): string {
  const lines = body.split("\n");
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) lines.pop();
  if (lines.length <= n) return body;
  return lines.slice(-n).join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * `CLAUDIN_BASH_FILE_READ_PASSTHROUGH=1`: a pure file read (fileReadShape.ts)
 * comes back whole, byte for byte, instead of capped; one too long for that
 * keeps the whole files that fit (`overBudgetFileRead`). Off by default. Read
 * once at module load, like the cap's own kill-switch in floor.ts.
 */
const FILE_READ_PASSTHROUGH = isEnvTruthy(process.env.CLAUDIN_BASH_FILE_READ_PASSTHROUGH);

/**
 * The largest pure file read the pass-through leaves whole. Bash persists a
 * result over 30k chars (`maxResultSizeChars`, BashTool.tsx) and hands the
 * model a 2 KB preview, which is worse than the cut; the margin keeps the
 * wrapper and the notes after it under that line. Above it a read that only
 * prints files is cut to whole files (`overBudgetFileRead`), and any other
 * takes the cap exactly as it always has.
 */
export const FILE_READ_PASSTHROUGH_MAX_CHARS = 28_000;

/**
 * Whether this result is a pure file read the pass-through leaves whole.
 *
 * Never after a rewrite: its marker names the command that actually ran, which
 * the model cannot infer from the output, and the read's own wrapper would
 * replace it.
 */
function isUncutFileRead(rawStdout: string, plan: PreExecPlan): boolean {
  return (
    FILE_READ_PASSTHROUGH &&
    rawStdout.length <= FILE_READ_PASSTHROUGH_MAX_CHARS &&
    plan.rewrite === null &&
    isPureFileRead(plan.effectiveCommand)
  );
}

/**
 * What a pure read prints when it is too long for the pass-through — over
 * FILE_READ_PASSTHROUGH_MAX_CHARS, or `spilled` to disk by the shell, whose
 * stdout then holds only the first 30 KB — and only when it prints nothing but
 * files: BashTool then keeps the whole files that fit and names the rest
 * (`fitWholeFiles`, BashTool/creditShownFiles.ts) before this filter runs,
 * where the cap would keep 30 lines and a spill a 2 KB preview of a saved file
 * the model reads back whole.
 *
 * Null with the flag off, and for a read with a listing segment (`ls`, `git
 * ls-files`, `wc`): a page of names is output the cap was made for, not a run
 * of whole files to fit.
 */
export function overBudgetFileRead(
  rawStdout: string,
  plan: PreExecPlan,
  spilled: boolean,
): readonly ReadWord[] | null {
  return safeApply(
    "overBudgetFileRead",
    () => {
      if (!FILE_READ_PASSTHROUGH || plan.rewrite !== null) return null;
      if (!spilled && rawStdout.length <= FILE_READ_PASSTHROUGH_MAX_CHARS) return null;
      const read = parsePureFileRead(plan.effectiveCommand);
      return read && !read.lists ? read.reads : null;
    },
    null,
  );
}

/**
 * Whether this RESULT may take the floor's lossy stages — the half of the fence
 * that depends on the output and the call site rather than on the spec.
 *
 * Two conditions gate everything, neither recoverable by looking at what came
 * back:
 *
 * - the body looks structured, where cutting the middle or folding a run of
 *   digit-identical lines corrupts it rather than shortening it;
 * - the caller budgets the result itself (`GitTool`), so a cut here is spent
 *   twice and desynchronises its delta lane.
 *
 * Past that the three stages diverge, because they are not equally wrong on the
 * same body. A page of `src/a.ts:12:…` is what `groupMatchLines` exists for and
 * what the digit collapse turns into one line; a page of diagnostics is
 * something neither the collapse nor the cap may touch, since every line names a
 * different failure and none of them is recoverable from the ones kept. See
 * `looksLikeLocationList` / `looksLikeDiagnostics` in `floor.ts`.
 *
 * The third condition — a spec matched, so its author already decided what to
 * keep — is deliberately NOT repeated here. `withGenericFloor` returns early for
 * a non-null spec and never reads these options, so a copy of that check in this
 * function would be unreachable, and an unreachable check is a comment that can
 * go stale without anything failing. It did: an earlier version of this one
 * claimed to be what protects `jq`'s 800-line pretty-printed JSON from the digit
 * collapse, and the audit found that `isCappableBody` is what actually protects
 * it. The spec fence lives in one place and `floor.test.ts` pins it.
 *
 * The cap alone carries a kill-switch, being the only one that can delete the
 * line that mattered.
 */
function floorOptionsFor(
  rawStdout: string,
  plan: PreExecPlan,
): { groupMatches: boolean; collapseTemplates: boolean; cap: boolean } {
  const eligible = plan.callerBudgets !== true && isCappableBody(rawStdout);
  if (!eligible) {
    return { groupMatches: false, collapseTemplates: false, cap: false };
  }
  const diagnostics = looksLikeDiagnostics(rawStdout);
  return {
    groupMatches: true,
    collapseTemplates: !diagnostics && !looksLikeLocationList(rawStdout),
    cap: !diagnostics && isFloorCapEnabled(),
  };
}

/**
 * Whether this result is a read whose command declared how many lines it
 * prints (`lineBound.ts`) and which the floor cap would otherwise cut. The
 * model sized it, so it goes back whole and as printed, inside the wrapper of a
 * pass-through read: the tool-result summarizer stands aside for that one,
 * where it would head-tail an untagged result past 8k chars instead, and a
 * range the model edits from must not come back a byte off.
 *
 * Only where the cap would have cut: no spec matched (a spec decides its own
 * cut, and a rewrite needs one), the floor offers the cap for this body
 * (`floorOptionsFor`), and it is longer than the cap. And only up to
 * BOUNDED_READ_MAX_LINES, declared and printed, and the pass-through's 28k
 * chars, past which Bash would persist the result behind a preview.
 */
function isWithinCommandBound(rawStdout: string, plan: PreExecPlan): boolean {
  if (!isCapKeepBoundedEnabled() || plan.filter !== null) return false;
  if (rawStdout.length > FILE_READ_PASSTHROUGH_MAX_CHARS) return false;
  if (!floorOptionsFor(rawStdout, plan).cap) return false;
  // The cap's own measure (pipeline.ts, maxLines) below, the printed lines above.
  if (rawStdout.split("\n").length <= FLOOR_CAP_LINES) return false;
  if (rawStdout.trimEnd().split("\n").length > BOUNDED_READ_MAX_LINES) return false;
  const bound = commandLineBound(plan.effectiveCommand);
  return bound !== null && bound <= BOUNDED_READ_MAX_LINES;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolves a filter for the command, runs rewrite if applicable, and returns an execution plan — all wrapped in `safeApply` so failures fall back to a no-op plan.
 *
 * `allowRewrite` (default true) gates every path that changes the executed command
 * (rewriteCommand and reducer-pipe stripping). Callers that did NOT execute
 * `plan.effectiveCommand` — or could not (rewrite disabled, background run) — must
 * pass `allowRewrite: false` so the plan never claims a rewrite that didn't happen:
 * the rewrite markers tell the model which command actually ran.
 *
 * `callerBudgets` (default false) is for a caller that budgets the result itself
 * and needs the filter to stop at noise removal — see `PreExecPlan`. */
export function planBashFilter(
  command: string,
  opts?: { allowRewrite?: boolean; callerBudgets?: boolean },
): PreExecPlan {
  const allowRewrite = opts?.allowRewrite ?? true;
  const callerBudgets = opts?.callerBudgets === true;
  return safeApply(
    "planBashFilter",
    () => {
      const filter = findFilterForCommand(command);

      // `BASE | tail -N` / `BASE | cat`: tail/cat consume all stdin, so running BASE alone is
      // equivalent — strip the trailing reducer pipe and let the filter (resolved against BASE)
      // run on the full output. The marker reports original="BASE | tail -N" actual="BASE".
      const reducer = allowRewrite && filter ? splitTrailingReducerPipe(command) : null;
      if (reducer) {
        return {
          effectiveCommand: reducer.base,
          filter,
          rewrite: { from: command, to: reducer.base },
          droppedReducer: reducer.reducer,
          isCompound: hasCompound(reducer.base),
          callerBudgets,
        };
      }

      // Skip rewriteCommand for chained commands — the filter only knows about its
      // own verb's arguments, so rewriting could mangle adjacent segments.
      const rewrite =
        allowRewrite && filter && !hasCompound(command)
          ? maybeRewrite(filter, command)
          : null;
      return {
        effectiveCommand: rewrite?.rewritten ?? command,
        filter,
        rewrite: rewrite
          ? { from: rewrite.original, to: rewrite.rewritten }
          : null,
        isCompound: hasCompound(rewrite?.rewritten ?? command),
        callerBudgets,
      };
    },
    {
      effectiveCommand: command,
      filter: null,
      rewrite: null,
      isCompound: false,
      callerBudgets,
    },
  );
}

/** The exit status the command the model actually sent would have reported.
 *
 * Stripping a trailing `| tail -N` changes it: a pipeline's status is its LAST
 * command's — nothing in the bash provider sets `pipefail` — so `make lint |
 * tail -40` exits 0 while the `make lint` we ran in its place exits 2. Reporting
 * the base's code turns a run the model wrote as a success into a tool error,
 * and an error skips the filter pipeline, so it also gets the full output
 * instead of the 40 lines it asked for. The real code is not swallowed: it is
 * disclosed as `exit="N"` on the marker. */
export function exitCodeAfterRewrite(plan: PreExecPlan, code: number): number {
  return plan.droppedReducer ? 0 : code;
}

/** The base's non-zero exit code that `exitCodeAfterRewrite` reported as 0,
 * or undefined when nothing was hidden. BashTool keeps it on its result as
 * `reducedExitCode`, so the response-chain guard (agent/tools/responseChain.ts)
 * does not take `bun test | tail -30` for a pass. */
export function exitCodeHiddenByRewrite(plan: PreExecPlan, code: number): number | undefined {
  return plan.droppedReducer && code !== 0 ? code : undefined;
}

/** Applies the filter pipeline to raw stdout and wraps the result with markers. Returns raw stdout unchanged on empty output, errors, already-wrapped input, or when the pipeline applied nothing. Fail-open: any exception returns `rawStdout`. `exitCode` is the RAW status of what ran, disclosed on the marker when a reducer strip hid it from the caller.
 *
 * The pipeline runs even when NO spec matched: `withGenericFloor` supplies the
 * stages that do not depend on knowing the command (see `floor.ts`), which is
 * what reaches the piped and chained shapes `registry.ts` bypasses — 65% of the
 * recorded output. The floor is applied HERE and never in `planBashFilter`: a
 * plan carrying an always-truthy filter would strip the trailing reducer off
 * every `cmd | tail -20` and execute the untrimmed base instead. */
export function applyBashFilterToStdout(
  rawStdout: string,
  isError: boolean,
  plan: PreExecPlan,
  exitCode?: number,
): string {
  return safeApply(
    "applyBashFilterToStdout",
    () => {
      // Empty output — no marker
      if (rawStdout === "") return "";
      // Error output. Two things are true at once here and they pull apart.
      //
      // It must NOT be marker-wrapped: this string is what the error renderers
      // print to the user verbatim, so the tag and its escaped attributes end up
      // on screen. An executed rewrite is still disclosed — as a plain note; see
      // prependRewriteNote for why the wrapper cannot be used.
      //
      // But it is worth filtering, and it was not before: failing builds and
      // test runs are 2.2% of recorded Bash characters and they are the output
      // most likely to repeat a line hundreds of times. What runs is
      // ERROR_FLOOR — not the matched spec, and not even the ordinary floor;
      // see its doc comment for why colour survives here and nothing lossier
      // does.
      if (isError) {
        const floored = applyPipeline(ERROR_FLOOR, rawStdout, {
          allowShortCircuit: false,
          allowRenderBody: false,
        }).body;
        // The reducer strip was justified by the pipeline doing better than a
        // blind line cap. The stages that justify it are the ones that do not
        // run here, so honour the cap the model actually asked for.
        const cap = plan.droppedReducer?.lines ?? null;
        const capped = cap === null ? floored : keepLastLines(floored, cap);
        if (!plan.rewrite) return capped;
        return prependRewriteNote(
          capped,
          plan.rewrite.to,
          capped === floored ? undefined : plan.droppedReducer?.text,
        );
      }
      // Already wrapped — don't double-wrap
      if (ALREADY_WRAPPED_RE.test(rawStdout)) {
        return rawStdout;
      }
      // A pure file read left whole goes back as the command printed it. No
      // floor stage may touch it — not only the cap: `collapseRuns` folds a
      // run of blank lines and repeats an identical line as `line (×N)`, the
      // digit collapse folds five data rows into one, `stripAnsi` edits bytes —
      // and a file shown one byte off is a file the model edits from a copy
      // that is not the file, and one the read credit cannot find.
      if (isUncutFileRead(rawStdout, plan)) return wrapFileRead(rawStdout);
      // A read the model already bounded keeps every line it asked for.
      if (isWithinCommandBound(rawStdout, plan)) return wrapFileRead(rawStdout);

      const pipelineResult: PipelineResult = applyPipeline(
        withGenericFloor(plan.filter, floorOptionsFor(rawStdout, plan)),
        rawStdout,
        {
          allowShortCircuit: !plan.isCompound,
          // What the model asked for with the `| tail -N` this plan stripped.
          capLines: plan.droppedReducer?.lines ?? null,
          // A caller that budgets the result itself already owns the reshape —
          // see `PreExecPlan.callerBudgets`. Running it here would spend the
          // same cut twice and hand its delta lane text it never produced.
          allowRenderBody: plan.callerBudgets !== true,
        },
      );
      return wrapStdoutWithMarkers(rawStdout, plan, pipelineResult, exitCode);
    },
    rawStdout,
  );
}
