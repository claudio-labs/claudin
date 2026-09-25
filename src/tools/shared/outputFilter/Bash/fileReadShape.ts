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
 * - `head` and `tail` with `-n N`, `-N` or `-c N`, and tail's `-n +N`, over
 *   the same arguments: part of a file. A file one of them happened to print
 *   whole counts as a `cat`'s does — the credit's verbatim check decides —
 *   but past 28k such a read is no run of whole files to fit, so it keeps the
 *   cap, as a listing does (`lists`);
 * - the listings: `ls` with flags and paths, `git ls-files` with flags and
 *   paths, `wc` with `-l`, `-c` or `-w` and paths;
 * - `cd <literal directory>` outside a loop body. The paths after it resolve
 *   in that directory, which each word carries (`ReadWord.dir`): relative to
 *   the one the command started in, or absolute, several `cd`s composing.
 *
 * joined by `;`, `&&` or newlines, with at least one `cat`, `head` or `tail`:
 * `ls -R` alone is the listing the cap exists for, not a read.
 *
 * The first call of a session-cache-ab run (2026-09-24) lists the tree and
 * prints the README in one command, `git ls-files && cat README.md
 * package.json`. Refused, it was capped in 4 of 5 runs, and the README it
 * carried was read again with Read in 3. In the A/B of both flags later that
 * day (20260924-212723) the grammar refused two more, `cd src && cat
 * catalog.ts cli.ts …` and a read with a `head -c 1500` among its cats; both
 * were capped, and the model Read the files they had printed.
 *
 * Everything else refuses the whole command: a command substitution anywhere
 * (`$(`, a backtick — even quoted, where the shell would still run it), an
 * output redirect (`2>/dev/null` excepted, which the walker already reads as
 * discarding stderr), a pipe, `||`, a subshell, a background job, a brace
 * expansion, and any other program. The segmentation is the shared walker's
 * (`walkCommandSegments`), the same one the Bash→tool redirect uses, so the
 * two can never disagree about where a segment ends.
 */
import { isAbsolute, join, normalize } from "path";
import { walkCommandSegments } from "src/platform/bash/segments.js";
import { tryParseShellCommand } from "src/platform/bash/shellQuote.js";

/** One word a `cat` reads: a literal path, or a glob the shell expanded. */
export type ReadWord = {
  readonly text: string;
  readonly glob: boolean;
  /**
   * The directory a `cd` earlier in the command moved to, which the word
   * resolves in: relative to the one the command started in, or absolute.
   * Absent, it resolves where the command started.
   */
  readonly dir?: string;
};

type PureFileRead = {
  /**
   * What the `cat`, `head` and `tail` segments print from, in order, a loop
   * variable replaced by its word list.
   */
  readonly reads: readonly ReadWord[];
  /**
   * A segment lists files rather than printing them (`ls`, `git ls-files`,
   * `wc`), or prints only part of one (`head`, `tail`). Past what the
   * pass-through shows whole such a read is not a run of whole files to fit,
   * so it keeps the cap.
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
/** The segments that print files: `cat` whole, `head` and `tail` in part. */
const PRINTERS: ReadonlySet<string> = new Set(["cat", "head", "tail"]);
/** The `head`/`tail` flags whose count is the next argument: lines, or bytes. */
const COUNT_FLAGS: ReadonlySet<string> = new Set(["-n", "-c"]);
const COUNT_RE = /^\d+$/;
/** `head -20`, `tail -20`: the line count spelled as the flag. */
const COUNT_FLAG_RE = /^-\d+$/;
/** `tail -n +N`: from line N to the end. */
const FROM_LINE_RE = /^\+\d+$/;
/** The directory stack moves the cwd where `cd`'s one argument does not say. */
const DIRECTORY_STACK: ReadonlySet<string> = new Set(["pushd", "popd"]);

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
export function wordsOf(segment: string): ReadWord[] | null {
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

/**
 * The words a path argument stands for: a loop's variable is its word list,
 * any other word the shell would rewrite is null, and the rest is itself.
 */
function pathWords(arg: ReadWord, loops: readonly Loop[]): readonly ReadWord[] | null {
  const loop = loops.findLast((open) => arg.text === `$${open.variable}`);
  if (loop) return loop.words;
  return EXPANDED_WORD_RE.test(arg.text) ? null : [arg];
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
    const words = pathWords(arg, loops);
    if (!words) return null;
    reads.push(...words);
  }
  return reads.length > 0 ? reads : null;
}

/**
 * What one `head` or `tail` prints part of, or null when it is not a plain
 * print of part of files. The counts are `-n N`, `-N` and `-c N`, and tail's
 * `-n +N`. Any other flag refuses: `-f`, `-F` and `--follow` never return,
 * `-z` splits on NULs, `-q` and `-v` change the headers.
 */
function parsePartialPrint(
  program: string,
  args: readonly ReadWord[],
  loops: readonly Loop[],
): ReadWord[] | null {
  const reads: ReadWord[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!afterDoubleDash && arg.text === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.text.startsWith("-") && arg.text !== "-") {
      if (COUNT_FLAG_RE.test(arg.text)) continue;
      if (!COUNT_FLAGS.has(arg.text)) return null;
      const count = args[++i]?.text ?? "";
      const fromLine = program === "tail" && arg.text === "-n" && FROM_LINE_RE.test(count);
      if (!COUNT_RE.test(count) && !fromLine) return null;
      continue;
    }
    // `-` is stdin, before `--` or after it.
    if (arg.text === "-") return null;
    const words = pathWords(arg, loops);
    if (!words) return null;
    reads.push(...words);
  }
  // With no path it prints stdin.
  return reads.length > 0 ? reads : null;
}

