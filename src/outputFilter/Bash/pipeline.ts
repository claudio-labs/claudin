import { logForDebugging } from "src/utils/debug.js";
import { isEnvTruthy } from "src/utils/envUtils.js";
import {
  collapseDigitTemplates,
  collapseIdenticalRuns,
} from "src/utils/toolResultSummarizer.js";
import type { RewriteContext } from "../types.js";
import type { FilterSpec, PipelineResult } from "./types.js";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

import stripAnsiLib from "strip-ansi";

function stripAnsi(text: string): string {
  return stripAnsiLib(text);
}

function dedupGlobal(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function debug(label: string, detail?: unknown): void {
  if (!isEnvTruthy("CLAUDIO_BASH_FILTER_DEBUG")) return;
  const payload =
    detail === undefined
      ? `bash-output-filter: ${label}`
      : `bash-output-filter: ${label} ${JSON.stringify(detail)}`;
  logForDebugging(payload, { level: "info" });
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const LEADING_PREFIX_RE =
  /^(?:sudo\s+|time\s+|nice\s+|ionice\s+|chrt\s+|unshare\s+)+/;
// Keywords are only shell control-flow when delimited by whitespace/metacharacters —
// NOT inside flag names like --for-each-ref or filenames like done.txt.
const COMPOUND_RE =
  /[;&|]|`\S|`\$|\$\(|>\(|(?:(?:^|[\s;&|()`])(?:then|do|done|if|while|for)(?=[\s;&|()`]|$))/;
const WHITESPACE_RE = /\s+/;
const DIGIT_TEMPLATE_RE = /\d+/g;

/** Strips env assignments and leading prefixes (sudo, time, nice…) to extract the verb and args. */
export function parseBashCommand(command: string): RewriteContext {
  let trimmed = command.trim();
  // Strip env assignments
  while (ENV_ASSIGNMENT_RE.test(trimmed)) {
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) break;
    trimmed = trimmed.slice(spaceIdx + 1).trimStart();
  }
  // Strip leading prefixes
  trimmed = trimmed.replace(LEADING_PREFIX_RE, "");
  const parts = trimmed.split(WHITESPACE_RE);
  const verb = parts[0] ?? "";
  const args = parts.slice(1);
  return { command: trimmed, verb, args };
}

/** True if the command uses shell operators (`&&`, `||`, `|`, `;`), subshells, or control flow — these bypass filtering.
 * Compound commands can fan out to multiple verbs, so there is no single canonical verb to match a filter against. */
export function hasCompound(command: string): boolean {
  const trimmed = command.trim();
  return COMPOUND_RE.test(trimmed);
}

// ---------------------------------------------------------------------------
// Command matching
// ---------------------------------------------------------------------------

/** Tests the canonicalized command against `matchCommand`, rejects compounds, and honours `matchCommandReject`. */
export function matchesCommand(filter: FilterSpec, command: string): boolean {
  if (hasCompound(command)) return false;
  const ctx = parseBashCommand(command);
  if (
    !filter.matchCommand.test(ctx.verb) &&
    !filter.matchCommand.test(ctx.command)
  )
    return false;
  if (filter.matchCommandReject?.test(ctx.command)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

/** Invokes the filter's `rewriteCommand` and returns the rewrite pair, or null if unchanged / not applicable. */
export function maybeRewrite(
  filter: FilterSpec,
  command: string,
): { rewritten: string; original: string } | null {
  if (!filter.rewriteCommand) return null;
  const ctx = parseBashCommand(command);
  const rewritten = filter.rewriteCommand(ctx);
  // Treat an identity rewrite as "no rewrite" so no marker is emitted for an unchanged command.
  if (!rewritten || rewritten === command) return null;
  return { rewritten, original: command };
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

const HEAD_TAIL_OMIT_MARKER = "…N lines omitted…";
const DEFAULT_HEAD_LINES = 15;
const DEFAULT_TAIL_LINES = 15;

/** Runs the full filter pipeline (stripAnsi → matchOutput → replace → collapse → dedup → strip/keep → truncate → head/tail → onEmpty) and returns the result with applied-stage names and reduction percentage. */
export function applyPipeline(filter: FilterSpec, raw: string): PipelineResult {
  const originalLength = raw.length;
  let text = raw;
  const applied: string[] = [];
  let shortCircuited = false;

  // 1. stripAnsi — must run first so matchOutput patterns match on clean text
  if (filter.stripAnsi) {
    const before = text.length;
    text = stripAnsi(text);
    if (text.length !== before) applied.push("stripAnsi");
  }

  // 2. matchOutput — short-circuit
  if (filter.matchOutput) {
    for (const rule of filter.matchOutput) {
      if (rule.pattern.test(text)) {
        let skip = false;
        if (rule.unless?.test(text)) skip = true;
        if (!skip) {
          debug("matchOutput short-circuit", rule.message);
          shortCircuited = true;
          applied.push(`matchOutput:${rule.message}`);
          text = rule.message;
          break;
        }
      }
    }
  }

  if (!shortCircuited) {
    // 3. replace
    if (filter.replace) {
      for (const rule of filter.replace) {
        if (rule.unless?.test(text)) continue;
        const before = text.length;
        text = text.replace(rule.pattern, rule.replacement);
        if (text.length !== before)
          applied.push(`replace:${rule.pattern.source.slice(0, 30)}`);
      }
    }

    // Split into lines for line-oriented stages
    let lines = text.split("\n");

    // 4. collapseRuns
    if (filter.collapseRuns) {
      const before = lines.length;
      lines = collapseIdenticalRuns(lines);
      if (lines.length !== before) applied.push("collapseRuns");
    }

    // 5. collapseDigitTemplates
    if (filter.collapseDigitTemplates) {
      const before = lines.length;
      const minRun =
        typeof filter.collapseDigitTemplates === "object" &&
        filter.collapseDigitTemplates.minRun
          ? filter.collapseDigitTemplates.minRun
          : undefined;
      // The shared helper uses a fixed minRun of 5; if caller wants a different
      // threshold we apply our own thin wrapper. For the common case (true),
      // just delegate directly.
      if (minRun !== undefined) {
        // Custom threshold: inline a minimal digit-template collapser
        const out: string[] = [];
        let template: string | null = null;
        let runStart = 0;
        let runCount = 0;
        const emitRun = (endExclusive: number) => {
          if (runCount >= minRun) {
            out.push(`${lines[runStart] ?? ""} (${runCount} updates)`);
          } else {
            for (let i = runStart; i < endExclusive; i++)
              out.push(lines[i] ?? "");
          }
        };
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          const t = line.replaceAll(DIGIT_TEMPLATE_RE, "#");
          if (template !== null && t === template) {
            runCount++;
            continue;
          }
          if (template !== null) emitRun(i);
          template = t;
          runStart = i;
          runCount = 1;
        }
        if (template !== null) emitRun(lines.length);
        lines = out;
      } else {
        lines = collapseDigitTemplates(lines);
      }
      if (lines.length !== before) applied.push("collapseDigitTemplates");
    }

    // 6. dedupGlobal
    if (filter.dedupGlobal) {
      const before = lines.length;
      lines = dedupGlobal(lines);
      if (lines.length !== before) applied.push("dedupGlobal");
    }

    // 7. stripLinesMatching
    if (filter.stripLinesMatching) {
      const stripRes = filter.stripLinesMatching;
      const before = lines.length;
      lines = lines.filter((line) => !stripRes.some((re) => re.test(line)));
      if (lines.length !== before) applied.push("stripLinesMatching");
    }

    // 8. keepLinesMatching
    if (filter.keepLinesMatching) {
      const keepRes = filter.keepLinesMatching;
      const before = lines.length;
      lines = lines.filter((line) => keepRes.some((re) => re.test(line)));
      if (lines.length !== before) applied.push("keepLinesMatching");
    }

    // 9. truncateLineAt
    if (filter.truncateLineAt) {
      const limit = filter.truncateLineAt;
      let changed = false;
      lines = lines.map((line) => {
        if (line.length > limit) {
          changed = true;
          return `${line.slice(0, limit)}…`;
        }
        return line;
      });
      if (changed) applied.push("truncateLineAt");
    }

    // 10. maxLines (takes priority over headLines+tailLines)
    if (filter.maxLines && lines.length > filter.maxLines) {
      const head = filter.headLines ?? DEFAULT_HEAD_LINES;
      const tail = filter.tailLines ?? DEFAULT_TAIL_LINES;
      const omitted = lines.length - head - tail;
      if (omitted > 0) {
        const headPart = head > 0 ? lines.slice(0, head) : [];
        const tailPart = tail > 0 ? lines.slice(-tail) : [];
        lines = [
          ...headPart,
          HEAD_TAIL_OMIT_MARKER.replace("N", String(omitted)),
          ...tailPart,
        ];
        applied.push("maxLines");
      }
    } else if (filter.headLines || filter.tailLines) {
      // 11. headLines + tailLines (when no maxLines or within maxLines)
      const head = filter.headLines ?? 0;
      const tail = filter.tailLines ?? 0;
      if (lines.length > head + tail + 1) {
        const omitted = lines.length - head - tail;
        const headPart = head > 0 ? lines.slice(0, head) : [];
        const tailPart = tail > 0 ? lines.slice(-tail) : [];
        lines = [
          ...headPart,
          HEAD_TAIL_OMIT_MARKER.replace("N", String(omitted)),
          ...tailPart,
        ];
        applied.push("headTailLines");
      }
    }

    text = lines.join("\n");
  }

  // 12. onEmpty
  if (text.trim() === "" && filter.onEmpty) {
    text = filter.onEmpty;
    applied.push("onEmpty");
  }

  const reductionPct =
    originalLength > 0
      ? Math.round(((originalLength - text.length) / originalLength) * 100)
      : 0;

  debug("pipeline result", { applied, reductionPct, shortCircuited });

  return {
    body: text,
    applied,
    shortCircuited,
    reductionPct,
  };
}
