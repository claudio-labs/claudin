import { describe, expect, test } from "bun:test";
import {
  MIXED_READS_2026_10_09,
  PURE_READS_2026_10_09,
} from "src/tools/shared/outputFilter/Bash/__fixtures__/reads20261009.js";
import { isModelDirectedRead } from "src/tools/shared/outputFilter/Bash/readLane.js";

describe("isModelDirectedRead — what the model asked to read", () => {
  test.each(PURE_READS_2026_10_09)("a pure read of 10-09: %s", (command) => {
    expect(isModelDirectedRead(command)).toBe(true);
  });

  test.each(MIXED_READS_2026_10_09)("a mixed read of 10-09: %s", (command) => {
    expect(isModelDirectedRead(command)).toBe(true);
  });

  test.each([
    ["a loop over a glob", 'for f in src/*.ts; do echo "=== $f"; cat -n $f; done'],
    ["a loop over words, sliced", "for f in a.ts b.ts; do sed -n 1,20p $f; done"],
    ["a search over named files", 'grep -n -i -B2 -A4 "shipping" README.md docs/a.md'],
    ["a search in a loop over its variable", "for f in a.ts b.ts; do grep -n export $f; done"],
    ["a recursive search into a bound", 'grep -rn "TODO" src | head -20'],
    ["a file into a bound and a line filter", "cat data/catalog.json | head -40 | cut -c1-80"],
    ["a count among the prints", "wc -l src/*.ts; grep -c export src/a.ts; cat src/a.ts"],
    ["an alternative that prints nothing", "cat src/optional.ts || true"],
    ["head by bytes", "head -c 600 data/catalog.json"],
  ])("%s", (_, command) => {
    expect(isModelDirectedRead(command)).toBe(true);
  });

  // The surviving surface: none of these is something the model asked to read,
  // and the cut exists for exactly them.
  test.each([
    ["a test run", "bun test"],
    ["a test run into a bound", "bun test 2>&1 | grep -B15 error | head -40"],
    ["a build", "bun run build"],
    ["a recursive search with no bound", 'grep -rn "TODO" src'],
    ["a recursive search by long flag", 'grep --recursive -n "TODO" src/a.ts'],
    ["rg, which recurses by default", 'rg -n "TODO" src/a.ts'],
    ["a search with no file (stdin)", 'grep -n "TODO"'],
    ["a find", "find . -name '*.ts'"],
    ["a listing alone", "ls -R src"],
    ["echo alone", "echo hello"],
    ["git state beside a read", "git status && cat src/a.ts"],
    ["a file piped into a filter with no bound", "cat src/a.ts | grep export"],
    ["a loop piped onward", "for f in a.ts b.ts; do cat $f; done | head -50"],
    ["a write", "cat src/a.ts > /tmp/copy.ts"],
    ["a substitution", "cat $(git ls-files)"],
    ["an in-place edit", "sed -i 's/a/b/' src/a.ts"],
    ["a sed that prints every line", "sed 's/a/b/' src/a.ts"],
    ["a follow", "tail -f server.log"],
    ["any other program", "python3 -c 'print(1)'"],
    ["any other program beside a read", "make && cat src/a.ts"],
    ["a substitution in glue beside a read", 'echo "$(touch /tmp/x)"; cat src/a.ts'],
    ["a cd inside a loop body", "for f in a.ts b.ts; do cd src; cat $f; done"],
    ["a heredoc edit then a read", "python3 - <<'E'\nprint(1)\nE\ncat src/a.ts"],
  ])("not a read: %s", (_, command) => {
    expect(isModelDirectedRead(command)).toBe(false);
  });
});
