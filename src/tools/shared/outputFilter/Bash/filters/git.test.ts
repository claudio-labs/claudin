// git family — log, status, blame, pull, add, commit, push, diff, show,
// fetch, branch, stash and worktree.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadSample,
  runFilterBody,
  assertReduction,
  findFilterForCommand,
  SAMPLES_DIR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import { applyBashFilterToStdout, planBashFilter } from "src/tools/shared/outputFilter/Bash/index.js";

// ---------------------------------------------------------------------------
// Phase 6.1.4 — git rewrite specs
// ---------------------------------------------------------------------------

describe("phase 6.1.4 — gitLog", () => {
  test("rewrite: git log → git log --oneline", () => {
    const plan = planBashFilter("git log");
    expect(plan.rewrite?.to).toBe("git log --oneline");
  });

  test("rewrite: git log src/foo.ts → forwards path", () => {
    const plan = planBashFilter("git log src/foo.ts");
    expect(plan.rewrite?.to).toBe("git log --oneline src/foo.ts");
  });

  test("rewrite: git log --author=alice → forwards flag", () => {
    const plan = planBashFilter("git log --author=alice");
    expect(plan.rewrite?.to).toBe("git log --oneline --author=alice");
  });

  test("no rewrite when --oneline already present", () => {
    const plan = planBashFilter("git log --oneline");
    expect(plan.rewrite).toBeNull();
    expect(plan.filter).toBeNull();
  });

  test("no rewrite when --format= present", () => {
    expect(planBashFilter('git log --format="%H"').rewrite).toBeNull();
  });

  test("no rewrite when --pretty= present", () => {
    expect(planBashFilter("git log --pretty=oneline").rewrite).toBeNull();
  });

  test("no rewrite when --pretty <fmt> present (no equals)", () => {
    expect(planBashFilter("git log --pretty oneline").rewrite).toBeNull();
    expect(planBashFilter("git log --pretty format:'%h %s'").rewrite).toBeNull();
  });

  test("no rewrite when --pretty at end of string (no arg)", () => {
    expect(planBashFilter("git log --pretty").rewrite).toBeNull();
  });

  test("no rewrite when -p (patch) present", () => {
    expect(planBashFilter("git log -p").rewrite).toBeNull();
  });

  test("no rewrite when --patch present", () => {
    expect(planBashFilter("git log --patch").rewrite).toBeNull();
  });

  test("no rewrite for single-digit -N flag: git log -5", () => {
    expect(planBashFilter("git log -5").rewrite).toBeNull();
    expect(planBashFilter("git log -5").filter).toBeNull();
  });

  test("rewrite fires for multi-digit -10 (not single-digit)", () => {
    const plan = planBashFilter("git log -10");
    expect(plan.rewrite?.to).toBe("git log --oneline -10");
  });

  test("chain resolves: git log && echo done applies git-log filter", () => {
    // The trailing `echo done` has no filter of its own, so the chain
    // resolves to `git-log` (no conflict). Rewriting is suppressed for
    // chains because rewrite would only mutate the `git log` segment.
    const plan = planBashFilter("git log && echo done");
    expect(plan.filter?.name).toBe("git-log");
    expect(plan.rewrite).toBeNull();
  });

  test("match: git-log spec claims 'git log'", () => {
    expect(findFilterForCommand("git log")?.name).toBe("git-log");
  });

  test("ROI: git-log-default sample — rewrite fires and maxLines trims", () => {
    const raw = loadSample("git-log-default");
    const plan = planBashFilter("git log");
    expect(plan.rewrite?.to).toBe("git log --oneline");
    expect(() => applyBashFilterToStdout(raw, false, plan)).not.toThrow();
  });

  test("ROI: git-log-oneline sample — passthrough (no rewrite)", () => {
    const raw = loadSample("git-log-oneline");
    const plan = planBashFilter("git log --oneline");
    expect(plan.rewrite).toBeNull();
    expect(applyBashFilterToStdout(raw, false, plan)).toBe(raw);
  });
});

