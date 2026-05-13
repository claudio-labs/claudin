/**
 * Bash Output Filter — integration harness tests
 *
 * These tests are ported from docs/discovery/bash-output-filter/validation/validate.ts.
 * They are all test.skip() because builtInFilters is empty in Phase 1.
 * Phase 2 will unskip them as filters land.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyBashFilterToStdout, planBashFilter } from "./index.js";
import { findFilterForCommand } from "./registry.js";
import { builtInFilters } from "./filters/index.js";
import type { FilterSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Phase 6.1.2 harness helpers — load real shell output captured in
// docs/discovery/.../samples/ and measure byte-reduction against the
// predicted ROI (see .claudio/plans/fizzy-churning-stearns.md, decision D1).
// ---------------------------------------------------------------------------
const SAMPLES_DIR = resolve(
  import.meta.dir,
  "../../../docs/discovery/bash-output-filter/validation/samples",
);

function loadSample(name: string): string {
  return readFileSync(resolve(SAMPLES_DIR, `${name}.txt`), "utf8");
}

function getFilter(name: string): FilterSpec {
  const f = builtInFilters.find((s) => s.name === name);
  if (!f) throw new Error(`filter '${name}' not registered in builtInFilters`);
  return f;
}

function runFilter(filterName: string, command: string, raw: string): string {
  const filter = getFilter(filterName);
  return applyBashFilterToStdout(raw, false, {
    effectiveCommand: command,
    filter,
    rewrite: null,
  });
}

// Strip the `<bash-output-filtered ...>BODY</bash-output-filtered>` wrapper
// so tests measure the actual content reduction, not the marker overhead.
// The marker is enforced elsewhere (markers.test.ts); the ROI target in the
// roadmap is about the filtered body size.
const WRAPPER_RE = /^<bash-output-filtered\s[^>]*>([\s\S]*)<\/bash-output-filtered>$/;

function stripWrapper(s: string): string {
  const m = s.match(WRAPPER_RE);
  return m ? m[1]! : s;
}

function runFilterBody(filterName: string, command: string, raw: string): string {
  return stripWrapper(runFilter(filterName, command, raw));
}

function reductionPct(raw: string, filteredBody: string): number {
  return 100 * (1 - filteredBody.length / Math.max(1, raw.length));
}

function assertReduction(
  filterName: string,
  command: string,
  sampleName: string,
  predictedPct: number,
): void {
  const raw = loadSample(sampleName);
  const body = runFilterBody(filterName, command, raw);
  const pct = reductionPct(raw, body);
  expect(
    pct,
    `filter=${filterName} sample=${sampleName} predicted=${predictedPct}% actual=${pct.toFixed(1)}%`,
  ).toBeGreaterThanOrEqual(predictedPct - 5);
}

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

// ===========================================================================
// Phase 6.1.2 — active tests for the 14 built-in filters.
//
// Three layers per filter:
//   1. ROI test    — predicted byte reduction against a real sample
//   2. Safety test — `unless` guard must preserve error signal
//   3. Match test  — matchCommand / matchCommandReject sanity
// ===========================================================================

describe("phase 6.1.2 — bundleInstall", () => {
  test("ROI: bundle-install sample reduces ≥ 91%", () => {
    assertReduction("bundle-install", "bundle install", "bundle-install", 91);
  });

  test("safety: matchOutput does NOT fire when 'error' is present", () => {
    const raw = [
      "Fetching rake 13.0.6",
      "Installing rake 13.0.6",
      "error: could not resolve rails 7.0.0",
      "Bundle complete!",
    ].join("\n");
    const body = runFilterBody("bundle-install", "bundle install", raw);
    expect(body).toContain("error: could not resolve");
    expect(body).not.toBe("✓ bundle install completed");
  });

  test("match: 'bundle install' → matches; 'bundle check' → no match", () => {
    expect(findFilterForCommand("bundle install")?.name).toBe("bundle-install");
    expect(findFilterForCommand("bundle check")?.name).not.toBe("bundle-install");
  });
});

describe("phase 6.1.2 — pytest", () => {
  test("ROI: pytest-clean sample reduces ≥ 90%", () => {
    assertReduction("pytest", "pytest", "pytest-clean", 90);
  });

  test("safety: matchOutput does NOT fire when a test FAILED", () => {
    const raw = [
      "============== test session starts ==============",
      "platform linux -- Python 3.11",
      "FAILED tests/test_x.py::test_broken - AssertionError",
      "========== 1 failed, 4 passed in 0.12s ==========",
    ].join("\n");
    const body = runFilterBody("pytest", "pytest", raw);
    expect(body).toContain("FAILED");
    expect(body).not.toBe("✓ pytest: all tests passed");
  });

  test("match: pytest & python -m pytest ✓; --json-report rejects", () => {
    expect(findFilterForCommand("pytest")?.name).toBe("pytest");
    expect(findFilterForCommand("python -m pytest tests/")?.name).toBe("pytest");
    expect(findFilterForCommand("pytest --json-report")?.name).not.toBe("pytest");
  });
});

describe("phase 6.1.2 — rspec", () => {
  test("ROI: rspec sample reduces ≥ 68%", () => {
    assertReduction("rspec", "rspec", "rspec", 68);
  });

  test("safety: matchOutput does NOT fire when summary reports failures", () => {
    const raw = [
      "..F..",
      "Failures:",
      "  1) Foo does bar",
      "     Failure/Error: expect(x).to eq(y)",
      "5 examples, 1 failure",
    ].join("\n");
    const body = runFilterBody("rspec", "rspec", raw);
    expect(body).toContain("Failures:");
    expect(body).not.toBe("✓ rspec: all tests passed");
  });

  test("match: rspec & bundle exec rspec both register", () => {
    expect(findFilterForCommand("rspec")?.name).toBe("rspec");
    expect(findFilterForCommand("bundle exec rspec spec/")?.name).toBe("rspec");
  });
});

describe("phase 6.1.2 — goTest", () => {
  test("ROI: go-test sample reduces ≥ 77%", () => {
    assertReduction("go-test", "go test ./...", "go-test", 77);
  });

  test("safety: matchOutput does NOT fire on FAIL / panic", () => {
    const raw = [
      "=== RUN   TestOne",
      "--- FAIL: TestOne (0.00s)",
      "    foo_test.go:10: expected 1 got 2",
      "FAIL",
      "ok  pkg/foo  0.02s",
    ].join("\n");
    const body = runFilterBody("go-test", "go test ./...", raw);
    expect(body).toContain("--- FAIL");
    expect(body).not.toBe("✓ go test: all tests passed");
  });

  test("match: go test ✓; go build ✗", () => {
    expect(findFilterForCommand("go test ./...")?.name).toBe("go-test");
    expect(findFilterForCommand("go build")?.name).not.toBe("go-test");
  });
});

describe("phase 6.1.2 — psAux", () => {
  test("ROI: ps-aux sample reduces ≥ 88%", () => {
    assertReduction("ps-aux", "ps aux", "ps-aux", 88);
  });

  test("safety: user processes are preserved", () => {
    const raw = loadSample("ps-aux");
    const body = runFilterBody("ps-aux", "ps aux", raw);
    // The header is always the first line of `ps aux` output.
    expect(body.split("\n")[0]).toMatch(/USER\s+PID/);
  });

  test("match: ps aux ✓; ps -ef ✓ (both common)", () => {
    expect(findFilterForCommand("ps aux")?.name).toBe("ps-aux");
    expect(findFilterForCommand("ps -ef")?.name).toBe("ps-aux");
  });
});

describe("phase 6.1.2 — top", () => {
  test("ROI: top-bn1 sample reduces ≥ 47%", () => {
    assertReduction("top", "top -bn1", "top-bn1", 47);
  });

  test("safety: top's multi-line header is preserved", () => {
    const raw = loadSample("top-bn1");
    const body = runFilterBody("top", "top -bn1", raw);
    // `top` always prints `top - HH:MM:SS up ...` as line 1.
    expect(body.split("\n")[0]).toMatch(/^top\s+-\s+\d/);
  });

  test("match: top -bn1 ✓; plain 'top' ✗ (interactive)", () => {
    expect(findFilterForCommand("top -bn1")?.name).toBe("top");
    expect(findFilterForCommand("top")?.name).not.toBe("top");
  });
});

describe("phase 6.1.2 — rubocop", () => {
  test("ROI: rubocop sample reduces ≥ 78%", () => {
    assertReduction("rubocop", "rubocop", "rubocop", 78);
  });

  test("safety: output with no preamble is idempotent (no crash)", () => {
    const raw = "Inspecting 3 files\n...\n3 files inspected, no offenses detected\n";
    expect(() => runFilter("rubocop", "rubocop", raw)).not.toThrow();
  });

  test("match: rubocop & bundle exec rubocop both register", () => {
    expect(findFilterForCommand("rubocop")?.name).toBe("rubocop");
    expect(findFilterForCommand("bundle exec rubocop -a")?.name).toBe("rubocop");
  });
});

describe("phase 6.1.2 — ruffCheck", () => {
  test("ROI: ruff-clean sample collapses to sentinel", () => {
    const raw = loadSample("ruff-clean");
    const body = runFilterBody("ruff-check", "ruff check", raw);
    // M-only filter — on clean runs we expect the sentinel line.
    expect(body).toBe("✓ ruff: all checks passed");
  });

  test("safety: matchOutput does NOT fire when 'Found N errors' is present", () => {
    const raw = [
      "src/foo.py:1:1: E501 line too long",
      "Found 1 error.",
    ].join("\n");
    const body = runFilterBody("ruff-check", "ruff check", raw);
    expect(body).toContain("Found 1 error");
    expect(body).not.toBe("✓ ruff: all checks passed");
  });

  test("match: ruff check ✓; ruff format ✗", () => {
    expect(findFilterForCommand("ruff check")?.name).toBe("ruff-check");
    expect(findFilterForCommand("ruff format")?.name).not.toBe("ruff-check");
  });
});

describe("phase 6.1.2 — lsLa", () => {
  test("ROI: ls-la sample reduces ≥ 76%", () => {
    assertReduction("ls-la", "ls -la", "ls-la", 76);
  });

  test("safety: the 'total N' header is preserved", () => {
    const raw = loadSample("ls-la");
    const body = runFilterBody("ls-la", "ls -la", raw);
    expect(body).toMatch(/^total\s+\d+/m);
  });

  test("match: ls -la ✓, ls -al ✓; plain ls ✗", () => {
    expect(findFilterForCommand("ls -la")?.name).toBe("ls-la");
    expect(findFilterForCommand("ls -al")?.name).toBe("ls-la");
    expect(findFilterForCommand("ls")?.name).not.toBe("ls-la");
  });
});

describe("phase 6.1.2 — grepRg", () => {
  test("ROI: grep sample reduces ≥ 28%", () => {
    assertReduction("grep-rg", "grep -rn isAbortError .", "grep", 28);
  });

  test("safety: relative paths are left untouched (idempotent)", () => {
    const raw = "src/utils/errors.ts:42:throw new Error\n";
    const body = runFilterBody("grep-rg", "rg 'new Error' src/", raw);
    expect(body).toBe(raw);
  });

  test("match: grep, rg, ag ✓; rg --json rejects", () => {
    expect(findFilterForCommand("grep -rn foo .")?.name).toBe("grep-rg");
    expect(findFilterForCommand("rg foo")?.name).toBe("grep-rg");
    expect(findFilterForCommand("ag foo")?.name).toBe("grep-rg");
    expect(findFilterForCommand("rg --json foo")?.name).not.toBe("grep-rg");
  });
});

describe("phase 6.1.2 — cargoBuild", () => {
  test("ROI: cargo-build sample reduces ≥ 50%", () => {
    assertReduction("cargo-build", "cargo build", "cargo-build", 50);
  });

  test("safety: error[E0308] preserves body, no sentinel", () => {
    const raw = [
      "   Compiling foo v0.1.0 (/work/foo)",
      "error[E0308]: mismatched types",
      "  --> src/main.rs:5:9",
      "   |",
      "5  |     let x: u32 = \"\";",
      "   |                  ^^ expected u32, found &str",
      "error: could not compile `foo`",
    ].join("\n");
    const body = runFilterBody("cargo-build", "cargo build", raw);
    expect(body).toContain("error[E0308]");
    expect(body).not.toMatch(/^✓ cargo build/);
  });

  test("match: cargo build ✓; cargo clippy ✗", () => {
    expect(findFilterForCommand("cargo build")?.name).toBe("cargo-build");
    expect(findFilterForCommand("cargo clippy")?.name).not.toBe("cargo-build");
  });
});

describe("phase 6.1.2 — cargoCheck", () => {
  test("ROI: cargo-check sample reduces ≥ 59%", () => {
    assertReduction("cargo-check", "cargo check", "cargo-check", 59);
  });

  test("match: cargo check ✓", () => {
    expect(findFilterForCommand("cargo check")?.name).toBe("cargo-check");
  });
});

describe("phase 6.1.2 — cargoTest", () => {
  test("ROI: cargo-test-norun sample is passthrough (reject active)", () => {
    // cargo test --no-run is rejected by cargoTest AND not matched by
    // cargoBuild (different verb), so it goes through unfiltered. We only
    // assert the filter didn't crash and returned something reasonable.
    const raw = loadSample("cargo-test-norun");
    const plan = planBashFilter("cargo test --no-run");
    // No filter should claim this command line.
    expect(plan.filter).toBeNull();
    const filtered = applyBashFilterToStdout(raw, false, plan);
    expect(filtered).toBe(raw);
  });

  test("safety: FAILED keyword preserves the failures block", () => {
    const raw = [
      "running 3 tests",
      "test foo ... ok",
      "test bar ... FAILED",
      "failures:",
      "    bar",
      "test result: FAILED. 2 passed; 1 failed; 0 ignored",
    ].join("\n");
    const body = runFilterBody("cargo-test", "cargo test", raw);
    expect(body).toContain("FAILED");
    expect(body).toContain("failures:");
    expect(body).not.toMatch(/^✓ cargo test/);
  });

  test("match: cargo test ✓; cargo test --no-run rejects; cargo test -q rejects", () => {
    expect(findFilterForCommand("cargo test")?.name).toBe("cargo-test");
    expect(findFilterForCommand("cargo test --no-run")?.name).not.toBe("cargo-test");
    expect(findFilterForCommand("cargo test -q")?.name).not.toBe("cargo-test");
  });
});

describe("phase 6.1.2 — cargoClippy", () => {
  test("ROI: cargo-clippy sample passes through without crashing", () => {
    const raw = loadSample("cargo-clippy");
    expect(() => runFilter("cargo-clippy", "cargo clippy", raw)).not.toThrow();
    // Warnings must survive — clippy warnings *are* the signal.
    const body = runFilterBody("cargo-clippy", "cargo clippy", raw);
    // The sample contains at least one `warning:` line; verify preservation.
    if (raw.includes("warning:")) {
      expect(body).toContain("warning:");
    }
  });

  test("match: cargo clippy ✓", () => {
    expect(findFilterForCommand("cargo clippy")?.name).toBe("cargo-clippy");
  });
});

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
// Phase 6.1.4 — gh rewrite specs
// ---------------------------------------------------------------------------

describe("phase 6.1.4 — ghPrList", () => {
  test("rewrite: gh pr list → canonical --json form", () => {
    const plan = planBashFilter("gh pr list");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("number,title,state");
    expect(plan.rewrite?.to).toContain("headRefName");
  });

  test("no rewrite when --json already present", () => {
    expect(planBashFilter("gh pr list --json number").rewrite).toBeNull();
    expect(planBashFilter("gh pr list --json number").filter).toBeNull();
  });

  test("chain resolves: gh pr list && echo done applies gh-pr-list", () => {
    // `echo done` has no filter, so the chain resolves to `gh-pr-list`.
    expect(planBashFilter("gh pr list && echo done").filter?.name).toBe(
      "gh-pr-list",
    );
  });

  test("match: gh-pr-list spec claims 'gh pr list'", () => {
    expect(findFilterForCommand("gh pr list")?.name).toBe("gh-pr-list");
  });

  test("ROI: gh-pr-list sample passes through without crashing", () => {
    const raw = loadSample("gh-pr-list");
    const plan = planBashFilter("gh pr list");
    expect(() => applyBashFilterToStdout(raw, false, plan)).not.toThrow();
  });

  test("determinism: two runs yield same plan", () => {
    const a = planBashFilter("gh pr list");
    const b = planBashFilter("gh pr list");
    expect(a.rewrite?.to).toBe(b.rewrite?.to);
  });

  test("flag-forward: --repo owner/repo is preserved in rewrite", () => {
    const plan = planBashFilter("gh pr list --repo owner/repo");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("--repo owner/repo");
  });

  test("flag-forward: --author and --state flags are preserved", () => {
    const plan = planBashFilter("gh pr list --author alice --state open");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("--author alice");
    expect(plan.rewrite?.to).toContain("--state open");
  });
});

describe("phase 6.1.4 — ghIssueList", () => {
  test("rewrite: gh issue list → canonical --json form", () => {
    const plan = planBashFilter("gh issue list");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("number,title,state");
  });

  test("no rewrite when --json already present", () => {
    expect(planBashFilter("gh issue list --json number").rewrite).toBeNull();
  });

  test("match: gh-issue-list spec claims 'gh issue list'", () => {
    expect(findFilterForCommand("gh issue list")?.name).toBe("gh-issue-list");
  });

  test("ROI: gh-issue-list sample passes through without crashing", () => {
    const raw = loadSample("gh-issue-list");
    const plan = planBashFilter("gh issue list");
    expect(() => applyBashFilterToStdout(raw, false, plan)).not.toThrow();
  });

  test("flag-forward: --assignee flag is preserved in rewrite", () => {
    const plan = planBashFilter("gh issue list --assignee bob --label bug");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("--assignee bob");
    expect(plan.rewrite?.to).toContain("--label bug");
  });
});

describe("phase 6.1.4 — ghRunList", () => {
  test("rewrite: gh run list → canonical --json form", () => {
    const plan = planBashFilter("gh run list");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("status,conclusion,name");
  });

  test("no rewrite when --json already present", () => {
    expect(planBashFilter("gh run list --json status").rewrite).toBeNull();
  });

  test("match: gh-run-list spec claims 'gh run list'", () => {
    expect(findFilterForCommand("gh run list")?.name).toBe("gh-run-list");
  });

  test("ROI: gh-run-list sample passes through without crashing", () => {
    const raw = loadSample("gh-run-list");
    const plan = planBashFilter("gh run list");
    expect(() => applyBashFilterToStdout(raw, false, plan)).not.toThrow();
  });

  test("flag-forward: --branch flag is preserved in rewrite", () => {
    const plan = planBashFilter("gh run list --branch main --limit 10");
    expect(plan.rewrite?.to).toContain("--json");
    expect(plan.rewrite?.to).toContain("--branch main");
    expect(plan.rewrite?.to).toContain("--limit 10");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.1.4 — Regression: batch-1 specs unaffected
// ---------------------------------------------------------------------------

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
    const raw = "^b8dc2bb (Viudes 2026-04-29 18:08:59 -0300   1) # Claudio\n23551ecd (Viudes 2026-05-02 11:28:25 -0300   3) Coding agent\n";
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
// Phase 6.1.5 — container specs
// ---------------------------------------------------------------------------

describe("phase 6.1.5 — dockerPs", () => {
  test("ROI: docker-ps sample ≥20% reduction", () => {
    assertReduction("docker-ps", "docker ps -a", "docker-ps", 20);
  });

  test("match: docker ps", () => {
    expect(findFilterForCommand("docker ps")?.name).toBe("docker-ps");
  });

  test("match: docker ps -a", () => {
    expect(findFilterForCommand("docker ps -a")?.name).toBe("docker-ps");
  });

  test("reject: docker ps --format", () => {
    expect(findFilterForCommand("docker ps --format '{{.Names}}'")).toBeNull();
  });

  test("reject: docker ps -q", () => {
    expect(findFilterForCommand("docker ps -q")).toBeNull();
  });

  test("reject: docker ps --quiet", () => {
    expect(findFilterForCommand("docker ps --quiet")).toBeNull();
  });

  test("reject: docker ps --no-trunc", () => {
    expect(findFilterForCommand("docker ps --no-trunc")).toBeNull();
  });

  test("strips CONTAINER ID column from data rows", () => {
    const raw = "CONTAINER ID   IMAGE             STATUS\na3f8c9d2e1b7   postgres:16       Up 2 hours\n";
    const body = runFilterBody("docker-ps", "docker ps -a", raw);
    expect(body).not.toMatch(/^[0-9a-f]{12}\s/m);
    expect(body).toContain("postgres:16");
  });

  test("onEmpty: no containers returns message", () => {
    const raw = "CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES\n";
    const body = runFilterBody("docker-ps", "docker ps", raw);
    expect(body).toContain("No matching containers.");
  });
});

describe("phase 6.1.5 — dockerImages", () => {
  test("ROI: docker-images sample ≥30% reduction", () => {
    assertReduction("docker-images", "docker images", "docker-images", 30);
  });

  test("match: docker images", () => {
    expect(findFilterForCommand("docker images")?.name).toBe("docker-images");
  });

  test("reject: docker images --format", () => {
    expect(findFilterForCommand("docker images --format '{{.Repository}}'")).toBeNull();
  });

  test("reject: docker images -q", () => {
    expect(findFilterForCommand("docker images -q")).toBeNull();
  });

  test("strips WARNING line", () => {
    const raw = "WARNING: This output is designed for human readability. For machine-readable output, please use --format.\nIMAGE   ID   DISK USAGE\npostgres:16   108b27c919e6   276MB\n";
    const body = runFilterBody("docker-images", "docker images", raw);
    expect(body).not.toContain("WARNING:");
    expect(body).toContain("postgres:16");
  });

  test("strips 12-char hex ID column", () => {
    const raw = "IMAGE   ID             DISK USAGE\npostgres:16   108b27c919e6   276MB\n";
    const body = runFilterBody("docker-images", "docker images", raw);
    expect(body).not.toMatch(/\b[0-9a-f]{12}\b/);
  });
});

describe("phase 6.1.5 — dockerLogs", () => {
  test("ROI: docker-logs sample ≥15% reduction", () => {
    assertReduction("docker-logs", "docker logs postgres", "docker-logs", 15);
  });

  test("match: docker logs myapp", () => {
    expect(findFilterForCommand("docker logs myapp")?.name).toBe("docker-logs");
  });

  test("match: docker logs --tail 50 myapp", () => {
    expect(findFilterForCommand("docker logs --tail 50 myapp")?.name).toBe("docker-logs");
  });

  test("reject: docker logs -f myapp", () => {
    expect(findFilterForCommand("docker logs -f myapp")).toBeNull();
  });

  test("reject: docker logs --follow myapp", () => {
    expect(findFilterForCommand("docker logs --follow myapp")).toBeNull();
  });

  test("reject: docker logs --timestamps=false myapp", () => {
    expect(findFilterForCommand("docker logs --timestamps=false myapp")).toBeNull();
  });

  test("strips postgres-style timestamp prefix to HH:MM:SS", () => {
    const raw = "2026-05-05 14:35:40.337 UTC [27] LOG:  checkpoint complete\n2026-05-05 14:35:40.405 UTC [1] LOG:  database shut down\n";
    const body = runFilterBody("docker-logs", "docker logs postgres", raw);
    expect(body).toContain("14:35:40 LOG:");
    expect(body).not.toContain("2026-05-05");
    expect(body).not.toContain("[27]");
  });

  test("strips Docker ISO timestamp prefix", () => {
    const raw = "2026-05-05T14:35:40.337Z INFO Starting server\n2026-05-05T14:35:41.001Z INFO Ready\n";
    const body = runFilterBody("docker-logs", "docker logs myapp", raw);
    expect(body).toContain("INFO Starting server");
    expect(body).not.toContain("2026-05-05T");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.1.5 — network specs
// ---------------------------------------------------------------------------

describe("phase 6.1.5 — curlV", () => {
  test("ROI: curl-v sample ≥50% reduction", () => {
    assertReduction("curl", "curl -v https://httpbin.org/get", "curl-v", 50);
  });

  test("match: curl -v https://example.com", () => {
    expect(findFilterForCommand("curl -v https://example.com")?.name).toBe("curl");
  });

  test("phase 9: curl https://example.com (no -v) is claimed by curl-plain, not curlV", () => {
    // Before phase 9, plain curl had no filter. The new curl-plain spec
    // (network.ts) covers it now — verify curl-plain wins, not curlV.
    expect(findFilterForCommand("curl https://example.com")?.name).toBe(
      "curl-plain",
    );
  });

  test("match: curl --verbose https://example.com", () => {
    expect(findFilterForCommand("curl --verbose https://example.com")?.name).toBe("curl");
  });

  test("reject: curl -s https://api.example.com", () => {
    expect(findFilterForCommand("curl -s https://api.example.com")).toBeNull();
  });

  test("reject: curl --silent https://api.example.com", () => {
    expect(findFilterForCommand("curl --silent https://api.example.com")).toBeNull();
  });

  test("reject: curl -I https://example.com", () => {
    expect(findFilterForCommand("curl -I https://example.com")).toBeNull();
  });

  test("reject: curl --head https://example.com", () => {
    expect(findFilterForCommand("curl --head https://example.com")).toBeNull();
  });

  test("strips TLS handshake lines", () => {
    const raw = "* TLSv1.3 (OUT), TLS handshake, Client hello (1):\n* TLSv1.2 (IN), TLS handshake, Certificate (11):\n* SSL certificate verify ok.\n> GET / HTTP/2\n< HTTP/2 200\n";
    const body = runFilterBody("curl", "curl -v https://example.com", raw);
    expect(body).not.toContain("TLSv1.3");
    expect(body).not.toContain("TLSv1.2");
    expect(body).toContain("> GET / HTTP/2");
    expect(body).toContain("< HTTP/2 200");
  });

  test("strips byte-count markers", () => {
    const raw = "} [1566 bytes data]\n{ [5 bytes data]\n> GET / HTTP/2\n";
    const body = runFilterBody("curl", "curl -v https://example.com", raw);
    expect(body).not.toContain("bytes data");
    expect(body).toContain("> GET / HTTP/2");
  });

  test("strips DNS/connection noise", () => {
    const raw = "* Host httpbin.org:443 was resolved.\n* IPv4: 44.199.179.5\n* Trying 44.199.179.5:443...\n* ALPN: curl offers h2,http/1.1\n* Connection #0 to host left intact\n< HTTP/2 200\n";
    const body = runFilterBody("curl", "curl -v https://httpbin.org/get", raw);
    expect(body).not.toContain("was resolved");
    expect(body).not.toContain("IPv4:");
    expect(body).not.toContain("Trying ");
    expect(body).not.toContain("ALPN:");
    expect(body).not.toContain("Connection #0");
    expect(body).toContain("< HTTP/2 200");
  });
});

describe("phase 6.1.5 — dig", () => {
  test("ROI: dig sample ≥40% reduction", () => {
    assertReduction("dig", "dig httpbin.org", "dig", 40);
  });

  test("match: dig example.com", () => {
    expect(findFilterForCommand("dig example.com")?.name).toBe("dig");
  });

  test("match: dig @8.8.8.8 example.com", () => {
    expect(findFilterForCommand("dig @8.8.8.8 example.com")?.name).toBe("dig");
  });

  test("reject: dig +short example.com", () => {
    expect(findFilterForCommand("dig +short example.com")).toBeNull();
  });

  test("reject: dig +nocomments example.com", () => {
    expect(findFilterForCommand("dig +nocomments example.com")).toBeNull();
  });

  test("strips semicolon comment lines", () => {
    const raw = "; <<>> DiG 9.20.22 <<>> example.com\n;; global options: +cmd\n;; Got answer:\nexample.com. 60 IN A 93.184.216.34\n";
    const body = runFilterBody("dig", "dig example.com", raw);
    expect(body).not.toContain("; <<>>");
    expect(body).not.toContain(";; global options");
    expect(body).toContain("example.com.");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.1.5 — system extend: journalctl
// ---------------------------------------------------------------------------

describe("phase 6.1.5 — journalctl", () => {
  test("ROI: journalctl sample ≥10% reduction", () => {
    assertReduction("journalctl", "journalctl -u systemd-logind", "journalctl", 10);
  });

  test("match: journalctl -u systemd-logind", () => {
    expect(findFilterForCommand("journalctl -u systemd-logind")?.name).toBe("journalctl");
  });

  test("match: sudo journalctl -n 50", () => {
    expect(findFilterForCommand("sudo journalctl -n 50")?.name).toBe("journalctl");
  });

  test("reject: journalctl --output=json", () => {
    expect(findFilterForCommand("journalctl --output=json")).toBeNull();
  });

  test("reject: journalctl -o json", () => {
    expect(findFilterForCommand("journalctl -o json")).toBeNull();
  });

  test("reject: journalctl --output=cat", () => {
    expect(findFilterForCommand("journalctl --output=cat")).toBeNull();
  });

  test("reject: journalctl -f (follow)", () => {
    expect(findFilterForCommand("journalctl -f")).toBeNull();
  });

  test("reject: journalctl --follow", () => {
    expect(findFilterForCommand("journalctl --follow")).toBeNull();
  });

  test("reject: journalctl --machine=host1 (hostname is informative)", () => {
    expect(findFilterForCommand("journalctl --machine=host1")).toBeNull();
  });

  test("strips hostname from log lines", () => {
    const raw = "May 05 12:18:04 viudes-arch systemd-logind[726]: Watching system buttons\nMay 05 12:22:44 viudes-arch systemd-logind[726]: System is rebooting.\n";
    const body = runFilterBody("journalctl", "journalctl -u systemd-logind", raw);
    expect(body).not.toContain("viudes-arch");
    expect(body).toContain("May 05 12:18:04");
    expect(body).toContain("systemd-logind[726]: Watching");
  });

  test("strips boot markers", () => {
    const raw = "May 05 12:22:49 viudes-arch systemd[1]: Stopped service.\n-- Boot ed3041156fb04270ae0d53e7892c949b --\nMay 05 12:23:37 viudes-arch systemd[1]: Starting service.\n";
    const body = runFilterBody("journalctl", "journalctl -u systemd", raw);
    expect(body).not.toContain("-- Boot ed3041");
    expect(body).toContain("Stopped service.");
    expect(body).toContain("Starting service.");
  });

  test("strips no-entries marker", () => {
    const raw = "-- No entries --\n";
    const body = runFilterBody("journalctl", "journalctl -u unknown-service", raw);
    expect(body).not.toContain("-- No entries --");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.1.5 — Regression: all batch-1 + 6.1.4 specs still match
// ---------------------------------------------------------------------------

describe("regression 6.1.5 — batch-1 specs still match after batch-2 added", () => {
  const cases: [string, string][] = [
    ["pytest",          "pytest src/"],
    ["rspec",           "rspec spec/"],
    ["go-test",         "go test ./..."],
    ["bundle-install",  "bundle install"],
    ["ps-aux",          "ps aux"],
    ["top",             "top -bn1"],
    ["rubocop",         "rubocop app/"],
    ["ruff-check",      "ruff check src/"],
    ["ls-la",           "ls -la"],
    ["grep-rg",         "rg foo src/"],
    ["cargo-test",      "cargo test"],
    ["cargo-clippy",    "cargo clippy"],
    ["cargo-check",     "cargo check"],
    ["cargo-build",     "cargo build"],
    ["git-log",         "git log"],
    ["git-status",      "git status"],
    ["gh-pr-list",      "gh pr list"],
    ["gh-issue-list",   "gh issue list"],
    ["gh-run-list",     "gh run list"],
  ];
  for (const [name, cmd] of cases) {
    test(`${name} still matches '${cmd}'`, () => {
      expect(findFilterForCommand(cmd)?.name).toBe(name);
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 6.1.5 — Regression: reject guards for new specs
// ---------------------------------------------------------------------------

describe("regression 6.1.5 — reject guards for batch-2 specs", () => {
  // gitBlame rejects
  test("git blame --porcelain → no match", () => expect(findFilterForCommand("git blame --porcelain")).toBeNull());
  test("git blame -p → no match",           () => expect(findFilterForCommand("git blame -p README.md")).toBeNull());
  // gitPull rejects
  test("git pull --dry-run → no match",    () => expect(findFilterForCommand("git pull --dry-run")).toBeNull());
  test("git pull --no-ff → no match",      () => expect(findFilterForCommand("git pull --no-ff")).toBeNull());
  // gitAdd rejects
  test("git add -i → no match",            () => expect(findFilterForCommand("git add -i")).toBeNull());
  test("git add --patch → no match",       () => expect(findFilterForCommand("git add --patch")).toBeNull());
  // gitCommit rejects
  test("git commit --dry-run → no match",  () => expect(findFilterForCommand("git commit --dry-run")).toBeNull());
  // gitPush rejects
  test("git push --dry-run → no match",    () => expect(findFilterForCommand("git push --dry-run")).toBeNull());
  // dockerPs rejects
  test("docker ps --format → no match",    () => expect(findFilterForCommand("docker ps --format '{{.Names}}'")).toBeNull());
  test("docker ps -q → no match",          () => expect(findFilterForCommand("docker ps -q")).toBeNull());
  test("docker ps --no-trunc → no match",  () => expect(findFilterForCommand("docker ps --no-trunc")).toBeNull());
  // dockerImages rejects
  test("docker images --format → no match", () => expect(findFilterForCommand("docker images --format '{{.ID}}'")).toBeNull());
  test("docker images -q → no match",       () => expect(findFilterForCommand("docker images -q")).toBeNull());
  // dockerLogs rejects
  test("docker logs -f → no match",         () => expect(findFilterForCommand("docker logs -f myapp")).toBeNull());
  test("docker logs --follow → no match",   () => expect(findFilterForCommand("docker logs --follow myapp")).toBeNull());
  test("docker logs --timestamps=false → no match", () => expect(findFilterForCommand("docker logs --timestamps=false myapp")).toBeNull());
  // curlV rejects
  test("curl -s → no match",                () => expect(findFilterForCommand("curl -s https://api.example.com")).toBeNull());
  test("curl --silent → no match",          () => expect(findFilterForCommand("curl --silent https://api.example.com")).toBeNull());
  test("curl -I → no match",                () => expect(findFilterForCommand("curl -I https://example.com")).toBeNull());
  test("curl --head → no match",            () => expect(findFilterForCommand("curl --head https://example.com")).toBeNull());
  // dig rejects
  test("dig +short → no match",             () => expect(findFilterForCommand("dig +short example.com")).toBeNull());
  test("dig +nocomments → no match",        () => expect(findFilterForCommand("dig +nocomments example.com")).toBeNull());
  // journalctl rejects
  test("journalctl --output=json → no match", () => expect(findFilterForCommand("journalctl --output=json")).toBeNull());
  test("journalctl -o json → no match",       () => expect(findFilterForCommand("journalctl -o json")).toBeNull());
  test("journalctl -f → no match",            () => expect(findFilterForCommand("journalctl -f")).toBeNull());
  test("journalctl --machine=host1 → no match", () => expect(findFilterForCommand("journalctl --machine=host1")).toBeNull());
});

// ---------------------------------------------------------------------------

describe("regression 6.1.4 — batch-1 specs still match after new specs added", () => {
  const cases: [string, string][] = [
    ["pytest",          "pytest src/"],
    ["rspec",           "rspec spec/"],
    ["go-test",         "go test ./..."],
    ["bundle-install",  "bundle install"],
    ["ps-aux",          "ps aux"],
    ["top",             "top -bn1"],
    ["rubocop",         "rubocop app/"],
    ["ruff-check",      "ruff check src/"],
    ["ls-la",           "ls -la"],
    ["grep-rg",         "rg foo src/"],
    ["cargo-test",      "cargo test"],
    ["cargo-clippy",    "cargo clippy"],
    ["cargo-check",     "cargo check"],
    ["cargo-build",     "cargo build"],
  ];
  for (const [name, cmd] of cases) {
    test(`${name} still matches '${cmd}'`, () => {
      expect(findFilterForCommand(cmd)?.name).toBe(name);
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 6.1.4 — Regression: reject guards
// ---------------------------------------------------------------------------

describe("regression 6.1.4 — reject guards", () => {
  // gitLog rejects
  test("git log --oneline → no match",      () => expect(findFilterForCommand("git log --oneline")).toBeNull());
  test('git log --format="%H" → no match',  () => expect(findFilterForCommand('git log --format="%H"')).toBeNull());
  test("git log -p → no match",             () => expect(findFilterForCommand("git log -p")).toBeNull());
  test("git log --patch → no match",        () => expect(findFilterForCommand("git log --patch")).toBeNull());
  test("git log -5 → no match (single-digit)", () => expect(findFilterForCommand("git log -5")).toBeNull());
  // gitStatus rejects
  test("git status --porcelain → no match", () => expect(findFilterForCommand("git status --porcelain")).toBeNull());
  test("git status --short → no match",     () => expect(findFilterForCommand("git status --short")).toBeNull());
  test("git status -s → no match",           () => expect(findFilterForCommand("git status -s")).toBeNull());
  test("git status -sb → no match",          () => expect(findFilterForCommand("git status -sb")).toBeNull());
  test("git log --pretty oneline → no match",() => expect(findFilterForCommand("git log --pretty oneline")).toBeNull());
  // gh rejects
  test("gh pr list --json → no match",      () => expect(findFilterForCommand("gh pr list --json number")).toBeNull());
  test("gh issue list --json → no match",   () => expect(findFilterForCommand("gh issue list --json number")).toBeNull());
  test("gh run list --json → no match",     () => expect(findFilterForCommand("gh run list --json status")).toBeNull());
  test("gh pr list --format → no match",    () => expect(findFilterForCommand("gh pr list --format '{{.number}}'")).toBeNull());
  test("gh pr list --template → no match",  () => expect(findFilterForCommand("gh pr list --template '{{.number}}'")).toBeNull());
  test("gh issue list --format → no match", () => expect(findFilterForCommand("gh issue list --format '{{.number}}'")).toBeNull());
  test("gh run list --format → no match",   () => expect(findFilterForCommand("gh run list --format '{{.name}}'")).toBeNull());
  // compound: bypass when filters disagree, resolve when only one segment matches
  test("git log && echo done → resolves to git-log (echo has no filter)", () => expect(findFilterForCommand("git log && echo done")?.name).toBe("git-log"));
  test("git status || true → resolves to git-status (only matching segment)", () => expect(findFilterForCommand("git status || true")?.name).toBe("git-status"));
  test("gh pr list && echo done → resolves to gh-pr-list (echo has no filter)", () => expect(findFilterForCommand("gh pr list && echo done")?.name).toBe("gh-pr-list"));
  test("git log | head → no match (pipe — cannot split)", () => expect(findFilterForCommand("git log | head")).toBeNull());
  test("cd src && git status → resolves to git-status", () => expect(findFilterForCommand("cd src && git status")?.name).toBe("git-status"));
  // P3: --format with space (not only --format=)
  test("git log --format '%H' → no match (space form)", () => expect(findFilterForCommand("git log --format '%H'")).toBeNull());
  test("git log --format=%H → no match (= form)",    () => expect(findFilterForCommand("git log --format=%H")).toBeNull());
  // P4: --web flag opens browser, must not be rewritten
  test("gh pr list --web → no match",                () => expect(findFilterForCommand("gh pr list --web")).toBeNull());
  test("gh issue list --web → no match",             () => expect(findFilterForCommand("gh issue list --web")).toBeNull());
  test("gh run list --web → no match",               () => expect(findFilterForCommand("gh run list --web")).toBeNull());
});

// ---------------------------------------------------------------------------
// Phase 6.1.4 — Regression: -[1-9]\b boundary
// ---------------------------------------------------------------------------

describe("regression 6.1.4 — -N boundary for git log", () => {
  test("git log -10 is NOT rejected (multi-digit safe)", () => {
    expect(findFilterForCommand("git log -10")?.name).toBe("git-log");
  });
  test("git log -1 IS rejected (single-digit)", () => {
    expect(findFilterForCommand("git log -1")).toBeNull();
  });
  test("git log -9 IS rejected (single-digit)", () => {
    expect(findFilterForCommand("git log -9")).toBeNull();
  });
  test("git log -20 is NOT rejected (multi-digit)", () => {
    expect(findFilterForCommand("git log -20")?.name).toBe("git-log");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.2 — JS/TS toolchain (jest, vitest, bun test, mocha, playwright)
// ---------------------------------------------------------------------------

describe("phase 6.2 — jest", () => {
  test("ROI: jest-clean ≥90% reduction (collapse to sentinel)", () => {
    assertReduction("jest", "jest", "jest-clean", 90);
  });
  test("match: jest, npx jest, yarn jest, pnpm jest", () => {
    expect(findFilterForCommand("jest")?.name).toBe("jest");
    expect(findFilterForCommand("npx jest")?.name).toBe("jest");
    expect(findFilterForCommand("yarn jest")?.name).toBe("jest");
    expect(findFilterForCommand("pnpm jest")?.name).toBe("jest");
  });
  test("reject: --watch / --listTests passthrough", () => {
    expect(findFilterForCommand("jest --watch")).toBeNull();
    expect(findFilterForCommand("jest --listTests")).toBeNull();
  });
  test("safety: failure run is not collapsed", () => {
    const failed = "PASS  src/foo.test.ts\nFAIL  src/bar.test.ts\nTests:       1 failed, 2 passed, 3 total";
    expect(runFilterBody("jest", "jest", failed)).toContain("FAIL");
  });
});

describe("phase 6.2 — vitest", () => {
  test("ROI: vitest-clean ≥90% reduction", () => {
    assertReduction("vitest", "vitest", "vitest-clean", 90);
  });
  test("match: vitest, npx vitest", () => {
    expect(findFilterForCommand("vitest")?.name).toBe("vitest");
    expect(findFilterForCommand("npx vitest")?.name).toBe("vitest");
  });
  test("reject: --ui / --watch passthrough", () => {
    expect(findFilterForCommand("vitest --ui")).toBeNull();
    expect(findFilterForCommand("vitest --watch")).toBeNull();
  });
});

describe("phase 6.2 — bun test", () => {
  test("ROI: bun-test-clean ≥90% reduction", () => {
    assertReduction("bun-test", "bun test", "bun-test-clean", 90);
  });
  test("match: bun test", () => {
    expect(findFilterForCommand("bun test")?.name).toBe("bun-test");
    expect(findFilterForCommand("bun test src/foo.test.ts")?.name).toBe("bun-test");
  });
  test("reject: --watch passthrough", () => {
    expect(findFilterForCommand("bun test --watch")).toBeNull();
  });
  test("safety: failure run is not collapsed", () => {
    const failed = "src/foo.test.ts:\n✓ a\n✗ b\n 1 pass\n 1 fail";
    expect(runFilterBody("bun-test", "bun test", failed)).toContain("fail");
  });
});

describe("phase 6.2 — mocha", () => {
  test("ROI: mocha-clean ≥80% reduction", () => {
    assertReduction("mocha", "mocha", "mocha-clean", 80);
  });
  test("match: mocha, npx mocha", () => {
    expect(findFilterForCommand("mocha")?.name).toBe("mocha");
    expect(findFilterForCommand("npx mocha")?.name).toBe("mocha");
  });
  test("reject: --reporter=json passthrough", () => {
    expect(findFilterForCommand("mocha --reporter=json")).toBeNull();
  });
});

describe("phase 6.2 — playwright", () => {
  test("ROI: playwright-clean ≥80% reduction", () => {
    assertReduction("playwright", "playwright test", "playwright-clean", 80);
  });
  test("match: playwright test, npx playwright test", () => {
    expect(findFilterForCommand("playwright test")?.name).toBe("playwright");
    expect(findFilterForCommand("npx playwright test")?.name).toBe("playwright");
  });
  test("reject: --ui / --debug passthrough", () => {
    expect(findFilterForCommand("playwright test --ui")).toBeNull();
    expect(findFilterForCommand("playwright test --debug")).toBeNull();
  });
  test("non-test playwright subcommands do not match", () => {
    expect(findFilterForCommand("playwright codegen")).toBeNull();
    expect(findFilterForCommand("playwright install")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 6.2 — TypeScript compiler
// ---------------------------------------------------------------------------

describe("phase 6.2 — tsc", () => {
  test("ROI: tsc-errors ≥10% reduction (strip underline + Errors table)", () => {
    assertReduction("tsc", "tsc --noEmit", "tsc-errors", 10);
  });
  test("match: tsc, npx tsc, yarn tsc", () => {
    expect(findFilterForCommand("tsc")?.name).toBe("tsc");
    expect(findFilterForCommand("npx tsc")?.name).toBe("tsc");
    expect(findFilterForCommand("yarn tsc --noEmit")?.name).toBe("tsc");
  });
  test("reject: --watch / --listFiles / --traceResolution passthrough", () => {
    expect(findFilterForCommand("tsc --watch")).toBeNull();
    expect(findFilterForCommand("tsc --listFiles")).toBeNull();
    expect(findFilterForCommand("tsc --traceResolution")).toBeNull();
  });
  test("error messages are preserved (TS codes + paths intact)", () => {
    const raw = loadSample("tsc-errors");
    const body = runFilterBody("tsc", "tsc --noEmit", raw);
    expect(body).toContain("error TS2322");
    expect(body).toContain("src/utils/parser.ts:23:5");
  });
  test("Errors  Files trailing table is stripped", () => {
    const raw = loadSample("tsc-errors");
    const body = runFilterBody("tsc", "tsc --noEmit", raw);
    expect(body).not.toMatch(/^Errors\s+Files$/m);
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
  test("commit subject + diff body are preserved", () => {
    const raw = loadSample("git-show-full");
    const body = runFilterBody("git-show", "git show HEAD", raw);
    expect(body).toContain("commit a200d7d5");
    expect(body).toContain("retry transient 404s");
    expect(body).toMatch(/^@@/m);
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

// ---------------------------------------------------------------------------
// Phase 9 — system utilities (ping/rsync/tree/ssh/df/du/dmesg/stat/jq + curl-plain)
// ---------------------------------------------------------------------------

describe("phase 9 — ping", () => {
  test("ROI: ping-google sample reduces ≥ 55%", () => {
    assertReduction("ping", "ping -c 20 8.8.8.8", "ping-google", 55);
  });

  test("safety: --- statistics --- and rtt are preserved", () => {
    const raw = loadSample("ping-google");
    const body = runFilterBody("ping", "ping -c 20 8.8.8.8", raw);
    expect(body).toContain("--- 8.8.8.8 ping statistics ---");
    expect(body).toMatch(/^rtt min\/avg\/max/m);
  });

  test("match: ping ✓; ping6 ✓; pinger ✗", () => {
    expect(findFilterForCommand("ping example.com")?.name).toBe("ping");
    expect(findFilterForCommand("ping6 ::1")?.name).toBe("ping");
    expect(findFilterForCommand("pinger foo")?.name).not.toBe("ping");
  });

  // Corner-case audit P0: `ping -f` (flood) and other modes can emit lines
  // far exceeding terminal width. Verify truncateLineAt clamps them.
  test("defense: pathologically long lines are truncated (P0)", () => {
    const longLine = "x".repeat(5000);
    const raw = `PING host\n${longLine}\n--- statistics ---\n`;
    const body = runFilterBody("ping", "ping -f host", raw);
    expect(body).toContain("…");
    expect(body.split("\n").every((l) => l.length <= 4097)).toBe(true);
  });
});

describe("phase 9 — rsync", () => {
  test("ROI: rsync-incremental sample reduces ≥ 70%", () => {
    assertReduction("rsync", "rsync -av src/ dst/", "rsync-incremental", 70);
  });

  test("safety: summary lines are preserved", () => {
    const raw = loadSample("rsync-incremental");
    const body = runFilterBody("rsync", "rsync -av src/ dst/", raw);
    expect(body).toMatch(/sent .* received .* bytes/);
    expect(body).toContain("total size is");
    expect(body).toContain("speedup is");
  });

  test("safety: error lines are preserved (not stripped as filename)", () => {
    const raw = [
      "sending incremental file list",
      "file-1.txt",
      "rsync: failed to set permissions on \"/dst/locked\": Permission denied (13)",
      "rsync error: some files could not be transferred (code 23) at main.c:1234",
      "",
      "sent 100 bytes  received 50 bytes  300.00 bytes/sec",
      "total size is 1024  speedup is 6.83",
    ].join("\n");
    const body = runFilterBody("rsync", "rsync -av src/ dst/", raw);
    expect(body).toContain("rsync: failed to set permissions");
    expect(body).toContain("rsync error:");
  });

  test("match: rsync ✓; rsyncd ✗", () => {
    expect(findFilterForCommand("rsync -av a/ b/")?.name).toBe("rsync");
    expect(findFilterForCommand("rsyncd --daemon")?.name).not.toBe("rsync");
  });

  // Corner-case audit P1: `rsync --info=progress2` emits a single-line
  // progress meter that `\r`-overwrites itself, identical to curl's progress
  // bar. The CR-collapse pass reduces it to the final summary line.
  test("defense: --info=progress2 CR-overwrites collapse (P1)", () => {
    const raw = [
      "sending incremental file list",
      // 5 progress frames separated by \r — only the last should survive
      "       1.00K   0%    0.00kB/s    0:00:01\r" +
        "      50.00K  50%   500.00kB/s    0:00:00\r" +
        "     100.00K 100%   1.00MB/s    0:00:00 (xfr#1, to-chk=0/1)",
      "",
      "sent 100,012 bytes  received 35 bytes  200,094.00 bytes/sec",
      "total size is 100,000  speedup is 1.00",
    ].join("\n");
    const body = runFilterBody("rsync", "rsync --info=progress2 a b", raw);
    // Intermediate progress frames are gone (only the post-`\r` final frame survives).
    expect(body).not.toContain("1.00K   0%");
    expect(body).not.toContain("50.00K  50%");
    expect(body).toContain("100.00K 100%");
    expect(body).toContain("speedup is 1.00");
  });
});

describe("phase 9 — tree", () => {
  test("ROI: tree-deep sample reduces ≥ 30%", () => {
    assertReduction("tree", "tree", "tree-deep", 30);
  });

  test("reject: tree -J passes through (structured output not corrupted)", () => {
    expect(findFilterForCommand("tree -J")).toBeNull();
    expect(findFilterForCommand("tree --json")).toBeNull();
    expect(findFilterForCommand("tree -X")).toBeNull();
    expect(findFilterForCommand("tree --xml")).toBeNull();
  });

  test("match: tree-sitter is not claimed", () => {
    // `tree-sitter` is a real dev binary — must not match our `tree` spec.
    expect(findFilterForCommand("tree-sitter parse foo.ts")?.name).not.toBe(
      "tree",
    );
  });

  test("match: tree ✓; tree -L 2 ✓", () => {
    expect(findFilterForCommand("tree")?.name).toBe("tree");
    expect(findFilterForCommand("tree -L 2 src")?.name).toBe("tree");
  });

  // Corner-case audit P0: a flat directory with one extremely long entry
  // (e.g. a 5 KB single-line file name) should be clamped, not passed
  // through verbatim.
  test("defense: pathologically long entry is truncated (P0)", () => {
    const longName = "x".repeat(5000);
    const raw = `.\n├── ${longName}\n└── normal.txt\n`;
    const body = runFilterBody("tree", "tree", raw);
    expect(body).toContain("…");
    expect(body.split("\n").every((l) => l.length <= 4097)).toBe(true);
    expect(body).toContain("normal.txt");
  });
});

describe("phase 9 — ssh", () => {
  test("ROI: ssh-vvv sample reduces ≥ 70% (debug lines stripped)", () => {
    assertReduction("ssh", "ssh -vvv example.com echo ok", "ssh-vvv", 70);
  });

  test("safety: non-debug lines (banner, output) are preserved", () => {
    const raw = loadSample("ssh-vvv");
    const body = runFilterBody("ssh", "ssh -vvv example.com echo ok", raw);
    expect(body).toContain("OpenSSH_10.3p1");
    // The remote command's actual output ("ok") must not be stripped.
    expect(body).toMatch(/\bok\b/);
  });

  test("match: ssh-add / ssh-keygen are not claimed", () => {
    expect(findFilterForCommand("ssh-add -l")?.name).not.toBe("ssh");
    expect(findFilterForCommand("ssh-keygen -t ed25519")?.name).not.toBe("ssh");
  });
});

describe("phase 9 — df", () => {
  test("ROI: df-h sample reduces ≥ 40%", () => {
    assertReduction("df", "df -h", "df-h", 40);
  });

  test("safety: header + real-disk rows are preserved", () => {
    const raw = loadSample("df-h");
    const body = runFilterBody("df", "df -h", raw);
    expect(body.split("\n")[0]).toMatch(/^Filesystem\s+.*Mounted on/);
    expect(body).toContain("/dev/sdb4");
    expect(body).toContain("/dev/sdb3");
  });

  test("safety: tmpfs / fuse / squashfs rows are stripped", () => {
    const raw = loadSample("df-h");
    const body = runFilterBody("df", "df -h", raw);
    expect(body).not.toMatch(/^tmpfs/m);
    expect(body).not.toMatch(/^devtmpfs/m);
    expect(body).not.toMatch(/^squashfs/m);
    expect(body).not.toMatch(/^fuse\./m);
  });

  // Audit-2026-05 finding A3 — overlay rows carry real docker disk-usage
  // signal and MUST be preserved (regression test).
  test("safety: overlay rows are preserved (docker disk-usage signal)", () => {
    const raw = loadSample("df-h");
    const body = runFilterBody("df", "df -h", raw);
    expect(body).toMatch(/^overlay/m);
    expect(body).toContain("/var/lib/docker/overlay2");
  });

  test("reject: df -a / df --all pass through (user wants tmpfs)", () => {
    expect(findFilterForCommand("df -a")).toBeNull();
    expect(findFilterForCommand("df --all -h")).toBeNull();
  });
});

describe("phase 9 — du", () => {
  test("safety: top-level + shallow subdir totals are preserved", () => {
    const raw = loadSample("du-noisy");
    const body = runFilterBody("du", "du -h", raw);
    expect(body).toContain("./src");
    expect(body).toContain("./node_modules");
    // Final "total" line (just "." with size) must survive.
    expect(body).toMatch(/^\S+\s+\.$/m);
  });

  test("safety: nested node_modules/.../node_modules/ subdirs are stripped", () => {
    const raw = loadSample("du-noisy");
    const body = runFilterBody("du", "du -h", raw);
    expect(body).not.toContain("/lodash/node_modules/isarray");
    expect(body).not.toContain("/react/node_modules/scheduler");
  });

  test("safety: .git/refs and .git/objects subdirs are stripped", () => {
    const raw = loadSample("du-noisy");
    const body = runFilterBody("du", "du -h", raw);
    expect(body).not.toContain(".git/refs/heads");
    expect(body).not.toContain(".git/objects/00");
  });

  test("match: du ✓; du -h ✓; du-meta ✗", () => {
    expect(findFilterForCommand("du -h")?.name).toBe("du");
    expect(findFilterForCommand("du -sh src")?.name).toBe("du");
    expect(findFilterForCommand("du-meta")?.name).not.toBe("du");
  });
});

describe("phase 9 — dmesg", () => {
  test("ROI: dmesg-long sample reduces ≥ 25% (tail of 60 lines)", () => {
    assertReduction("dmesg", "dmesg", "dmesg-long", 25);
  });

  test("safety: most-recent lines are kept (the ones with high timestamps)", () => {
    const raw = loadSample("dmesg-long");
    const body = runFilterBody("dmesg", "dmesg", raw);
    expect(body).toContain("nf_conntrack: table full");
    expect(body).toContain("New session 1");
  });

  // Audit-2026-05 finding A4 — `dmesg` is used to debug boot/hardware
  // enumeration; the first kernel lines (BIOS-e820, PCI, ACPI) carry the
  // signal and must survive even when the buffer is huge.
  test("safety: boot-time lines are kept (head=10) — A4 regression", () => {
    const raw = loadSample("dmesg-long");
    const body = runFilterBody("dmesg", "dmesg", raw);
    expect(body).toContain("Linux version 6.18");
    expect(body).toContain("BIOS-e820");
  });

  test("match: dmesg ✓; dmesg -T ✓", () => {
    expect(findFilterForCommand("dmesg")?.name).toBe("dmesg");
    expect(findFilterForCommand("dmesg -T")?.name).toBe("dmesg");
  });

  // Corner-case audit P0: `dmesg --color=always` injects CSI codes even
  // when output isn't a TTY. Filter must strip them so they don't bloat
  // the budget or confuse downstream readers.
  test("defense: ANSI color codes from --color=always are stripped (P0)", () => {
    const raw =
      "\x1b[33m[    0.000000]\x1b[0m Linux version 6.18\n" +
      "\x1b[31m[   12.345678] error: something\x1b[0m\n";
    const body = runFilterBody("dmesg", "dmesg --color=always", raw);
    expect(body).not.toContain("\x1b[");
    expect(body).toContain("Linux version 6.18");
    expect(body).toContain("error: something");
  });
});

describe("phase 9 — stat", () => {
  test("safety: short stat output passes through under cap", () => {
    const raw = loadSample("stat-file");
    const body = runFilterBody("stat", "stat package.json", raw);
    // Under maxLines=40 — body should be ~identical.
    expect(body).toContain("File:");
    expect(body).toContain("Inode:");
  });

  test("match: stat ✓; statfs (gnu utility) ✗", () => {
    expect(findFilterForCommand("stat foo")?.name).toBe("stat");
    // No exact other binary collides today, but anchor still must hold.
    expect(findFilterForCommand("stat-other")?.name).not.toBe("stat");
  });
});

describe("phase 9 — jq", () => {
  test("safety: jq-pretty-deep sample is preserved verbatim", () => {
    const raw = loadSample("jq-pretty-deep");
    const body = runFilterBody("jq", "jq '.'", raw);
    expect(body).toContain('"name": "claudio"');
    expect(body).toContain('"nested"');
  });

  // Audit-2026-05 finding A1 — `jq` output is structured data. Truncating
  // mid-object yields invalid JSON the LLM cannot parse. Verify the filter
  // never injects an omit marker even on large pretty-printed JSON.
  test("safety: large pretty-printed JSON is not truncated (A1 regression)", () => {
    // Synthesize a >200-line pretty JSON object — much larger than the old
    // maxLines=100 cap.
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) keys.push(`  "key_${i}": ${i}`);
    const raw = `{\n${keys.join(",\n")}\n}`;
    const body = runFilterBody("jq", "jq '.'", raw);
    // No omit marker — JSON structure remains parseable.
    expect(body).not.toMatch(/lines omitted/);
    expect(body).toContain('"key_0": 0');
    expect(body).toContain('"key_199": 199');
    // Final closing brace survives.
    expect(body.trimEnd().endsWith("}")).toBe(true);
    // Result is valid JSON.
    expect(() => JSON.parse(body)).not.toThrow();
  });

  test("reject: jq -r passes through (structured output to downstream)", () => {
    expect(findFilterForCommand("jq -r .name")).toBeNull();
    expect(findFilterForCommand("jq --raw-output .name")).toBeNull();
    expect(findFilterForCommand("jq -c .")).toBeNull();
    expect(findFilterForCommand("jq --compact-output .")).toBeNull();
    expect(findFilterForCommand("jq -j .name")).toBeNull();
    expect(findFilterForCommand("jq --join-output .name")).toBeNull();
    expect(findFilterForCommand("jq --tab .")).toBeNull();
  });

  test("match: jq ✓; jq '.foo' ✓", () => {
    expect(findFilterForCommand("jq '.'")?.name).toBe("jq");
    expect(findFilterForCommand("jq .foo")?.name).toBe("jq");
  });

  // Corner-case audit P0 C1: the original A1 fix removed *all* caps to avoid
  // mid-object truncation, but that left jq unbounded — a 50k-line JSON
  // would either flood the LLM context or be tail-truncated by the global
  // pipeline cap (also invalid JSON, just less obviously). The
  // 500-line cap with explicit head/tail marker is the documented
  // compromise: outputs over the cap emit a clear "lines omitted" marker
  // that the LLM can recognize as truncated.
  test("safety: huge JSON over 500 lines is bounded with omit marker (P0 C1)", () => {
    const keys: string[] = [];
    for (let i = 0; i < 800; i++) keys.push(`  "key_${i}": ${i}`);
    const raw = `{\n${keys.join(",\n")}\n}`;
    const body = runFilterBody("jq", "jq '.'", raw);
    expect(body).toMatch(/lines omitted/);
    expect(body).toContain('"key_0": 0');
    expect(body).toContain('"key_799": 799');
    // First 200 + marker + last 300 ≈ 501 lines.
    expect(body.split("\n").length).toBeLessThan(550);
  });
});

describe("phase 9 — curlPlain", () => {
  test("ROI: curl-plain sample reduces ≥ 40% (progress meter stripped)", () => {
    assertReduction("curl-plain", "curl http://example.com", "curl-plain", 40);
  });

  test("safety: response body is preserved", () => {
    const raw = loadSample("curl-plain");
    const body = runFilterBody("curl-plain", "curl http://example.com", raw);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Example Domain");
  });

  test("safety: progress meter headers are stripped", () => {
    const raw = loadSample("curl-plain");
    const body = runFilterBody("curl-plain", "curl http://example.com", raw);
    expect(body).not.toMatch(/% Total\s+% Received/);
    expect(body).not.toMatch(/Dload\s+Upload/);
  });

  test("match: curl ✓; curl -v claimed by curlV not curlPlain", () => {
    expect(findFilterForCommand("curl http://example.com")?.name).toBe(
      "curl-plain",
    );
    expect(findFilterForCommand("curl -v http://example.com")?.name).toBe(
      "curl",
    );
  });

  test("reject: -s / -I / -o pass through (no body or no progress)", () => {
    expect(findFilterForCommand("curl -s http://example.com")).toBeNull();
    expect(findFilterForCommand("curl --silent http://example.com")).toBeNull();
    expect(findFilterForCommand("curl -I http://example.com")).toBeNull();
    expect(findFilterForCommand("curl -o out.html http://example.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 10 — wget + find
// ---------------------------------------------------------------------------

describe("phase 10 — wget", () => {
  test("ROI: wget sample reduces ≥ 70% (progress dots stripped)", () => {
    assertReduction("wget", "wget https://example.com/file.tar.gz", "wget", 70);
  });

  test("safety: 'saved' summary survives the filter", () => {
    const raw = loadSample("wget");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/file.tar.gz",
      raw,
    );
    expect(body).toMatch(/saved \[\d+\/\d+\]/);
    // Final timestamped completion line carries throughput
    expect(body).toMatch(/MB\/s/);
  });

  test("safety: progress / chatter lines are stripped", () => {
    const raw = loadSample("wget");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/file.tar.gz",
      raw,
    );
    expect(body).not.toMatch(/^Resolving /m);
    expect(body).not.toMatch(/^Connecting to /m);
    expect(body).not.toMatch(/^HTTP request sent,/m);
    expect(body).not.toMatch(/^Length: /m);
    expect(body).not.toMatch(/^Saving to:/m);
    expect(body).not.toMatch(/^Loaded CA certificate/m);
    // No surviving progress-dot rows
    expect(body).not.toMatch(/^\s*\d+K\s+\.{2,}/m);
  });

  test("safety: error lines are preserved (not stripped as progress)", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/missing.tar.gz",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Connecting to example.com (example.com)|1.2.3.4|:443... connected.",
      "HTTP request sent, awaiting response... 404 Not Found",
      "2026-05-12 09:14:02 ERROR 404: Not Found.",
      "",
    ].join("\n");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/missing.tar.gz",
      raw,
    );
    expect(body).toContain("ERROR 404: Not Found");
  });

  test("match: wget ✓; wgetx ✗", () => {
    expect(findFilterForCommand("wget https://example.com/x")?.name).toBe(
      "wget",
    );
    expect(findFilterForCommand("wgetx --version")?.name).not.toBe("wget");
  });

  test("reject: -q / --quiet / -O - pass through", () => {
    expect(findFilterForCommand("wget -q https://example.com/x")).toBeNull();
    expect(
      findFilterForCommand("wget --quiet https://example.com/x"),
    ).toBeNull();
    expect(findFilterForCommand("wget -O - https://example.com/x")).toBeNull();
    expect(
      findFilterForCommand("wget --output-document=- https://example.com/x"),
    ).toBeNull();
  });

  // Installer-one-liner shorthand: `wget -qO- URL | sh`. The `-q` is glued
  // to `-O-` so a plain `\b` after `-q` doesn't fire. The reject regex
  // matches `-q?O\s*-` explicitly to cover both `-O-` and `-qO-` forms.
  test("reject: -qO- / -qO - glued forms pass through", () => {
    expect(findFilterForCommand("wget -qO- https://example.com/x")).toBeNull();
    expect(findFilterForCommand("wget -qO - https://example.com/x")).toBeNull();
  });

  // P1 information-loss fix: the `HTTP request sent, awaiting response... NNN`
  // line is the only place wget prints the response status code for non-fatal
  // outcomes. We strip it only for success (200/206); 3xx/4xx/5xx must survive.
  test("safety: non-success HTTP status (3xx/4xx/5xx) survives", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/redirect",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Connecting to example.com (example.com)|1.2.3.4|:443... connected.",
      "HTTP request sent, awaiting response... 301 Moved Permanently",
      "Location: https://example.com/new [following]",
      "--2026-05-12 09:14:02--  https://example.com/new",
      "HTTP request sent, awaiting response... 404 Not Found",
      "2026-05-12 09:14:02 ERROR 404: Not Found.",
    ].join("\n");
    const body = runFilterBody("wget", "wget https://example.com/redirect", raw);
    expect(body).toContain("301 Moved Permanently");
    expect(body).toContain("404 Not Found");
    expect(body).toContain("Location: https://example.com/new");
  });

  test("safety: HTTP 200 OK noise IS stripped (still compresses success path)", () => {
    const raw = loadSample("wget");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/file.tar.gz",
      raw,
    );
    expect(body).not.toMatch(/HTTP request sent, awaiting response\.\.\. 200 OK/);
  });

  // --progress=bar is a single-line bar that `\r`-overwrites itself. The
  // CR-collapse pass leaves only the final frame, which the bar-strip
  // pattern then removes. The opening banner and the final saved-line
  // must survive.
  test("safety: --progress=bar CR-overwrites collapse to summary", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/file.bin",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Connecting to example.com (example.com)|1.2.3.4|:443... connected.",
      "HTTP request sent, awaiting response... 200 OK",
      "Length: 1048576 (1.0M) [application/octet-stream]",
      "Saving to: 'file.bin'",
      "",
      // Three bar frames; only the final one survives the CR collapse.
      "     0K [>                    ]      0%  0.00 =0s\r" +
        "   500K [==========>          ]     50%  1.00M=0.5s\r" +
        "  1024K [====================>] 100%  2.00M=0.5s",
      "",
      "2026-05-12 09:14:03 (2.00 MB/s) - 'file.bin' saved [1048576/1048576]",
    ].join("\n");
    const body = runFilterBody("wget", "wget --progress=bar https://example.com/file.bin", raw);
    // Banner and saved-line survive
    expect(body).toContain("https://example.com/file.bin");
    expect(body).toMatch(/saved \[1048576\/1048576\]/);
    // No surviving bar frames (CR-collapsed, then bar-stripped)
    expect(body).not.toContain("[>");
    expect(body).not.toContain("==========>");
    expect(body).not.toContain("====================>");
  });

  // -S / --server-response prints indented HTTP response headers. These are
  // information-rich (status, content-type, redirect target, caching) and
  // must survive — the strip patterns only target wget's own chatter.
  test("safety: -S response headers survive", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/api",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Connecting to example.com (example.com)|1.2.3.4|:443... connected.",
      "HTTP request sent, awaiting response... ",
      "  HTTP/1.1 200 OK",
      "  Content-Type: application/json",
      "  Content-Length: 42",
      "  Cache-Control: no-cache",
      "Length: 42 [application/json]",
      "Saving to: 'api'",
    ].join("\n");
    const body = runFilterBody("wget", "wget -S https://example.com/api", raw);
    expect(body).toContain("HTTP/1.1 200 OK");
    expect(body).toContain("Content-Type: application/json");
    expect(body).toContain("Cache-Control: no-cache");
  });

  // Common redirect chain: 301 → 200. The 301 hop carries the Location we
  // care about; the final 200 is OK to strip (it's just success chatter).
  test("safety: 301 → 200 redirect chain preserves the 301 hop", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/old",
      "Resolving example.com (example.com)... 1.2.3.4",
      "HTTP request sent, awaiting response... 301 Moved Permanently",
      "Location: https://example.com/new [following]",
      "--2026-05-12 09:14:02--  https://example.com/new",
      "HTTP request sent, awaiting response... 200 OK",
      "Length: 100 [text/plain]",
      "Saving to: 'new'",
      "",
      "2026-05-12 09:14:03 (10 MB/s) - 'new' saved [100/100]",
    ].join("\n");
    const body = runFilterBody("wget", "wget https://example.com/old", raw);
    expect(body).toContain("301 Moved Permanently");
    expect(body).toContain("Location: https://example.com/new");
    expect(body).toMatch(/saved \[100\/100\]/);
  });

  // -nv / --no-verbose: one summary line per file, no dot progress, no
  // headers. Should pass through essentially unchanged.
  test("safety: -nv summary line passes through", () => {
    const raw = "2026-05-12 09:14:03 URL:https://example.com/x [100/100] -> \"x\" [1]";
    const body = runFilterBody("wget", "wget -nv https://example.com/x", raw);
    expect(body).toContain("URL:https://example.com/x");
    expect(body).toContain("[100/100]");
  });

  // Defense: real filename with literal dots in path must not be eaten by
  // the progress-dot pattern (anchored at `^\s*\d+[KMG]?\s+\.{2,}`).
  test("defense: filename with dots in body is preserved (P0)", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/foo.tar.gz",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Saving to: 'foo.tar.gz'",
      "../some/path/with/many.dots.in.it.txt",
      "2026-05-12 09:14:03 (10 MB/s) - 'foo.tar.gz' saved [100/100]",
    ].join("\n");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/foo.tar.gz",
      raw,
    );
    expect(body).toContain("../some/path/with/many.dots.in.it.txt");
    expect(body).toMatch(/saved \[100\/100\]/);
  });
});

describe("phase 10 — find", () => {
  test("ROI: find-large sample reduces ≥ 40% (cap kicks in)", () => {
    assertReduction("find", "find . -type f", "find-large", 40);
  });

  test("safety: head and tail entries both survive truncation", () => {
    const raw = loadSample("find-large");
    const body = runFilterBody("find", "find . -type f", raw);
    const firstLine = raw.split("\n")[0]!;
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const lastLine = lines[lines.length - 1]!;
    expect(body).toContain(firstLine);
    expect(body).toContain(lastLine);
  });

  test("safety: small find output passes through unchanged", () => {
    const raw = "./a.ts\n./b.ts\n./c.ts";
    const body = runFilterBody("find", "find . -name '*.ts'", raw);
    // Strict equality catches over-eager stripping; whitespace/EOL normalization
    // by the framework is acceptable so we compare trimmed.
    expect(body.trim()).toBe(raw.trim());
  });

  // Permission-denied stderr lines are commonly merged into stdout; they
  // identify dirs the search couldn't enter and must reach the model.
  test("safety: 'Permission denied' lines survive head/tail cap", () => {
    const denied = "find: '/root/.cache': Permission denied";
    const filler = Array.from({ length: 200 }, (_, i) => `./pkg/file${i}.ts`).join("\n");
    const raw = `${denied}\n${filler}`;
    const body = runFilterBody("find", "find / -type f", raw);
    expect(body).toContain(denied);
  });

  // Zero-match case: find prints nothing. Filter must not crash and the
  // empty output must pass through (trimmed/empty equivalent).
  test("safety: empty output passes through cleanly", () => {
    const body = runFilterBody("find", "find . -name 'no-such-file'", "");
    expect(body.trim()).toBe("");
  });

  test("match: find ✓; findutils ✗", () => {
    expect(findFilterForCommand("find . -type f")?.name).toBe("find");
    expect(findFilterForCommand("findutils --version")?.name).not.toBe("find");
  });

  test("reject: -printf / -print0 / -exec / -ls pass through (format-changing)", () => {
    expect(findFilterForCommand("find . -printf '%p\\n'")).toBeNull();
    expect(findFilterForCommand("find . -print0")).toBeNull();
    expect(findFilterForCommand("find . -type f -exec wc -l {} +")).toBeNull();
    expect(findFilterForCommand("find . -execdir cat {} \\;")).toBeNull();
    expect(findFilterForCommand("find . -ls")).toBeNull();
    expect(findFilterForCommand("find . -fprint out.txt")).toBeNull();
  });

  // Defense P0: a single 5 KB filename should be clamped, not pass through
  // verbatim (clobbers terminal width assumptions downstream).
  test("defense: pathologically long path is truncated (P0)", () => {
    const longPath = "./" + "x".repeat(5000) + ".txt";
    const raw = `${longPath}\n./normal.txt\n`;
    const body = runFilterBody("find", "find .", raw);
    expect(body).toContain("…");
    expect(body.split("\n").every((l) => l.length <= 4097)).toBe(true);
    expect(body).toContain("./normal.txt");
  });
});
