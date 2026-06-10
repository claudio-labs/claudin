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
  if (!isEnvTruthy("CLAUDIN_BASH_FILTER_DEBUG")) return;
  const payload =
    detail === undefined
      ? `bash-output-filter: ${label}`
      : `bash-output-filter: ${label} ${JSON.stringify(detail)}`;
  logForDebugging(payload, { level: "info" });
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const LEADING_PREFIX_RE =
  /^(?:sudo\s+|time\s+|nice\s+|ionice\s+|chrt\s+|unshare\s+)+/;
// Runner prefixes whose argument IS the tool being invoked — stripping them
// lets every filter registered for the bare tool match the runner-invoked form
// (`poetry run pytest` → pytest, `npx eslint` → eslint, `pnpm dlx prettier` →
// prettier). Deliberately NOT included: script-by-name runners (`npm run`,
// `pnpm run`, `yarn <script>`, `bun run`) — their argument is a package-script
// name, not a tool, so the inner command is unknowable. Only zero-config flags
// are consumed (`npx -y`, `bunx --bun`); any other flag stops the strip and the
// command falls through to no-filter passthrough (fail-open).
export const RUNNER_PREFIX_RE =
  /^(?:npx\s+(?:(?:-y|--yes|--no-install|-q|--quiet)\s+)*|bunx\s+(?:--bun\s+)?|(?:poetry|pipenv|uv|hatch)\s+run\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+dlx\s+)/;
// Bash treats `\<LF>` as line continuation (joins lines into a single command).
// Used by `parseBashCommand` and `extractCommandPrefix` to collapse continuations
// before tokenization. Module-level so it is compiled once.
const LINE_CONTINUATION_RE = /\\\n/g;
const WHITESPACE_RE = /\s+/;
const DIGIT_TEMPLATE_RE = /\d+/g;

/** Returns the offset where the actual command begins, after consuming — in any
 * interleaving — env assignments (`FOO=bar`), wrapper prefixes (`sudo`, `time`, …)
 * and runner prefixes (`npx`, `poetry run`, …). Single source of truth for
 * `parseBashCommand`, `extractCommandPrefix` and `canonicalizeForMatching`, so
 * stripping and prefix re-prepending (on rewrite) stay in lockstep. */
export function consumeExecutionPrefix(s: string): number {
  let i = 0;
  for (;;) {
    const rest = s.slice(i);
    const ws = rest.length - rest.trimStart().length;
    if (ws > 0) {
      i += ws;
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(rest)) {
      const end = findEnvAssignmentEnd(rest);
      if (end === -1) return i;
      i += end;
      continue;
    }
    const lead = rest.match(LEADING_PREFIX_RE);
    if (lead) {
      i += lead[0].length;
      continue;
    }
    const runner = rest.match(RUNNER_PREFIX_RE);
    if (runner) {
      i += runner[0].length;
      continue;
    }
    return i;
  }
}

/** Strips env assignments, leading prefixes (sudo, time, nice…) and runner prefixes
 * (npx, poetry run, pnpm dlx…) to extract the verb and args.
 *
 * Env stripping is quote-, escape-, and subshell-aware via `findEnvAssignmentEnd` so that
 * `FOO="a b" git status`, `FOO=$(date) git status`, `FOO=a\ b git status` all canonicalize
 * to `git status` (verb `git`, args `[status]`). Backslash-newline line continuations are
 * collapsed into a single space before tokenization so `git \<LF>status` parses as
 * verb `git`, args `[status]`.
 */
export function parseBashCommand(command: string): RewriteContext {
  // Collapse `\<LF>` line continuations into a single space (bash semantics).
  const collapsed = command.replace(LINE_CONTINUATION_RE, " ");
  const trimmed = collapsed.slice(consumeExecutionPrefix(collapsed)).trim();
  const parts = trimmed.split(WHITESPACE_RE);
  const verb = parts[0] ?? "";
  const args = parts.slice(1);
  return { command: trimmed, verb, args };
}

/** Returns the index immediately after an env assignment value (start of the next token), or -1
 * if no whitespace boundary is found.
 *
 * Quote-, escape-, and subshell-aware: `FOO="a b"`, `FOO=a\ b`, `FOO=$(date)`, `FOO=\`date\``
 * all advance past the full value before returning the next-token offset. Returns -1 (no
 * boundary) when quotes/subshells are unclosed — caller should treat this as "do not strip".
 */
