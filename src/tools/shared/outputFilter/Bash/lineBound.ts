/**
 * How many lines a Bash command's own syntax limits its output to — the bound
 * the model wrote into it — or null when any part of it prints without one.
 *
 * ## Why it has a name
 *
 * The floor cap (`floor.ts`) keeps the first and last 15 lines of unmatched
 * output past 60. On a read the model already sized — `sed -n 95,135p a.ts;
 * sed -n 279,310p b.ts`, `grep -n X -A 60 f | head -90` — that cut removes the
 * middle it asked for, and the next request reads the same file again, whole.
 * Over the real corpus of 2026-09-14..25 (team memory
 * `cut-results-request-cost-2026-09-25`), a sub-agent re-read or re-ran within
 * three requests after 48% of the capped range reads and 41% of the capped
 * searches into a bound, against 15% after an uncut result of the same size.
 * After `cmd | head -N` of any other command it was 14%, the baseline, so that
 * shape is not here: the floor honors the bound of these shapes and no other
 * (`index.ts`, `isWithinCommandBound`).
 *
 * ## What counts
 *
 * Pipelines joined by `;`, `&&`, `||` or newlines; the bound is their sum.
 *
 * - A range print of files:
 *   - `sed -n` whose script holds only numeric `A,Bp` and `Ap` commands,
 *     `;`-joined or in repeated `-e`s — the sum of the ranges, since sed reads
 *     its files as one stream (times the files under `-s`);
 *   - `head`/`tail`, bare (10) or with `-N`, `-n N` or `-nN`, over paths it
 *     can count — N per file, plus two header lines per file when there are
 *     several;
 *   - `awk` whose program is an `NR` range (`NR>=A && NR<=B`, `NR==A,NR==B`,
 *     `NR<=B`) with at most a `{print …}` body — the range, NR counting across
 *     files.
 * - A pipeline whose bound is one of those over stdin, fed only by file prints
 *   (`cat`, `nl`, `git show <rev>:<path>`), searches (`grep`, `egrep`, `fgrep`,
 *   `rg`) or other range prints — or one of those over files at its head.
 *   What follows the bound may only drop or reshape lines: `cut`, `tr`,
 *   `sort`, `uniq`, `column`, `wc`, a bare `cat` or `nl`, a `grep` over stdin
 *   without `-o` or context.
 * - `for V in <literal words>; do …; done` around any of these — the body's
 *   bound once per word, `$V` counting as one file.
 * - Glue: `echo` and `printf` (a line, plus one per `\n` written out),
 *   `cd <dir>`, `NAME=value` and `true` (none), `wc -l|-c|-w` and `grep -c`
 *   over paths (a line per path, plus wc's total line).
 *
 * At least one range print must be there: `echo` alone is not a read. Anything
 * else refuses the whole command — `cat f`, `tail -n +N`, `sed -n '/re/p'` or
 * `'10,$p'`, a loop over a glob, `ls`, any other producer piped into `head`, an
 * output redirect (`2>&1` included: the walk cannot tell it from a write), a
 * substitution, a subshell or a group.
 */
import { walkCommandSegments } from "src/platform/bash/segments.js";
import {
  cdTarget,
  type ReadWord,
  wordsOf,
} from "src/tools/shared/outputFilter/Bash/fileReadShape.js";

