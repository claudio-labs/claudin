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

  // The two shapes the lane refused in 10-25..30, each cut and then read again
  // (team memory `census-2026-10-30-cache-tools-context`).
  test.each([
    [
      "a cd under home by tilde, then named-file searches",
      'cd ~/.cache/ferrous-review/wt-e && grep -n "fn sql_now" -A12 crates/infrastructure/src/repositories/mod.rs; grep -n "fn hours_ago_cutoff" -A8 crates/infrastructure/src/repositories/query.rs',
    ],
    ["a print of a file under home", "cat ~/notes/a.md"],
    ["a search of a file under home", 'grep -n "port" ~/.config/app/config.toml'],
    ["a listing under home beside a read", "ls ~/proj && head -20 ~/proj/README.md"],
    [
      "a loop over literal ranges into one sed script",
      'for r in 486,512 572,582 1286,1300; do echo "=== $r"; sed -n "${r}p" docs/api.md; done',
    ],
    ["a loop over single lines into one sed script", 'for n in 12 40; do sed -n "${n}p" a.ts; done'],
  ])("the 10-30 census: %s", (_, command) => {
    expect(isModelDirectedRead(command)).toBe(true);
  });

  test.each([
    ["another user's home", "cd ~bob/src && cat a.ts"],
    ["a loop word that is not a range", 'for r in 1,3 x; do sed -n "${r}p" f.md; done'],
    ["a loop over a variable into sed", 'for r in $R; do sed -n "${r}p" f.md; done'],
    ["a sed script that also prints by pattern", 'for r in 1,3; do sed -n "${r}p;/x/p" f.md; done'],
    ["a sed script naming a variable no loop sets", 'sed -n "${r}p" f.md'],
  ])("still not a read: %s", (_, command) => {
    expect(isModelDirectedRead(command)).toBe(false);
  });

  // Explore's caps of 11-22..26 (team memory `census-2026-11-26-cache-clean-explore-caps`):
  // a diff limited to paths the model named, cut to 100 lines while it had
  // asked for 150. Verbatim but for the sibling checkout made relative.
  test.each([
    ["a commit's diff of one file into a bound", "cd ../openclaude && git show 766d48db -- src/services/api/withRetry.ts | head -150"],
    [
      "a commit's diff of several files into a bound",
      "cd ../openclaude && git show 766d48db -- src/services/api/withRetry.ts src/hooks/useIdleCompaction.ts src/services/compact/idleCompaction.ts | head -400",
    ],
    ["a branch diff behind the pager guard", "git --no-pager diff main...HEAD -- src/tools/BashTool/bashPermissions/decide.ts | cat"],
    ["the changed lines of a diff into a bound", "cd ../openclaude && git show 3beebbfd -- src/services/mcp/auth.ts | grep -n '^[-+]' | head -150"],
    [
      "a diff sliced by sed beside a file slice",
      "sed -n 284,320p src/agent/compact/compact.ts; echo ----OC; cd ../openclaude && git show 766d48db -- src/services/compact/compact.ts | sed -n 118,235p",
    ],
    [
      "a diff of another checkout, without its header",
      "git -C ../openclaude show c61b6b58 --format= -- src/utils/execFileNoThrow.ts src/utils/execFileNoThrowPortable.ts",
    ],
    [
      "a range diff beside a file print",
      "cat src/agent/input/pastedContent.display.test.tsx; git diff 51c2b0e2..HEAD -- src/agent/handlePromptSubmit.test.ts src/shared/text/displayTags.test.ts | head -150",
    ],
    [
      "a working-tree diff between prints",
      "cat .claudin/memory/team/tool-row-drawn-in-two-places.md; git diff -- .claudin/memory/team/MEMORY.md | cat; cat src/agent/ui/messages/toolRowIcons.ts src/agent/ui/ToolStatusIcon.tsx",
    ],
    [
      "a pathspec glob the model wrote",
      "cd ../openclaude && git show 439d7534 -- src/tools/ExitWorktreeTool/ExitWorktreeTool.ts; echo ====; git show 439d7534 -- '*ExitWorktreeTool.test.ts' | head -120",
    ],
  ])("the 11-26 census: %s", (_, command) => {
    expect(isModelDirectedRead(command)).toBe(true);
  });

  test("a bare cat at the end of a pipeline is the identity", () => {
    expect(isModelDirectedRead("cat src/a.ts | cat")).toBe(true);
    // What a loop pipes into is still a pipeline of its own.
    expect(isModelDirectedRead("for f in a.ts b.ts; do cat $f; done | cat")).toBe(false);
    expect(isModelDirectedRead("echo hi | cat")).toBe(false);
  });

  // The diffs the lane still leaves to the cap: no path the model named, or a
  // git that could run or write something else.
  test.each([
    ["a whole commit", "cd ../openclaude && git show 9b92b89c | head -300"],
    ["a commit's file list", "git show HEAD~1 --stat | head"],
    ["a commit message", "git show -s --format='%b' 3beebbfd | head -70"],
    ["the whole tree as the path", "git diff main...HEAD -- . | head -150"],
    ["the tree spelled ./", "git diff -- ./"],
    ["a pathspec with magic", "git show 63a6ffc2 -- src/utils/sliceAnsi.ts ':!*.test.ts'"],
    ["a diff written to a file", "git diff --output=/tmp/d.patch -- src/a.ts"],
    ["an external diff driver", "git diff --ext-diff -- src/a.ts"],
    ["a text conversion filter", "git show --textconv HEAD -- src/a.ts"],
    ["a diff of files outside the repository", "git diff --no-index -- a.ts b.ts"],
    ["a config override", "git -c core.pager=less diff -- src/a.ts"],
    ["a substituted revision", "git show $(git rev-parse HEAD) -- src/a.ts"],
    ["a variable revision", "git show $REV -- src/a.ts"],
    ["a log", "git log -p -- src/a.ts"],
    ["a diff into a filter with no bound", "git show 3beebbfd -- src/utils/memoize.ts | grep '^[-+]'"],
    ["no path after the separator", "git diff main --"],
  ])("still capped: %s", (_, command) => {
    expect(isModelDirectedRead(command)).toBe(false);
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
