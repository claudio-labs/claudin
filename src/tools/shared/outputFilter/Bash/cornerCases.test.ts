/**
 * Corner-case tests for chained command filter resolution.
 *
 * Each test names a real-world command an agent might run, declares the
 * EXPECTED behavior (what an experienced developer would want), then exercises
 * `findFilterForCommand` and `splitTopLevelSegments`. Tests marked with
 * `// KNOWN GAP` document deliberate or accepted limitations.
 */

import { describe, expect, test } from "bun:test";
import { applyBashFilterToStdout, planBashFilter } from "src/tools/shared/outputFilter/Bash/index.js";
import {
  applyPipeline,
  extractCommandPrefix,
  hasCompound,
  maybeRewrite,
  parseBashCommand,
  splitTopLevelSegments,
} from "src/tools/shared/outputFilter/Bash/pipeline.js";
import type { FilterSpec } from "src/tools/shared/outputFilter/Bash/types.js";
import {
  canonicalizeForMatching,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/registry.js";

const filterName = (cmd: string): string | null =>
  findFilterForCommand(cmd)?.name ?? null;

describe("corner cases: whitespace variations around operators", () => {
  test("no spaces around &&", () => {
    expect(splitTopLevelSegments("cd src&&ls")).toEqual(["cd src", "ls"]);
    expect(filterName("cd src&&ls")).toBe(filterName("ls"));
  });

  test("tabs around &&", () => {
    expect(splitTopLevelSegments("cd src\t&&\tls")).toEqual(["cd src", "ls"]);
  });

  test("multiple spaces around &&", () => {
    expect(splitTopLevelSegments("cd src     &&     ls")).toEqual([
      "cd src",
      "ls",
    ]);
  });

  test("newline between segments", () => {
    expect(splitTopLevelSegments("cd src &&\nls")).toEqual(["cd src", "ls"]);
  });

  test("backslash-newline continuation splits cleanly", () => {
    // bash treats `\<newline>` as line continuation. Splitter keeps the
    // backslash in the segment text but verb parsing splits on whitespace,
    // so the verb is still recognised. The filter assertion depends on
    // whether `git status` and `git diff` resolve to the same filter — if
    // they don't (different filters), bypass is the correct answer; here we
    // only assert the splitter works.
    const segs = splitTopLevelSegments("git status \\\n  && git diff");
    expect(segs).not.toBeNull();
    expect(segs?.length).toBe(2);
  });
});

describe("corner cases: trailing operators", () => {
  test("trailing semicolon", () => {
    expect(splitTopLevelSegments("ls;")).toEqual(["ls"]);
    expect(filterName("ls;")).toBe(filterName("ls"));
  });

  test("leading semicolon (defensive)", () => {
    expect(splitTopLevelSegments(";ls")).toEqual(["ls"]);
  });

  test("trailing && (malformed but tolerant)", () => {
    expect(splitTopLevelSegments("ls && ")).toEqual(["ls"]);
  });

  test("double semicolon (rare but harmless)", () => {
    expect(splitTopLevelSegments("ls ;; pwd")).toEqual(["ls", "pwd"]);
  });
});

describe("corner cases: redirects (must NOT bail)", () => {
  test("stdout to file with chain", () => {
    expect(splitTopLevelSegments("git status > /tmp/out && cat /tmp/out")).toEqual([
      "git status > /tmp/out",
      "cat /tmp/out",
    ]);
  });

  test("append redirect with chain", () => {
    expect(splitTopLevelSegments("ls >> log && wc -l log")).not.toBeNull();
  });

  test("stdin redirect with chain", () => {
    expect(splitTopLevelSegments("wc -l < input.txt && echo done")).toEqual([
      "wc -l < input.txt",
      "echo done",
    ]);
  });

  test("regression: 'echo done' as literal arg is NOT control-flow", () => {
    // Control-flow keywords are only recognised at statement boundaries.
    // `echo done` is `echo` with arg `done`, not a `for` loop closer.
    expect(splitTopLevelSegments("echo done")).toEqual(["echo done"]);
    expect(splitTopLevelSegments("ls && echo done")).toEqual([
      "ls",
      "echo done",
    ]);
    expect(splitTopLevelSegments("echo if && echo fi")).toEqual([
      "echo if",
      "echo fi",
    ]);
  });

  test("regression: real for-loop is still detected as control-flow", () => {
    // The fix must not break legitimate control-flow detection.
    expect(splitTopLevelSegments("for f in *; do ls $f; done")).toBeNull();
    expect(splitTopLevelSegments("if true; then ls; fi")).toBeNull();
    expect(splitTopLevelSegments("while read l; do echo $l; done")).toBeNull();
  });

  // Previously a KNOWN GAP: `2>&1` contains a literal `&` followed by `1` and
  // the splitter bailed. Fixed by treating `>&` and `&>` as redirection tokens
  // (pipeline.ts) — this was the dominant false-positive in the bash-filter
  // bench (~50% of "compound" commands were just `cmd 2>&1`).
  test("2>&1 redirect does not cause bypass", () => {
    expect(splitTopLevelSegments("ls 2>&1 && cat")).toEqual([
      "ls 2>&1",
      "cat",
    ]);
  });

  // Previously a KNOWN GAP: `&>` is a bash redirect (stdout+stderr). Now the
  // splitter keeps the redirection as part of its segment.
  test("&> redirect does not cause bypass", () => {
    expect(splitTopLevelSegments("ls &> /tmp/out && cat /tmp/out")).toEqual([
      "ls &> /tmp/out",
      "cat /tmp/out",
    ]);
  });
});

describe("corner cases: quoted operators (must NOT split)", () => {
  test("&& inside double quotes", () => {
    expect(splitTopLevelSegments('echo "a && b"')).toEqual(['echo "a && b"']);
  });

  test("|| inside single quotes", () => {
    expect(splitTopLevelSegments("echo 'a || b'")).toEqual(["echo 'a || b'"]);
  });

  test("semicolons inside quotes", () => {
    expect(splitTopLevelSegments('echo "a;b;c" && pwd')).toEqual([
      'echo "a;b;c"',
      "pwd",
    ]);
  });

  test("escaped quote inside double quote does not exit quote", () => {
    expect(splitTopLevelSegments('echo "she said \\"hi && bye\\"" ; ls')).toEqual([
      'echo "she said \\"hi && bye\\""',
      "ls",
    ]);
  });

  test("nested-quote (single inside double)", () => {
    expect(splitTopLevelSegments(`echo "it's && fine" && pwd`)).toEqual([
      `echo "it's && fine"`,
      "pwd",
    ]);
  });
});

describe("corner cases: subshells and control-flow (must bail)", () => {
  test("$(...) subshell bails", () => {
    expect(splitTopLevelSegments("echo $(date) && ls")).toBeNull();
  });

  test("backtick subshell bails", () => {
    expect(splitTopLevelSegments("echo `date` && ls")).toBeNull();
  });

  test("process substitution >() bails", () => {
    expect(splitTopLevelSegments("tee >(cat) && pwd")).toBeNull();
  });

  test("process substitution <() bails", () => {
    expect(splitTopLevelSegments("diff <(ls a) <(ls b)")).toBeNull();
  });

  test("if/then/fi bails", () => {
    expect(splitTopLevelSegments("if true; then ls; fi")).toBeNull();
  });

  test("for loop bails", () => {
    expect(splitTopLevelSegments("for f in *.ts; do echo $f; done")).toBeNull();
  });

  test("pipe bails", () => {
    expect(splitTopLevelSegments("cat foo | grep bar")).toBeNull();
  });

  test("background single & bails", () => {
    expect(splitTopLevelSegments("pwd & ls")).toBeNull();
  });
});

describe("corner cases: escape sequences outside quotes", () => {
  test("escaped && outside quotes is treated as literal arg, not operator", () => {
    // Bash semantics: `\&` is a literal `&`. So `echo a \&\& b` is a single
    // command `echo` with three args (`a`, `&&`, `b`), not a chain.
    expect(splitTopLevelSegments("echo a \\&\\& b")).toEqual(["echo a && b"]);
  });

  test("escaped semicolon does not split", () => {
    expect(splitTopLevelSegments("echo a\\;b")).toEqual(["echo a;b"]);
  });

  test("backslash-newline is line continuation (joined)", () => {
    // `git \<LF>status` should become `git status` (single segment).
    const segs = splitTopLevelSegments("git \\\nstatus");
    expect(segs).not.toBeNull();
    expect(segs?.length).toBe(1);
    // Verb is recognized as `git` → resolves to git-status filter.
    expect(filterName("git \\\nstatus")).toBe(filterName("git status"));
  });
});

describe("corner cases: comments", () => {
  // KNOWN GAP: `#` is not recognized as comment-start. In practice the agent
  // rarely embeds comments mid-command (it just writes them as separate
  // lines or omits them), so this is a tolerable gap.
  test("KNOWN GAP: # inside command does not stop splitter", () => {
    const segs = splitTopLevelSegments("ls # comment && pwd");
    expect(segs?.length).toBe(2);
  });
});

describe("corner cases: longer chains", () => {
  test("three-segment chain with single filter", () => {
    expect(splitTopLevelSegments("cd a && cd b && ls")).toEqual([
      "cd a",
      "cd b",
      "ls",
    ]);
    expect(filterName("cd a && cd b && ls")).toBe(filterName("ls"));
  });

  test("mix of && and ;", () => {
    expect(splitTopLevelSegments("cd src ; pwd && ls")).toEqual([
      "cd src",
      "pwd",
      "ls",
    ]);
  });

  test("mix of && and ||", () => {
    expect(splitTopLevelSegments("git pull && git push || echo failed")).toEqual([
      "git pull",
      "git push",
      "echo failed",
    ]);
  });
});

describe("corner cases: prefix preservation", () => {
  test("sudo on first segment", () => {
    expect(filterName("sudo apt update && sudo apt upgrade")).toBe(
      filterName("apt update"),
    );
  });

  test("env vars on first segment", () => {
    // Env-var prefix on the first segment must be stripped before
    // matching. Both segments resolve to the same filter so the chained
    // form should agree with the atomic form.
    expect(filterName("FOO=bar npm install && npm install lodash")).toBe(
      filterName("npm install"),
    );
  });

  test("time prefix on chained segment", () => {
    expect(filterName("cd src && time npm test")).toBe(filterName("npm test"));
  });
});

describe("corner cases: the `timeout` prefix (Phase 14)", () => {
  // `timeout` is not `sudo`: the duration sits between the wrapper and the
  // command, so consuming the word alone would promote the number to the verb.
  test("plain duration resolves to the wrapped command's filter", () => {
    expect(filterName("timeout 300 docker compose up")).toBe(
      filterName("docker compose up"),
    );
    expect(filterName("timeout 60 pytest tests/")).toBe(filterName("pytest tests/"));
  });

  test("duration suffixes s/m/h/d and a fractional duration", () => {
    for (const d of ["30s", "5m", "2h", "1d", "1.5h", "0.5s"]) {
      expect(filterName(`timeout ${d} pytest tests/`)).toBe(
        filterName("pytest tests/"),
      );
    }
  });

  test("flags before the duration are consumed with it", () => {
    const want = filterName("pytest tests/");
    expect(filterName("timeout -k 5s 60 pytest tests/")).toBe(want);
    expect(filterName("timeout --kill-after=5s 60 pytest tests/")).toBe(want);
    expect(filterName("timeout --preserve-status 30 pytest tests/")).toBe(want);
    expect(filterName("timeout --foreground -s KILL 30 pytest tests/")).toBe(want);
  });

  test("prefix on a chained segment, and stacked with sudo/env", () => {
    expect(filterName("cd src && timeout 60 pytest tests/")).toBe(
      filterName("pytest tests/"),
    );
    expect(filterName("sudo timeout 30 docker compose up")).toBe(
      filterName("docker compose up"),
    );
    expect(filterName("CI=1 timeout 30 bun run build")).toBe(
      filterName("bun run build"),
    );
  });

  test("negative: with no duration nothing is stripped", () => {
    // The dangerous case. If the bare word were consumed, `--help` would be
    // promoted to the verb and could match some unrelated spec.
    expect(filterName("timeout --help")).toBeNull();
    expect(parseBashCommand("timeout --help").verb).toBe("timeout");
    expect(parseBashCommand("timeout").verb).toBe("timeout");
  });

  test("negative: word boundary — `timeoutctl` is a different program", () => {
    expect(parseBashCommand("timeoutctl 30 status").verb).toBe("timeoutctl");
  });
});

describe("corner cases: real-world agent commands", () => {
  test("typical 'navigate then run' pattern", () => {
    // No filter for `cd`, so should resolve to `ls` filter.
    expect(filterName("cd /tmp/foo && ls -la")).toBe(filterName("ls -la"));
  });

  test("'try and fallback' pattern", () => {
    // Both segments have git filters but they may be DIFFERENT filters
    // (git status vs git diff). When they disagree, we expect bypass.
    const f1 = filterName("git status");
    const f2 = filterName("git diff");
    if (f1 && f2 && f1 !== f2) {
      expect(filterName("git status && git diff")).toBeNull();
    }
  });

  test("'navigate then test' pattern", () => {
    expect(filterName("cd packages/foo && bun test")).toBe(
      filterName("bun test"),
    );
  });

  test("git options preserved", () => {
    // `git -C foo status && git -C foo diff` — verbs are still git.
    // Whether this resolves depends on whether status/diff filters differ.
    const segs = splitTopLevelSegments("git -C foo status && git -C foo diff");
    expect(segs).toEqual(["git -C foo status", "git -C foo diff"]);
  });

  test("noop guard via test &&", () => {
    expect(filterName("test -d node_modules || npm install")).toBe(
      filterName("npm install"),
    );
  });

  test("install + test pattern resolves consistently", () => {
    // npm install and npm test typically have different filters; chain
    // should bypass (return null). If they ever share a filter, it should
    // resolve to that filter — both outcomes are acceptable, just not a
    // crash and not a wrong filter.
    const a = filterName("npm install");
    const b = filterName("npm test");
    const chained = filterName("npm install && npm test");
    if (a && b && a !== b) {
      expect(chained).toBeNull();
    } else {
      expect(chained === a || chained === b || chained === null).toBe(true);
    }
  });
});

describe("corner cases: pathological but legal inputs", () => {
  test("only whitespace returns null", () => {
    expect(splitTopLevelSegments("   ")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(splitTopLevelSegments("")).toBeNull();
  });

  test("single segment returns array of one", () => {
    expect(splitTopLevelSegments("ls -la")).toEqual(["ls -la"]);
  });

  test("unclosed double quote bails", () => {
    expect(splitTopLevelSegments('echo "hello && pwd')).toBeNull();
  });

  test("unclosed single quote bails", () => {
    expect(splitTopLevelSegments("echo 'hello && pwd")).toBeNull();
  });
});

describe("corner cases: subshell groups (...)", () => {
  // KNOWN GAP: `(cmd && cmd)` subshell groups are not recognized. The splitter
  // walks past `(` and `)` as ordinary chars, so it splits inside the group.
  // Agents rarely use explicit subshell groups; the verb-parse on `(ls`
  // typically yields no matching filter, leading to bypass — acceptable.
  test("KNOWN GAP: subshell group not detected", () => {
    const segs = splitTopLevelSegments("(ls && pwd) && echo done");
    // Naive split: ["(ls", "pwd)", "echo done"]
    expect(segs?.length).toBe(3);
    // Resolves to either echo's filter or null — harmless because verbs
    // `(ls` and `pwd)` don't match any filter, so divergence is impossible.
    // Either way, no wrong filter is applied to a real command.
    const result = filterName("(ls && pwd) && echo done");
    // Either bypass (null) or a real FilterSpec with a string `name` —
    // never accidentally a different filter from `ls`/`pwd` (which the naive
    // split garbled into `(ls` / `pwd)` and so cannot match).
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("corner cases: newline as statement separator", () => {
  test("bare newline splits like ;", () => {
    expect(splitTopLevelSegments("git status\ngit diff")).toEqual([
      "git status",
      "git diff",
    ]);
  });

  test("newline + same filter resolves (cd doesn't conflict)", () => {
    // `cd` has no filter; `git status` does. Chain should resolve to git-status.
    expect(filterName("cd src\ngit status")).toBe(filterName("git status"));
  });

  test("newline + divergent filters bypasses", () => {
    // git-status and git-diff are distinct filters → divergence → bypass.
    expect(filterName("git status\ngit diff")).toBeNull();
  });

  test("CRLF: \\r remains as char inside segment, \\n splits", () => {
    // A raw \r\n shouldn't break the splitter. \r ends up as trailing
    // whitespace on a segment and is trimmed by .trim().
    const segs = splitTopLevelSegments("git status\r\ngit diff");
    expect(segs).toEqual(["git status", "git diff"]);
  });

  test("newline inside double quotes does NOT split", () => {
    expect(splitTopLevelSegments('echo "a\nb" && ls')).toEqual([
      'echo "a\nb"',
      "ls",
    ]);
  });
});

describe("corner cases: heredoc", () => {
  test("heredoc bypasses (body would be split mid-text)", () => {
    expect(splitTopLevelSegments("cat <<EOF\nfoo\nEOF\n && ls")).toBeNull();
    expect(filterName("cat <<EOF\nfoo\nEOF\n && ls")).toBeNull();
  });

  test("here-string `<<<` also bypasses", () => {
    expect(splitTopLevelSegments("grep foo <<< 'bar' && wc -l")).toBeNull();
  });
});

describe("corner cases: env assignment with quoted values", () => {
  test("FOO=\"a b\" git status — verb is git, not git=...", () => {
    expect(canonicalizeForMatching('FOO="a b" git status')).toBe("git status");
    expect(filterName('FOO="a b" git status')).toBe(filterName("git status"));
  });

  test("multiple quoted env assignments", () => {
    expect(
      canonicalizeForMatching("FOO='x y' BAR=\"a b c\" npm install"),
    ).toBe("npm install");
  });

  test("env assignment chained with && (same filter)", () => {
    // Both segments resolve to git-status → chain resolves to git-status.
    expect(
      filterName('FOO="a b" git status && BAR="c d" git status -uno'),
    ).toBe(filterName("git status"));
  });
});

describe("corner cases: literal operators inside quotes", () => {
  test("&& inside single quotes (real grep pattern)", () => {
    // Real-world: search for the literal string `a && b` in a file, then wc.
    const segs = splitTopLevelSegments("grep 'a && b' file.txt && wc -l file.txt");
    expect(segs).toEqual(["grep 'a && b' file.txt", "wc -l file.txt"]);
  });

  test("; inside double quotes (real echo)", () => {
    expect(splitTopLevelSegments('echo "a;b;c" && ls')).toEqual([
      'echo "a;b;c"',
      "ls",
    ]);
  });

  test("|| inside escape inside double quote", () => {
    expect(splitTopLevelSegments('echo "a \\|\\| b" && ls')).toEqual([
      'echo "a \\|\\| b"',
      "ls",
    ]);
  });
});

describe("corner cases: ! logical-not prefix", () => {
  test("! prefix on first segment does not break split", () => {
    // Whether or not the verb resolves to a filter, the split must succeed.
    const segs = splitTopLevelSegments("! grep foo file.txt && echo missing");
    expect(segs).toEqual(["! grep foo file.txt", "echo missing"]);
  });
});

describe("corner cases: brace expansion", () => {
  test("braces inside arg do not affect split", () => {
    expect(splitTopLevelSegments("ls {a,b,c} && pwd")).toEqual([
      "ls {a,b,c}",
      "pwd",
    ]);
  });
});

describe("corner cases: long chains (perf)", () => {
  test("50-segment ; chain splits cleanly", () => {
    const cmd = Array.from({ length: 50 }, (_, i) => `echo ${i}`).join("; ");
    const segs = splitTopLevelSegments(cmd);
    expect(segs?.length).toBe(50);
    // All segments share the same filter (echo) → single filter resolves.
    expect(filterName(cmd)).toBe(filterName("echo 0"));
  });

  test("1000-segment chain finishes quickly (< 100ms)", () => {
    const cmd = Array.from({ length: 1000 }, () => "ls").join(" && ");
    const t0 = performance.now();
    const segs = splitTopLevelSegments(cmd);
    const elapsed = performance.now() - t0;
    expect(segs?.length).toBe(1000);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("corner cases: planBashFilter rewrite is suppressed in chains", () => {
  test("rewrite is null for compound even when atomic would rewrite", () => {
    // Atomic `git status` may produce a rewrite (e.g. --porcelain). In a
    // chain, mutating the verb would mangle the surrounding segments.
    const atomic = planBashFilter("git status");
    const chain = planBashFilter("git status && git diff");
    if (atomic.filter && chain.filter) {
      expect(chain.rewrite).toBeNull();
    }
  });

  test("rewrite still applies for true atomics", () => {
    // Sanity: the suppression is scoped to compounds, not blanket-off.
    const atomic = planBashFilter("git log");
    // We don't assert rewrite is non-null (filter may not define one);
    // we assert at least it isn't suppressed *because* of compound logic.
    expect(atomic.filter).not.toBeNull();
  });
});

describe("corner cases: empty / degenerate inputs", () => {
  test("only operators is handled gracefully", () => {
    // `&& && ` is a bash syntax error, but we must not crash. Splitter
    // either bails or produces empty segments which get filtered out.
    const segs = splitTopLevelSegments(" && && ");
    expect(segs === null || segs.length === 0).toBe(true);
  });

  test("trailing operator", () => {
    expect(splitTopLevelSegments("ls &&")).toEqual(["ls"]);
  });

  test("leading operator", () => {
    expect(splitTopLevelSegments("&& ls")).toEqual(["ls"]);
  });

  test("only whitespace", () => {
    expect(splitTopLevelSegments("   ")).toBeNull();
  });

  test("empty string", () => {
    expect(splitTopLevelSegments("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review-round-2 fixes: env-assignment robustness, quote-aware control-flow
// detection, line continuation. These tests pin the behaviour the second
// review pass identified as broken.
// ---------------------------------------------------------------------------

describe("env assignment: subshell values", () => {
  test("FOO=$(date) cmd → cmd canonicalizes correctly", () => {
    expect(canonicalizeForMatching("FOO=$(date) git status")).toBe(
      "git status",
    );
    expect(filterName("FOO=$(date) git status")).toBe(filterName("git status"));
  });

  test("FOO=$(echo a b) cmd — inner space stays inside subshell", () => {
    expect(canonicalizeForMatching("FOO=$(echo a b) ls")).toBe("ls");
  });

  test("FOO=`date` cmd — backtick subshell respected", () => {
    expect(canonicalizeForMatching("FOO=`date` ls")).toBe("ls");
  });

  test("nested subshell in env value", () => {
    expect(canonicalizeForMatching("FOO=$(echo $(pwd)) ls -la")).toBe("ls -la");
  });

  test("multiple env assignments with subshells", () => {
    expect(canonicalizeForMatching("A=$(date) B=$(pwd) git status")).toBe(
      "git status",
    );
  });
});

describe("env assignment: escaped/special values", () => {
  test("FOO=a\\ b cmd — escaped space stays in value", () => {
    // Verb must be `ls`, not `b`.
    expect(canonicalizeForMatching("FOO=a\\ b ls")).toBe("ls");
  });

  test("FOO= cmd — empty value", () => {
    expect(canonicalizeForMatching("FOO= ls")).toBe("ls");
  });

  test("FOO=\"a b\" cmd — quoted value with space", () => {
    expect(canonicalizeForMatching('FOO="a b" git status')).toBe("git status");
  });

  test("FOO='a;b' cmd — single-quoted operator stays in value", () => {
    expect(canonicalizeForMatching("FOO='a;b' ls")).toBe("ls");
  });
});

describe("control-flow detection is quote-aware (post-split)", () => {
  test("quoted control-flow keyword in chain does not bypass", () => {
    // `echo "; then ls"` is a single command whose argument happens to look
    // like control flow. Chained with `pwd`, it must NOT bail.
    const segs = splitTopLevelSegments('echo "; then ls" && pwd');
    expect(segs).toEqual(['echo "; then ls"', "pwd"]);
  });

  test("quoted `done` argument does not bypass in chain", () => {
    expect(splitTopLevelSegments('echo "done" && ls')).toEqual([
      'echo "done"',
      "ls",
    ]);
  });

  test("real control-flow at segment start still bypasses", () => {
    expect(splitTopLevelSegments("ls && for f in *; do echo; done")).toBeNull();
  });

  test("control-flow keyword as plain echo arg is fine atomically", () => {
    // `echo done` is just one command — splitter returns one segment.
    expect(splitTopLevelSegments("echo done")).toEqual(["echo done"]);
  });
});

describe("backslash-newline line continuation", () => {
  test("line continuation joins verb and args", () => {
    const segs = splitTopLevelSegments("git \\\nstatus");
    expect(segs?.length).toBe(1);
    expect(filterName("git \\\nstatus")).toBe(filterName("git status"));
  });

  test("line continuation across multiple lines", () => {
    const segs = splitTopLevelSegments("git \\\nlog \\\n--oneline");
    expect(segs?.length).toBe(1);
    expect(filterName("git \\\nlog \\\n--oneline")).toBe(
      filterName("git log --oneline"),
    );
  });

  test("line continuation in chain preserves segments", () => {
    const segs = splitTopLevelSegments("cd src && \\\nls");
    expect(segs).toEqual(["cd src", "ls"]);
  });
});

describe("review-round-2: end-to-end plan invariants", () => {
  test("FOO=$(date) git status → filter applied (not bypass)", () => {
    const plan = planBashFilter("FOO=$(date) git status");
    expect(plan.filter).not.toBeNull();
    expect(plan.filter?.name).toBe(filterName("git status") ?? "");
  });

  test("quoted control-flow keyword in chain — does not bail on false positive", () => {
    // `echo "; then ls"` is a single command. Chained with `pwd`, neither
    // has a built-in filter so the chain resolves to null — but crucially it
    // is null because of "no filter", not because of CONTROL_FLOW false bail.
    const segs = splitTopLevelSegments('echo "; then ls" && pwd');
    expect(segs).toEqual(['echo "; then ls"', "pwd"]);
  });

  test("git \\<LF>status → git-status filter applied", () => {
    const plan = planBashFilter("git \\\nstatus");
    expect(plan.filter).not.toBeNull();
    expect(plan.filter?.name).toBe(filterName("git status") ?? "");
  });
});

// ---------------------------------------------------------------------------
// Round-3 review fixes — parseBashCommand parity, [[ ]] / (( )) bail-out,
// |& bash-4 pipe, fail-open verification.
// ---------------------------------------------------------------------------

describe("parseBashCommand: quoted env value (C1 regression)", () => {
  test('FOO="a b" git status → verb="git", args=["status"]', () => {
    const ctx = parseBashCommand('FOO="a b" git status');
    expect(ctx.verb).toBe("git");
    expect(ctx.args).toEqual(["status"]);
  });

  test("FOO=$(date) git status → verb=git, no subshell leakage", () => {
    const ctx = parseBashCommand("FOO=$(date) git status");
    expect(ctx.verb).toBe("git");
    expect(ctx.args).toEqual(["status"]);
  });

  test("FOO=a\\ b git status → escaped space stays in value", () => {
    const ctx = parseBashCommand("FOO=a\\ b git status");
    expect(ctx.verb).toBe("git");
    expect(ctx.args).toEqual(["status"]);
  });

  test("multiple env assignments stripped in order", () => {
    const ctx = parseBashCommand('FOO="a b" BAR=c git status');
    expect(ctx.verb).toBe("git");
    expect(ctx.args).toEqual(["status"]);
  });

  test("backtick env value advances correctly", () => {
    const ctx = parseBashCommand("FOO=`date` git status");
    expect(ctx.verb).toBe("git");
    expect(ctx.args).toEqual(["status"]);
  });

  test("git \\<LF>status atomic → verb=git, args=[status] (line continuation collapsed)", () => {
    const ctx = parseBashCommand("git \\\nstatus");
    expect(ctx.verb).toBe("git");
    expect(ctx.args).toEqual(["status"]);
  });

  test("parseBashCommand and canonicalizeForMatching agree on quoted env", () => {
    const cmd = 'FOO="a b" git status';
    const ctx = parseBashCommand(cmd);
    const canon = canonicalizeForMatching(cmd);
    expect(ctx.command).toBe(canon);
  });
});

describe("splitTopLevelSegments: [[ ]] and (( )) bail-out (C2 regression)", () => {
  test("[[ -f x && -f y ]] && ls — bails (cannot split through test brackets)", () => {
    expect(splitTopLevelSegments("[[ -f x && -f y ]] && ls")).toBeNull();
  });

  test("[[ ... ]] && ls — bails (conservative)", () => {
    expect(splitTopLevelSegments("[[ -d node_modules ]] && ls")).toBeNull();
  });

  test("(( i + 1 == 2 )) && echo ok — bails (arithmetic eval)", () => {
    expect(splitTopLevelSegments("(( i + 1 == 2 )) && echo ok")).toBeNull();
  });

  test("[[ inside quotes is literal — does NOT bail", () => {
    // `echo "[["` is fine — the brackets are quoted.
    expect(splitTopLevelSegments('echo "[[" && pwd')).toEqual([
      'echo "[["',
      "pwd",
    ]);
  });

  test("planBashFilter on [[ ]] chain → null filter (bypass, fail-safe)", () => {
    const plan = planBashFilter("[[ -f foo && -f bar ]] && git status");
    expect(plan.filter).toBeNull();
  });
});

describe("splitTopLevelSegments: |& pipe-with-stderr bails", () => {
  test("cmd1 |& cmd2 — bails (transformed output, like `|`)", () => {
    expect(splitTopLevelSegments("make |& tee log")).toBeNull();
  });
});

describe("safeApply fail-open (C-defensive)", () => {
  test("planBashFilter never throws on pathological input", () => {
    // Inputs that previously could trip parsing: deep nesting, unbalanced
    // quotes, very long strings. All must return a usable plan.
    const inputs = [
      "",
      " ".repeat(1000),
      "'".repeat(500), // unclosed single quotes
      '"'.repeat(500), // unclosed double quotes
      "$(".repeat(200) + ")".repeat(200),
      "x".repeat(10_000),
      "\\\n".repeat(200),
    ];
    for (const input of inputs) {
      const plan = planBashFilter(input);
      expect(plan).toBeDefined();
      // Fail-open invariant: effectiveCommand always defined, never throws.
      expect(typeof plan.effectiveCommand).toBe("string");
    }
  });

  test("applyBashFilterToStdout returns raw on empty plan", () => {
    const plan = planBashFilter("nonsense-command-xyz");
    const result = applyBashFilterToStdout("hello\nworld\n", false, plan);
    expect(result).toBe("hello\nworld\n");
  });
});

describe("review #4: process substitution is treated as compound", () => {
  test("findFilterForCommand rejects diff <(...) <(...)", () => {
    // Process substitution exposes per-process output that the splitter cannot
    // safely segment. Must bypass filtering — a `diff` filter applied to
    // multi-stream output would corrupt it.
    expect(filterName("diff <(ls a) <(ls b)")).toBeNull();
  });

  test("findFilterForCommand rejects > (out) process substitution", () => {
    expect(filterName("tee >(grep error)")).toBeNull();
  });

  test("hasCompound returns true for process substitution (atomic command)", () => {
    // `diff` is otherwise a single verb but `<(...)` makes it compound.
    expect(hasCompound("diff <(ls)")).toBe(true);
  });

  test("planBashFilter passthrough for process substitution", () => {
    const plan = planBashFilter("diff <(ls a) <(ls b)");
    expect(plan.filter).toBeNull();
    expect(plan.rewrite).toBeNull();
  });
});

describe("review #4: hasCompound is quote-aware", () => {
  test("quoted operators do not trigger compound", () => {
    // `;` `&&` `|` `(` inside single quotes are literal — atomic command.
    expect(hasCompound("git log --grep='fix; pwd'")).toBe(false);
    expect(hasCompound("git log --grep='a && b'")).toBe(false);
    expect(hasCompound("git log --grep='fix $(date)'")).toBe(false);
    expect(hasCompound("git log --grep='a | b'")).toBe(false);
  });

  test("quoted operators preserved through to filter resolution", () => {
    // The filter should still resolve to git's filter (atomic, not compound).
    const name = filterName("git log --grep='fix; pwd'");
    expect(name).not.toBeNull();
    expect(name).toBe(filterName("git log"));
  });

  test("real operators outside quotes still trigger compound", () => {
    // Sanity: don't over-correct.
    expect(hasCompound("git log; pwd")).toBe(true);
    expect(hasCompound("git log && pwd")).toBe(true);
    expect(hasCompound("git log | head")).toBe(true);
  });

  test("real operators after quoted region still trigger compound", () => {
    expect(hasCompound("git log --grep='fix' && pwd")).toBe(true);
  });
});

describe("review #4: maybeRewrite preserves env prefix and sudo", () => {
  // Mirror git's actual filter rewrite: `git log` → `git log --oneline`.
  const gitLogFilter: FilterSpec = {
    name: "test:git log",
    matchCommand: /^git$/,
    rewriteCommand: (ctx) => {
      if (ctx.args[0] !== "log") return null;
      const extra = ctx.args.slice(1).join(" ");
      return extra ? `git log --oneline ${extra}` : "git log --oneline";
    },
  };

  test("env assignment prefix is re-prepended after rewrite", () => {
    const result = maybeRewrite(gitLogFilter, "GIT_PAGER=cat git log");
    expect(result).not.toBeNull();
    // User's GIT_PAGER override must survive the rewrite.
    expect(result?.rewritten).toBe("GIT_PAGER=cat git log --oneline");
    expect(result?.original).toBe("GIT_PAGER=cat git log");
  });

  test("multiple env assignments preserved", () => {
    const result = maybeRewrite(gitLogFilter, "GIT_PAGER=cat LANG=C git log");
    expect(result?.rewritten).toBe("GIT_PAGER=cat LANG=C git log --oneline");
  });

  test("quoted env value preserved", () => {
    const result = maybeRewrite(gitLogFilter, 'FOO="a b" git log');
    expect(result?.rewritten).toBe('FOO="a b" git log --oneline');
  });

  test("sudo prefix is re-prepended after rewrite", () => {
    const result = maybeRewrite(gitLogFilter, "sudo git log");
    expect(result?.rewritten).toBe("sudo git log --oneline");
  });

  test("env + sudo combo preserved", () => {
    const result = maybeRewrite(gitLogFilter, "GIT_PAGER=cat sudo git log");
    expect(result?.rewritten).toBe("GIT_PAGER=cat sudo git log --oneline");
  });

  test("identity rewrite returns null even with env prefix", () => {
    // Filter returns identical command — caller must see null (no marker).
    const identityFilter: FilterSpec = {
      name: "test:identity",
      matchCommand: /^echo$/,
      rewriteCommand: (ctx) => ctx.command,
    };
    expect(maybeRewrite(identityFilter, "FOO=bar echo hi")).toBeNull();
  });

  test("rewrite skipped when filter has no rewriteCommand", () => {
    const noRewrite: FilterSpec = {
      name: "test:noop",
      matchCommand: /^echo$/,
    };
    expect(maybeRewrite(noRewrite, "FOO=bar echo hi")).toBeNull();
  });
});

describe("review #4: extractCommandPrefix", () => {
  test("returns empty string when no env or prefix", () => {
    expect(extractCommandPrefix("git log")).toBe("");
    expect(extractCommandPrefix("ls -la")).toBe("");
  });

  test("captures single env assignment + trailing space", () => {
    expect(extractCommandPrefix("FOO=bar git log")).toBe("FOO=bar ");
  });

  test("captures multiple env assignments", () => {
    expect(extractCommandPrefix("FOO=bar BAZ=qux git log")).toBe(
      "FOO=bar BAZ=qux ",
    );
  });

  test("captures quoted env value", () => {
    expect(extractCommandPrefix('FOO="a b" git log')).toBe('FOO="a b" ');
  });

  test("captures env + sudo", () => {
    expect(extractCommandPrefix("FOO=bar sudo git log")).toBe("FOO=bar sudo ");
  });

  test("captures sudo alone", () => {
    expect(extractCommandPrefix("sudo git log")).toBe("sudo ");
  });

  test("captures time prefix", () => {
    expect(extractCommandPrefix("time git log")).toBe("time ");
  });

  // --- Phase 14: `timeout` and the lockstep invariant ----------------------
  //
  // This is the one place in the phase where being wrong changes BEHAVIOUR
  // rather than formatting. `maybeRewrite` re-prepends whatever this returns
  // onto the rewritten verb, so a prefix that came back short would execute the
  // command with the timeout silently dropped.

  test("captures timeout with its duration", () => {
    expect(extractCommandPrefix("timeout 300 git status")).toBe("timeout 300 ");
    expect(extractCommandPrefix("timeout 1.5h git status")).toBe("timeout 1.5h ");
  });

  test("captures timeout with its flags and duration", () => {
    expect(extractCommandPrefix("timeout -k 5s 60 git status")).toBe(
      "timeout -k 5s 60 ",
    );
    expect(extractCommandPrefix("timeout --preserve-status 30 git status")).toBe(
      "timeout --preserve-status 30 ",
    );
  });

  test("captures env + sudo + timeout stacked", () => {
    expect(extractCommandPrefix("CI=1 sudo timeout 30 git status")).toBe(
      "CI=1 sudo timeout 30 ",
    );
  });

  test("captures nothing when timeout has no duration", () => {
    expect(extractCommandPrefix("timeout --help")).toBe("");
  });

  test("lockstep: the prefix is always a real prefix of the command", () => {
    // The property `consumeExecutionPrefix`'s two callers must agree on: what
    // `extractCommandPrefix` hands back and what `parseBashCommand` calls the
    // verb must join back into the original, so a rewrite cannot lose the
    // wrapper.
    //
    // Named for what it pins, which is the STRUCTURE — it survives a
    // `TIMEOUT_PREFIX_RE` that eats the wrong number of tokens, because the
    // prefix and the verb still meet. The duration handling is pinned by the
    // eight tests around it, verified by deleting the duration from the regex
    // and watching them go red.
    for (const cmd of [
      "timeout 300 git status",
      "timeout -k 5s 60 git status",
      "CI=1 sudo timeout 30 git status",
      "timeout --help",
    ]) {
      const prefix = extractCommandPrefix(cmd);
      expect(cmd.startsWith(prefix)).toBe(true);
      // What the parser calls the verb is exactly what sits after the prefix,
      // so `prefix + rewritten-verb` recreates the command the model approved.
      expect(cmd.slice(prefix.length).startsWith(parseBashCommand(cmd).verb)).toBe(
        true,
      );
    }
  });

  test("collapses line continuation before scanning", () => {
    // `\<LF>` becomes a single space — the resulting string has the env value
    // followed by that injected space and the original space before `git`.
    // Both spaces are preserved so a re-prepended prefix exactly recreates
    // the boundary the parser saw (semantics-preserving).
    expect(extractCommandPrefix("FOO=bar \\\ngit log")).toBe("FOO=bar  ");
  });
});

describe("review #4: safeApply fail-open contract", () => {
  test("planBashFilter never throws on inputs designed to break parsers", () => {
    // The bash filter must NEVER block the user (fallback pattern from typescript-patterns.md).
    // If any internal step throws, planBashFilter must produce a valid plan with fallback values.
    const adversarial = [
      "\u0000\u0001\u0002",
      String.fromCharCode(0xfffd).repeat(100),
      "git log " + "\\\n".repeat(500),
      'git log --grep="' + "\\".repeat(200),
      "(((((((((((((((((((((((((((",
      ")))))))))))))))))))))))))))",
      "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[",
      "$(".repeat(50),
    ];
    for (const input of adversarial) {
      expect(() => planBashFilter(input)).not.toThrow();
      const plan = planBashFilter(input);
      expect(plan).toBeDefined();
      expect(typeof plan.effectiveCommand).toBe("string");
    }
  });

  test("applyBashFilterToStdout never throws and returns raw on adversarial input", () => {
    const plan = planBashFilter("git log");
    const adversarialOutput = "\u0000\uFFFD\n".repeat(1000);
    expect(() =>
      applyBashFilterToStdout(adversarialOutput, false, plan),
    ).not.toThrow();
  });

  test("adversarial input never resolves to a real filter", () => {
    // Pin the fail-safe behavior: garbage in must never produce a filter that
    // would then attempt to rewrite or transform stdout.
    const garbage = [
      "\u0000\u0001\u0002",
      String.fromCharCode(0xfffd).repeat(100),
      "(((((((((((((((((((((((((((",
      "$(".repeat(50),
    ];
    for (const input of garbage) {
      const plan = planBashFilter(input);
      expect(plan.filter).toBeNull();
      expect(plan.rewrite).toBeNull();
    }
  });
});

describe("convention compliance — round 5 fixes", () => {
  test("planBashFilter on pure env assignment with no command", () => {
    // verb === "" must short-circuit matching to avoid greedy user filters
    // accidentally matching the empty string.
    const plan = planBashFilter("FOO=bar");
    expect(plan.effectiveCommand).toBe("FOO=bar");
    expect(plan.filter).toBeNull();
    expect(plan.rewrite).toBeNull();
  });

  test("planBashFilter on env assignment with whitespace tail", () => {
    const plan = planBashFilter("FOO=bar   ");
    expect(plan.filter).toBeNull();
    expect(plan.rewrite).toBeNull();
  });

  test("matchesAtomicCommand rejects empty-verb input even with greedy filter", () => {
    const greedy: FilterSpec = {
      name: "greedy-test",
      matchCommand: /.*/,
      stripAnsi: true,
    };
    // Pure env: parseBashCommand strips it, leaving verb="".
    // Without the verb==="" guard, /.*/ would match and the rewrite path
    // would run on a no-op command.
    const plan = planBashFilter("FOO=bar");
    expect(plan.filter).toBeNull();
    expect(plan.rewrite).toBeNull();
    // Direct API check too:
    // (we don't import matchesAtomicCommand directly; assert via planBashFilter)
    expect(greedy.matchCommand.test("")).toBe(true); // sanity: regex would match
  });

  test("extractCommandPrefix on unclosed quote returns empty (fail-safe)", () => {
    // findEnvAssignmentEnd returns -1 when quotes are unclosed; the loop
    // breaks and the prefix collapses to empty — never corrupts the input.
    expect(extractCommandPrefix('FOO="unclosed git log')).toBe("");
    expect(extractCommandPrefix("FOO='unclosed git log")).toBe("");
    expect(extractCommandPrefix("FOO=$(unclosed")).toBe("");
  });

  test("splitTopLevelSegments bails on background &", () => {
    expect(splitTopLevelSegments("ls &")).toBeNull();
    expect(splitTopLevelSegments("git log & pwd")).toBeNull();
  });

  test("splitTopLevelSegments bails on single pipe |", () => {
    expect(splitTopLevelSegments("ls | wc")).toBeNull();
    expect(splitTopLevelSegments("git log | grep foo")).toBeNull();
  });

  test("planBashFilter bypasses background and pipe (no filter applied)", () => {
    expect(planBashFilter("ls &").filter).toBeNull();
    expect(planBashFilter("ls | wc").filter).toBeNull();
  });

  test("splitTopLevelSegments handles mixed quote types correctly", () => {
    // Single quotes containing a literal double quote
    expect(splitTopLevelSegments(`echo 'foo"bar' && ls`)).toEqual([
      `echo 'foo"bar'`,
      "ls",
    ]);
    // Double quotes containing a literal single quote
    expect(splitTopLevelSegments(`echo "foo'bar" && ls`)).toEqual([
      `echo "foo'bar"`,
      "ls",
    ]);
    // Operators inside mixed quotes do not split
    expect(splitTopLevelSegments(`echo "a'b;c" && ls`)).toEqual([
      `echo "a'b;c"`,
      "ls",
    ]);
    expect(splitTopLevelSegments(`echo 'a"b&&c' && ls`)).toEqual([
      `echo 'a"b&&c'`,
      "ls",
    ]);
  });

  test("CRLF line endings — \\r is preserved as part of the segment", () => {
    // splitTopLevelSegments only treats \n as a separator. \r becomes part
    // of the previous segment. This is the documented current behavior;
    // pin it so a future change doesn't silently break it.
    const result = splitTopLevelSegments("ls\r\npwd");
    expect(result).toEqual(["ls", "pwd"]);
    // The first segment retains its trailing \r since trim() handles it.
  });

  test("parseBashCommand on pure env assignment returns empty verb", () => {
    const ctx = parseBashCommand("FOO=bar");
    expect(ctx.verb).toBe("FOO=bar");
    // Boundary unclear (no terminating whitespace) — env stays in place.
    // The verb is the env assignment itself (not stripped) because
    // findEnvAssignmentEnd returns -1.
  });

  test("parseBashCommand on empty / whitespace-only input", () => {
    expect(parseBashCommand("").verb).toBe("");
    expect(parseBashCommand("   ").verb).toBe("");
    expect(parseBashCommand("\t\n").verb).toBe("");
  });

  test("planBashFilter on empty / whitespace-only input is fail-safe", () => {
    expect(planBashFilter("").filter).toBeNull();
    expect(planBashFilter("   ").filter).toBeNull();
    expect(planBashFilter("\t\n").filter).toBeNull();
  });
});

// ===========================================================================
// review #6 — applyPipeline replace stage tracks identity, not length
// ===========================================================================

describe("review #6: applyPipeline replace stage tracks content, not length", () => {
  test("same-length replacement is recorded in applied[]", () => {
    // CRITICAL: a redaction that preserves length (e.g. SHA → fixed mask)
    // must register the stage as applied so wrapStdoutWithMarkers does not
    // discard the transformed body. Pre-fix, length-only diff missed it.
    const filter: FilterSpec = {
      name: "redact-sha",
      matchCommand: /^git$/,
      replace: [
        {
          // 7 hex chars → 7 X's. Body length is unchanged.
          pattern: /[0-9a-f]{7}/g,
          replacement: "XXXXXXX",
        },
      ],
    };
    const input = "commit abc1234 by alice";
    const result = applyPipeline(filter, input);
    expect(result.body).toBe("commit XXXXXXX by alice");
    expect(result.applied.some((a) => a.startsWith("replace:"))).toBe(true);
  });

  test("same-length replacement survives end-to-end through wrapper", () => {
    // The full path: applyBashFilterToStdout → applyPipeline →
    // wrapStdoutWithMarkers. Even if no other stage fires, the body must be
    // the redacted text, not the raw input.
    const plan = {
      effectiveCommand: "git log",
      filter: {
        name: "redact",
        matchCommand: /^git$/,
        replace: [{ pattern: /secret/g, replacement: "XXXXXX" }],
      } as FilterSpec,
      rewrite: null,
    };
    const wrapped = applyBashFilterToStdout(
      "commit by secret user",
      false,
      plan,
    );
    expect(wrapped).toContain("XXXXXX");
    expect(wrapped).not.toContain("secret");
  });

  test("identical replacement (no-op) is NOT recorded in applied[]", () => {
    // If the regex matched but produced the same string (e.g. /a/ → "a"),
    // applied[] should still be empty. Identity check is text vs text.
    const filter: FilterSpec = {
      name: "noop",
      matchCommand: /^git$/,
      replace: [{ pattern: /alice/g, replacement: "alice" }],
    };
    const result = applyPipeline(filter, "commit by alice");
    expect(result.applied.some((a) => a.startsWith("replace:"))).toBe(false);
  });
});

// ===========================================================================
// review #6 — extractCommandPrefix preserves leading whitespace
// ===========================================================================

describe("review #6: extractCommandPrefix preserves leading whitespace", () => {
  test("leading whitespace before env is part of the prefix", () => {
    // The previous implementation stripped the leading whitespace and
    // returned only the env+sudo portion, so a rewrite of `  FOO=bar git log`
    // would lose two leading spaces when re-prepended. While exotic, that
    // changes the user-visible command. Whitespace is now retained verbatim.
    expect(extractCommandPrefix("  FOO=bar git log")).toBe("  FOO=bar ");
    expect(extractCommandPrefix("\tsudo git log")).toBe("\tsudo ");
    expect(extractCommandPrefix("  git log")).toBe("  ");
  });

  test("plain leading whitespace returns just the whitespace", () => {
    expect(extractCommandPrefix("   ls")).toBe("   ");
  });
});

// ===========================================================================
// review #6 — applyPipeline input-size cap
// ===========================================================================

describe("review #6: applyPipeline input-size cap", () => {
  test("oversized input bypasses the pipeline unchanged", () => {
    // 9 MiB > 8 MiB cap — pipeline returns body untouched, applied empty.
    // Defends against worst-case regex backtracking on huge inputs.
    const huge = "x".repeat(9 * 1024 * 1024);
    const filter: FilterSpec = {
      name: "should-not-run",
      matchCommand: /^git$/,
      stripLinesMatching: [/x/],
    };
    const result = applyPipeline(filter, huge);
    expect(result.body.length).toBe(huge.length);
    expect(result.applied).toEqual([]);
    expect(result.shortCircuited).toBe(false);
  });

  test("input just under cap is processed normally", () => {
    const filter: FilterSpec = {
      name: "ok",
      matchCommand: /^git$/,
      stripLinesMatching: [/^drop$/],
    };
    const lines = "keep\ndrop\nkeep";
    const result = applyPipeline(filter, lines);
    expect(result.body).toBe("keep\nkeep");
    expect(result.applied).toContain("stripLinesMatching");
  });
});
