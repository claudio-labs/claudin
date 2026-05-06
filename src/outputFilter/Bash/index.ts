import { ClaudeError } from "src/utils/errors.js";
import { logError } from "src/utils/log.js";
import { ALREADY_WRAPPED_RE, wrapStdoutWithMarkers } from "./markers.js";
import { applyPipeline, maybeRewrite } from "./pipeline.js";
import { findFilterForCommand } from "./registry.js";
import type { PipelineResult, PreExecPlan } from "./types.js";

export type { MatchOutputRule, ReplaceRule, RewriteContext } from "../types.js";
export type { FilterSpec, PipelineResult, PreExecPlan } from "./types.js";

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

/** Resolves a filter for the command, runs rewrite if applicable, and returns an execution plan — all wrapped in `safeApply` so failures fall back to a no-op plan. */
export function planBashFilter(command: string): PreExecPlan {
  return safeApply(
    "planBashFilter",
    () => {
      const filter = findFilterForCommand(command);
      const rewrite = filter ? maybeRewrite(filter, command) : null;
      return {
        effectiveCommand: rewrite?.rewritten ?? command,
        filter,
        rewrite: rewrite
          ? { from: rewrite.original, to: rewrite.rewritten }
          : null,
      };
    },
    {
      effectiveCommand: command,
      filter: null,
      rewrite: null,
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
      );
      return wrapStdoutWithMarkers(rawStdout, plan, pipelineResult);
    },
    rawStdout,
  );
}
