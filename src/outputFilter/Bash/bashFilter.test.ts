/**
 * Bash Output Filter — integration harness tests
 *
 * These tests are ported from docs/discovery/bash-output-filter/validation/validate.ts.
 * They are all test.skip() because builtInFilters is empty in Phase 1.
 * Phase 2 will unskip them as filters land.
 */
import { describe, expect, test } from "bun:test";
import { applyBashFilterToStdout, planBashFilter } from "./index.js";
import { findFilterForCommand } from "./registry.js";

// ---------------------------------------------------------------------------
// Structural tests (run immediately, don't depend on filters)
// ---------------------------------------------------------------------------

describe("structural (Phase 1)", () => {
  test("module loads without error", () => {
    expect(planBashFilter).toBeDefined();
    expect(applyBashFilterToStdout).toBeDefined();
  });

  test("findFilterForCommand returns null when no filters", () => {
    expect(findFilterForCommand("npm install")).toBeNull();
  });

  test("planBashFilter returns no-op plan when no filters", () => {
    const plan = planBashFilter("npm install");
    expect(plan.filter).toBeNull();
    expect(plan.rewrite).toBeNull();
    expect(plan.effectiveCommand).toBe("npm install");
  });

  test("applyBashFilterToStdout returns raw output when no filter", () => {
    const plan = planBashFilter("npm install");
    const result = applyBashFilterToStdout("some output", false, plan);
    expect(result).toBe("some output");
  });

  test("applyBashFilterToStdout returns empty string for empty input", () => {
    const plan = planBashFilter("npm install");
    const result = applyBashFilterToStdout("", false, plan);
    expect(result).toBe("");
  });

  test("applyBashFilterToStdout passes through whitespace-only input without marker", () => {
    // Filter matches but output is whitespace-only — no useful body to wrap.
    const filter = { name: "test", matchCommand: /^npm$/, stripAnsi: true };
    const plan = { effectiveCommand: "npm install", filter, rewrite: null };
    const ws = "   \n  \n";
    const result = applyBashFilterToStdout(ws, false, plan);
    expect(result).not.toContain("<bash-output-filtered");
    expect(result).not.toContain("<bash-output-rewritten");
  });

  test("module init + first filter lookup completes under 50ms", async () => {
    const start = performance.now();
    const mod = await import("./index.js");
    mod.planBashFilter("git status");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  test("applyBashFilterToStdout passes through error output", () => {
    const filter = { name: "test", matchCommand: /^npm$/ };
    const plan = { effectiveCommand: "npm install", filter, rewrite: null };
    const result = applyBashFilterToStdout("error output", true, plan);
    expect(result).toBe("error output");
  });

  test("error output preserves ANSI codes (not stripped)", () => {
    const filter = { name: "test", matchCommand: /^npm$/, stripAnsi: true };
    const plan = { effectiveCommand: "npm install", filter, rewrite: null };
    const ansiError = "\x1b[31mERROR\x1b[0m: something failed";
    const result = applyBashFilterToStdout(ansiError, true, plan);
    expect(result).toBe(ansiError);
  });

  test("error output with rewrite still shows rewrite marker", () => {
    const filter = { name: "docker", matchCommand: /^docker$/ };
    const plan = {
      effectiveCommand: "docker build --progress=plain .",
      filter,
      rewrite: { from: "docker build .", to: "docker build --progress=plain ." },
    };
    const errorOutput = "error: build failed";
    const result = applyBashFilterToStdout(errorOutput, true, plan);
    expect(result).toContain("<bash-output-rewritten");
    expect(result).toContain("error: build failed");
  });

  test("error output with rewrite marker preserves full error content", () => {
    const filter = { name: "docker", matchCommand: /^docker$/ };
    const plan = {
      effectiveCommand: "docker build --progress=plain .",
      filter,
      rewrite: { from: "docker build .", to: "docker build --progress=plain ." },
    };
    const longError = Array.from({ length: 100 }, (_, i) => `error line ${i}`).join("\n");
    const result = applyBashFilterToStdout(longError, true, plan);
    expect(result).toContain("error line 0");
    expect(result).toContain("error line 99");
  });

  test("safeApply returns raw output on pipeline crash", () => {
    const filter = { name: "test", matchCommand: /^test$/ };
    const plan = { effectiveCommand: "test", filter, rewrite: null };
    // Even with a valid plan, if the pipeline throws, safeApply falls back
    const result = applyBashFilterToStdout("some output", false, plan);
    expect(result).toBe("some output");
  });
});

// ---------------------------------------------------------------------------
// Integration harness — 67 cases (skipped until Phase 2)
// ---------------------------------------------------------------------------

describe.skip("integration harness", () => {
  // --- git ---
  test("git-status (clean state)", () => {
    /* Phase 2 */
  });
  test("git-log (default)", () => {
    /* Phase 2 */
  });
  test("git-log (oneline) — passthrough", () => {
    /* Phase 2 */
  });
  test("git-diff (empty / no changes)", () => {
    /* Phase 2 */
  });
  test("git-add (--dry-run)", () => {
    /* Phase 2 */
  });
  test("git-push (--dry-run = up-to-date)", () => {
    /* Phase 2 */
  });
  test("git blame (author + date dominate)", () => {
    /* Phase 2 */
  });
  test("git branch -a (already compact)", () => {
    /* Phase 2 */
  });
  test("git show HEAD --stat", () => {
    /* Phase 2 */
  });
  test("git tag --list", () => {
    /* Phase 2 */
  });
  test("git remote -v", () => {
    /* Phase 2 */
  });
  test("git worktree list", () => {
    /* Phase 2 */
  });
  test("git config --list", () => {
    /* Phase 2 */
  });
  test("git reflog", () => {
    /* Phase 2 */
  });
  test("git show HEAD (full with diff)", () => {
    /* Phase 2 */
  });
  test("git fetch --dry-run", () => {
    /* Phase 2 */
  });
  test("git clean -nd (dry run)", () => {
    /* Phase 2 */
  });
  test("git pull (fast-forward 3 files)", () => {
    /* Phase 2 */
  });

  // --- ls / find / grep ---
  test("ls -la", () => {
    /* Phase 2 */
  });
  test("ls (plain)", () => {
    /* Phase 2 */
  });
  test("find (user-filtered)", () => {
    /* Phase 2 */
  });
  test("grep -rn (absolute paths)", () => {
    /* Phase 2 */
  });
  test("rg (absolute path — unexpected finding)", () => {
    /* Phase 2 */
  });
  test("rg (relative path — compact case)", () => {
    /* Phase 2 */
  });

  // --- cargo ---
  test("cargo build (warm cache, warnings)", () => {
    /* Phase 2 */
  });
  test("cargo build + dedup (repeated warning headers)", () => {
    /* Phase 2 */
  });
  test("cargo check (cold cache)", () => {
    /* Phase 2 */
  });
  test("cargo test --no-run", () => {
    /* Phase 2 */
  });
  test("cargo clippy (40 warnings)", () => {
    /* Phase 2 */
  });

  // --- dedup-specific ---
  test("ps aux + dedup (kthreads nearly identical)", () => {
    /* Phase 2 */
  });
  test("dedup: connection retry alternating (collapseRuns fails)", () => {
    /* Phase 2 */
  });
  test("dedup: connection retry alternating (dedupGlobal resolves)", () => {
    /* Phase 2 */
  });
  test("dedup: progress bar (collapseDigitTemplates)", () => {
    /* Phase 2 */
  });
  test("dedup: progress bar (collapseRuns insufficient)", () => {
    /* Phase 2 */
  });
  test("dedup: cargo warnings repeated (dedupGlobal)", () => {
    /* Phase 2 */
  });
  test("dedup: cargo warning header repeated (dedupGlobal real)", () => {
    /* Phase 2 */
  });

  // --- build / test tools ---
  test("tsc --noEmit (truncated 50KB)", () => {
    /* Phase 2 */
  });
  test("bun install (no changes)", () => {
    /* Phase 2 */
  });
  test("npm ls --depth=0", () => {
    /* Phase 2 */
  });
  test("pytest (clean — all pass)", () => {
    /* Phase 2 */
  });
  test("ruff check (errors in project)", () => {
    /* Phase 2 */
  });
  test("ruff check (clean — match_output)", () => {
    /* Phase 2 */
  });
  test("bun test (already compact)", () => {
    /* Phase 2 */
  });
  test("prettier --check", () => {
    /* Phase 2 */
  });
  test("rubocop (preamble dominate)", () => {
    /* Phase 2 */
  });
  test("rspec (clean — all pass)", () => {
    /* Phase 2 */
  });
  test("go test -v (clean — all pass)", () => {
    /* Phase 2 */
  });
  test("golangci-lint (1 issue)", () => {
    /* Phase 2 */
  });

  // --- docker / process ---
  test("docker ps -a", () => {
    /* Phase 2 */
  });
  test("docker images", () => {
    /* Phase 2 */
  });
  test("docker logs (postgres tail 50)", () => {
    /* Phase 2 */
  });
  test("ps aux", () => {
    /* Phase 2 */
  });

  // --- system ---
  test("journalctl -u systemd-logind", () => {
    /* Phase 2 */
  });
  test("df -h", () => {
    /* Phase 2 */
  });
  test("du -h --max-depth=1", () => {
    /* Phase 2 */
  });
  test("top -bn1", () => {
    /* Phase 2 */
  });
  test("ss -tln (already minimal)", () => {
    /* Phase 2 */
  });
  test("dig (DNS query)", () => {
    /* Phase 2 */
  });

  // --- network ---
  test("curl -v (TLS noise dominates)", () => {
    /* Phase 2 */
  });
  test("wget", () => {
    /* Phase 2 */
  });

  // --- misc ---
  test("jq pretty-print (already compact)", () => {
    /* Phase 2 */
  });
  test("env (filtered grep)", () => {
    /* Phase 2 */
  });
  test("json structure (small json)", () => {
    /* Phase 2 */
  });
  test("pip list", () => {
    /* Phase 2 */
  });
  test("pip list --outdated", () => {
    /* Phase 2 */
  });
  test("bundle install", () => {
    /* Phase 2 */
  });
  test("tail (pacman log)", () => {
    /* Phase 2 */
  });
});

// ---------------------------------------------------------------------------
// Safety tests (skipped until Phase 2)
// ---------------------------------------------------------------------------

describe.skip("safety", () => {
  test("cargo-build: warning preserves output (unless `warning`)", () => {
    /* Phase 2 */
  });
  test("cargo-build: error preserves output", () => {
    /* Phase 2 */
  });
  test("git-status: Unmerged path NOT collapsed by match_output", () => {
    /* Phase 2 */
  });
});

// ---------------------------------------------------------------------------
// Rewrite tests (skipped until Phase 2)
// ---------------------------------------------------------------------------

describe.skip("rewrite", () => {
  test("git-log: rewrite default → --oneline", () => {
    /* Phase 2 */
  });
});
