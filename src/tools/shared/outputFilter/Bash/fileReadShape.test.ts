import { describe, expect, test } from "bun:test";
import {
  catReadsOf,
  isPureFileRead,
  parsePureFileRead,
} from "src/tools/shared/outputFilter/Bash/fileReadShape.js";

// Verbatim from the recorded bench (`scripts/bench/ab/session-cache-ab.ts`,
// runs under /tmp/session-cache-ab/, `runs[].calls[]` with name "Bash"). The
// loop is the call claudin spent its second API request on in 3 of 3 reps of
// run 20260923-062408; the floor cap kept 30 of its 616-665 lines and the model
// re-read every file with Read.
const RECORDED_READS = {
  // 20260923-060401 claudindev r2 — the plain loop.
  plain: 'for f in src/*.ts; do echo "=== $f"; cat $f; done',
  // 20260923-062408 claudindev r1.
  afterLs: 'ls -R .claudin; for f in src/*.ts; do echo "=== $f"; cat $f; done',
  // 20260923-062408 claudindev r2 — `2>/dev/null` discards stderr only.
  thenRules:
    'for f in src/*.ts; do echo "=== $f"; cat $f; done; ls .claudin/rules; cat .claudin/rules/* 2>/dev/null',
  // 20260923-062408 claudindev r3 — 665 lines, 27,651 chars.
  mixedList:
    'for f in src/*.ts package.json data/catalog.json data/carts/*.json; do echo "=== $f"; cat -n $f; done',
  // 20260923-062408 claude r3 — the reference arm writes the same loop.
  numbered: 'for f in src/*.ts; do echo "=== $f"; cat -n $f; done',
  // 20260923-043629 nodefer r2 — the variable quoted.
  quotedVar:
    'for f in README.md package.json src/*.ts data/catalog.json data/carts/*.json; do echo "=== $f"; cat "$f"; done',
  // 20260923-054328 n5 r3 — cat before the loop.
  catThenLoop:
    'ls -R .claudin; cat .claudin/rules/* 2>/dev/null; for f in src/*.ts test/helpers.ts; do echo "=== $f"; cat $f; done',
};

// The first call of session-cache-ab run 20260924-170553, which lists the tree
// and prints the README in one command. It was capped in 4 of 5 runs, and the
// README it carried was read again with Read in 3.
const RECORDED_LISTINGS = {
  // claudindev r5.
  lsFilesThenCat: "git ls-files && cat README.md package.json && ls .claudin",
  // The same call as it was recorded earlier (20260923, r1/r2).
  lsFilesThenMemory:
    "git ls-files && cat README.md package.json && ls .claudin .claudin/memory 2>/dev/null; cat .claudin/memory/MEMORY.md .claudin/memory/team/MEMORY.md 2>/dev/null",
};

// The two calls of the 5-arm A/B (session-cache-ab 20260924-212723) the
// grammar refused with the read credit on. Both were capped, and the model
// then Read the files they had printed.
const RECORDED_MISSES = {
  // catread r5 — 345 lines, 12,236 chars.
  cdFirst: "cd src && cat catalog.ts cli.ts discounts.ts errors.ts money.ts quote.ts receipt.ts",
  // catread r2 — 568 lines, 23,977 chars; refused for its `head -c`.
  headAmongCats:
    'cat -n src/types.ts; head -c 1500 data/catalog.json; echo; cat data/carts/basic-us.json; for f in test/*.ts; do echo "=== $f"; cat -n $f; done',
};

describe("isPureFileRead — the recorded reads", () => {
  for (const [name, command] of Object.entries(RECORDED_READS)) {
    test(`accepts ${name}: ${command}`, () => {
      expect(isPureFileRead(command)).toBe(true);
    });
  }

  test("accepts a plain cat of named files", () => {
    expect(isPureFileRead("cat README.md package.json")).toBe(true);
    expect(isPureFileRead("cat -n -- src/a.ts")).toBe(true);
  });

  test("accepts a loop written across lines", () => {
    expect(isPureFileRead('for f in a.ts b.ts\ndo\n  echo "$f"\n  cat $f\ndone')).toBe(true);
  });
});