export function findEnvAssignmentEnd(s: string): number {
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0; // tracks `$(...)` (and nested) depth
  let inBacktick = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (c === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === "`") inBacktick = false;
      continue;
    }
    if (parenDepth > 0) {
      if (c === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        continue;
      }
      if (c === "(") parenDepth++;
      else if (c === ")") parenDepth--;
      continue;
    }
    // Outside quotes/subshells.
    if (c === "\\" && i + 1 < s.length) {
      // Backslash escapes the next char (including space) — it stays part of the value.
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "`") {
      inBacktick = true;
      continue;
    }
    if (c === "$" && s[i + 1] === "(") {
      parenDepth = 1;
      i++;
      continue;
    }
    if (c === " " || c === "\t") return i + 1;
  }
  return -1;
}

/** True if the command uses shell operators (`&&`, `||`, `|`, `;`), subshells, process
 * substitution, heredocs, control flow, or unbalanced quotes — these bypass single-filter matching.
 *
 * Quote-aware: `git log --grep='fix; pwd'` is atomic, not compound, because the `;` is inside
 * single quotes. Implemented via `splitTopLevelSegments`, which is the single source of truth
 * for what counts as a separable boundary. Any input the splitter refuses (returns `null`) or
 * splits into >1 segments is treated as compound. */
export function hasCompound(command: string): boolean {
  const segments = splitTopLevelSegments(command.trim());
  return segments === null || segments.length > 1;
}

/** Returns the env-assignment + leading-prefix + runner-prefix slice of a command
 * (e.g. `GIT_PAGER=cat sudo ` for `GIT_PAGER=cat sudo git log`, `poetry run ` for
 * `poetry run pytest`). Used by `maybeRewrite` to re-prepend the prefix onto the
 * rewritten verb so env overrides, `sudo` and runners are not silently dropped.
 * Shares `consumeExecutionPrefix` with `parseBashCommand` so the two stay in
 * lockstep. Always returns a string ending at a token boundary (or empty). */
export function extractCommandPrefix(command: string): string {
  const collapsed = command.replace(LINE_CONTINUATION_RE, " ");
  return collapsed.slice(0, consumeExecutionPrefix(collapsed));
}

// ---------------------------------------------------------------------------
// Command matching
// ---------------------------------------------------------------------------

/** Tests the canonicalized command against `matchCommand`, rejects compounds, and honours `matchCommandReject`. */
export function matchesCommand(filter: FilterSpec, command: string): boolean {
  if (hasCompound(command)) return false;
  return matchesAtomicCommand(filter, command);
}

/** Same as `matchesCommand` but skips the compound bypass — caller guarantees the input is a single atomic segment. */
export function matchesAtomicCommand(
  filter: FilterSpec,
  command: string,
): boolean {
  const ctx = parseBashCommand(command);
  // No verb means no command to match — pure env assignment, blank, or
  // similar. A greedy user filter (`/.*/`) would otherwise match the empty
  // string and try to rewrite a no-op.
  if (ctx.verb === "") return false;
  if (
    !filter.matchCommand.test(ctx.verb) &&
    !filter.matchCommand.test(ctx.command)
  )
    return false;
  if (filter.matchCommandReject?.test(ctx.command)) return false;
  return true;
}

const CONTROL_FLOW_VERBS = new Set([
  "then",
  "do",
  "done",
  "if",
  "fi",
  "while",
  "for",
  "case",
  "esac",
  "function",
  "elif",
  "else",
  "in",
  "select",
  "until",
]);

/**
 * Splits a compound command into atomic top-level segments separated by
 * `&&`, `||`, `;`, or unquoted newlines (bash treats `\n` as a statement
 * separator equivalent to `;`).
 *
 * Returns `null` when the command uses constructs we cannot safely split:
 * pipes (`|`), background (`&`), subshells (`$(...)`, backticks, `<()`, `>()`),
 * heredocs (`<<`), shell control-flow keywords, or unclosed quotes.
 *
 * Quote-aware so that `echo "a; b" && ls` splits cleanly into [`echo "a; b"`, `ls`].
 * Backslash-newline (`\<LF>`) is a line continuation and is consumed silently
 * (bash semantics — joins lines into a single command).
 * Whitespace around segments is trimmed; empty segments are dropped.
 *
 * Control-flow keywords are detected post-split by inspecting each segment's
 * verb (so `echo "; then ls"` keeps its quoted token and is not misclassified).
 */
