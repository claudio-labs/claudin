import { describe, expect, test } from "bun:test";
import {
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
    // Another program before the read — the recorded first call of r1/r2.
    "another command in the chain": "git ls-files && cat README.md",
    "the recorded git ls-files call":
      "git ls-files && cat README.md package.json && ls .claudin .claudin/memory 2>/dev/null; cat .claudin/memory/MEMORY.md .claudin/memory/team/MEMORY.md 2>/dev/null",
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
});