// `git ls-files` and `wc` list files the way `ls` does; the three are the
// listing segments a read may carry.
describe("isPureFileRead — a listing beside the read", () => {
  for (const [name, command] of Object.entries(RECORDED_LISTINGS)) {
    test(`accepts ${name}: ${command}`, () => {
      expect(isPureFileRead(command)).toBe(true);
    });
  }

  test("accepts git ls-files with flags and paths, and wc with a count flag", () => {
    expect(isPureFileRead("git ls-files && cat README.md package.json")).toBe(true);
    expect(isPureFileRead("git ls-files --others --exclude-standard src && cat a.ts")).toBe(true);
    expect(isPureFileRead("wc -l src/*.ts && cat src/a.ts")).toBe(true);
    expect(isPureFileRead("wc -c -w a.ts; cat a.ts")).toBe(true);
  });

  const REFUSED: Record<string, string> = {
    "wc over a substitution": "wc -l $(git ls-files) && cat README.md",
    "a listing piped to head": "ls -R | head; cat a.ts",
    "git ls-files piped onward": "git ls-files | grep x && cat a.ts",
    "a git command that is not ls-files": "git status && cat a",
    "git with an option before the subcommand": "git -C src ls-files && cat a.ts",
    "wc of stdin": "wc -l && cat a.ts",
    "wc of stdin, spelled -": "wc -l - && cat a.ts",
    "a wc flag that is not a count": "wc --files0-from=list && cat a.ts",
    // The three wc cases above name no path, so the path check refuses them
    // before the flags are looked at; beside a path, only the flag check does.
    "a wc flag that is not a count, beside a path": "wc -L a.ts && cat a.ts",
    "wc of stdin spelled -, beside a path": "wc -l - a.ts && cat a.ts",
    "a listing of an expanded word": "ls $HOME && cat a.ts",
    // A listing is not a read, whichever one it is.
    "only git ls-files": "git ls-files",
    "only wc": "wc -l src/a.ts",
  };
  for (const [name, command] of Object.entries(REFUSED)) {
    test(`rejects ${name}: ${JSON.stringify(command)}`, () => {
      expect(isPureFileRead(command)).toBe(false);
    });
  }

  // Past what the pass-through shows whole, only a read that prints nothing
  // but files is cut down to whole files; a listing keeps the cap.
  test("says whether a segment lists", () => {
    expect(parsePureFileRead(RECORDED_LISTINGS.lsFilesThenCat)?.lists).toBe(true);
    expect(parsePureFileRead(RECORDED_READS.afterLs)?.lists).toBe(true);
    expect(parsePureFileRead("wc -l a.ts; cat a.ts")?.lists).toBe(true);
    expect(parsePureFileRead(RECORDED_READS.plain)?.lists).toBe(false);
    expect(parsePureFileRead("cat README.md package.json")?.lists).toBe(false);
  });
});

describe("isPureFileRead — anything that is not only printing files", () => {
  const REJECTED: Record<string, string> = {
    // The list comes from a command the shell runs first.
    "command substitution in the list": "for f in $(git ls-files); do cat $f; done",
    "a backtick substitution": "for f in `ls`; do cat $f; done",
    "command substitution inside an echo": 'echo "$(date)"; cat a.ts',
    // Writes a file.
    "an output redirect": "cat $f > x",
    "an appending redirect": "cat a.ts >> out.txt",
    // Another program in the loop body.
    "another command in the loop": "for f in *.ts; do bun test $f; done",
    // Another program before the read.
    "another command in the chain": "bun run build && cat dist/cli.mjs",
    // The output is reshaped, or only one branch runs.
    "a pipe": "cat src/a.ts | head -40",
    "an or-chain": "cat a.ts || echo missing",
    // cat that does not print the file as it is, or prints no file.
    "a cat flag other than -n": "cat -A src/a.ts",
    "cat of stdin": "cat",
    "a variable that is not the loop's": "cat $HOME/.bashrc",
    "the loop variable inside a path": 'for f in a b; do cat "src/$f.ts"; done',
    "brace expansion": "for f in {a,b}.ts; do cat $f; done",
    // A listing is not a read — `ls -R` alone is what the cap exists for.
    "only a listing": "ls -R .claudin",
    // Unbalanced loop.
    "a loop that never closes": "for f in a.ts; do cat $f",
    "a background job": "cat a.ts &",
    "a subshell": "cat a.ts; (cat b.ts)",
  };
  for (const [name, command] of Object.entries(REJECTED)) {
    test(`rejects ${name}: ${JSON.stringify(command)}`, () => {
      expect(isPureFileRead(command)).toBe(false);
    });
  }
});

