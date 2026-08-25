import { logForDebugging } from "src/shared/debug.js";
import { isEnvTruthy } from "src/shared/envUtils.js";
import {
  collapseDigitTemplates,
  collapseIdenticalRuns,
} from "src/agent/tools/toolResultSummarizer.js";
import type { RewriteContext } from "src/tools/shared/outputFilter/types.js";
import type { DroppedReducer, FilterSpec, PipelineResult } from "src/tools/shared/outputFilter/Bash/types.js";

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
// `timeout` cannot join the list above, because unlike `sudo`/`time` it takes an
// ARGUMENT: the duration sits between the wrapper and the command. Stripping the
// bare word would promote the duration to the verb and the command would match
// nothing (`timeout 300 docker compose up` → verb `300`).
//
// So the duration is part of the pattern, and that is also the safety property:
// with no duration to consume there is no match and nothing is stripped, which
// is what keeps `timeout --help` from having its flag promoted to a verb.
//
// GNU coreutils syntax: `timeout [OPTION] DURATION COMMAND [ARG]...`, where
// DURATION is a floating point number with an optional s/m/h/d suffix. It is a
// single number — `1h30m` is a `sleep`-ism that timeout rejects — so this does
// not try to accept one.
export const TIMEOUT_PREFIX_RE =
  /^timeout\s+(?:(?:-[ks]\s+\S+|--(?:kill-after|signal)(?:=\S+|\s+\S+)|--preserve-status|--foreground|--verbose|-v)\s+)*\d+(?:\.\d+)?[smhd]?\s+/;
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
    const timeout = rest.match(TIMEOUT_PREFIX_RE);
    if (timeout) {
      i += timeout[0].length;
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
/** The line-count forms of the above: `-40`, `-n40`, `-n 40`. `-c N` counts
 * bytes, which we do not emulate. */
const TAIL_LINE_COUNT_RE = /^(?:-n\s*|-)(\d+)$/;
/** `tail` with no arguments keeps the last 10 lines. */
const BARE_TAIL_LINES = 10;

function isPureReducer(segment: string): boolean {
  const trimmed = segment.trim();
  const verb = trimmed.split(WHITESPACE_RE, 1)[0] ?? "";
  const rest = trimmed.slice(verb.length).trim();
  if (verb === "cat") return rest === "";
  if (verb === "tail") return PURE_TAIL_ARGS_RE.test(rest);
  return false;
}

/** How many lines the reducer would have let through, or null when it caps
 * nothing we can reproduce (`cat`, or `tail -c` counting bytes). Only ever
 * called on a segment `isPureReducer` accepted. */
function reducerLineCap(segment: string): number | null {
  const trimmed = segment.trim();
  const verb = trimmed.split(WHITESPACE_RE, 1)[0] ?? "";
  if (verb !== "tail") return null;
  const rest = trimmed.slice(verb.length).trim();
  if (rest === "") return BARE_TAIL_LINES;
  const match = TAIL_LINE_COUNT_RE.exec(rest);
  return match ? Number(match[1]) : null;
}

/**
 * Detects a command shaped exactly as `BASE | <pure reducer>` at the top level and returns
 * the command without the trailing reducer pipe plus what that reducer was, or `null`
 * otherwise. The caller needs the reducer back: dropping it changes both the exit status
 * of the pipeline and the number of lines the model asked for, and it has to make good on
 * each (see `exitCodeAfterRewrite` and the error path of `applyBashFilterToStdout`).
 *
 * Reuses the same quote-/escape-/redirection-aware scan as `splitTopLevelSegments` and bails
 * on every construct that function bails on. Unlike it, a *single* top-level `|` is captured
 * as a split point instead of aborting.
 *
 * ## Why a chain is allowed in front of it
 *
 * `&&`, `||`, `;` and newline START A NEW COMMAND rather than transforming output, and `|`
 * binds tighter than all of them — bash reads `a && b | tail -5` as `a && (b | tail -5)`.
 * So the reducer applies to the LAST command of the chain, and running `a && b` in its place
 * is the same execution. Refusing the whole shape (which is what this did until the chain
 * branches below were added) cost the registry every `cd X && CMD | tail -N`: the atomic
 * `CMD | tail -N` resolved to CMD's spec while the same command behind a `cd` resolved to
 * nothing, because `splitTopLevelSegments` bails on the `|` and this function bailed on the
 * `&&` — each refusing for the reason the other exists.
 *
 * A separator only counts while no pipe has been seen yet. Past one, the pipe was not the
 * trailing one (`a | tail -4 && b | tail -3`) and the shape is refused, as is a second pipe
 * inside the same command (`a | b | tail -5`). Background, subshells and the rest still
 * disqualify wherever they appear.
 *
 * That `pipeIndex >= 0` test in the three separator branches is DEFENCE IN DEPTH, not the
 * thing currently doing the work, and a test written against it passes with it deleted.
 * `reducer` is sliced to the END of the string, so a separator after the pipe always lands
 * inside the reducer text and `isPureReducer` rejects it — `tail -4 && b` is not `tail -4`.
 * It goes load-bearing the moment `isPureReducer` accepts anything laxer, which is exactly
 * the kind of change this file invites (`head` has been proposed for it more than once), so
 * the invariant stays local rather than borrowed from a function three screens away.
 *
 * One fidelity note, deliberately accepted: the returned `lines` cap is applied by the caller
 * to the output of the WHOLE chain, where the shell applied it to the last command alone. For
 * the `cd X &&` shape that dominates real traffic the prefix prints nothing, so the two agree;
 * for `echo hi && cmd | tail -3` they do not.
 *
 * `base` and `reducer` are sliced out of the ORIGINAL string rather than rebuilt from the
 * scanner's buffer: the buffer drops the backslash of an escaped character, so a rebuilt
 * `echo a\&b | tail -5` came back as `echo a&b` — which bash then reads as backgrounding
 * `echo a`, in a string this function's caller EXECUTES.
 */
export function splitTrailingReducerPipe(
  command: string,
): { base: string; reducer: DroppedReducer } | null {
  // Offset of the single top-level `|` inside the last command of the chain.
  let pipeIndex = -1;
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
    if (c === "|" && next === "|") {
      if (pipeIndex >= 0) return null; // the pipe was not the trailing one
      buf = "";
      i++;
      continue;
    }
    if (c === "|") {
      // Top-level single pipe — the split point. A second one disqualifies.
      if (pipeIndex >= 0) return null;
      pipeIndex = i;
      buf = "";
      continue;
    }
    if (c === "&" && next === "&") {
      if (pipeIndex >= 0) return null;
      buf = "";
      i++;
      continue;
    }
    if (c === "&") {
      const lastBufChar = buf.length > 0 ? buf[buf.length - 1] : "";
      if (lastBufChar === ">" || next === ">") {
        buf += c;
        continue;
      }
      return null; // background
    }
    if (c === ";" || c === "\n") {
      if (pipeIndex >= 0) return null;
      buf = "";
      continue;
    }
    buf += c;
  }
  if (inSingle || inDouble) return null;
  if (pipeIndex < 0) return null; // need exactly one top-level pipe
  const base = command.slice(0, pipeIndex).trim();
  const reducer = command.slice(pipeIndex + 1).trim();
  if (base === "" || reducer === "") return null;
  if (!isPureReducer(reducer)) return null;
  return { base, reducer: { text: reducer, lines: reducerLineCap(reducer) } };
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
 * ("✓ already up to date") would swallow the other segments' output.
 *
 * `capLines` is the line cap of a reducer the plan stripped (`BASE | tail -N` → `BASE`).
 * It runs LAST, on what the filter selected: stripping the pipe is only defensible
 * because the filter trims better than a blind line count, and when the filter turns
 * out to trim nothing — a `make` failure has no `Entering directory` noise to strip —
 * the model would otherwise receive the whole output in place of the N lines it asked
 * for. Measured on a failing `make lint 2>&1 | tail -5`: 14 lines back, 0 stages applied. */
export function applyPipeline(
  filter: FilterSpec,
  raw: string,
  opts?: {
    allowShortCircuit?: boolean;
    capLines?: number | null;
    allowRenderBody?: boolean;
  },
): PipelineResult {
  const allowShortCircuit = opts?.allowShortCircuit ?? true;
  const allowRenderBody = opts?.allowRenderBody ?? true;
  const capLines = opts?.capLines ?? null;
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
    // 2b. renderBody — the whole-body reshape, before the line-oriented stages
    // get their hands on the text. Declining (null) is the normal outcome and
    // leaves the body untouched, so nothing is recorded as applied.
    if (filter.renderBody && allowRenderBody) {
      const rendered = filter.renderBody(text);
      if (rendered !== null && rendered !== text) {
        text = rendered;
        applied.push("renderBody");
      }
    }

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

    // 11b. The stripped reducer's own cap, applied to whatever survived above.
    // A short-circuited body never reaches here, and it is a one-line sentinel
    // anyway, so the cap could not bite it.
    if (capLines !== null) {
      // `tail -N` counts newline-terminated lines, so the empty element a
      // trailing newline leaves behind is not one of them — counting it cost a
      // line (a `| tail -5` came back with 4) the first time this shipped.
      const trailingBlank = lines.at(-1) === "";
      const content = trailingBlank ? lines.slice(0, -1) : lines;
      if (content.length > capLines) {
        const kept = content.slice(-capLines);
        lines = trailingBlank ? [...kept, ""] : kept;
        applied.push(`reducerCap:${capLines}`);
      }
    }

    text = lines.join("\n");
  }

  // 12. onEmpty
  if (text.trim() === "" && filter.onEmpty) {
    text = filter.onEmpty;
    applied.push("onEmpty");
  }

  // Clamped at 0: a matchOutput/onEmpty message can be longer than a tiny
  // original, and a negative percentage in the marker would only confuse.
  const reductionPct =
    originalLength > 0
      ? Math.max(
          0,
          Math.round(((originalLength - text.length) / originalLength) * 100),
        )
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
