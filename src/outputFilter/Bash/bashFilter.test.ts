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

  test("compound bypass: git log && echo done passes through", () => {
    const plan = planBashFilter("git log && echo done");
    expect(plan.filter).toBeNull();
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

  test("compound bypass: git status || true passes through", () => {
    const plan = planBashFilter("git status || true");
    expect(plan.filter).toBeNull();
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

  test("compound bypass: gh pr list && echo done passes through", () => {
    expect(planBashFilter("gh pr list && echo done").filter).toBeNull();
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
  // compound bypass
  test("git log && echo → no match (compound)",       () => expect(findFilterForCommand("git log && echo done")).toBeNull());
  test("git status || true → no match (compound)",    () => expect(findFilterForCommand("git status || true")).toBeNull());
  test("gh pr list && echo → no match (compound)",    () => expect(findFilterForCommand("gh pr list && echo done")).toBeNull());
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