export function splitTopLevelSegments(command: string): string[] | null {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    const next = command[i + 1] ?? "";
    if (inSingle) {
      if (c === "'") inSingle = false;
      buf += c;
      continue;
    }
    if (inDouble) {
      // Track escapes so we don't exit the double-quoted region on \"
      if (c === "\\" && next) {
        buf += c + next;
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      buf += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      buf += c;
      continue;
    }
    // Backslash escapes the next character (outside quotes). `\<LF>` is line
    // continuation — drop both. Any other `\X` keeps X verbatim (so `\&` does
    // not split, `\;` does not split). This matches bash's rules for unquoted
    // backslash.
    if (c === "\\" && next) {
      if (next === "\n") {
        i++;
        continue;
      }
      buf += next;
      i++;
      continue;
    }
    // Bail on constructs we cannot safely segment:
    if (c === "`") return null; // backtick subshell
    if (c === "$" && next === "(") return null; // $(...) subshell
    if ((c === "<" || c === ">") && next === "(") return null; // process substitution
    if (c === "<" && next === "<") return null; // heredoc — body would be split mid-text
    // `[[ ... ]]` test brackets and `(( ... ))` arithmetic eval can contain
    // `&&` / `||` operators that are NOT statement separators. Splitting
    // through them produces wrong segments, so bail conservatively.
    if (c === "[" && next === "[") return null;
    if (c === "(" && next === "(") return null;
    // `|&` (bash 4+ pipe-with-stderr) — same risk as a plain pipe.
    if (c === "|" && next === "&") return null;
    if (c === "|" && next === "|") {
      segments.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (c === "|") return null; // single pipe — output is transformed, not concatenated
    if (c === "&" && next === "&") {
      segments.push(buf);
      buf = "";
      i++;
      continue;
    }
    // Redirection forms that contain `&` but are NOT command separators:
    //   - `N>&M` / `>&FILE` — dup or merge file descriptors (e.g. `cmd 2>&1`)
    //   - `&>FILE` / `&>>FILE` — bash shortcut for redirecting stdout+stderr
    // BashTool already merges stderr into stdout (BashTool.tsx:725), so users
    // append `2>&1` out of habit; treating these as compound was making the
    // output filter skip otherwise-atomic commands.
    if (c === "&") {
      const lastBufChar = buf.length > 0 ? buf[buf.length - 1] : "";
      if (lastBufChar === ">" || next === ">") {
        buf += c;
        continue;
      }
      return null; // background — output ordering undefined
    }
    if (c === ";" || c === "\n") {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (inSingle || inDouble) return null;
  segments.push(buf);
  const cleaned = segments.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) return null;
  // Reject if any segment begins with a control-flow keyword. Doing this on
  // the cleaned segment (rather than on raw input) keeps the check quote-aware
  // — `echo "; then ls"` stays as a single segment whose verb is `echo`.
  for (const seg of cleaned) {
    const verb = seg.split(WHITESPACE_RE, 1)[0] ?? "";
    if (CONTROL_FLOW_VERBS.has(verb)) return null;
  }
  return cleaned;
}

/**
 * `tail`/`cat` consume their entire stdin, so `BASE | tail -40` (or `| cat`) runs BASE
 * identically to BASE alone — the trailing pipe is a *manual* version of what the output
 * filter already does, only worse (a blind line cap can drop the failing line above it).
 *
 * `head` is deliberately excluded: it closes the pipe early (SIGPIPE), so stripping it would
 * turn an early-exit command (`grep -r`, `ls -R`, `find`) into a full scan — see plan D3.
 *
 * A "pure" reducer is `tail` with only count flags (`-N`, `-nN`, `-n N`, `-c N`) or bare `cat`
 * (no args). Anything else (`tail -f`, `tail file`, `cat -A`, `cat file`) disqualifies.
 */
const PURE_TAIL_ARGS_RE = /^(?:-n\s*\d+|-\d+|-c\s*\d+)?$/;

function isPureReducer(segment: string): boolean {
  const trimmed = segment.trim();
  const verb = trimmed.split(WHITESPACE_RE, 1)[0] ?? "";
  const rest = trimmed.slice(verb.length).trim();
  if (verb === "cat") return rest === "";
  if (verb === "tail") return PURE_TAIL_ARGS_RE.test(rest);
  return false;
}

/**
 * Detects a command shaped exactly as `BASE | <pure reducer>` at the top level and returns
 * `{ base }` (the command without the trailing reducer pipe), or `null` otherwise.
 *
 * Reuses the same quote-/escape-/redirection-aware scan as `splitTopLevelSegments` and bails
 * on every construct that function bails on. Unlike it, a *single* top-level `|` is captured
 * as a split point instead of aborting. Any other top-level operator (`&&`, `||`, `;`, newline,
 * background, a second `|`) disqualifies, keeping this strictly to the `BASE | REDUCER` shape.
 */
export function splitTrailingReducerPipe(command: string): { base: string } | null {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    const next = command[i + 1] ?? "";
    if (inSingle) {
      if (c === "'") inSingle = false;
      buf += c;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && next) {
        buf += c + next;
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      buf += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      buf += c;
      continue;
    }
    if (c === "\\" && next) {
      if (next === "\n") {
        i++;
        continue;
      }
      buf += next;
      i++;
      continue;
    }
    // Same bail-outs as splitTopLevelSegments.
    if (c === "`") return null;
    if (c === "$" && next === "(") return null;
    if ((c === "<" || c === ">") && next === "(") return null;
    if (c === "<" && next === "<") return null;
    if (c === "[" && next === "[") return null;
    if (c === "(" && next === "(") return null;
    if (c === "|" && next === "&") return null;
    if (c === "|" && next === "|") return null; // `||` is a separator, not the shape we want
    if (c === "|") {
      // Top-level single pipe — a split point. A second one disqualifies.
      if (segments.length > 0) return null;
      segments.push(buf);
      buf = "";
      continue;
    }
    if (c === "&" && next === "&") return null;
    if (c === "&") {
      const lastBufChar = buf.length > 0 ? buf[buf.length - 1] : "";
      if (lastBufChar === ">" || next === ">") {
        buf += c;
        continue;
      }
      return null; // background
    }
    if (c === ";" || c === "\n") return null;
    buf += c;
  }
  if (inSingle || inDouble) return null;
  if (segments.length !== 1) return null; // need exactly one top-level pipe
  const base = segments[0]?.trim() ?? "";
  const reducer = buf.trim();
  if (base === "" || reducer === "") return null;
  if (!isPureReducer(reducer)) return null;
  return { base };
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

/** Invokes the filter's `rewriteCommand` and returns the rewrite pair, or null if unchanged / not applicable.
 *
 * Re-prepends any env-assignment / leading-prefix (sudo, time, …) that `parseBashCommand`
 * stripped before passing the command to the filter, so a rewrite like `git log` →
 * `git log --oneline` does not silently drop a user-supplied `GIT_PAGER=cat` or `sudo`.
 * Identity is checked against the canonicalized command (the form the filter sees), so a
 * filter returning its input unchanged correctly produces no marker. */
export function maybeRewrite(
  filter: FilterSpec,
  command: string,
): { rewritten: string; original: string } | null {
  if (!filter.rewriteCommand) return null;
  const ctx = parseBashCommand(command);
  const rewritten = filter.rewriteCommand(ctx);
  if (!rewritten || rewritten === ctx.command) return null;
  const prefix = extractCommandPrefix(command);
  return { rewritten: prefix + rewritten, original: command };
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

const HEAD_TAIL_OMIT_MARKER = "…N lines omitted…";
const DEFAULT_HEAD_LINES = 15;
const DEFAULT_TAIL_LINES = 15;

/** Counts lines for the marker's `lines="body/original"` evidence. Empty → 0; a single
 * trailing newline is not counted as an extra line so counts match what a human would say. */
function countLines(text: string): number {
  if (text === "") return 0;
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.split("\n").length;
}

// Hard cap on raw input size fed into the pipeline. Anything larger is passed
// through unchanged with a tail-truncation marker — the regex engine has no
// timeout, so an unbounded input combined with a marginally-greedy user regex
// is the realistic ReDoS path. 8 MiB covers any reasonable command output;
// anything bigger is almost always a corrupted binary or a runaway loop.
const PIPELINE_INPUT_MAX_BYTES = 8 * 1024 * 1024;

/** Runs the full filter pipeline (stripAnsi → matchOutput → replace → collapse → dedup → strip/keep → truncate → head/tail → onEmpty) and returns the result with applied-stage names and reduction percentage.
 *
 * `allowShortCircuit: false` skips the matchOutput stage — used for compound commands,
 * where the output interleaves several commands and a single-command sentinel
 * ("✓ already up to date") would swallow the other segments' output. */
export function applyPipeline(
  filter: FilterSpec,
  raw: string,
  opts?: { allowShortCircuit?: boolean },
): PipelineResult {
  const allowShortCircuit = opts?.allowShortCircuit ?? true;
  if (raw.length > PIPELINE_INPUT_MAX_BYTES) {
    debug("input exceeds cap, bypassing pipeline", {
      length: raw.length,
      cap: PIPELINE_INPUT_MAX_BYTES,
    });
    return {
      body: raw,
      applied: [],
      shortCircuited: false,
      reductionPct: 0,
      originalLines: countLines(raw),
      bodyLines: countLines(raw),
    };
  }
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

  // 2. matchOutput — short-circuit (atomic commands only, see doc comment)
  if (filter.matchOutput && allowShortCircuit) {
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
        const before = text;
        text = text.replace(rule.pattern, rule.replacement);
        if (text !== before)
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
    originalLines: countLines(raw),
    bodyLines: countLines(text),
  };
}
