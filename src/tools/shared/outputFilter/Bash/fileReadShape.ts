/**
 * Whether a Bash command does nothing but print files — the shape a model
 * reaches for when it wants a batch of files in one call:
 *
 *   for f in src/*.ts; do echo "=== $f"; cat $f; done
 *
 * ## Why it has a name
 *
 * The floor cap (`floor.ts`) keeps the first and last 15 lines of unmatched
 * output. On a loop like that one it keeps one file's header, 14 of its lines
 * and the last file's tail: 11 of 12 files vanish, and the marker gives no
 * pointer to the rest. In session-cache-ab (2026-09-23) claudin spent its
 * second API call on exactly this in 3 of 3 reps, and then re-read every file
 * with parallel Read calls. Two behaviours key on this shape, both OFF by
 * default:
 *
 * - `CLAUDIN_BASH_FILE_READ_PASSTHROUGH=1` — the filter hands such a read back
 *   byte for byte up to 28k chars, inside a `<bash-output-read>` wrapper the
 *   tool-result summarizer stands aside for (`index.ts`, `markers.ts`). A
 *   longer one that only prints files keeps the whole files that fit and names
 *   the rest (`fitWholeFiles`, `BashTool/creditShownFiles.ts`), where the cap
 *   would cut it or Bash would save it to disk behind a 2 KB preview.
 * - `CLAUDIN_BASH_READ_CREDIT=1` — each file a `cat` printed whole counts as a
 *   Read for the read-before-edit gate (`BashTool/creditShownFiles.ts`). That
 *   one reaches past this grammar: `catReadsOf` below finds the `cat`
 *   segments of any command.
 *
 * ## What counts
 *
 * Only segments that print a file as it is, or print something the model
 * wrote itself:
 *
 * - `for V in <literal words or globs>` / `do` / `done`;
 * - `echo` and `printf`;
 * - `cat [-n] <$V | paths | globs>` — the loop variable only as a whole
 *   argument, since `src/$f.ts` is a path this module would have to evaluate;
 * - the listings: `ls` with flags and paths, `git ls-files` with flags and
 *   paths, `wc` with `-l`, `-c` or `-w` and paths.
 *
 * joined by `;`, `&&` or newlines, with at least one `cat`: `ls -R` alone is
 * the listing the cap exists for, not a read.
 *
 * The first call of a session-cache-ab run (2026-09-24) lists the tree and
 * prints the README in one command, `git ls-files && cat README.md
 * package.json`. Refused, it was capped in 4 of 5 runs, and the README it
 * carried was read again with Read in 3.
 *
 * Everything else refuses the whole command: a command substitution anywhere
 * (`$(`, a backtick — even quoted, where the shell would still run it), an
 * output redirect (`2>/dev/null` excepted, which the walker already reads as
 * discarding stderr), a pipe, `||`, a subshell, a background job, a brace
 * expansion, and any other program. The segmentation is the shared walker's
 * (`walkCommandSegments`), the same one the Bash→tool redirect uses, so the
 * two can never disagree about where a segment ends.
 */
import { walkCommandSegments } from "src/platform/bash/segments.js";
import { tryParseShellCommand } from "src/platform/bash/shellQuote.js";

/** One word a `cat` reads: a literal path, or a glob the shell expanded. */
export type ReadWord = { readonly text: string; readonly glob: boolean };

type PureFileRead = {
  /** What the `cat` segments read, in order, a loop variable replaced by its word list. */
  readonly reads: readonly ReadWord[];
  /**
   * A segment lists files rather than printing them (`ls`, `git ls-files`,
   * `wc`). Past what the pass-through shows whole such a read is not a run of
   * whole files to fit, so it keeps the cap.
   */
  readonly lists: boolean;
};

/** Command substitution, which survives shell-quote's parse as plain text. */
const SUBSTITUTION_RE = /\$\(|`/;
const LOOP_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * A word the shell would rewrite before `cat` saw it: a variable, a tilde, a
 * brace expansion. Globs are not here — shell-quote hands those back as glob
 * tokens, which is what tells a glob from a quoted literal.
 */
const EXPANDED_WORD_RE = /[$`{}]|^~/;
/** `cat -n` numbers the lines, which the read credit accounts for; no other flag prints the file as it is. */
const CAT_FLAGS: ReadonlySet<string> = new Set(["-n", "--number"]);
/** The counts `wc` may print; any other flag, or `-` for stdin, is not a listing of files. */
const WC_FLAGS: ReadonlySet<string> = new Set(["-l", "-c", "-w"]);

