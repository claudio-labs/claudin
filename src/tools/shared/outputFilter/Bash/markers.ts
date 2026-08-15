import { escapeXmlAttr } from "src/shared/data/xml.js";
import type { PipelineResult, PreExecPlan } from "src/tools/shared/outputFilter/Bash/types.js";

const MAX_ATTR_LEN = 200;

/** Matches the opening tag of any previously-wrapped output — used to prevent double-wrapping.
 * `persisted-output` and `tool-result-summary` come from the upstream toolResultStorage layer,
 * which may already have wrapped large output before this filter runs. */
export const ALREADY_WRAPPED_RE =
  /^<(?:persisted-output|tool-result-summary|bash-output-rewritten|bash-output-filtered)/;

/** Display-only inverse of {@link wrapStdoutWithMarkers}: strips the outer
 * `<bash-output-filtered …>` / `<bash-output-rewritten …>` wrapper and returns
 * just the body. The wrapped form is model-facing (it discloses the rewrite /
 * filter to the model); the TUI must render the bare output, not the raw XML tag.
 * Anchored to the whole string so body content that merely contains a tag-like
 * substring is untouched. Idempotent — unwrapped input passes through. */
const WRAPPED_OUTPUT_RE =
  /^\s*<bash-output-(?:filtered|rewritten)(?:\s[^>]*)?>([\s\S]*)<\/bash-output-(?:filtered|rewritten)>\s*$/;

export function stripOutputMarkers(stdout: string): string {
  const match = WRAPPED_OUTPUT_RE.exec(stdout);
  return match ? match[1]! : stdout;
}

/** Plain-text disclosure of an executed rewrite, for the paths that must NOT
 * use {@link wrapStdoutWithMarkers}.
 *
 * The wrapper is stripped for display by exactly one renderer (the Bash success
 * one), and every other consumer prints the string it is given verbatim. The
 * error renderers do — `FallbackToolUseErrorMessage` shows the model-facing
 * text as-is — so a wrapped error put `<bash-output-rewritten original="make
 * lint 2&gt;&amp;1 | tail -40" …>` on the user's screen, XML-escaped
 * attributes and all. Teaching those renderers to unwrap is not the fix: the
 * error string carries a prefix (`Exit code N`, a git diagnosis line) AND a
 * possible suffix (the repeated-failure hint), so nothing about the wrapper is
 * anchored any more, and an unanchored strip would eat a tag-like substring out
 * of the output itself.
 *
 * A wrapper buys nothing here anyway — the error path runs no pipeline, so
 * there are no `lines=`/`reduction=` attributes to report, only the rewrite.
 * This is the same shape as the background-task disclosure in BashTool. */
export function prependRewriteNote(body: string, actual: string): string {
  return `Note: the bash output filter rewrote this command before execution; what ran was: ${actual}\n${body}`;
}

function truncateAttr(value: string): string {
  // Truncate the raw value BEFORE escaping so the cut can never land inside
  // an escape entity (`&quo…`). The escaped result may slightly exceed
  // MAX_ATTR_LEN — the limit is cosmetic, well-formedness is not.
  if (value.length <= MAX_ATTR_LEN) return escapeXmlAttr(value);
  return `${escapeXmlAttr(value.slice(0, MAX_ATTR_LEN - 1))}…`;
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
  // Concrete line-count evidence: "you got <bodyLines> of <originalLines> lines, errors
  // preserved". This is what tells the model the filter already trimmed the output, so
  // piping to head/tail is redundant (and would risk cutting the preserved error tail).
  const lines = pipelineResult
    ? ` lines="${pipelineResult.bodyLines}/${pipelineResult.originalLines}"`
    : "";

  if (hasRewrite && hasFilter) {
    const actual = truncateAttr(rewrite.to);
    return `<bash-output-filtered original="${original}" actual="${actual}"${lines} reduction="${reduction}%">${body}</bash-output-filtered>`;
  }

  if (hasRewrite) {
    const actual = truncateAttr(rewrite.to);
    return `<bash-output-rewritten original="${original}" actual="${actual}">${body}</bash-output-rewritten>`;
  }

  // Filter only
  return `<bash-output-filtered original="${original}"${lines} reduction="${reduction}%">${body}</bash-output-filtered>`;
}