describe("phase 6.1.4 — gitStatus", () => {
  test("rewrite: git status → git status --porcelain --branch", () => {
    const plan = planBashFilter("git status");
    expect(plan.rewrite?.to).toBe("git status --porcelain --branch");
  });

  test("no rewrite when --porcelain already present", () => {
    const plan = planBashFilter("git status --porcelain");
    expect(plan.rewrite).toBeNull();
    expect(plan.filter).toBeNull();
  });

  test("no rewrite when --short present", () => {
    expect(planBashFilter("git status --short").rewrite).toBeNull();
  });

  test("no rewrite when -s present", () => {
    expect(planBashFilter("git status -s").rewrite).toBeNull();
  });

  test("no rewrite when combined -sb flag present", () => {
    expect(planBashFilter("git status -sb").rewrite).toBeNull();
    expect(planBashFilter("git status -su").rewrite).toBeNull();
  });

  test("no rewrite when combined -suno / -suall flags present", () => {
    expect(planBashFilter("git status -suno").rewrite).toBeNull();
    expect(planBashFilter("git status -suall").rewrite).toBeNull();
  });

  test("chained: git status || true resolves to git-status (only matching segment)", () => {
    const plan = planBashFilter("git status || true");
    expect(plan.filter?.name).toBe("git-status");
    // Rewrite is skipped on compound commands to avoid mangling adjacent segments.
    expect(plan.rewrite).toBeNull();
  });

  test("match: git-status spec claims 'git status'", () => {
    expect(findFilterForCommand("git status")?.name).toBe("git-status");
  });

  test("ROI: git-status sample passes through without crashing", () => {
    const raw = loadSample("git-status");
    const plan = planBashFilter("git status");
    expect(plan.rewrite?.to).toBe("git status --porcelain --branch");
    expect(() => applyBashFilterToStdout(raw, false, plan)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 6.1.5 — git pipeline-only specs
// ---------------------------------------------------------------------------

describe("phase 6.1.5 — gitBlame", () => {
  test("ROI: git-blame sample ≥20% reduction", () => {
    assertReduction("git-blame", "git blame README.md", "git-blame", 20);
  });

  test("match: git blame README.md", () => {
    expect(findFilterForCommand("git blame README.md")?.name).toBe("git-blame");
  });

  test("match: git blame -w src/foo.ts", () => {
    expect(findFilterForCommand("git blame -w src/foo.ts")?.name).toBe("git-blame");
  });

  test("reject: git blame --porcelain", () => {
    expect(findFilterForCommand("git blame --porcelain README.md")).toBeNull();
  });

  test("reject: git blame -p", () => {
    expect(findFilterForCommand("git blame -p README.md")).toBeNull();
  });

  test("strips author+timezone, keeps hash+date+line", () => {
    const raw = "^b8dc2bb (Viudes 2026-04-29 18:08:59 -0300   1) # Claudin\n23551ecd (Viudes 2026-05-02 11:28:25 -0300   3) Coding agent\n";
    const body = runFilterBody("git-blame", "git blame README.md", raw);
    expect(body).toContain("^b8dc2bb");
    expect(body).toContain("2026-04-29");
    expect(body).not.toContain("18:08:59");
    expect(body).not.toContain("-0300");
    expect(body).not.toContain("Viudes");
  });

  test("strips author+timezone with full 40-char hash (--abbrev=40)", () => {
    const hash = "a3f8c9d1e2b4f6a7c8d9e0f1a2b3c4d5e6f7a8b9";
    const raw = `${hash} (Viudes 2026-05-01 10:00:00 +0000   5) full hash line\n`;
    const body = runFilterBody("git-blame", "git blame --abbrev=40 README.md", raw);
    expect(body).toContain(hash);
    expect(body).toContain("2026-05-01");
    expect(body).not.toContain("10:00:00");
    expect(body).not.toContain("Viudes");
  });
});

describe("phase 6.1.5 — gitPull", () => {
  test("ROI: git-pull-synthetic sample ≥40% reduction", () => {
    assertReduction("git-pull", "git pull", "git-pull-synthetic", 40);
  });

  test("match: git pull", () => {
    expect(findFilterForCommand("git pull")?.name).toBe("git-pull");
  });

  test("match: git pull origin main", () => {
    expect(findFilterForCommand("git pull origin main")?.name).toBe("git-pull");
  });

  test("reject: git pull --dry-run", () => {
    expect(findFilterForCommand("git pull --dry-run")).toBeNull();
  });

  test("reject: git pull --no-ff", () => {
    expect(findFilterForCommand("git pull --no-ff")).toBeNull();
  });

  test("matchOutput: already up to date collapses", () => {
    const raw = "Already up to date.\n";
    const body = runFilterBody("git-pull", "git pull", raw);
    expect(body).toBe("✓ git pull: already up to date");
  });

  test("matchOutput: already up to date with error → passthrough", () => {
    const raw = "Already up to date.\nerror: conflict\n";
    const body = runFilterBody("git-pull", "git pull", raw);
    expect(body).not.toBe("✓ git pull: already up to date");
    expect(body).toContain("error: conflict");
  });

  test("strips remote: progress noise, keeps From/Updating/Fast-forward", () => {
    const raw = [
      "remote: Enumerating objects: 47, done.",
      "remote: Counting objects: 100% (47/47), done.",
      "remote: Compressing objects: 100% (25/25), done.",
      "remote: Total 29 (delta 18), reused 0 (delta 0), pack-reused 0",
      "Unpacking objects: 100% (29/29), 4.32 KiB | 1.08 MiB/s, done.",
      "From git.server:owner/repo",
      "   3c1ce42..bb98dbf  main       -> origin/main",
      "Updating 3c1ce42..bb98dbf",
      "Fast-forward",
      " src/foo.ts | 12 ++++++++----",
      " 3 files changed, 11 insertions(+), 6 deletions(-)",
    ].join("\n") + "\n";
    const body = runFilterBody("git-pull", "git pull", raw);
    expect(body).not.toContain("Enumerating objects");
    expect(body).not.toContain("Unpacking objects");
    expect(body).toContain("From git.server");
    expect(body).toContain("Fast-forward");
    expect(body).toContain("3 files changed");
  });
});

describe("phase 6.1.5 — gitAdd", () => {
  test("match: git add .", () => {
    expect(findFilterForCommand("git add .")?.name).toBe("git-add");
  });

  test("match: git add --dry-run docs/", () => {
    expect(findFilterForCommand("git add --dry-run docs/")?.name).toBe("git-add");
  });

  test("reject: git add -i (interactive)", () => {
    expect(findFilterForCommand("git add -i")).toBeNull();
  });

  test("reject: git add --interactive", () => {
    expect(findFilterForCommand("git add --interactive")).toBeNull();
  });

  test("reject: git add -p (patch)", () => {
    expect(findFilterForCommand("git add -p")).toBeNull();
  });

  test("reject: git add --patch", () => {
    expect(findFilterForCommand("git add --patch")).toBeNull();
  });

  test("caps dry-run output at 30 lines", () => {
    const raw = Array.from({ length: 50 }, (_, i) => `add 'src/file${i}.ts'`).join("\n") + "\n";
    const body = runFilterBody("git-add", "git add --dry-run .", raw);
    const lines = body.split("\n").filter((l) => l.startsWith("add "));
    expect(lines.length).toBeLessThanOrEqual(30);
  });
});

describe("phase 6.1.5 — gitCommit", () => {
  test("match: git commit -m 'msg'", () => {
    expect(findFilterForCommand("git commit -m 'fix: something'")?.name).toBe("git-commit");
  });

  test("match: git commit --amend", () => {
    expect(findFilterForCommand("git commit --amend")?.name).toBe("git-commit");
  });

  test("reject: git commit --dry-run", () => {
    expect(findFilterForCommand("git commit --dry-run")).toBeNull();
  });

  test("matchOutput: success collapses to committed message with hash", () => {
    const raw = "[main a3f8c9d] fix: something\n 7 files changed, 30 insertions(+), 4 deletions(-)\n";
    const body = runFilterBody("git-commit", "git commit -m 'fix: something'", raw);
    expect(body.trim()).toBe("✓ committed a3f8c9d");
  });

  test("matchOutput: nothing to commit collapses", () => {
    const raw = "On branch main\nnothing to commit, working tree clean\n";
    const body = runFilterBody("git-commit", "git commit", raw);
    expect(body).toBe("✓ nothing to commit");
  });

  test("matchOutput: hook failure → passthrough (error keyword)", () => {
    const raw = "husky - pre-commit hook exited with code 1 (error)\n✗ ESLint failed\n";
    const body = runFilterBody("git-commit", "git commit -m 'msg'", raw);
    expect(body).toContain("hook exited");
    expect(body).not.toBe("✓ committed");
  });

  test("passthrough: gpg failure (non-indented line)", () => {
    const raw = "[main a3f8c9d] fix: something\ngpg failed to sign the data\n";
    const body = runFilterBody("git-commit", "git commit -S -m 'fix'", raw);
    expect(body).toContain("gpg failed");
    expect(body).not.toContain("✓ committed");
  });

  test("passthrough: indented error line after hash (was blocker)", () => {
    // GIT_COMMIT_SUCCESS_RE captures indented lines via (?:\n[ \t][^\n]*)* —
    // without the `unless` guard the replace would swallow the error and return
    // "✓ committed a3f8c9d", hiding the failure from the agent.
    const raw =
      "[main a3f8c9d] fix: something\n\terror: failed to write commit object\n";
    const body = runFilterBody("git-commit", "git commit -m 'fix'", raw);
    expect(body).toContain("error: failed to write commit object");
    expect(body).not.toContain("✓ committed");
  });

  test("passthrough: rejected → passthrough", () => {
    const raw = "[main a3f8c9d] fix: something\nerror: rejected by server\n";
    const body = runFilterBody("git-commit", "git commit -m 'fix'", raw);
    expect(body).toContain("rejected by server");
    expect(body).not.toContain("✓ committed");
  });
});

describe("phase 6.1.5 — gitPush", () => {
  test("match: git push", () => {
    expect(findFilterForCommand("git push")?.name).toBe("git-push");
  });

  test("match: git push origin main", () => {
    expect(findFilterForCommand("git push origin main")?.name).toBe("git-push");
  });

  test("match: git push -u origin feature/foo", () => {
    expect(findFilterForCommand("git push -u origin feature/foo")?.name).toBe("git-push");
  });

  test("reject: git push --dry-run", () => {
    expect(findFilterForCommand("git push --dry-run")).toBeNull();
  });

  test("matchOutput: Everything up-to-date collapses", () => {
    const raw = "Everything up-to-date\n";
    const body = runFilterBody("git-push", "git push", raw);
    expect(body).toBe("✓ push: up-to-date");
  });

  test("strips transfer protocol noise, preserves remote: lines and To line", () => {
    const raw = [
      "Enumerating objects: 47, done.",
      "Counting objects: 100% (47/47), done.",
      "Delta compression using up to 8 threads",
      "Compressing objects: 100% (25/25), done.",
      "Writing objects: 100% (29/29), 4.32 KiB | 4.32 MiB/s, done.",
      "Total 29 (delta 18), reused 0 (delta 0), pack-reused 0",
      "remote: Resolving deltas: 100% (18/18), completed with 11 local objects.",
      "remote:",
      "remote: Create a pull request for 'feature/foo' on GitHub by visiting:",
      "remote:      https://github.com/owner/repo/pull/new/feature/foo",
      "remote:",
      "To github.com:owner/repo.git",
      " * [new branch]      feature/foo -> feature/foo",
    ].join("\n") + "\n";
    const body = runFilterBody("git-push", "git push", raw);
    expect(body).not.toContain("Enumerating objects");
    expect(body).not.toContain("Counting objects");
    expect(body).not.toContain("Compressing objects");
    expect(body).not.toContain("Writing objects");
    expect(body).toContain("https://github.com/owner/repo/pull/new/feature/foo");
    expect(body).toContain("To github.com:owner/repo.git");
    expect(body).toContain("* [new branch]");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.2 — git diff / git show
// ---------------------------------------------------------------------------

describe("phase 6.2 — gitDiff", () => {
  test("ROI: git-diff sample ≥5% reduction (strip diff/index/noeol)", () => {
    assertReduction("git-diff", "git diff", "git-diff", 5);
  });
  test("match: git diff, git diff <file>", () => {
    expect(findFilterForCommand("git diff")?.name).toBe("git-diff");
    expect(findFilterForCommand("git diff HEAD~1 src/foo.ts")?.name).toBe("git-diff");
  });
  test("reject: --stat / --name-only / --check passthrough", () => {
    expect(findFilterForCommand("git diff --stat")).toBeNull();
    expect(findFilterForCommand("git diff --name-only")).toBeNull();
    expect(findFilterForCommand("git diff --check")).toBeNull();
  });
  test("hunks (@@…) and ± lines are preserved", () => {
    const raw = loadSample("git-diff");
    const body = runFilterBody("git-diff", "git diff", raw);
    expect(body).toMatch(/^@@/m);
    expect(body).toMatch(/^\+import\s/m);
    expect(body).toMatch(/^-/m);
  });
  test("index <hash>..<hash> lines are stripped", () => {
    const raw = loadSample("git-diff");
    const body = runFilterBody("git-diff", "git diff", raw);
    expect(body).not.toMatch(/^index\s+[0-9a-f]/m);
  });
  test("`diff --git` header is stripped (redundant with --- a/X / +++ b/X)", () => {
    const raw = loadSample("git-diff");
    const body = runFilterBody("git-diff", "git diff", raw);
    expect(body).not.toMatch(/^diff --git/m);
    expect(body).toMatch(/^--- a\//m);
    expect(body).toMatch(/^\+\+\+ b\//m);
  });
});

describe("phase 6.2 — gitShow", () => {
  test("ROI: git-show-full sample ≥5% reduction", () => {
    assertReduction("git-show", "git show HEAD", "git-show-full", 5);
  });
  test("match: git show, git show HEAD, git show <sha>", () => {
    expect(findFilterForCommand("git show")?.name).toBe("git-show");
    expect(findFilterForCommand("git show HEAD")?.name).toBe("git-show");
    expect(findFilterForCommand("git show abc1234")?.name).toBe("git-show");
  });
  test("reject: --stat / --no-patch / -s passthrough", () => {
    expect(findFilterForCommand("git show --stat")).toBeNull();
    expect(findFilterForCommand("git show --no-patch")).toBeNull();
    expect(findFilterForCommand("git show -s HEAD")).toBeNull();
  });

  // `git status --porcelain && git diff` resolves to a git filter — `--porcelain`
  // opts the status half out, so the two segments do not disagree — and it is
  // among the largest recorded Bash results. The diff renderer only ever sees
  // the text from the first diff header onwards, so the other segment's output
  // is spliced back verbatim instead of being swallowed by a stat table.
  test("a compound command keeps the segment that ran before the diff", () => {
    const porcelain = [
      " M src/tools/BashTool/BashTool.tsx",
      "?? src/tools/shared/outputFilter/Bash/floor.ts",
      "",
    ].join("\n");
    // Long enough to pass DIFF_PIVOT_CHARS, so the diff half really is replaced.
    const hunks = Array.from({ length: 40 }, (_, i) =>
      [
        `diff --git a/src/f${i}.ts b/src/f${i}.ts`,
        "index 1111111..2222222 100644",
        `--- a/src/f${i}.ts`,
        `+++ b/src/f${i}.ts`,
        "@@ -1,4 +1,4 @@",
        " const keep = true",
        `-const value = ${i}`,
        `+const value = ${i + 1}`,
        " const tail = true",
      ].join("\n"),
    ).join("\n");
    const raw = `${porcelain}${hunks}\n`;
    const command = "git status --porcelain && git diff";
    expect(findFilterForCommand(command)?.name).toBe("git-diff");
    const body = runFilterBody("git-diff", command, raw);
    expect(body).toContain(" M src/tools/BashTool/BashTool.tsx");
    expect(body).toContain("?? src/tools/shared/outputFilter/Bash/floor.ts");
    expect(body).toContain("src/f0.ts");
    expect(body.length).toBeLessThan(raw.length);
  });

  test("a body with no diff in it is declined, not mangled", () => {
    const raw = " M src/a.ts\n?? src/b.ts\n";
    expect(runFilterBody("git-diff", "git diff", raw)).toBe(raw);
  });
  // The commit header is spliced back verbatim — it sits above the first
  // `diff --git`, and renderDiff only ever sees the tail. What replaces the
  // hunks depends on size: this sample is ~10 KB, past DIFF_PIVOT_CHARS, so it
  // pivots to the stat table that names how to fetch a file's hunks back.
  test("commit header survives; an over-pivot diff body becomes the stat table", () => {
    const raw = loadSample("git-show-full");
    const body = runFilterBody("git-show", "git show HEAD", raw);
    expect(body).toContain("commit a200d7d5");
    expect(body).toContain("retry transient 404s");
    expect(body).not.toMatch(/^@@/m);
    expect(body).toContain("git diff --");
    expect(body.length).toBeLessThan(raw.length);
  });

  // Below the pivot, renderDiff declines rather than re-render: stripping
  // context the model can simply read is not a saving. Hunks stay.
  test("a diff small enough to read keeps its hunks", () => {
    const raw = [
      "commit deadbeef",
      "Author: Dev <dev@example.com>",
      "Date:   Mon Jan 1 00:00:00 2026 +0000",
      "",
      "    tweak one line",
      "",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1",
      "-const b = 2",
      "+const b = 3",
      " const c = 4",
      "",
    ].join("\n");
    const body = runFilterBody("git-show", "git show HEAD", raw);
    expect(body).toContain("commit deadbeef");
    expect(body).toMatch(/^@@/m);
    expect(body).toContain("+const b = 3");
  });
  test("Author + Date pair is collapsed to single line", () => {
    const raw = loadSample("git-show-full");
    const body = runFilterBody("git-show", "git show HEAD", raw);
    // Original has two separate Author / Date lines; collapsed form is "Author: Name (Date)".
    const authorLines = body.match(/^Author:/gm) ?? [];
    const dateLines = body.match(/^Date:/gm) ?? [];
    expect(authorLines.length).toBe(1);
    expect(dateLines.length).toBe(0);
  });
});

// ===========================================================================
// Phase 12.3 — Git extras + alternative VCS (rtk gap-fill).
// ===========================================================================

describe("phase 12.3 — git-fetch", () => {
  test("ROI: progress-bearing fetch reduces ≥ 95% via remote: / Receiving / Resolving strip", () => {
    assertReduction(
      "git-fetch",
      "git fetch --progress origin main",
      "git-fetch",
      95,
    );
  });

  test("safety: ref-update table is preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "git-fetch.txt"), "utf8");
    const body = runFilterBody("git-fetch", "git fetch", raw);
    expect(body).toContain("From https://github.com/nodejs/node");
    expect(body).toContain("FETCH_HEAD");
    expect(body).toContain("origin/main");
  });

  test("match: git fetch ✓; --porcelain rejects", () => {
    expect(findFilterForCommand("git fetch")?.name).toBe("git-fetch");
    expect(findFilterForCommand("git fetch origin")?.name).toBe("git-fetch");
    expect(findFilterForCommand("git fetch --porcelain")?.name).not.toBe(
      "git-fetch",
    );
  });
});

describe("phase 12.3 — git-branch", () => {
  test("safety: branch listing preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "git-branch-a.txt"), "utf8");
    const body = runFilterBody("git-branch", "git branch -a", raw);
    expect(body).toContain("main");
    expect(body).toContain("remotes/origin/main");
  });

  test("match: git branch / -a / -r / -vv ✓; -d (delete) rejects", () => {
    expect(findFilterForCommand("git branch")?.name).toBe("git-branch");
    expect(findFilterForCommand("git branch -a")?.name).toBe("git-branch");
    expect(findFilterForCommand("git branch -r")?.name).toBe("git-branch");
    expect(findFilterForCommand("git branch -vv")?.name).toBe("git-branch");
    expect(findFilterForCommand("git branch -d feature")?.name).not.toBe(
      "git-branch",
    );
    expect(findFilterForCommand("git branch -m newname")?.name).not.toBe(
      "git-branch",
    );
  });
});

describe("phase 12.3 — git-stash", () => {
  test("safety: stash entries preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "git-stash.txt"), "utf8");
    const body = runFilterBody("git-stash", "git stash list", raw);
    expect(body).toContain("stash@{0}");
    expect(body).toContain("stash@{4}");
  });

  test("match: list/show/pop/apply/drop/clear ✓; bare 'git stash' (= push) not matched", () => {
    expect(findFilterForCommand("git stash list")?.name).toBe("git-stash");
    expect(findFilterForCommand("git stash show stash@{0}")?.name).toBe(
      "git-stash",
    );
    expect(findFilterForCommand("git stash pop")?.name).toBe("git-stash");
    expect(findFilterForCommand("git stash apply")?.name).toBe("git-stash");
    expect(findFilterForCommand("git stash drop stash@{1}")?.name).toBe(
      "git-stash",
    );
    expect(findFilterForCommand("git stash clear")?.name).toBe("git-stash");
    expect(findFilterForCommand("git stash")?.name).not.toBe("git-stash");
  });
});

describe("phase 12.3 — git-worktree", () => {
  test("safety: worktree entries preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "git-worktree-list.txt"),
      "utf8",
    );
    const body = runFilterBody("git-worktree", "git worktree list", raw);
    expect(body).toContain("/home/devusr/projects/claudin");
  });

  test("match: git worktree list ✓; --porcelain rejects; add/remove not matched", () => {
    expect(findFilterForCommand("git worktree list")?.name).toBe("git-worktree");
    expect(findFilterForCommand("git worktree list --porcelain")?.name).not.toBe(
      "git-worktree",
    );
    expect(findFilterForCommand("git worktree add ../foo")?.name).not.toBe(
      "git-worktree",
    );
  });
});
