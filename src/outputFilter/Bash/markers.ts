import { escapeXmlAttr } from "src/utils/xml.js";
import type { PipelineResult, PreExecPlan } from "./types.js";

const MAX_ATTR_LEN = 200;

/** Matches the opening tag of any previously-wrapped output — used to prevent double-wrapping.
 * `persisted-output` and `tool-result-summary` come from the upstream toolResultStorage layer,
 * which may already have wrapped large output before this filter runs. */
export const ALREADY_WRAPPED_RE =
  /^<(?:persisted-output|tool-result-summary|bash-output-rewritten|bash-output-filtered)/;

function truncateAttr(value: string): string {
  const escaped = escapeXmlAttr(value);
  if (escaped.length <= MAX_ATTR_LEN) return escaped;
  return `${escaped.slice(0, MAX_ATTR_LEN - 3)}…`;
}

/** Wraps filtered/rewritten stdout in XML markers (`<bash-output-filtered>` or `<bash-output-rewritten>`) with truncated `original`/`actual` attrs. Idempotent — skips already-wrapped output. */
export function wrapStdoutWithMarkers(
  rawStdout: string,
  plan: PreExecPlan,
  pipelineResult: PipelineResult | null,
): string {
  // Idempotency: don't double-wrap
  if (ALREADY_WRAPPED_RE.test(rawStdout)) return rawStdout;

  const rewrite = plan.rewrite;
  const hasRewrite = rewrite !== null;
  // A pipeline that ran but applied zero stages didn't change the output — wrapping it as
  // "filtered" would be misleading to the model, so treat it the same as no filter.
  const hasFilter =
    pipelineResult !== null && pipelineResult.applied.length > 0;

  // No rewrite, no filter — pass through
  if (!hasRewrite && !hasFilter) return rawStdout;

  const body = pipelineResult?.body ?? rawStdout;
  const original = truncateAttr(rewrite?.from ?? "");
  const reduction = pipelineResult?.reductionPct ?? 0;

  if (hasRewrite && hasFilter) {
    const actual = truncateAttr(rewrite.to);
    return `<bash-output-filtered original="${original}" actual="${actual}" reduction="${reduction}%">${body}</bash-output-filtered>`;
  }

  if (hasRewrite) {
    const actual = truncateAttr(rewrite.to);
    return `<bash-output-rewritten original="${original}" actual="${actual}">${body}</bash-output-rewritten>`;
  }

  // Filter only
  return `<bash-output-filtered original="${original}" reduction="${reduction}%">${body}</bash-output-filtered>`;
}
