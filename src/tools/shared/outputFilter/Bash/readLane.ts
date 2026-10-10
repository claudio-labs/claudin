/**
 * Whether a Bash command does nothing but show the model what it asked to
 * read — whole files, slices it sized, matches in files it named — so that its
 * output may reach the model as printed instead of cut.
 *
 * ## Why it has a name
 *
 * Two shapes of read were already let through, each on its own switch and
 * each refusing the other's: a pure print of files (`fileReadShape.ts`, the
 * parked pass-through) and a read whose command bounds its own output
 * (`lineBound.ts`). The model mixes them. In the session A/B of 2026-10-09 on
 * Sonnet 5.5 claudindev's 41 caps fell on 39 commands with a `cat`, 14 of
 * them shaped like
 *
 *   cat test/helpers.ts; sed -n 1,30p test/quote.test.ts; head -c 600 data/catalog.json
 *
 * which neither predicate accepts: the cap kept 30 of their lines, with the
 * cap off the tool-result summarizer cut them past 8k, and after either the
 * model fetched the same files again with Read. With both cutters off the
 * session cost 33% less (ranges separated, N=5) and the first edit came two
 * calls sooner. This is the one predicate both cutters answer to: the filter
 * returns such a read in `<bash-output-read>` (`index.ts`), which the
 * summarizer stands aside for.
 *
 * ## What counts
 *
 * Pipelines joined by `;`, `&&`, `||` or newlines, every one of them:
 *
 * - a print of files: `cat [-n]`, `head`/`tail` with a count (`printedBy`);
 * - a slice the command bounds (`pipelineBound`): `sed -n A,Bp`, an awk `NR`
 *   range, and a file print or a search piped into `head -N` and line filters;
 * - a search over files it names, not recursive: `grep -n X a.ts b.ts` prints
 *   at most those files' lines;
 * - glue: `echo`, `printf`, a literal `cd` outside a loop, an assignment,
 *   `true`, a listing (`ls`, `git ls-files`, `wc`), `grep -c`;
 * - `for V in <words or globs>; do …; done` around any of these.
 *
 * At least one segment must print something read. Everything else refuses the
 * whole command: any other program, a pipe into anything but a bound, an
 * output redirect (`2>/dev/null` excepted), a substitution, a subshell.
 *
 * What bounds the result is not the grammar but the caller's ceiling
 * (`FILE_READ_PASSTHROUGH_MAX_CHARS`): past it a read takes the cut like any
 * other output. The grammar only answers whether every byte is something the
 * model asked to see — which a test log, a build or a `find` never are.
 *
 * On by default since 2026-10-09; `CLAUDIN_BASH_READ_LANE=0` turns it off
 * (`index.ts`, where the measurement is).
 */
import { walkCommandSegments } from "src/platform/bash/segments.js";
import {
  cdTarget,
  isListing,
  type Loop,
  parseLoopHeader,
  printedBy,
  type ReadWord,
  wordsOf,
} from "src/tools/shared/outputFilter/Bash/fileReadShape.js";
import { pipelineBound, type Scope } from "src/tools/shared/outputFilter/Bash/lineBound.js";

/** Command substitution, which survives shell-quote's parse as plain text. */
const SUBSTITUTION_RE = /\$\(|`/;
/** A word the shell would rewrite, other than a loop's variable. */
const EXPANDED_WORD_RE = /[$`{}]|^~/;
/** Short flags run together, one of them recursing: `-r`, `-rn`, `-nRi`. */
const RECURSIVE_SHORT_FLAGS_RE = /^-[^-]*[rRd]/;
const RECURSIVE_LONG_FLAGS_RE = /^--(?:recursive|dereference-recursive|directories|include|exclude)/;
/** The searches that read only the files they are given; `rg` recurses by default. */
const FILE_SEARCHERS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep"]);

type Verdict = "print" | "glue";

/**
 * `grep -n X a.ts b.ts`: a search that prints lines of the files it names and
 * nothing else. The split between pattern and paths is not parsed — `-A 4`
 * reads as a pattern and a path — because nothing here depends on it: a word
 * misread as a path is at worst one more file grep fails to open.
 */