/** Command substitution, which survives shell-quote's parse as plain text. */
const SUBSTITUTION_RE = /\$\(|`/;
/** A word the shell would rewrite, hiding how many files it names. */
const EXPANDED_WORD_RE = /[$`{}]|^~/;
/** `$DIR/a.ts`, `${DIR}/a.ts`, `~/a.ts`: one path under a directory the shell fills in. */
const ONE_EXPANDED_PATH_RE = /^(?:\$\{?\w+\}?|~)\/[^\s*?[\]{}$`]+$/;
const LOOP_VARIABLE_RE = /^[A-Za-z_]\w*$/;
const ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;
const COUNT_RE = /^\d+$/;
/** `head -20`: the count spelled as the flag. */
const DASH_COUNT_RE = /^-(\d+)$/;
/** `head -n20`: the count glued to `-n`. */
const GLUED_COUNT_RE = /^-n(\d+)$/;
/** What `head` and `tail` print with no count. */
const DEFAULT_HEAD_TAIL_LINES = 10;

/** One sed command of a range print: `12p` or `12,40p`. */
const SED_PRINT_RE = /^(\d+)(?:,(\d+))?p$/;
const SED_SCRIPT_SPLIT_RE = /[;\n]/;
const SED_QUIET_FLAGS: ReadonlySet<string> = new Set(["-n", "--quiet", "--silent"]);
/** Flags that change how a script is read, not which lines it prints. */
const SED_INERT_FLAGS: ReadonlySet<string> = new Set(["-E", "-r", "--regexp-extended"]);
const SED_SEPARATE_FLAGS: ReadonlySet<string> = new Set(["-s", "--separate"]);
const SED_EXPRESSION_FLAGS: ReadonlySet<string> = new Set(["-e", "--expression"]);
/** `-nE`, `-ne`: short flags run together; an `e` at the end takes the next word. */
const SED_SHORT_FLAGS_RE = /^-[nErs]*e?$/;

/** `NR>=A && NR<=B`, either side strict or not, then an optional body. */
const AWK_RANGE_RE = /^\s*NR\s*(>=?)\s*(\d+)\s*&&\s*NR\s*(<=?)\s*(\d+)\s*(\{[\s\S]*\})?\s*$/;
/** `NR==A,NR==B`: a range pattern, printing from line A through line B. */
const AWK_BETWEEN_RE = /^\s*NR\s*==\s*(\d+)\s*,\s*NR\s*==\s*(\d+)\s*(\{[\s\S]*\})?\s*$/;
/** `NR<=B`: the first B lines. */
const AWK_UP_TO_RE = /^\s*NR\s*(<=?)\s*(\d+)\s*(\{[\s\S]*\})?\s*$/;
/** A body that prints the line it is given and nothing else: no redirect, pipe or second statement. */
const AWK_PRINT_BODY_RE = /^\{\s*print\b[^{}>|;]*\}$/;
const AWK_SIDE_EFFECT_RE = /\b(?:system|getline)\b/;

const WC_FLAGS: ReadonlySet<string> = new Set(["-l", "-c", "-w"]);
/** `grep -c`, alone or run together with flags that change what matches, not what prints. */
const GREP_COUNT_FLAGS_RE = /^-[iEFwxv]*c[iEFwxv]*$/;
const GREP_MATCH_FLAGS_RE = /^-[iEFwxv]+$/;
/** A grep over stdin that prints at most one line per line it reads: no `-o`, no context, no recursion. */
const GREP_FILTER_FLAGS_RE = /^-[iEFwxvnch]+$/;
const NEWLINE_ESCAPE_RE = /\\n/g;

const SEARCHERS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg"]);
const FILE_PRINTERS: ReadonlySet<string> = new Set(["cat", "nl"]);
const RANGE_PRINTERS: ReadonlySet<string> = new Set(["sed", "head", "tail", "awk"]);
/** `|| true` and friends: a status, no output. */
const SILENT_COMMANDS: ReadonlySet<string> = new Set(["true", "false", ":"]);
/** Stages that never print more lines than they read. */
const LINE_FILTERS: ReadonlySet<string> = new Set(["cut", "tr", "sort", "uniq", "column", "wc"]);

/** What one stage bounds its output to, and the files it reads rather than stdin. */
type StageBound = { readonly lines: number; readonly files: readonly ReadWord[] };
/** The variables of the `for` loops a segment sits in: each stands for one word per pass. */
type Scope = { readonly loopVariables: ReadonlySet<string> };

/** How many paths `words` name, or null when a glob or an expansion hides the count. */
function pathCount(words: readonly ReadWord[], scope: Scope): number | null {
  for (const word of words) {
    if (word.glob || word.text === "-") return null;
    if (!EXPANDED_WORD_RE.test(word.text)) continue;
    const loopVariable = word.text.startsWith("$") && scope.loopVariables.has(word.text.slice(1));
    if (!loopVariable && !ONE_EXPANDED_PATH_RE.test(word.text)) return null;
  }
  return words.length;
}

/** `head`/`tail` with a line count, or none; null for bytes (`-c`), `tail -n +N`, `-f` and any other flag. */
function headOrTailBound(args: readonly ReadWord[], scope: Scope): StageBound | null {
  let lines = DEFAULT_HEAD_TAIL_LINES;
  const files: ReadWord[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (!afterDoubleDash && text === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && text.startsWith("-") && text !== "-") {
      const inline = DASH_COUNT_RE.exec(text) ?? GLUED_COUNT_RE.exec(text);
      if (inline) {
        lines = Number(inline[1]);
        continue;
      }
      if (text !== "-n") return null;
      const count = args[++i]?.text ?? "";
      if (!COUNT_RE.test(count)) return null;
      lines = Number(count);
      continue;
    }
    files.push(args[i]!);
  }
  if (files.length === 0) return { lines, files };
  // A glob or a variable may stand for any number of files, each printing N lines.
  const count = pathCount(files, scope);
  if (count === null) return null;
  if (count === 1) return { lines, files };
  // Several files: N lines each, and a `==> f <==` header plus a blank line between them.
  return { lines: count * (lines + 2), files };
}

/** The lines one sed script prints, or null when any command in it is not a numeric range print. */
function sedScriptLines(script: string): number | null {
  let lines = 0;
  for (const part of script.split(SED_SCRIPT_SPLIT_RE)) {
    const command = part.trim();
    if (command === "") continue;
    const match = SED_PRINT_RE.exec(command);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    // `40,12p` prints line 40 alone.
    lines += Math.max(to - from + 1, 1);
  }
  return lines > 0 ? lines : null;
}

/** `sed -n` with a script of numeric range prints; null without `-n`, where sed prints every line. */
function sedBound(args: readonly ReadWord[], scope: Scope): StageBound | null {
  let quiet = false;
  let separate = false;
  const scripts: string[] = [];
  const positional: ReadWord[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const text = arg.text;
    if (!afterDoubleDash && text === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (afterDoubleDash || !text.startsWith("-") || text === "-") {
      positional.push(arg);
      continue;
    }
    if (SED_QUIET_FLAGS.has(text)) quiet = true;
    else if (SED_SEPARATE_FLAGS.has(text)) separate = true;
    else if (SED_INERT_FLAGS.has(text)) continue;
    else if (SED_EXPRESSION_FLAGS.has(text) || (SED_SHORT_FLAGS_RE.test(text) && text.endsWith("e"))) {
      if (text.includes("n") && !text.startsWith("--")) quiet = true;
      if (text.includes("s") && !text.startsWith("--")) separate = true;
      const script = args[++i];
      if (!script || script.glob) return null;
      scripts.push(script.text);
    } else if (SED_SHORT_FLAGS_RE.test(text)) {
      if (text.includes("n")) quiet = true;
      if (text.includes("s")) separate = true;
    } else return null;
  }
  if (!quiet) return null;
  if (scripts.length === 0) {
    const script = positional.shift();
    if (!script || script.glob) return null;
    scripts.push(script.text);
  }
  let lines = 0;
  for (const script of scripts) {
    const scriptLines = sedScriptLines(script);
    if (scriptLines === null) return null;
    lines += scriptLines;
  }
  // One stream across every file, unless `-s` restarts the line count in each.
  if (!separate || positional.length === 0) return { lines, files: positional };
  const count = pathCount(positional, scope);
  return count === null ? null : { lines: lines * count, files: positional };
}

/** `awk` whose program is an `NR` range with at most a print body; NR counts across files. */
function awkBound(args: readonly ReadWord[]): StageBound | null {
  const [program, ...files] = args;
  if (!program || program.glob || program.text.startsWith("-")) return null;
  const text = program.text;
  let lines: number;
  let body: string | undefined;
  const range = AWK_RANGE_RE.exec(text);
  const between = range ? null : AWK_BETWEEN_RE.exec(text);
  const upTo = range || between ? null : AWK_UP_TO_RE.exec(text);
  if (range) {
    const from = Number(range[2]) + (range[1] === ">" ? 1 : 0);
    const to = Number(range[4]) - (range[3] === "<" ? 1 : 0);
    lines = Math.max(to - from + 1, 0);
    body = range[5];
  } else if (between) {
    const from = Number(between[1]);
    const to = Number(between[2]);
    // A range whose end line comes before its start never closes: it prints to the end.
    if (to < from) return null;
    lines = to - from + 1;
    body = between[3];
  } else if (upTo) {
    lines = Number(upTo[2]) - (upTo[1] === "<" ? 1 : 0);
    body = upTo[3];
  } else return null;
  if (body !== undefined && (!AWK_PRINT_BODY_RE.test(body) || AWK_SIDE_EFFECT_RE.test(body))) return null;
  if (files.some((file) => file.text.startsWith("-"))) return null;
  return { lines, files };
}

/** A range print: what it bounds, and whether it reads files or stdin. */
function rangePrintBound(words: readonly ReadWord[], scope: Scope): StageBound | null {
  const [head, ...args] = words;
  switch (head?.text) {
    case "sed":
      return sedBound(args, scope);
    case "head":
    case "tail":
      return headOrTailBound(args, scope);
    case "awk":
      return awkBound(args);
    default:
      return null;
  }
}

/** `echo`, `printf`, `cd`, an assignment, `true`, `wc`, `grep -c`: the lines of a segment that is not the read itself. */
function glueLines(words: readonly ReadWord[], scope: Scope): number | null {
  const [head, ...args] = words;
  if (!head) return null;
  if (words.every((word) => ASSIGNMENT_RE.test(word.text))) return 0;
  if (SILENT_COMMANDS.has(head.text)) return args.length === 0 ? 0 : null;
  switch (head.text) {
    case "echo":
    case "printf":
      return 1 + args.reduce((n, arg) => n + (arg.text.match(NEWLINE_ESCAPE_RE)?.length ?? 0), 0);
    case "cd":
      return cdTarget(args) === null ? null : 0;
    case "wc": {
      const flags = args.filter((arg) => arg.text.startsWith("-"));
      const paths = args.filter((arg) => !arg.text.startsWith("-"));
      if (!flags.every((flag) => WC_FLAGS.has(flag.text))) return null;
      const count = pathCount(paths, scope);
      if (!count) return null;
      return count > 1 ? count + 1 : 1;
    }
    case "grep": {
      const flags = args.filter((arg) => arg.text.startsWith("-"));
      const [pattern, ...paths] = args.filter((arg) => !arg.text.startsWith("-"));
      if (!pattern || !flags.some((flag) => GREP_COUNT_FLAGS_RE.test(flag.text))) return null;
      if (!flags.every((flag) => GREP_COUNT_FLAGS_RE.test(flag.text) || GREP_MATCH_FLAGS_RE.test(flag.text))) return null;
      const count = pathCount(paths, scope);
      return count ? count : null;
    }
    default:
      return null;
  }
}

/** Whether a stage may feed a bound: it prints files, searches, or is a range print itself. */
function isBoundedFeed(words: readonly ReadWord[]): boolean {
  const [head, ...args] = words;
  if (!head) return false;
  if (FILE_PRINTERS.has(head.text) || SEARCHERS.has(head.text) || RANGE_PRINTERS.has(head.text)) return true;
  // `git show <rev>:<path>` prints a file as it was; any other `git show` prints a commit.
  return head.text === "git" && args[0]?.text === "show" && args.slice(1).some((arg) => arg.text.includes(":"));
}

/** Whether a stage after the bound prints no more lines than it reads, all of them from stdin. */
function isLineFilter(words: readonly ReadWord[]): boolean {
  const [head, ...args] = words;
  if (!head) return false;
  if (LINE_FILTERS.has(head.text)) return true;
  const flags = args.filter((arg) => arg.text.startsWith("-"));
  const operands = args.filter((arg) => !arg.text.startsWith("-"));
  if (FILE_PRINTERS.has(head.text)) return operands.length === 0;
  // One operand, the pattern: a second would be a file, read instead of stdin.
  if (SEARCHERS.has(head.text)) return operands.length === 1 && flags.every((flag) => GREP_FILTER_FLAGS_RE.test(flag.text));
  return false;
}

/**
 * The lines one pipeline prints and whether it is a read, or null when it has
 * no bound. The bound is the last range print in it: at the head, over files;
 * past the head, over stdin, fed only by what `isBoundedFeed` accepts. Every
 * stage after it must be a line filter.
 */
function pipelineBound(stages: readonly (readonly ReadWord[])[], scope: Scope): { lines: number; read: boolean } | null {
  let at = -1;
  let bound: StageBound | null = null;
  for (let i = stages.length - 1; i >= 0 && !bound; i--) {
    bound = rangePrintBound(stages[i]!, scope);
    at = i;
  }
  if (!bound) {
    const glue = stages.length === 1 ? glueLines(stages[0]!, scope) : null;
    return glue === null ? null : { lines: glue, read: false };
  }
  // At the head a range print with no file reads stdin, which a command has none of.
  if (at === 0 ? bound.files.length === 0 : bound.files.length > 0) return null;
  if (!stages.slice(0, at).every(isBoundedFeed)) return null;
  if (!stages.slice(at + 1).every(isLineFilter)) return null;
  return { lines: bound.lines, read: true };
}

/** An open `for` loop: how many passes it makes, and what its body has added up so far. */
type Loop = { readonly variable: string; readonly passes: number; lines: number; read: boolean };

/**
 * The lines `command` limits its output to, or null when any part of it
 * prints without a bound or it holds no read — see the module comment.
 */
export function commandLineBound(command: string): number | null {
  if (SUBSTITUTION_RE.test(command)) return null;
  const walked = walkCommandSegments(command);
  if (!walked || walked.hasOutputRedirection) return null;

  const top = { lines: 0, read: false };
  const loops: Loop[] = [];
  let stages: ReadWord[][] = [];
  let awaitingDo = false;
  const closePipeline = (): boolean => {
    const bound = pipelineBound(stages, { loopVariables: new Set(loops.map((loop) => loop.variable)) });
    stages = [];
    if (!bound) return false;
    const into = loops.at(-1) ?? top;
    into.lines += bound.lines;
    into.read ||= bound.read;
    return true;
  };
  for (const segment of walked.segments) {
    if (segment.joinedBy !== "|" && stages.length > 0 && !closePipeline()) return null;
    let words = wordsOf(segment.text);
    if (!words) return null;
    if (awaitingDo) {
      // The body opens with `do`, alone or in front of its first command.
      if (words[0]!.text !== "do") return null;
      awaitingDo = false;
      words = words.slice(1);
      if (words.length === 0) continue;
    }
    const head = words[0]!.text;
    if (head === "for") {
      const [, variable, keyword, ...list] = words;
      if (!variable || !LOOP_VARIABLE_RE.test(variable.text) || keyword?.text !== "in") return null;
      // A glob or an expansion hides how many passes the loop makes.
      if (list.length === 0 || list.some((word) => word.glob || EXPANDED_WORD_RE.test(word.text))) return null;
      loops.push({ variable: variable.text, passes: list.length, lines: 0, read: false });
      awaitingDo = true;
      continue;
    }
    if (head === "done") {
      // A loop piped onward needs no check here: what it pipes into opens a
      // pipeline of its own that reads stdin, and those are refused.
      const loop = loops.pop();
      if (!loop || words.length > 1) return null;
      const into = loops.at(-1) ?? top;
      into.lines += loop.passes * loop.lines;
      into.read ||= loop.read;
      continue;
    }
    stages.push(words);
  }
  if (stages.length > 0 && !closePipeline()) return null;
  if (awaitingDo || loops.length > 0) return null;
  return top.read ? top.lines : null;
}