// What the read credit expands against the cwd: a loop variable stands for
// its word list, a glob stays a glob, a quoted word stays literal.
describe("parsePureFileRead — what the command reads", () => {
  test("a loop variable is its word list, in order", () => {
    expect(parsePureFileRead(RECORDED_READS.mixedList)?.reads).toEqual([
      { text: "src/*.ts", glob: true },
      { text: "package.json", glob: false },
      { text: "data/catalog.json", glob: false },
      { text: "data/carts/*.json", glob: true },
    ]);
  });

  test("a cat after the loop adds its own arguments", () => {
    expect(parsePureFileRead(RECORDED_READS.thenRules)?.reads).toEqual([
      { text: "src/*.ts", glob: true },
      { text: ".claudin/rules/*", glob: true },
    ]);
  });

  test("named files are literal", () => {
    expect(parsePureFileRead("cat README.md package.json")?.reads).toEqual([
      { text: "README.md", glob: false },
      { text: "package.json", glob: false },
    ]);
  });

  test("a listing segment adds nothing to what is read", () => {
    expect(parsePureFileRead(RECORDED_LISTINGS.lsFilesThenMemory)?.reads).toEqual([
      { text: "README.md", glob: false },
      { text: "package.json", glob: false },
      { text: ".claudin/memory/MEMORY.md", glob: false },
      { text: ".claudin/memory/team/MEMORY.md", glob: false },
    ]);
  });
});

// The read credit's candidates: every `cat` of any command whose output
// reaches the result as printed.
describe("catReadsOf — the cat segments of any command", () => {
  const literal = (...paths: string[]) => paths.map((text) => ({ text, glob: false }));

  test("a pure read names what parsePureFileRead does", () => {
    for (const command of [...Object.values(RECORDED_READS), ...Object.values(RECORDED_LISTINGS)]) {
      expect(catReadsOf(command)).toEqual([...parsePureFileRead(command)!.reads]);
    }
  });

  test("the rest of the command may be anything", () => {
    expect(catReadsOf("git status && cat README.md package.json")).toEqual(
      literal("README.md", "package.json"),
    );
    expect(catReadsOf("bun run build; cat dist/a.js || echo missing")).toEqual(literal("dist/a.js"));
    expect(catReadsOf("grep -rn foo src | head -5; cat src/a.ts")).toEqual(literal("src/a.ts"));
  });

  test("a cat piped onward names nothing, the next one still does", () => {
    expect(catReadsOf("cat src/a.ts | head -40")).toEqual([]);
    expect(catReadsOf("cat package.json | jq .scripts && cat README.md")).toEqual(literal("README.md"));
  });

  test("a loop piped at its done names nothing inside it", () => {
    expect(catReadsOf('for f in src/*.ts; do echo "== $f"; cat $f; done | head -100')).toEqual([]);
    expect(catReadsOf("for f in a.ts b.ts; do cat $f; done; cat c.ts")).toEqual(
      literal("a.ts", "b.ts", "c.ts"),
    );
  });

  test("a loop variable resolves only for a for over literal words", () => {
    expect(catReadsOf("for f in $LIST; do cat $f; done")).toEqual([]);
    expect(catReadsOf("ls | while read f; do cat $f; done")).toEqual([]);
  });

  const NOTHING: Record<string, string> = {
    "an output redirect": "cat a.ts > b.ts",
    "a redirect elsewhere in the command": "cat a.ts && bun test 2>&1",
    "a substitution anywhere": 'cat a.ts; echo "$(date)"',
    "a cat captured by a substitution": "x=$(cat a.ts) && echo $x",
    "a subshell": "(cat a.ts) | head",
    "a group": "{ cat a.ts; cat b.ts; } | head",
    "an if block": "if [ -f a.ts ]; then\ncat a.ts\nfi | head",
    "a background job": "cat a.ts &",
    "an input redirect": "cat < a.ts",
    "a flag that changes what cat prints": "cat -A a.ts",
    "cat of stdin": "echo x | cat",
    "a variable that is not a loop's": "cat $HOME/.bashrc",
    "a done with no loop": "cat a.ts; done",
  };
  for (const [name, command] of Object.entries(NOTHING)) {
    test(`names nothing for ${name}: ${JSON.stringify(command)}`, () => {
      expect(catReadsOf(command)).toEqual([]);
    });
  }
});

