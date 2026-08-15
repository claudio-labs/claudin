import { ClaudeError } from "src/shared/errors.js";
import { logError } from "src/shared/log.js";
import {
  ALREADY_WRAPPED_RE,
  prependRewriteNote,
  wrapStdoutWithMarkers,
} from "src/tools/shared/outputFilter/Bash/markers.js";
import {
  applyPipeline,
  hasCompound,
  maybeRewrite,
  splitTrailingReducerPipe,
} from "src/tools/shared/outputFilter/Bash/pipeline.js";
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolves a filter for the command, runs rewrite if applicable, and returns an execution plan — all wrapped in `safeApply` so failures fall back to a no-op plan.
 *
 * `allowRewrite` (default true) gates every path that changes the executed command
 * (rewriteCommand and reducer-pipe stripping). Callers that did NOT execute
 * `plan.effectiveCommand` — or could not (rewrite disabled, background run) — must
 * pass `allowRewrite: false` so the plan never claims a rewrite that didn't happen:
 * the rewrite markers tell the model which command actually ran. */
export function planBashFilter(
  command: string,
  opts?: { allowRewrite?: boolean },
): PreExecPlan {
  const allowRewrite = opts?.allowRewrite ?? true;
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
      };
    },
    {
      effectiveCommand: command,
      filter: null,
      rewrite: null,
      isCompound: false,
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

/** Applies the planned filter pipeline to raw stdout and wraps the result with markers. Returns raw stdout unchanged on empty output, errors, no-filter, or already-wrapped input. Fail-open: any exception returns `rawStdout`. `exitCode` is the RAW status of what ran, disclosed on the marker when a reducer strip hid it from the caller. */
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
      // No filter matched — pass through (but add rewrite marker if applicable)
      if (!plan.filter && !plan.rewrite) return rawStdout;
      // Error output — don't filter content, and don't marker-wrap it either:
      // this string is what the error renderers print to the user verbatim, so
      // the tag and its escaped attributes end up on screen. An executed
      // rewrite still has to be disclosed — as a plain note (see
      // prependRewriteNote for why the wrapper cannot be used here).
      if (isError) {
        if (!plan.rewrite) return rawStdout;
        // Stripping the reducer was justified by the pipeline doing a better job
        // than a blind line cap — and the pipeline is exactly what does not run
        // here. Apply the cap the model asked for rather than handing back
        // everything the command printed.
        const cap = plan.droppedReducer?.lines ?? null;
        const capped = cap === null ? rawStdout : keepLastLines(rawStdout, cap);
        return prependRewriteNote(
          capped,
          plan.rewrite.to,
          capped === rawStdout ? undefined : plan.droppedReducer?.text,
        );
      }
      // Already wrapped — don't double-wrap
      if (ALREADY_WRAPPED_RE.test(rawStdout)) {
        return rawStdout;
      }
      // Rewrite-only (no filter) — wrap raw with rewrite marker, skip pipeline
      if (!plan.filter) {
        return wrapStdoutWithMarkers(rawStdout, plan, null, exitCode);
      }

      const pipelineResult: PipelineResult = applyPipeline(
        plan.filter,
        rawStdout,
        {
          allowShortCircuit: !plan.isCompound,
          // What the model asked for with the `| tail -N` this plan stripped.
          capLines: plan.droppedReducer?.lines ?? null,
        },
      );
      return wrapStdoutWithMarkers(rawStdout, plan, pipelineResult, exitCode);
    },
    rawStdout,
  );
}