function isFileSearch(head: string, args: readonly ReadWord[], loops: readonly Loop[]): boolean {
  if (!FILE_SEARCHERS.has(head)) return false;
  const flags = args.filter((arg) => arg.text.startsWith("-"));
  const operands = args.filter((arg) => !arg.text.startsWith("-"));
  if (flags.some((flag) => RECURSIVE_SHORT_FLAGS_RE.test(flag.text) || RECURSIVE_LONG_FLAGS_RE.test(flag.text))) {
    return false;
  }
  // The pattern, then at least one path: with none, grep reads stdin.
  const paths = operands.slice(1);
  if (paths.length === 0) return false;
  return paths.every(
    (path) => !EXPANDED_WORD_RE.test(path.text) || loops.some((loop) => path.text === `$${loop.variable}`),
  );
}

/** What one unpiped segment is, or null when it is not part of a read. */
function segmentVerdict(words: readonly ReadWord[], loops: readonly Loop[], scope: Scope): Verdict | null {
  const [head, ...args] = words;
  if (!head) return null;
  switch (head.text) {
    case "cat":
    case "head":
    case "tail":
      return printedBy(head.text, args, loops) ? "print" : null;
    case "echo":
    case "printf":
      return "glue";
    case "cd":
      // In a loop body a relative `cd` moves again on every pass.
      return loops.length === 0 && cdTarget(args) !== null ? "glue" : null;
    case "ls":
    case "git":
    case "wc":
      return isListing(head.text, args) ? "glue" : null;
  }
  if (isFileSearch(head.text, args, loops)) return "print";
  // `sed -n`, awk NR ranges; and the glue lineBound knows: `wc`, `grep -c`, `true`, `X=1`.
  const bound = pipelineBound([words], scope);
  if (bound) return bound.read ? "print" : "glue";
  return null;
}

/** Whether `command` only shows what the model asked to read — see the module comment. */
export function isModelDirectedRead(command: string): boolean {
  if (SUBSTITUTION_RE.test(command)) return false;
  const walked = walkCommandSegments(command);
  if (!walked || walked.hasOutputRedirection) return false;

  const loops: Loop[] = [];
  let awaitingDo = false;
  let printed = false;
  let stages: ReadWord[][] = [];
  const closePipeline = (): boolean => {
    const pipeline = stages;
    stages = [];
    if (pipeline.length === 0) return true;
    const scope: Scope = { loopVariables: new Set(loops.map((loop) => loop.variable)) };
    if (pipeline.length > 1) {
      // Piped, only into a bound: `cat f | head -40`, `grep -n X f | head`.
      const bound = pipelineBound(pipeline, scope);
      if (!bound?.read) return false;
      printed = true;
      return true;
    }
    const verdict = segmentVerdict(pipeline[0]!, loops, scope);
    if (verdict === null) return false;
    if (verdict === "print") printed = true;
    return true;
  };

  for (const segment of walked.segments) {
    if (segment.joinedBy !== "|" && !closePipeline()) return false;
    let words = wordsOf(segment.text);
    if (!words) return false;
    if (awaitingDo) {
      // The loop body opens with `do`, alone or in front of its first command.
      if (words[0]!.text !== "do") return false;
      awaitingDo = false;
      words = words.slice(1);
      if (words.length === 0) continue;
    }
    const head = words[0]!.text;
    if (head === "for") {
      if (stages.length > 0) return false;
      const loop = parseLoopHeader(words.slice(1));
      if (!loop) return false;
      loops.push(loop);
      awaitingDo = true;
      continue;
    }
    if (head === "done") {
      // What a loop pipes into opens a pipeline of its own that reads stdin,
      // and those are refused.
      if (words.length > 1 || stages.length > 0 || loops.pop() === undefined) return false;
      continue;
    }
    stages.push(words);
  }
  if (!closePipeline()) return false;
  return !awaitingDo && loops.length === 0 && printed;
}
