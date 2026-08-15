import { ClaudeError } from "src/shared/errors.js";
import { logError } from "src/shared/log.js";
import { ALREADY_WRAPPED_RE, wrapStdoutWithMarkers } from "src/tools/shared/outputFilter/Bash/markers.js";
import {
  applyPipeline,
  hasCompound,
  maybeRewrite,
  splitTrailingReducerPipe,
} from "src/tools/shared/outputFilter/Bash/pipeline.js";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";
import type { PipelineResult, PreExecPlan } from "src/tools/shared/outputFilter/Bash/types.js";

export type { MatchOutputRule, ReplaceRule, RewriteContext } from "src/tools/shared/outputFilter/types.js";
export type { FilterSpec, PipelineResult, PreExecPlan } from "src/tools/shared/outputFilter/Bash/types.js";

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

/** Applies the planned filter pipeline to raw stdout and wraps the result with markers. Returns raw stdout unchanged on empty output, errors, no-filter, or already-wrapped input. Fail-open: any exception returns `rawStdout`. */
export function applyBashFilterToStdout(
  rawStdout: string,
  isError: boolean,
  plan: PreExecPlan,
): string {
  return safeApply(
    "applyBashFilterToStdout",
    () => {
      // Empty output — no marker
      if (rawStdout === "") return "";
      // No filter matched — pass through (but add rewrite marker if applicable)
      if (!plan.filter && !plan.rewrite) return rawStdout;
      // Error output — don't filter content, but wrap with rewrite marker if applicable
      if (isError) {
        return wrapStdoutWithMarkers(rawStdout, plan, null);
      }
      // Already wrapped — don't double-wrap
      if (ALREADY_WRAPPED_RE.test(rawStdout)) {
        return rawStdout;
      }
      // Rewrite-only (no filter) — wrap raw with rewrite marker, skip pipeline
      if (!plan.filter) {
        return wrapStdoutWithMarkers(rawStdout, plan, null);
      }

      const pipelineResult: PipelineResult = applyPipeline(
        plan.filter,
        rawStdout,
        { allowShortCircuit: !plan.isCompound },
      );
      return wrapStdoutWithMarkers(rawStdout, plan, pipelineResult);
    },
    rawStdout,
  );
}
