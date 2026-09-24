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