/** What a `cat`, `head` or `tail` segment prints from; null for any other, or one that is not a plain print. */
function printedBy(
  program: string,
  args: readonly ReadWord[],
  loops: readonly Loop[],
): ReadWord[] | null {
  if (program === "cat") return parseCat(args, loops);
  return program === "head" || program === "tail" ? parsePartialPrint(program, args, loops) : null;
}

/**
 * Where a `cd` goes, as written, or null when the walk cannot name it: no
 * argument (home), `-` (the last directory) or any other flag, more than one
 * argument, an empty one, a glob, a word the shell would rewrite (`~`, `$D`).
 */
export function cdTarget(args: readonly ReadWord[]): string | null {
  const target = args.length === 1 ? args[0]! : null;
  if (!target || target.glob || target.text === "" || target.text.startsWith("-")) return null;
  return EXPANDED_WORD_RE.test(target.text) ? null : target.text;
}

/**
 * Where `cd target` lands from `dir`: relative to the directory the command
 * started in, or absolute. Undefined is that start directory itself.
 */
function cdFrom(dir: string | undefined, target: string): string | undefined {
  const next = isAbsolute(target) ? normalize(target) : join(dir ?? ".", target);
  return next === "." ? undefined : next;
}

/** `words` as read in `dir`, where a `cd` moved; as they are where none did. */
function inDir(words: readonly ReadWord[], dir: string | undefined): readonly ReadWord[] {
  return dir === undefined ? words : words.map((word) => ({ ...word, dir }));
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
  let printSeen = false;
  let lists = false;
  let partial = false;
  /** Where the paths resolve, when a `cd` moved away from where the command started. */
  let dir: string | undefined;
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
      case "cd": {
        // In a loop body a relative `cd` moves again on every pass.
        const target = loops.length === 0 ? cdTarget(args) : null;
        if (target === null) return null;
        dir = cdFrom(dir, target);
        break;
      }
      case "cat": {
        const catReads = parseCat(args, loops);
        if (!catReads) return null;
        reads.push(...inDir(catReads, dir));
        printSeen = true;
        break;
      }
      case "head":
      case "tail": {
        const partReads = parsePartialPrint(head!.text, args, loops);
        if (!partReads) return null;
        reads.push(...inDir(partReads, dir));
        printSeen = true;
        partial = true;
        break;
      }
      default:
        return null;
    }
  }
  if (awaitingDo || loops.length > 0 || !printSeen) return null;
  return { reads, lists: lists || partial };
}

export function isPureFileRead(command: string): boolean {
  return parsePureFileRead(command) !== null;
}

/**
 * What the `cat` segments of ANY command print as it is, in order: the files
 * the read credit checks the result for (`BashTool/creditShownFiles.ts`).
 * Where `parsePureFileRead` asks whether the whole command only prints files,
 * this asks nothing of the other segments — `git status && cat a.ts` names
 * `a.ts` — only of the `cat`s, and of the `head`s and `tail`s, which print
 * part of a file and name it all the same (the credit counts the file only
 * when that part was all of it):
 *
 * - the arguments are what `parseCat` and `parsePartialPrint` take: literal
 *   paths, globs, a `for` loop's variable;
 * - the output reaches the result as printed: the segment is not piped
 *   onward, nor is the `done` of a loop it sits in;
 * - each path carries the directory a `cd` before it moved to, as
 *   `parsePureFileRead` resolves one.
 *
 * And of the command, that the walk can follow where each `cat`'s output
 * goes: no output redirect anywhere (the walk flags one for the whole command,
 * not for its segment), no substitution (shell-quote leaves `$(` as text, so
 * `x=$(cat a)` is not a segment of its own), no subshell, group, `if` or
 * `case`. Nor where it reads: no `cd` whose directory it cannot name, none in
 * a loop body, a pipeline or on either side of an `||` (it may move nothing,
 * or not run), no `pushd` or `popd`. Any of those and the command names
 * nothing.
 *
 * Naming a file is not crediting it: the credit still requires the file's
 * bytes to sit in the result whole. That is also what stands between a `cd`
 * that failed under a `;` and the paths after it, named in a directory they
 * were not read from.
 */
export function catReadsOf(command: string): ReadWord[] {
  if (SUBSTITUTION_RE.test(command)) return [];
  const walked = walkCommandSegments(command);
  if (!walked || walked.hasOutputRedirection) return [];
  const { segments } = walked;
  const pipedOnward = (index: number) => segments[index + 1]?.joinedBy === "|";
  /** Runs in this shell whenever the command gets to it: in no pipeline, on neither side of an `||`. */
  const inThisShell = (index: number) => {
    const before = segments[index]!.joinedBy;
    const after = segments[index + 1]?.joinedBy;
    return before !== "|" && before !== "||" && after !== "|" && after !== "||";
  };

  const reads: ReadWord[] = [];
  /** Where the paths resolve, when a `cd` moved away from where the command started. */
  let dir: string | undefined;
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
    if (head.text === "cd") {
      const target = cdTarget(args);
      if (target === null || open.length > 0 || !inThisShell(index)) return [];
      dir = cdFrom(dir, target);
      continue;
    }
    if (DIRECTORY_STACK.has(head.text)) return [];
    if (!PRINTERS.has(head.text) || pipedOnward(index)) continue;
    const loops = open.flatMap(({ loop }) => (loop ? [loop] : []));
    const printed = printedBy(head.text, args, loops);
    if (printed) (open.at(-1)?.reads ?? reads).push(...inDir(printed, dir));
  }
  return reads;
}