/**
 * A segment the walk left as bare shell syntax: a subshell or group paren or
 * brace, `&`, `|&`, `;;`, a redirection it does not drop (`<`, `<(`). Around
 * one of these the shell can send a `cat`'s output where the walk cannot
 * follow it — `(cat a) | head` pipes a segment the walk sees unpiped.
 */
const SHELL_SYNTAX_RE = /^[(){}&|;<>]/;
/** The loops whose body the walk follows from `do` to `done`. */
const LOOP_KEYWORDS: ReadonlySet<string> = new Set(["for", "while", "until", "select"]);
/** Compound commands it does not follow: a `cat` inside one may be piped at its close. */
const UNFOLLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "case",
  "esac",
]);

/**
 * The words of one segment, the way the shell would split them. A variable is
 * handed back as its own `$NAME`, since only the loop's variable means anything
 * here and it is resolved by the caller. Null when anything other than a word
 * or a glob survives the parse: an operator, a comment, a malformed segment
 * the walker could not split.
 */
function wordsOf(segment: string): ReadWord[] | null {
  const parsed = tryParseShellCommand(segment, (name) => `$${name}`);
  if (!parsed.success) return null;
  const words: ReadWord[] = [];
  for (const token of parsed.tokens) {
    if (typeof token === "string") {
      words.push({ text: token, glob: false });
      continue;
    }
    if (
      token !== null &&
      typeof token === "object" &&
      "op" in token &&
      token.op === "glob" &&
      "pattern" in token
    ) {
      words.push({ text: String(token.pattern), glob: true });
      continue;
    }
    return null;
  }
  return words.length > 0 ? words : null;
}

type Loop = { readonly variable: string; readonly words: readonly ReadWord[] };

/** `V in w1 w2 …` after the `for`. */
function parseLoopHeader(args: readonly ReadWord[]): Loop | null {
  const [variable, keyword, ...words] = args;
  if (!variable || !LOOP_VARIABLE_RE.test(variable.text)) return null;
  if (keyword?.text !== "in") return null;
  if (words.some((word) => EXPANDED_WORD_RE.test(word.text))) return null;
  return { variable: variable.text, words };
}

/** What one `cat` reads, or null when it is not a plain print of files. */
function parseCat(args: readonly ReadWord[], loops: readonly Loop[]): ReadWord[] | null {
  const reads: ReadWord[] = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (!afterDoubleDash && arg.text === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.text.startsWith("-")) {
      // `-` alone is stdin, and every other flag changes what is printed.
      if (!CAT_FLAGS.has(arg.text)) return null;
      continue;
    }
    const loop = loops.findLast((open) => arg.text === `$${open.variable}`);
    if (loop) {
      reads.push(...loop.words);
      continue;
    }
    if (EXPANDED_WORD_RE.test(arg.text)) return null;
    reads.push(arg);
  }
  return reads.length > 0 ? reads : null;
}

/**
 * A segment that lists files — `ls`, `git ls-files`, `wc -l` — with flags and
 * literal paths or globs. Its output names files; none of it is a file's bytes.
 */
function isListing(head: string, args: readonly ReadWord[]): boolean {
  if (args.some((arg) => EXPANDED_WORD_RE.test(arg.text))) return false;
  switch (head) {
    case "ls":
      return true;
    case "git":
      return args[0]?.text === "ls-files";
    case "wc": {
      // With no path `wc` counts stdin, which is not a listing of anything.
      const paths = args.filter((arg) => !arg.text.startsWith("-"));
      const flags = args.filter((arg) => arg.text.startsWith("-"));
      return paths.length > 0 && flags.every((flag) => WC_FLAGS.has(flag.text));
    }
    default:
      return false;
  }
}

/**
 * The files a pure file read prints, or null when the command is anything
 * more than that — see the module comment for the grammar.
 */