// A `cd` moves where the paths after it are read. Each word it moved carries
// the directory, relative to where the command started or absolute; BashTool
// resolves it from there (creditShownFiles.ts).
describe("parsePureFileRead — a cd before the read", () => {
  const inSrc = (...paths: string[]) => paths.map((text) => ({ text, glob: false, dir: "src" }));
  const at = (dir: string, text: string) => [{ text, glob: false, dir }];

  test(`accepts the recorded miss: ${RECORDED_MISSES.cdFirst}`, () => {
    expect(parsePureFileRead(RECORDED_MISSES.cdFirst)).toEqual({
      reads: inSrc("catalog.ts", "cli.ts", "discounts.ts", "errors.ts", "money.ts", "quote.ts", "receipt.ts"),
      lists: false,
    });
  });

  test("the paths after a cd resolve in its directory, joined by && or ;", () => {
    expect(parsePureFileRead("cd src && cat a.ts")?.reads).toEqual(inSrc("a.ts"));
    expect(parsePureFileRead("cd src; cat a.ts")?.reads).toEqual(inSrc("a.ts"));
    expect(parsePureFileRead("cd src\ncat a.ts")?.reads).toEqual(inSrc("a.ts"));
    expect(parsePureFileRead('cd src && for f in *.ts; do echo "=== $f"; cat $f; done')?.reads).toEqual([
      { text: "*.ts", glob: true, dir: "src" },
    ]);
  });

  test("several cds compose, from where the command started", () => {
    expect(parsePureFileRead("cd a && cd b && cat x")?.reads).toEqual(at("a/b", "x"));
    expect(parsePureFileRead("cd .. && cat src/x")?.reads).toEqual(at("..", "src/x"));
    expect(parsePureFileRead("cd /abs && cd b && cat x")?.reads).toEqual(at("/abs/b", "x"));
    expect(parsePureFileRead("cd a; cd /abs/b; cat x")?.reads).toEqual(at("/abs/b", "x"));
  });

  test("a path read before any cd, or after one back to the start, carries no directory", () => {
    expect(parsePureFileRead("cat README.md && cd src && cat a.ts")?.reads).toEqual([
      { text: "README.md", glob: false },
      { text: "a.ts", glob: false, dir: "src" },
    ]);
    expect(parsePureFileRead("cd src && cd .. && cat README.md")?.reads).toEqual([
      { text: "README.md", glob: false },
    ]);
  });

  // Each of these leaves the paths after it somewhere the walk cannot name.
  const REFUSED: Record<string, string> = {
    "a cd with no argument (home)": "cd; cat x",
    "a cd to the last directory": "cd - && cat x",
    "a cd home by tilde": "cd ~ && cat x",
    "a cd under home by tilde": "cd ~/src && cat x",
    "a cd to a variable": "cd $D && cat x",
    "a cd with a flag": "cd -P src && cat x",
    "a cd with two arguments": "cd a b && cat x",
    "a cd to a glob": "cd sr* && cat x",
    "a cd to an empty word": 'cd "" && cat x',
    // A relative cd there moves again on every pass.
    "a cd in a loop body": "for f in a b; do cd src; cat $f; done",
    "a cd piped": "cd src | cat a.ts",
    "a cd on one side of an or": "cd src || cat a.ts",
    // A cd is not a read.
    "only a cd": "cd src",
    "a cd and a listing": "cd src && ls",
  };
  for (const [name, command] of Object.entries(REFUSED)) {
    test(`rejects ${name}: ${JSON.stringify(command)}`, () => {
      expect(isPureFileRead(command)).toBe(false);
    });
  }
});

// `head` and `tail` print part of a file. The read stays pure — the
// pass-through shows it whole — but past 28k it is not a run of whole files
// to fit, so it keeps the cap, as a listing does (`lists`).
describe("parsePureFileRead — head and tail print part of a file", () => {
  test(`accepts the recorded miss: ${RECORDED_MISSES.headAmongCats}`, () => {
    expect(parsePureFileRead(RECORDED_MISSES.headAmongCats)).toEqual({
      reads: [
        { text: "src/types.ts", glob: false },
        { text: "data/catalog.json", glob: false },
        { text: "data/carts/basic-us.json", glob: false },
        { text: "test/*.ts", glob: true },
      ],
      lists: true,
    });
  });

  const ACCEPTED: Record<string, string> = {
    "bytes from the start": "head -c 100 f",
    "lines from line N to the end": "tail -n +5 f",
    "a line count": "head -n 20 f",
    "the count spelled as the flag": "head -20 f",
    "the last lines": "tail -n 5 f",
    "the last bytes": "tail -c 100 f",
    "the last lines, spelled as the flag": "tail -20 f",
    "several files and a glob": "head -n 5 a.ts src/*.ts",
    "a loop's variable": 'for f in *.ts; do echo "=== $f"; head -n 5 $f; done',
    "beside a cat": "cat a.ts; tail -n 20 b.log",
    "a path after --": "head -n 5 -- -notes.txt",
    "after a cd": "cd logs && tail -n 50 app.log",
  };
  for (const [name, command] of Object.entries(ACCEPTED)) {
    test(`accepts ${name}: ${JSON.stringify(command)}, as more than whole files`, () => {
      expect(parsePureFileRead(command)?.lists).toBe(true);
    });
  }

  test("what they print from is read like a cat's arguments", () => {
    expect(parsePureFileRead("head -n 5 a.ts src/*.ts")?.reads).toEqual([
      { text: "a.ts", glob: false },
      { text: "src/*.ts", glob: true },
    ]);
    expect(parsePureFileRead("for f in a.ts b.ts; do tail -n +1 $f; done")?.reads).toEqual([
      { text: "a.ts", glob: false },
      { text: "b.ts", glob: false },
    ]);
    expect(parsePureFileRead("cd logs && tail -n 50 app.log")?.reads).toEqual([
      { text: "app.log", glob: false, dir: "logs" },
    ]);
  });

  const REFUSED: Record<string, string> = {
    "tail following a file": "tail -f log",
    "tail following a name": "tail -F log",
    "tail following, long form": "tail --follow log",
    "NUL-separated lines": "head -z -n 5 f",
    "a flag that is not a count": "head -q -n 5 a b",
    "head of stdin": "head -n 5",
    "head of stdin, spelled -": "head -n 5 -",
    "tail of stdin, spelled - after --": "tail -n 5 -- -",
    "a count from a variable": "head -n $N f",
    "a count that is not a number": "head -n five f",
    "a count flag with no count": "head f -n",
    "head from line N — only tail counts from a line": "head -n +5 f",
    "tail's bytes from byte N": "tail -c +5 f",
    "a variable that is not the loop's": "head -n 5 $F",
    "head piped onward": "head -n 5 f | grep x",
  };
  for (const [name, command] of Object.entries(REFUSED)) {
    test(`rejects ${name}: ${JSON.stringify(command)}`, () => {
      expect(isPureFileRead(command)).toBe(false);
    });
  }
});

describe("catReadsOf — a cd, a head, a tail", () => {
  const literal = (...paths: string[]) => paths.map((text) => ({ text, glob: false }));

  test("the recorded misses name what parsePureFileRead does", () => {
    for (const command of Object.values(RECORDED_MISSES)) {
      expect(catReadsOf(command)).toEqual([...parsePureFileRead(command)!.reads]);
    }
  });

  test("a cd anywhere in the command moves the paths after it", () => {
    expect(catReadsOf("git status && cd src && cat a.ts b.ts")).toEqual([
      { text: "a.ts", glob: false, dir: "src" },
      { text: "b.ts", glob: false, dir: "src" },
    ]);
    expect(catReadsOf("cd src && cat a.ts; cd ..; bun test; cat README.md")).toEqual([
      { text: "a.ts", glob: false, dir: "src" },
      { text: "README.md", glob: false },
    ]);
  });

  test("a head or a tail names what it printed from, unless it is piped onward", () => {
    expect(catReadsOf("head -n 5 a.ts; tail -n +2 b.ts")).toEqual(literal("a.ts", "b.ts"));
    expect(catReadsOf("bun test; tail -n 20 log.txt")).toEqual(literal("log.txt"));
    expect(catReadsOf("head -5 a.ts | grep x; cat b.ts")).toEqual(literal("b.ts"));
    expect(catReadsOf("tail -f log; cat a.ts")).toEqual(literal("a.ts"));
  });

  // A directory change the walk cannot follow leaves every path after it
  // somewhere it cannot name, and the command names nothing.
  const NOTHING: Record<string, string> = {
    "a cd to a variable": "cd $D && cat x",
    "a cd with no argument": "cd; cat x",
    "a cd to the last directory": "cd -; cat x",
    "a cd in a loop body": "for f in a b; do cd src; cat $f; done",
    // A pipeline runs each side in a subshell: the cd moves nothing.
    "a cd at the end of a pipeline": "echo x | cd src; cat a.ts",
    "a cd piped onward": "cd src | cat a.ts",
    // Either side of an or may not run.
    "a cd right of an or": "false || cd src; cat a.ts",
    "a cd left of an or": "cd src || exit 1; cat a.ts",
    "pushd": "pushd src && cat a.ts",
    "popd": "popd; cat a.ts",
  };
  for (const [name, command] of Object.entries(NOTHING)) {
    test(`names nothing for ${name}: ${JSON.stringify(command)}`, () => {
      expect(catReadsOf(command)).toEqual([]);
    });
  }
});