export function parsePureFileRead(command: string): PureFileRead | null {
  if (SUBSTITUTION_RE.test(command)) return null;
  const walked = walkCommandSegments(command);
  if (!walked || walked.hasOutputRedirection) return null;

  const loops: Loop[] = [];
  const reads: ReadWord[] = [];
  let awaitingDo = false;
  let catSeen = false;
  let lists = false;
  for (const segment of walked.segments) {
    if (segment.joinedBy === "|" || segment.joinedBy === "||") return null;
    let words = wordsOf(segment.text);
    if (!words) return null;
    if (awaitingDo) {
      // The loop body opens with `do`, alone or in front of its first command.
      if (words[0]!.text !== "do") return null;
      awaitingDo = false;
      words = words.slice(1);
      if (words.length === 0) continue;
    }
    const [head, ...args] = words;
    switch (head!.text) {
      case "for": {
        const loop = parseLoopHeader(args);
        if (!loop) return null;
        loops.push(loop);
        awaitingDo = true;
        break;
      }
      case "done":
        if (args.length > 0 || loops.pop() === undefined) return null;
        break;
      case "echo":
      case "printf":
        break;
      case "ls":
      case "git":
      case "wc":
        if (!isListing(head!.text, args)) return null;
        lists = true;
        break;
      case "cat": {
        const catReads = parseCat(args, loops);
        if (!catReads) return null;
        reads.push(...catReads);
        catSeen = true;
        break;
      }
      default:
        return null;
    }
  }
  if (awaitingDo || loops.length > 0 || !catSeen) return null;
  return { reads, lists };
}

export function isPureFileRead(command: string): boolean {
  return parsePureFileRead(command) !== null;
}

/**
 * What the `cat` segments of ANY command print as it is, in order: the files
 * the read credit checks the result for (`BashTool/creditShownFiles.ts`).
 * Where `parsePureFileRead` asks whether the whole command only prints files,
 * this asks nothing of the other segments — `git status && cat a.ts` names
 * `a.ts` — only of the `cat`s:
 *
 * - the arguments are what `parseCat` takes: `-n`, literal paths, globs, a
 *   `for` loop's variable;
 * - the output reaches the result as printed: the `cat` is not piped onward,
 *   nor is the `done` of a loop it sits in.
 *
 * And of the command, that the walk can follow where each `cat`'s output
 * goes: no output redirect anywhere (the walk flags one for the whole command,
 * not for its segment), no substitution (shell-quote leaves `$(` as text, so
 * `x=$(cat a)` is not a segment of its own), no subshell, group, `if` or
 * `case`. Any of those and the command names nothing.
 *
 * Naming a file is not crediting it: the credit still requires the file's
 * bytes to sit in the result whole.
 */
export function catReadsOf(command: string): ReadWord[] {
  if (SUBSTITUTION_RE.test(command)) return [];
  const walked = walkCommandSegments(command);
  if (!walked || walked.hasOutputRedirection) return [];
  const { segments } = walked;
  const pipedOnward = (index: number) => segments[index + 1]?.joinedBy === "|";

  const reads: ReadWord[] = [];
  /** The loops open at this segment, innermost last, each holding the reads inside it until its `done`. */
  const open: { loop: Loop | null; reads: ReadWord[] }[] = [];
  for (const [index, segment] of segments.entries()) {
    if (SHELL_SYNTAX_RE.test(segment.name)) return [];
    let words = wordsOf(segment.text);
    if (!words) continue;
    if (words[0]!.text === "do") words = words.slice(1);
    const [head, ...args] = words;
    if (!head) continue;
    if (UNFOLLOWED_KEYWORDS.has(head.text)) return [];
    if (LOOP_KEYWORDS.has(head.text)) {
      // Only a `for` binds its variable to words this module can read.
      open.push({ loop: head.text === "for" ? parseLoopHeader(args) : null, reads: [] });
      continue;
    }
    if (head.text === "done") {
      const closed = open.pop();
      if (!closed) return [];
      if (!pipedOnward(index)) (open.at(-1)?.reads ?? reads).push(...closed.reads);
      continue;
    }
    if (head.text !== "cat" || pipedOnward(index)) continue;
    const loops = open.flatMap(({ loop }) => (loop ? [loop] : []));
    const catReads = parseCat(args, loops);
    if (catReads) (open.at(-1)?.reads ?? reads).push(...catReads);
  }
  return reads;
}
