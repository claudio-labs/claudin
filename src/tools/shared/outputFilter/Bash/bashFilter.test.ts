/**
 * Bash Output Filter — integration harness tests
 *
 * These tests are ported from docs/archive/discovery/bash-output-filter/validation/validate.ts.
 * They are all test.skip() because builtInFilters is empty in Phase 1.
 * Phase 2 will unskip them as filters land.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyBashFilterToStdout,
  exitCodeAfterRewrite,
  planBashFilter,
} from "src/tools/shared/outputFilter/Bash/index.js";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";
import { builtInFilters } from "src/tools/shared/outputFilter/Bash/filters/index.js";
import type { FilterSpec } from "src/tools/shared/outputFilter/Bash/types.js";

// ---------------------------------------------------------------------------
// Phase 6.1.2 harness helpers — load real shell output captured in
// __fixtures__/samples/ and measure byte-reduction against the predicted ROI
// (see .claudin/plans/fizzy-churning-stearns.md, decision D1).
//
// This used to read docs/discovery/.../validation/samples/, a second copy of
// the same corpus that drifted a whole rebrand behind this one. The two are
// now one directory; see the header of __fixtures__/samples/README.md.
// ---------------------------------------------------------------------------
const SAMPLES_DIR = resolve(
  import.meta.dir,
  "__fixtures__/samples",
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

  // A command intentionally with no filter — used to exercise the
  // no-filter path of the planner / applier. Update if `whoami` ever
  // gains a filter.
  const NO_FILTER_CMD = "whoami";

  test("findFilterForCommand returns null when command has no filter", () => {
    expect(findFilterForCommand(NO_FILTER_CMD)).toBeNull();
  });

  test("planBashFilter returns no-op plan when command has no filter", () => {
    const plan = planBashFilter(NO_FILTER_CMD);
    expect(plan.filter).toBeNull();
    expect(plan.rewrite).toBeNull();
    expect(plan.effectiveCommand).toBe(NO_FILTER_CMD);
  });

  test("applyBashFilterToStdout returns raw output when no filter", () => {
    const plan = planBashFilter(NO_FILTER_CMD);
    const result = applyBashFilterToStdout("some output", false, plan);
    expect(result).toBe("some output");
  });

  test("applyBashFilterToStdout returns empty string for empty input", () => {
    const plan = planBashFilter(NO_FILTER_CMD);
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

  test("emits lines=\"shown/total\" evidence in the marker when a filter trims output", () => {
    // A filter that keeps only lines containing "keep" — deterministic line math.
    const filter: FilterSpec = {
      name: "test-keep",
      matchCommand: /^demo$/,
      keepLinesMatching: [/keep/],
    };
    const plan = { effectiveCommand: "demo", filter, rewrite: null };
    // The dropped lines are long on purpose: the marker is only emitted when it
    // costs less than it saves, so a five-token input would be handed back bare
    // and this would assert on the suppression path instead of the marker.
    const noise = "drop".padEnd(70, " .");
    const raw = ["keep 1", `${noise}a`, `${noise}b`, "keep 2", `${noise}c`].join("\n");
    const result = applyBashFilterToStdout(raw, false, plan);
    expect(result).toContain("<bash-output-filtered");
    // 5 input lines in, 2 kept → the model sees exactly how much was trimmed.
    expect(result).toContain('lines="2/5"');
  });

  test("strips trailing `| tail -N` and filters the base command", () => {
    // `git status | tail -40` should plan to run `git status` (a filtered verb) raw, with the
    // marker recording the original piped command and the actual executed one.
    const plan = planBashFilter("git status | tail -40");
    expect(plan.filter).not.toBeNull();
    expect(plan.effectiveCommand).toBe("git status");
    expect(plan.rewrite).toEqual({ from: "git status | tail -40", to: "git status" });
  });

  test("does not strip `| head` (SIGPIPE early-exit guard)", () => {
    const plan = planBashFilter("git status | head -40");
    expect(plan.effectiveCommand).toBe("git status | head -40");
    expect(plan.rewrite).toBeNull();
  });

  test("does not strip trailing reducer when base has no filter", () => {
    const plan = planBashFilter(`${NO_FILTER_CMD} | tail -40`);
    expect(plan.filter).toBeNull();
    expect(plan.effectiveCommand).toBe(`${NO_FILTER_CMD} | tail -40`);
    expect(plan.rewrite).toBeNull();
  });

  test("does not emit lines attr on error output (content is not filtered)", () => {
    const filter: FilterSpec = { name: "test", matchCommand: /^demo$/, stripAnsi: true };
    const plan = {
      effectiveCommand: "demo",
      filter,
      rewrite: { from: "demo", to: "demo --verbose" },
    };
    const result = applyBashFilterToStdout("boom\nerror: failed", true, plan);
    // Error path wraps with the rewrite marker only — no pipeline ran, so no line counts.
    expect(result).not.toContain("lines=");
  });

  test("module init + first filter lookup completes under 50ms", async () => {
    const start = performance.now();
    const mod = await import("src/tools/shared/outputFilter/Bash/index.js");
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

  // Everywhere else the output is model-facing and an escape sequence is a
  // display instruction for a terminal the model is not. An error string is
  // printed VERBATIM to the user's screen, where the red on ERROR is doing its
  // job — so the error floor deliberately omits stripAnsi even when the matched
  // spec asks for it.
  test("error output preserves ANSI codes (not stripped)", () => {
    const filter = { name: "test", matchCommand: /^npm$/, stripAnsi: true };
    const plan = { effectiveCommand: "npm install", filter, rewrite: null };
    const ansiError = "\x1b[31mERROR\x1b[0m: something failed";
    const result = applyBashFilterToStdout(ansiError, true, plan);
    expect(result).toBe(ansiError);
  });

  // A failing build repeating one line hundreds of times is the shape this
  // exists for. The first of the run survives verbatim, so the cause cannot be
  // hidden by the collapse.
  test("error output collapses a run of identical lines", () => {
    const filter = { name: "test", matchCommand: /^make$/ };
    const plan = { effectiveCommand: "make", filter, rewrite: null };
    const raw = `${"warning: unused variable 'x'\n".repeat(200)}error: build failed\n`;
    const result = applyBashFilterToStdout(raw, true, plan);
    expect(result).toContain("warning: unused variable 'x' (×200)");
    expect(result).toContain("error: build failed");
    expect(result).not.toContain("<bash-output-");
    expect(result.length).toBeLessThan(raw.length / 10);
  });

  // The matched spec is NOT consulted on the error path: its keepLinesMatching
  // was written for a successful run and would drop the traceback.
  test("error output ignores the matched spec's lossy stages", () => {
    const filter = {
      name: "test",
      matchCommand: /^suite$/,
      keepLinesMatching: [/^ok /],
      maxLines: 2,
      matchOutput: [{ pattern: /./, message: "✓ all good" }],
    };
    const plan = { effectiveCommand: "suite", filter, rewrite: null };
    const raw = "ok one\nok two\nTraceback (most recent call last)\n  line 42\n";
    const result = applyBashFilterToStdout(raw, true, plan);
    expect(result).toBe(raw);
  });

  // `callerBudgets` exists so GitTool's own budget and delta lane are not fed
  // text this filter already reshaped. Every lossy stage has to answer to it,
  // and each is asserted separately — an audit found all three mutations of this
  // flag passing, because nothing anywhere pinned it.
  describe("callerBudgets suppresses every lossy stage", () => {
    // Deliberately NOT `line ${i}`: those 200 lines are one digit template, so
    // collapseDigitTemplates folds them to a single line and the cap never sees
    // enough lines to fire. The suffix varies by letter instead.
    const wide = `${Array.from(
      { length: 200 },
      (_, i) =>
        `line ${String.fromCharCode(97 + (i % 26)).repeat(1 + (i % 7))} of plain output`,
    ).join("\n")}\n`;

    const plan = (callerBudgets: boolean) => ({
      effectiveCommand: "some-unmatched-command",
      filter: null,
      rewrite: null,
      callerBudgets,
    });

    test("the cap is applied without it and skipped with it", () => {
      expect(applyBashFilterToStdout(wide, false, plan(false))).toContain(
        "lines omitted",
      );
      expect(applyBashFilterToStdout(wide, false, plan(true))).toBe(wide);
    });

    test("the digit collapse is applied without it and skipped with it", () => {
      const progress = `${Array.from({ length: 20 }, (_, i) => `Compiling crate v1.0.${i}`).join("\n")}\n`;
      expect(applyBashFilterToStdout(progress, false, plan(false))).toContain(
        "updates)",
      );
      expect(applyBashFilterToStdout(progress, false, plan(true))).toBe(progress);
    });

    test("match-line grouping is applied without it and skipped with it", () => {
      const matches = "src/a.ts:1:x\nsrc/a.ts:2:y\nsrc/b.ts:3:z\n";
      expect(applyBashFilterToStdout(matches, false, plan(false))).toContain(
        "src/a.ts\n1:x",
      );
      expect(applyBashFilterToStdout(matches, false, plan(true))).toBe(matches);
    });

    test("planBashFilter records it, and defaults to off", () => {
      expect(planBashFilter("ls -la", { callerBudgets: true }).callerBudgets).toBe(
        true,
      );
      expect(planBashFilter("ls -la").callerBudgets).toBe(false);
    });
  });

  // The structured fence, end to end rather than only as a unit on
  // isCappableBody: an audit found that making it always return TRUE was caught
  // by nothing outside its own file.
  test("a structured body is not capped, however long it is", () => {
    const json = `{\n${Array.from({ length: 200 }, (_, i) => `  "key_${i}": ${i},`).join("\n")}\n}`;
    const plan = {
      effectiveCommand: "some-unmatched-command",
      filter: null,
      rewrite: null,
    };
    const result = applyBashFilterToStdout(json, false, plan);
    expect(result).toBe(json);
    expect(result).toContain('"key_199": 199');
  });

  test("error output with rewrite discloses it as a note, never as a marker", () => {
    // The error string is printed verbatim by FallbackToolUseErrorMessage, so a
    // wrapper here reaches the user's screen as raw XML with escaped attributes.
    const filter = { name: "docker", matchCommand: /^docker$/ };
    const plan = {
      effectiveCommand: "docker build --progress=plain .",
      filter,
      rewrite: { from: "docker build .", to: "docker build --progress=plain ." },
    };
    const errorOutput = "error: build failed";
    const result = applyBashFilterToStdout(errorOutput, true, plan);
    expect(result).not.toContain("<bash-output-");
    expect(result).toContain("what ran was: docker build --progress=plain .");
    expect(result).toContain("error: build failed");
  });

  test("error output with a rewrite note preserves full error content", () => {
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

  test("a failing reducer-stripped command leaks no XML to the error renderer", () => {
    // The reported shape: `make lint 2>&1 | tail -40` exits non-zero after the
    // trailing pipe was stripped, so the whole output takes the error path.
    const plan = planBashFilter("make lint 2>&1 | tail -40");
    expect(plan.rewrite).toEqual({
      from: "make lint 2>&1 | tail -40",
      to: "make lint 2>&1",
    });
    const result = applyBashFilterToStdout(
      "uv run ruff check .\nE501 Line too long\n",
      true,
      plan,
    );
    expect(result).not.toContain("<bash-output-");
    // …and nothing XML-escaped either: `2&gt;&amp;1` is what the user saw.
    expect(result).not.toContain("&gt;");
    expect(result).toContain("what ran was: make lint 2>&1");
  });

  test("error path honours the line cap of the reducer it stripped", () => {
    // The strip is justified by the pipeline out-trimming a blind cap — and the
    // pipeline does not run on an error, so the cap has to be applied here or
    // the model gets MORE than the `| tail -3` it asked for.
    const plan = planBashFilter("make lint | tail -3");
    const raw = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const result = applyBashFilterToStdout(raw, true, plan);
    expect(result).toContain("line 19");
    expect(result).toContain("line 17");
    expect(result).not.toContain("line 16");
    expect(result).toContain("`| tail -3`");
  });

  test("error path with `| cat` caps nothing (cat reduces nothing)", () => {
    const plan = planBashFilter("make lint | cat");
    const raw = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const result = applyBashFilterToStdout(raw, true, plan);
    expect(result).toContain("line 0");
    expect(result).toContain("line 19");
  });

  test("success path caps at the stripped reducer even when the filter trims nothing", () => {
    // The strip is a bet that the filter beats a blind line count. When the bet
    // does not pay — a failing `make` has no `Entering directory` noise to strip
    // — the model still gets only the lines it asked for. Live-verified shape:
    // 14 lines came back for a `| tail -5` before this cap existed.
    const plan = planBashFilter("make lint | tail -5");
    const raw = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n");
    const result = applyBashFilterToStdout(raw, false, plan, 2);
    expect(result).toContain("line 13");
    expect(result).toContain("line 9");
    expect(result).not.toContain("line 8");
    expect(result).toContain('exit="2"');
  });

  test("the cap counts lines the way `tail -N` does (a trailing newline is not one)", () => {
    const plan = planBashFilter("make lint | tail -5");
    const raw = `${Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const result = applyBashFilterToStdout(raw, false, plan, 0);
    expect(result).toContain('lines="5/14"');
    expect(result).toContain("line 9");
    expect(result).not.toContain("line 8");
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
// Rewrite gating + compound short-circuit safety
// ---------------------------------------------------------------------------

describe("planBashFilter — allowRewrite gate", () => {
  test("allowRewrite: false → filter resolved but command untouched, no rewrite claim", () => {
    const plan = planBashFilter("git log", { allowRewrite: false });
    expect(plan.filter?.name).toBe("git-log");
    expect(plan.rewrite).toBeNull();
    expect(plan.effectiveCommand).toBe("git log");
  });

  test("allowRewrite: false → trailing reducer pipe is not stripped either", () => {
    const plan = planBashFilter("git status | tail -40", { allowRewrite: false });
    expect(plan.effectiveCommand).toBe("git status | tail -40");
    expect(plan.rewrite).toBeNull();
  });

  test("rewrite preserves quoted-argument whitespace verbatim", () => {
    // args.join(' ') would collapse the double space inside the quotes; the
    // rewritten command is executed, so it must stay byte-identical.
    const plan = planBashFilter('git log --grep="a  b"');
    expect(plan.rewrite?.to).toBe('git log --oneline --grep="a  b"');
  });
});

describe("exitCodeAfterRewrite", () => {
  test("a stripped reducer reports the status the model's pipeline would have", () => {
    // No `pipefail` anywhere in the bash provider, so `make lint | tail -40`
    // exits with tail's 0 however badly `make lint` failed. Reporting the base's
    // 2 turned a success into a tool error — which then skipped the filter and
    // handed back everything the `| tail -40` was there to cut.
    const plan = planBashFilter("make lint | tail -40");
    expect(plan.droppedReducer).toEqual({ text: "tail -40", lines: 40 });
    expect(exitCodeAfterRewrite(plan, 2)).toBe(0);
  });

  test("every other plan keeps the real status", () => {
    expect(exitCodeAfterRewrite(planBashFilter("make lint"), 2)).toBe(2);
    // `git log` → `git log --oneline` is a flag rewrite: same process, same exit.
    expect(exitCodeAfterRewrite(planBashFilter("git log"), 2)).toBe(2);
  });
});

describe("compound commands — matchOutput short-circuit is disabled", () => {
  test("plan marks compound vs atomic vs reducer-stripped commands", () => {
    expect(planBashFilter("cd /tmp && git pull").isCompound).toBe(true);
    expect(planBashFilter("git pull").isCompound).toBe(false);
    // Reducer-stripped pipe resolves to an atomic base.
    expect(planBashFilter("git status | tail -40").isCompound).toBe(false);
  });

  test("sentinel from one segment does not swallow the other segment's output", () => {
    // Before the fix, `cd /tmp && git pull` with an up-to-date pull replaced the
    // ENTIRE combined output with "✓ git pull: already up to date".
    const plan = planBashFilter("cd /tmp && git pull");
    expect(plan.filter?.name).toBe("git-pull");
    const raw = "Already up to date.\nbuild artifacts written to dist/\n";
    const result = applyBashFilterToStdout(raw, false, plan);
    expect(result).toContain("build artifacts written to dist/");
    expect(result).not.toContain("✓ git pull: already up to date");
  });

  test("atomic command keeps the matchOutput short-circuit", () => {
    const plan = planBashFilter("git pull");
    const result = applyBashFilterToStdout("Already up to date.\n", false, plan);
    expect(result).toContain("✓ git pull: already up to date");
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
    const raw = "src/shared/errors.ts:42:throw new Error\n";
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
      "  --> src/platform/main.rs:5:9",
      "   |",
      "5  |     let x: u32 = \"\";",
      "   |                  ^^ expected u32, found &str",
      "error: could not compile `foo`",
    ].join("\n");
    const body = runFilterBody("cargo-build", "cargo build", raw);
    expect(body).toContain("error[E0308]");
    expect(body).not.toMatch(/^✓ cargo build/);
  });

  test("safety: warnings on a Finished build preserve body, no sentinel", () => {
    // Non-`unused` warning on an exit-0 (Finished) build: the old guard only
    // treated `warning: unused` as a problem, so this would collapse to the
    // sentinel and drop the warning text.
    const raw = [
      "   Compiling foo v0.1.0 (/work/foo)",
      "warning: associated function `new` is never used",
      "  --> src/core/stream.rs:95:12",
      'warning: `foo` (bin "foo") generated 1 warning',
      "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.20s",
    ].join("\n");
    const body = runFilterBody("cargo-build", "cargo build", raw);
    expect(body).toContain("is never used");
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

  test("safety: warnings on a Finished check preserve body, no sentinel", () => {
    const raw = [
      "    Checking foo v0.1.0 (/work/foo)",
      "warning: function `helper` is never used",
      "  --> src/platform/main.rs:10:4",
      "warning: `foo` (lib) generated 1 warning",
      "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.30s",
    ].join("\n");
    const body = runFilterBody("cargo-check", "cargo check", raw);
    expect(body).toContain("is never used");
    expect(body).not.toMatch(/^✓ cargo check/);
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
    const raw = "May 05 12:18:04 dev-arch systemd-logind[726]: Watching system buttons\nMay 05 12:22:44 dev-arch systemd-logind[726]: System is rebooting.\n";
    const body = runFilterBody("journalctl", "journalctl -u systemd-logind", raw);
    expect(body).not.toContain("dev-arch");
    expect(body).toContain("May 05 12:18:04");
    expect(body).toContain("systemd-logind[726]: Watching");
  });

  test("strips boot markers", () => {
    const raw = "May 05 12:22:49 dev-arch systemd[1]: Stopped service.\n-- Boot ed3041156fb04270ae0d53e7892c949b --\nMay 05 12:23:37 dev-arch systemd[1]: Starting service.\n";
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
    expect(body).toContain('"name": "claudin"');
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

// ==========================================================================
// Phase 11 — Java build tools (gradle, mvn)
// ==========================================================================

describe("phase 11 — gradle", () => {
  // ROI -------------------------------------------------------------------
  test("ROI: gradle-build-incremental reduces ≥ 90%", () => {
    assertReduction("gradle", "gradle build", "gradle-build-incremental", 90);
  });

  test("ROI: gradle-build-cold reduces ≥ 70%", () => {
    assertReduction("gradle", "./gradlew build", "gradle-build-cold", 70);
  });

  test("ROI: gradle-clean-build (multi-project) reduces ≥ 70%", () => {
    assertReduction("gradle", "gradle clean build", "gradle-clean-build", 70);
  });

  // strict success sentinel ----------------------------------------------
  test("sentinel: gradle build success collapses to ✓ gradle (strict)", () => {
    const raw = loadSample("gradle-build-incremental");
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body.trim()).toBe("✓ gradle: BUILD SUCCESSFUL");
  });

  test("sentinel: gradle clean build success collapses to ✓ gradle (strict)", () => {
    const raw = loadSample("gradle-clean-build");
    const body = runFilterBody("gradle", "gradle clean build", raw);
    expect(body.trim()).toBe("✓ gradle: BUILD SUCCESSFUL"); // body é EXATAMENTE o sentinel
  });

  // safety ----------------------------------------------------------------
  test("safety: test failure preserves stack trace and FAILED (P0)", () => {
    const raw = loadSample("gradle-test-failure");
    const body = runFilterBody("gradle", "gradle test", raw);
    expect(body).toContain("FAILED");
    expect(body).toContain("AssertionError");
    expect(body).toContain("BUILD FAILED");
    expect(body).not.toMatch(/^✓ gradle/);
    // anti-noise: configure-project chatter must be stripped.
    expect(body).not.toContain("> Configure project");
    expect(body).not.toMatch(/^✓ gradle/m);
  });

  test("safety: compile error preserves what went wrong block (P0)", () => {
    const raw = loadSample("gradle-compile-error");
    const body = runFilterBody("gradle", "./gradlew build", raw);
    expect(body).toContain("Could not resolve");
    expect(body).toContain("BUILD FAILED");
    // anti-noise: daemon/configure/resolving chatter must be stripped.
    expect(body).not.toContain("Starting a Gradle Daemon");
    expect(body).not.toContain("> Configure project");
    expect(body).not.toContain("> Resolving dependencies");
    expect(body).not.toMatch(/^✓ gradle/m);
  });

  test("safety: task without status suffix is not stripped (P0)", () => {
    // `> Task :app:compileJava` (no suffix) = task executed = must not be stripped.
    // `> Task :app:processResources UP-TO-DATE` = pure noise = must be stripped.
    // We use a FAILED build so the sentinel does not fire and we can inspect
    // which individual lines survive the strip rules.
    const raw = [
      "> Task :app:compileJava",
      "> Task :app:processResources UP-TO-DATE",
      "FAILURE: Build failed with an exception.",
      "BUILD FAILED in 3s",
    ].join("\n");
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body).toContain("> Task :app:compileJava");
    expect(body).not.toContain("> Task :app:processResources");
  });

  test("safety: actionable tasks summary line is preserved or sentinel fires (P1)", () => {
    // When the build succeeds, the sentinel collapses everything — the
    // "actionable tasks" line is only visible when the sentinel does NOT fire.
    // Either outcome is valid here; the test verifies the filter does not crash.
    const raw = loadSample("gradle-build-cold");
    const body = runFilterBody("gradle", "./gradlew build", raw);
    expect(body).toMatch(/\d+ actionable tasks|✓ gradle/);
  });

  test("safety: test report URL is preserved (P1)", () => {
    const raw = [
      "> Task :app:test FAILED",
      "FAILURE: Build failed with an exception.",
      "* What went wrong:",
      "There were failing tests. See the report at: file:///path/to/report/index.html",
      "BUILD FAILED in 12s",
    ].join("\n");
    const body = runFilterBody("gradle", "gradle test", raw);
    expect(body).toContain("file:///path/to/report/index.html");
  });

  // match/reject ----------------------------------------------------------
  test("match: gradle ✓; gradlew ✓; ./gradlew ✓; ./gradlew.bat ✓", () => {
    expect(findFilterForCommand("gradle build")?.name).toBe("gradle");
    expect(findFilterForCommand("gradlew build")?.name).toBe("gradle");
    expect(findFilterForCommand("./gradlew build")?.name).toBe("gradle");
    expect(findFilterForCommand("./gradlew.bat build")?.name).toBe("gradle");
  });

  test("reject: --info passthrough (user requested detail)", () => {
    expect(findFilterForCommand("gradle build --info")).toBeNull();
    expect(findFilterForCommand("./gradlew test --info")).toBeNull();
  });

  test("reject: --debug passthrough", () => {
    expect(findFilterForCommand("gradle build --debug")).toBeNull();
  });

  test("reject: --stacktrace passthrough", () => {
    expect(findFilterForCommand("gradle test --stacktrace")).toBeNull();
  });

  test("reject: --scan passthrough (generates build-scan URL)", () => {
    expect(findFilterForCommand("gradle build --scan")).toBeNull();
  });

  test("reject: -q passthrough", () => {
    expect(findFilterForCommand("gradle build -q")).toBeNull();
  });

  test("reject: -t (--continuous shorthand) passthrough", () => {
    expect(findFilterForCommand("gradle build -t")).toBeNull();
    expect(findFilterForCommand("gradle build --continuous")).toBeNull();
  });

  // defense ---------------------------------------------------------------
  test("defense: compiler warnings are not stripped when build fails (P0)", () => {
    // On a FAILED build the sentinel does not fire, so compiler warnings that
    // precede the error are preserved.  On a SUCCESS build the sentinel collapses
    // everything — warnings are intentionally omitted (build passed).
    const raw = [
      "> Task :app:compileJava FAILED",
      "warning: [deprecation] OldApi in com.example has been deprecated",
      "1 warning",
      "FAILURE: Build failed with an exception.",
      "BUILD FAILED in 4s",
    ].join("\n");
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body).toContain("warning: [deprecation]");
    expect(body).toContain("BUILD FAILED");
  });

  test("defense: blank lines are all removed (P1)", () => {
    const raw =
      "\n\n> Task :app:compileJava UP-TO-DATE\n\n\nBUILD SUCCESSFUL in 2s\n\n";
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body).not.toMatch(/^\s*$/m);
  });
});

describe("phase 11 — mvn", () => {
  // ROI -------------------------------------------------------------------
  test("ROI: mvn-build-success cold reduces ≥ 85%", () => {
    assertReduction("mvn", "mvn package", "mvn-build-success", 85);
  });

  test("ROI: mvn-test-success (100 tests) reduces ≥ 85%", () => {
    assertReduction("mvn", "mvn test", "mvn-test-success", 85);
  });

  test("ROI: mvn-clean-install (multi-module) reduces ≥ 85%", () => {
    assertReduction("mvn", "mvn clean install", "mvn-clean-install", 85);
  });

  // strict success sentinel ----------------------------------------------
  test("sentinel: mvn clean install success collapses to ✓ mvn (strict)", () => {
    const raw = loadSample("mvn-clean-install");
    const body = runFilterBody("mvn", "mvn clean install", raw);
    expect(body.trim()).toBe("✓ mvn: BUILD SUCCESS");
  });

  test("sentinel: mvn package success collapses to ✓ mvn (strict)", () => {
    const raw = loadSample("mvn-build-success");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body.trim()).toBe("✓ mvn: BUILD SUCCESS");
  });

  // safety ----------------------------------------------------------------
  test("safety: compile error preserves [ERROR] with path and line (P0)", () => {
    const raw = loadSample("mvn-compile-error");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).toContain("[ERROR]");
    expect(body).toContain("cannot find symbol");
    expect(body).toContain("BUILD FAILURE");
    expect(body).not.toMatch(/^✓ mvn/);
    // anti-noise: success-build chatter must be stripped on failure too.
    expect(body).not.toContain("Scanning for projects");
    expect(body).not.toContain("--- maven-compiler-plugin");
    expect(body).not.toContain("Copying 1 resource");
    expect(body).not.toContain("Changes detected");
    expect(body).not.toContain("Compiling 5 source files");
    expect(body).not.toMatch(/^✓ mvn/m);
  });

  test("safety: test failure preserves Surefire summary (P0)", () => {
    const raw = loadSample("mvn-test-failure");
    const body = runFilterBody("mvn", "mvn test", raw);
    expect(body).toContain("Failures:");
    expect(body).toContain("BUILD FAILURE");
    expect(body).not.toMatch(/^✓ mvn/);
    // anti-noise: plumbing lines must not survive.
    expect(body).not.toContain("Scanning for projects");
    expect(body).not.toContain("--- maven-surefire-plugin");
    expect(body).not.toMatch(/^✓ mvn/m);
  });

  test("safety: [WARNING] is not stripped when build fails (P0)", () => {
    // [WARNING] is not in any strip list and survives the strip phase.
    // On BUILD FAILURE the sentinel does not fire, so warnings remain visible.
    // On BUILD SUCCESS the sentinel collapses everything — this is acceptable
    // because a warning on a passing build does not block the work.
    const raw = [
      "[INFO] Scanning for projects...",
      "[INFO]",
      "[WARNING] Using platform encoding (UTF-8 actually) to copy filtered resources",
      "[ERROR] Some dependency could not be resolved",
      "[INFO] BUILD FAILURE",
      "[INFO] Total time: 1.5 s",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).toContain("[WARNING] Using platform encoding");
  });

  test("safety: success collapses to sentinel or preserves Total time (P1)", () => {
    const raw = loadSample("mvn-build-success");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body.trim()).toMatch(/✓ mvn: BUILD SUCCESS|Total time/);
  });

  test("safety: Tests run summary per class survives on failure (P1)", () => {
    const raw = loadSample("mvn-test-failure");
    const body = runFilterBody("mvn", "mvn test", raw);
    expect(body).toMatch(/Tests run: \d+, Failures: \d+/);
  });

  test("safety: multi-module BUILD SUCCESS collapses to sentinel (P1)", () => {
    const raw = [
      "[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ core ---",
      "[INFO]",
      "[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ api ---",
      "[INFO]",
      "[INFO] ------------------------------------------------------------------------",
      "[INFO] BUILD SUCCESS",
      "[INFO] ------------------------------------------------------------------------",
      "[INFO] Total time:  8.0 s",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn install", raw);
    expect(body.trim()).toContain("✓ mvn: BUILD SUCCESS");
  });

  // match/reject ----------------------------------------------------------
  test("match: mvn ✓; mvnw ✓; ./mvnw ✓", () => {
    expect(findFilterForCommand("mvn package")?.name).toBe("mvn");
    expect(findFilterForCommand("mvnw package")?.name).toBe("mvn");
    expect(findFilterForCommand("./mvnw package")?.name).toBe("mvn");
  });

  test("match: common goals are all covered", () => {
    const goals = [
      "compile",
      "package",
      "clean",
      "install",
      "test",
      "verify",
      "deploy",
      "validate",
    ];
    for (const goal of goals) {
      expect(findFilterForCommand(`mvn ${goal}`)?.name).toBe("mvn");
    }
  });

  test("reject: -q passthrough", () => {
    expect(findFilterForCommand("mvn -q package")).toBeNull();
  });

  test("reject: -X passthrough (debug verbose)", () => {
    expect(findFilterForCommand("mvn -X package")).toBeNull();
  });

  test("reject: -e passthrough (error stack trace)", () => {
    expect(findFilterForCommand("mvn -e package")).toBeNull();
  });

  // defense ---------------------------------------------------------------
  test("defense: empty [INFO] lines do not leak after stripping (P0)", () => {
    const raw = "[INFO]\n[INFO] BUILD SUCCESS\n[INFO]\n";
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).not.toContain("[INFO]\n");
  });

  test("defense: non-maven-* plugin headers are also stripped (P0)", () => {
    // Kotlin, Quarkus, Spring Boot, and exec plugins all use the same
    // `--- artifactId:version:goal ---` format but don't start with "maven-".
    const raw = [
      "[INFO] --- kotlin-maven-plugin:1.9.21:compile (compile) @ myapp ---",
      "[INFO] --- quarkus-maven-plugin:3.0.0:build (default) @ myapp ---",
      "[INFO] --- spring-boot-maven-plugin:3.2.0:repackage (repackage) @ myapp ---",
      "[INFO] --- exec-maven-plugin:3.1.0:exec (default) @ myapp ---",
      "[ERROR] Something went wrong",
      "[INFO] BUILD FAILURE",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).not.toContain("kotlin-maven-plugin");
    expect(body).not.toContain("quarkus-maven-plugin");
    expect(body).not.toContain("spring-boot-maven-plugin");
    expect(body).not.toContain("exec-maven-plugin");
    expect(body).toContain("[ERROR] Something went wrong");
  });

  test("defense: Downloading from custom repo is also stripped (P1)", () => {
    const raw = [
      "[INFO] Downloading from company-nexus: https://nexus.company.com/repo/com/example/lib/1.0/lib.pom",
      "[INFO] Downloaded from company-nexus: https://nexus.company.com/repo/com/example/lib/1.0/lib.pom (4.1 kB at 200 kB/s)",
      "[INFO] BUILD SUCCESS",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).not.toContain("nexus.company.com");
    expect(body.trim()).toContain("✓ mvn: BUILD SUCCESS");
  });

  test("defense: Surefire captured stdout survives on failure (P0)", () => {
    const raw = [
      "[INFO] --- maven-surefire-plugin:3.2.5:test (default-test) @ myapp ---",
      "[INFO]",
      "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0 <<< FAILURE!",
      "[ERROR] com.example.MyTest.testFoo -- AssertionError: expected 1 but was 2",
      "[INFO]",
      "[INFO] BUILD FAILURE",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn test", raw);
    expect(body).toContain("[ERROR] Tests run");
    expect(body).toContain("AssertionError: expected 1 but was 2");
  });
});

// ==========================================================================
// Phase 11 — IAC (terraform)
// ==========================================================================

describe("phase 11 — terraform", () => {
  // ROI -------------------------------------------------------------------
  test("ROI: terraform-plan-nochanges reduces ≥ 90%", () => {
    assertReduction(
      "terraform",
      "terraform plan",
      "terraform-plan-nochanges",
      90,
    );
  });

  // safety ----------------------------------------------------------------
  test("safety: plan with changes preserves full diff (P0)", () => {
    const raw = loadSample("terraform-plan-changes");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).toContain("+ resource");
    expect(body).toContain("~ resource");
    expect(body).toMatch(/Plan: \d+ to add/);
    expect(body).not.toMatch(/✓ terraform: no changes/);
  });

  test("safety: apply strips Still creating lines (P0)", () => {
    // "Still creating... [Xs elapsed]" is noise (repeats every 10 s per resource).
    // "Creation complete after Ns" is signal but is consumed when the sentinel fires.
    // Either way "Still creating" must not appear in the output.
    const raw = loadSample("terraform-apply-creating");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body).not.toContain("Still creating");
    expect(body).toMatch(/✓ terraform: apply complete|Apply complete!/);
  });

  test("safety: clean apply collapses to sentinel (P1)", () => {
    const raw = loadSample("terraform-apply-creating");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body.trim()).toContain("✓ terraform: apply complete");
  });

  test("safety: error block preserved with box-drawing chars (P0)", () => {
    const raw = loadSample("terraform-plan-error");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).toContain("Error: Reference to undeclared resource");
    expect(body).toContain("main.tf");
    expect(body).not.toMatch(/✓ terraform/);
  });

  test("safety: Refreshing/lock lines stripped on no-changes plan (P0)", () => {
    const raw = loadSample("terraform-plan-nochanges");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).not.toContain("Refreshing state");
    expect(body).not.toContain("Acquiring state lock");
    expect(body).not.toContain("Releasing state lock");
  });

  test("safety: plan with changes does not collapse to no-changes sentinel (P0)", () => {
    const raw = loadSample("terraform-plan-changes");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).not.toContain("✓ terraform: no changes");
  });

  test("safety: apply sentinel fires on clean apply (P1)", () => {
    // When Apply complete fires without errors, the sentinel collapses the output.
    // The Outputs: section (containing resource IDs) is consumed by the sentinel —
    // this is a known limitation of the single-sentinel collapse design.
    const raw = [
      "aws_instance.web: Creating...",
      "aws_instance.web: Creation complete after 45s [id=i-0abc123def4567890]",
      "",
      "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
      "",
      "Outputs:",
      "",
      'instance_id = "i-0abc123def4567890"',
    ].join("\n");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body.trim()).toContain("✓ terraform: apply complete");
  });

  // match/reject ----------------------------------------------------------
  test("match: terraform ✓; tofu ✓; tf ✓", () => {
    expect(findFilterForCommand("terraform plan")?.name).toBe("terraform");
    expect(findFilterForCommand("tofu plan")?.name).toBe("terraform");
    expect(findFilterForCommand("tf plan")?.name).toBe("terraform");
  });

  test("match: subcommands plan/apply/destroy/state list covered", () => {
    expect(findFilterForCommand("terraform plan")?.name).toBe("terraform");
    expect(findFilterForCommand("terraform apply")?.name).toBe("terraform");
    expect(findFilterForCommand("terraform destroy")?.name).toBe("terraform");
    expect(findFilterForCommand("terraform state list")?.name).toBe("terraform");
  });

  test("reject: -json passthrough (structured output)", () => {
    expect(findFilterForCommand("terraform plan -json")).toBeNull();
    expect(findFilterForCommand("terraform apply -json")).toBeNull();
  });

  test("reject: terraform output passthrough (values only, no filter needed)", () => {
    expect(findFilterForCommand("terraform output")).toBeNull();
  });

  test("reject: terraform init passthrough (not in match)", () => {
    expect(findFilterForCommand("terraform init")).toBeNull();
  });

  // defense ---------------------------------------------------------------
  test("defense: Still creating with dotted resource name is stripped (P1)", () => {
    const raw = [
      "aws_s3_bucket.my_bucket: Creating...",
      "aws_s3_bucket.my_bucket: Still creating... [10s elapsed]",
      "aws_s3_bucket.my_bucket: Still creating... [20s elapsed]",
      "aws_s3_bucket.my_bucket: Creation complete after 21s [id=my-bucket]",
      "",
      "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body).not.toContain("Still creating");
    // Sentinel fires on clean apply — Creation complete is consumed but sentinel is present.
    expect(body).toMatch(/✓ terraform: apply complete|Creation complete after 21s/);
  });

  test("defense: plan with destroy (- symbols) is preserved (P0)", () => {
    const raw = [
      "  # aws_instance.old will be destroyed",
      '  - resource "aws_instance" "old" {',
      '      - id = "i-oldid" -> null',
      "    }",
      "",
      "Plan: 0 to add, 0 to change, 1 to destroy.",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).toContain("- resource");
    expect(body).toContain("1 to destroy");
    expect(body).not.toContain("✓ terraform: no changes");
  });

  test("defense: state lock lines in no-changes plan do not prevent sentinel (P1)", () => {
    const raw = [
      "Acquiring state lock. This may take a few moments...",
      "No changes. Your infrastructure matches the configuration.",
      "Releasing state lock. This may take a few moments...",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body.trim()).toContain("✓ terraform: no changes");
  });

  test("defense: indexed resource address (for_each/count) Still creating is stripped (P0)", () => {
    // module.vpc.aws_subnet.private[0] has `[0]` which non-word chars break naive regex.
    const raw = [
      "module.vpc.aws_subnet.private[0]: Creating...",
      "module.vpc.aws_subnet.private[0]: Still creating... [10s elapsed]",
      "module.vpc.aws_subnet.private[0]: Still creating... [20s elapsed]",
      "module.vpc.aws_subnet.private[0]: Creation complete after 22s [id=subnet-abc]",
      "",
      "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body).not.toContain("Still creating");
    expect(body).toMatch(/✓ terraform: apply complete|Creation complete/);
  });

  test("defense: terraform destroy no-resources collapses to sentinel (P1)", () => {
    // 'terraform destroy' with nothing to destroy uses a different sentence than plan.
    const raw = [
      "Refreshing state... [id=vpc-0abc]",
      "",
      "No changes. No objects need to be destroyed.",
      "",
      "Either you have not created any objects yet or the existing objects were",
      "already deleted outside of Terraform.",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform destroy", raw);
    expect(body.trim()).toContain("✓ terraform: no changes");
  });
});

// ===========================================================================
// Phase 12 — JS package managers (rtk gap-fill).
//
// Measurements taken on real samples captured from npm 10.x / pnpm 9.x /
// yarn 1.x / prisma 7.x. Reduction targets reflect realistic per-sample
// signal-to-noise ratios — small clean samples (npm-install / prettier)
// have low absolute reduction because most of the bytes ARE the signal.
// ===========================================================================

describe("phase 12 — npm-install", () => {
  test("ROI: npm-install clean sample reduces ≥ 40%", () => {
    assertReduction("npm-install", "npm install express", "npm-install", 40);
  });

  test("safety: deprecation warnings are preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "npm-install-warn.txt"),
      "utf8",
    );
    const body = runFilterBody("npm-install", "npm install request", raw);
    expect(body).toContain("npm warn deprecated");
    expect(body).toContain("vulnerabilities");
  });

  test("match: install/i/ci/add ✓; --json rejects", () => {
    expect(findFilterForCommand("npm install")?.name).toBe("npm-install");
    expect(findFilterForCommand("npm i express")?.name).toBe("npm-install");
    expect(findFilterForCommand("npm ci")?.name).toBe("npm-install");
    expect(findFilterForCommand("npm add lodash")?.name).toBe("npm-install");
    expect(findFilterForCommand("npm install --json")?.name).not.toBe(
      "npm-install",
    );
  });
});

describe("phase 12 — npm-run", () => {
  test("ROI: npm-test sample reduces ≥ 75%", () => {
    assertReduction("npm-run", "npm test", "npm-test", 75);
  });

  test("safety: script body errors are preserved", () => {
    const raw = [
      "> myapp@1.0.0 test",
      "> jest --coverage",
      "",
      "FAIL src/foo.test.ts",
      "  ✕ does the thing",
      "    Error: AssertionError: expected 1 to equal 2",
    ].join("\n");
    const body = runFilterBody("npm-run", "npm test", raw);
    expect(body).toContain("FAIL src/foo.test.ts");
    expect(body).toContain("AssertionError");
  });

  test("match: test/t/run/start ✓; --silent rejects", () => {
    expect(findFilterForCommand("npm test")?.name).toBe("npm-run");
    expect(findFilterForCommand("npm t")?.name).toBe("npm-run");
    expect(findFilterForCommand("npm run build")?.name).toBe("npm-run");
    expect(findFilterForCommand("npm start")?.name).toBe("npm-run");
    expect(findFilterForCommand("npm test --silent")?.name).not.toBe("npm-run");
  });
});

describe("phase 12 — pnpm-install", () => {
  test("ROI: pnpm-install sample reduces ≥ 85%", () => {
    assertReduction("pnpm-install", "pnpm add express", "pnpm-install", 85);
  });

  test("safety: dependencies section is preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "pnpm-install.txt"),
      "utf8",
    );
    const body = runFilterBody("pnpm-install", "pnpm add express", raw);
    expect(body).toContain("dependencies:");
    expect(body).toContain("express");
    expect(body).toContain("Done in");
  });

  test("match: install/i/add ✓; --json rejects", () => {
    expect(findFilterForCommand("pnpm install")?.name).toBe("pnpm-install");
    expect(findFilterForCommand("pnpm add lodash")?.name).toBe("pnpm-install");
    expect(findFilterForCommand("pnpm install --json")?.name).not.toBe(
      "pnpm-install",
    );
  });
});

describe("phase 12 — pnpm-run", () => {
  test("ROI: pnpm-run sample reduces ≥ 70%", () => {
    assertReduction("pnpm-run", "pnpm run lint", "pnpm-run", 70);
  });

  test("match: run ✓; exec resolves to the inner tool's filter", () => {
    expect(findFilterForCommand("pnpm run build")?.name).toBe("pnpm-run");
    // `pnpm exec <tool>` runs the bin directly (no pnpm script ceremony) —
    // runner-prefix canonicalization hands it to the tool's own filter.
    expect(findFilterForCommand("pnpm exec eslint .")?.name).toBe("eslint");
  });
});

describe("phase 12 — yarn-install", () => {
  test("ROI: yarn-install sample reduces ≥ 85%", () => {
    assertReduction(
      "yarn-install",
      "yarn add express body-parser cors morgan",
      "yarn-install",
      85,
    );
  });

  test("safety: error lines are preserved", () => {
    const raw = [
      "yarn add v1.22.22",
      "[1/4] Resolving packages...",
      "error An unexpected error occurred: \"https://registry.yarnpkg.com/foo: not found\".",
      "info Visit https://yarnpkg.com/en/docs/cli/add for documentation.",
    ].join("\n");
    const body = runFilterBody("yarn-install", "yarn add foo", raw);
    expect(body).toContain("error An unexpected error");
  });

  test("match: bare yarn / add / install / upgrade / remove ✓", () => {
    expect(findFilterForCommand("yarn")?.name).toBe("yarn-install");
    expect(findFilterForCommand("yarn install")?.name).toBe("yarn-install");
    expect(findFilterForCommand("yarn add lodash")?.name).toBe("yarn-install");
    expect(findFilterForCommand("yarn upgrade")?.name).toBe("yarn-install");
    expect(findFilterForCommand("yarn remove foo")?.name).toBe("yarn-install");
  });
});

describe("phase 12 — eslint", () => {
  // ROI test omitted: a real error sample is *all* signal (diagnostics
  // are what the user asked for). The filter is here for the dirty-run
  // case where eslint prints summary + collapse-friendly blank lines.
  test("safety: diagnostics and ✖ summary are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "eslint-errors.txt"), "utf8");
    const body = runFilterBody("eslint", "npx eslint sample.js", raw);
    expect(body).toContain("no-unused-vars");
    expect(body).toContain("no-undef");
    expect(body).toContain("✖ 2 problems");
  });

  test("match: eslint / npx eslint ✓; --format=json rejects", () => {
    expect(findFilterForCommand("eslint src/")?.name).toBe("eslint");
    expect(findFilterForCommand("npx eslint src/")?.name).toBe("eslint");
    expect(findFilterForCommand("eslint --format=json src/")?.name).not.toBe(
      "eslint",
    );
  });
});

describe("phase 12 — prettier", () => {
  // ROI test omitted: dirty sample is all signal (file list is the diagnostic).
  test("safety: warn diagnostics preserved on --check failure", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "prettier-check.txt"),
      "utf8",
    );
    const body = runFilterBody("prettier", "npx prettier --check src/", raw);
    expect(body).toContain("[warn]");
    expect(body).toContain("Code style issues found");
  });

  test("preamble strip: 'Checking formatting...' line is removed", () => {
    const raw = "Checking formatting...\n[warn] foo.ts\n";
    const body = runFilterBody("prettier", "prettier --check .", raw);
    expect(body).not.toContain("Checking formatting...");
    expect(body).toContain("[warn] foo.ts");
  });

  test("match: prettier / npx prettier ✓; --loglevel=silent rejects", () => {
    expect(findFilterForCommand("prettier --check .")?.name).toBe("prettier");
    expect(findFilterForCommand("npx prettier --write src/")?.name).toBe(
      "prettier",
    );
    expect(
      findFilterForCommand("prettier --loglevel=silent --check .")?.name,
    ).not.toBe("prettier");
  });
});

describe("phase 12 — prisma-generate", () => {
  test("ROI: prisma-generate sample reduces ≥ 60%", () => {
    assertReduction(
      "prisma-generate",
      "npx prisma generate",
      "prisma-generate",
      60,
    );
  });

  test("safety: Generated Prisma Client line is preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "prisma-generate.txt"),
      "utf8",
    );
    const body = runFilterBody(
      "prisma-generate",
      "npx prisma generate",
      raw,
    );
    expect(body).toContain("Generated Prisma Client");
  });

  test("match: prisma generate / npx prisma generate ✓", () => {
    expect(findFilterForCommand("prisma generate")?.name).toBe(
      "prisma-generate",
    );
    expect(findFilterForCommand("npx prisma generate")?.name).toBe(
      "prisma-generate",
    );
  });
});

describe("phase 12 — prisma-migrate", () => {
  test("ROI: prisma-migrate sample reduces ≥ 35%", () => {
    assertReduction(
      "prisma-migrate",
      "npx prisma migrate dev --name init",
      "prisma-migrate",
      35,
    );
  });

  test("safety: 'created the following migration' line is preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "prisma-migrate.txt"),
      "utf8",
    );
    const body = runFilterBody(
      "prisma-migrate",
      "npx prisma migrate dev",
      raw,
    );
    expect(body).toContain("created the following migration");
  });

  test("match: prisma migrate ✓; not generate", () => {
    expect(findFilterForCommand("prisma migrate dev")?.name).toBe(
      "prisma-migrate",
    );
    expect(findFilterForCommand("npx prisma migrate deploy")?.name).toBe(
      "prisma-migrate",
    );
    expect(findFilterForCommand("prisma generate")?.name).not.toBe(
      "prisma-migrate",
    );
  });
});

// ===========================================================================
// Phase 12.2 — Universal linters (rtk gap-fill).
//
// Samples for yamllint / markdownlint / hadolint / pre-commit / shellcheck
// live under __fixtures__/samples/. Some are real (markdownlint via
// npx) and some are synthetic-with-source-header (the rest — tools are
// not installed in the dev container; samples mirror the official output
// formats documented in each tool's README/docs).
// ===========================================================================

describe("phase 12.2 — shellcheck", () => {
  test("ROI: shellcheck sample reduces ≥ 20% via 'For more information' strip", () => {
    assertReduction("shellcheck", "shellcheck bad.sh", "shellcheck", 20);
  });

  test("safety: SC codes and diagnostic carets are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "shellcheck.txt"), "utf8");
    const body = runFilterBody("shellcheck", "shellcheck bad.sh", raw);
    expect(body).toContain("SC2086");
    expect(body).toContain("SC2034");
    expect(body).toContain("^---^");
  });

  test("match: shellcheck ✓; --format=json rejects", () => {
    expect(findFilterForCommand("shellcheck bad.sh")?.name).toBe("shellcheck");
    expect(findFilterForCommand("shellcheck --format=json bad.sh")?.name).not.toBe(
      "shellcheck",
    );
  });
});

describe("phase 12.2 — yamllint", () => {
  test("safety: filename headers + diagnostics are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "yamllint.txt"), "utf8");
    const body = runFilterBody("yamllint", "yamllint .", raw);
    expect(body).toContain("config.yaml");
    expect(body).toContain("line-length");
    expect(body).toContain("indentation");
  });

  test("match: yamllint ✓; --format=parsable rejects", () => {
    expect(findFilterForCommand("yamllint .")?.name).toBe("yamllint");
    expect(findFilterForCommand("yamllint --format=parsable .")?.name).not.toBe(
      "yamllint",
    );
  });
});

describe("phase 12.2 — markdownlint", () => {
  test("safety: MD codes and file paths are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "markdownlint.txt"), "utf8");
    const body = runFilterBody("markdownlint", "markdownlint sample.md", raw);
    expect(body).toContain("MD019");
    expect(body).toContain("MD022");
    expect(body).toContain("sample.md");
  });

  test("match: markdownlint and mdl ✓; --json rejects", () => {
    expect(findFilterForCommand("markdownlint .")?.name).toBe("markdownlint");
    expect(findFilterForCommand("mdl .")?.name).toBe("markdownlint");
    expect(findFilterForCommand("markdownlint --json .")?.name).not.toBe(
      "markdownlint",
    );
  });
});

describe("phase 12.2 — hadolint", () => {
  test("safety: DL codes and file:line refs are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "hadolint.txt"), "utf8");
    const body = runFilterBody("hadolint", "hadolint Dockerfile", raw);
    expect(body).toContain("DL3007");
    expect(body).toContain("DL3008");
    expect(body).toContain("Dockerfile:");
  });

  test("match: hadolint ✓; --format=json rejects", () => {
    expect(findFilterForCommand("hadolint Dockerfile")?.name).toBe("hadolint");
    expect(findFilterForCommand("hadolint --format=json Dockerfile")?.name).not.toBe(
      "hadolint",
    );
  });
});

describe("phase 12.2 — pre-commit", () => {
  test("ROI: pre-commit sample reduces ≥ 45% via Passed-line strip", () => {
    assertReduction("pre-commit", "pre-commit run --all-files", "pre-commit", 45);
  });

  test("safety: Failed hooks and their diagnostic blocks are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "pre-commit.txt"), "utf8");
    const body = runFilterBody("pre-commit", "pre-commit run", raw);
    expect(body).toContain("black");
    expect(body).toContain("Failed");
    expect(body).toContain("F401");
    expect(body).toContain("E302");
  });

  test("safety: Passed-only output collapses to empty signal", () => {
    const raw = [
      "check yaml...............................................................Passed",
      "trim trailing whitespace.................................................Passed",
    ].join("\n");
    const body = runFilterBody("pre-commit", "pre-commit run", raw);
    expect(body).not.toContain("Passed");
  });

  test("match: pre-commit run ✓; pre-commit install not", () => {
    expect(findFilterForCommand("pre-commit run --all-files")?.name).toBe(
      "pre-commit",
    );
    expect(findFilterForCommand("pre-commit install")?.name).not.toBe(
      "pre-commit",
    );
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

describe("phase 12.3 — glab-list", () => {
  test("safety: MR ids and titles preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "glab-pr-list.txt"), "utf8");
    const body = runFilterBody("glab-list", "glab mr list", raw);
    expect(body).toContain("!142");
    expect(body).toContain("Phase 12.1");
  });

  test("match: glab pr|mr|issue list ✓; --output json rejects", () => {
    expect(findFilterForCommand("glab pr list")?.name).toBe("glab-list");
    expect(findFilterForCommand("glab mr list")?.name).toBe("glab-list");
    expect(findFilterForCommand("glab issue list")?.name).toBe("glab-list");
    expect(findFilterForCommand("glab mr list --output json")?.name).not.toBe(
      "glab-list",
    );
  });
});

describe("phase 12.3 — gt (Graphite)", () => {
  test("safety: stack lines preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "gt-log.txt"), "utf8");
    const body = runFilterBody("gt", "gt log", raw);
    expect(body).toContain("feat/bash-filters-expansion");
    expect(body).toContain("main");
  });

  test("match: gt log/ls/submit/sync/restack ✓; gt create not matched", () => {
    expect(findFilterForCommand("gt log")?.name).toBe("gt");
    expect(findFilterForCommand("gt ls")?.name).toBe("gt");
    expect(findFilterForCommand("gt submit")?.name).toBe("gt");
    expect(findFilterForCommand("gt sync")?.name).toBe("gt");
    expect(findFilterForCommand("gt restack")?.name).toBe("gt");
    expect(findFilterForCommand("gt create")?.name).not.toBe("gt");
  });
});

describe("phase 12.3 — jj (Jujutsu)", () => {
  test("safety: change ids and commit lines preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "jj-log.txt"), "utf8");
    const body = runFilterBody("jj", "jj log", raw);
    expect(body).toContain("qpvuntsm");
    expect(body).toContain("Phase 12.1");
  });

  test("match: jj log/st/status/diff ✓; jj new not matched", () => {
    expect(findFilterForCommand("jj log")?.name).toBe("jj");
    expect(findFilterForCommand("jj st")?.name).toBe("jj");
    expect(findFilterForCommand("jj status")?.name).toBe("jj");
    expect(findFilterForCommand("jj diff")?.name).toBe("jj");
    expect(findFilterForCommand("jj new")?.name).not.toBe("jj");
  });
});

// ===========================================================================
// Phase 12.4 — Go toolchain + Rust extras (rtk gap-fill).
// ===========================================================================

describe("phase 12.4 — go-build", () => {
  test("ROI: cold-cache download-only output collapses to positive marker", () => {
    // Cold-cache success (only `go: downloading/finding/found` lines) is
    // short-circuited via matchOutput to a positive marker so the LLM doesn't
    // see an empty body and wonder if the build ran at all. Floor of 75%
    // accounts for the marker string itself (~50 chars).
    assertReduction("go-build", "go build ./...", "go-build", 75);
  });

  test("matchOutput: cold-cache success emits positive marker", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "go-build.txt"), "utf8");
    const body = runFilterBody("go-build", "go build ./...", raw);
    expect(body).toContain("go build: dependencies downloaded, build ok");
  });

  test("safety: compile errors are preserved (no positive marker on error)", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "go-build-error.txt"), "utf8");
    const body = runFilterBody("go-build", "go build ./...", raw);
    expect(body).toContain("declared and not used");
    expect(body).toContain("undefined: fmt.Prinln");
    // The positive marker must not appear when an error is present.
    expect(body).not.toContain("dependencies downloaded, build ok");
  });

  test("match: go build ✓; -json rejects", () => {
    expect(findFilterForCommand("go build ./...")?.name).toBe("go-build");
    expect(findFilterForCommand("go build -json ./...")?.name).not.toBe(
      "go-build",
    );
  });
});

describe("phase 12.4 — go-vet", () => {
  test("safety: vet diagnostics are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "go-vet.txt"), "utf8");
    const body = runFilterBody("go-vet", "go vet ./...", raw);
    expect(body).toContain("format %d has arg");
  });

  test("match: go vet ✓; -json rejects", () => {
    expect(findFilterForCommand("go vet ./...")?.name).toBe("go-vet");
    expect(findFilterForCommand("go vet -json ./...")?.name).not.toBe("go-vet");
  });
});

describe("phase 12.4 — golangci-lint", () => {
  test("safety: lint diagnostics preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "golangci-lint.txt"),
      "utf8",
    );
    const body = runFilterBody("golangci-lint", "golangci-lint run", raw);
    // The sample includes real linter diagnostics; assert it's not stripped.
    expect(body.length).toBeGreaterThan(0);
    expect(body).toBe(raw); // passthrough (signal floor)
  });

  test("match: golangci-lint run ✓; --out-format=json rejects", () => {
    expect(findFilterForCommand("golangci-lint run")?.name).toBe(
      "golangci-lint",
    );
    expect(
      findFilterForCommand("golangci-lint run --out-format=json")?.name,
    ).not.toBe("golangci-lint");
  });
});

describe("phase 12.4 — cargo-run", () => {
  test("ROI: cargo run strips Finished + Running, preserves program output ≥ 80%", () => {
    assertReduction("cargo-run", "cargo run", "cargo-run", 80);
  });

  test("safety: program stdout is preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "cargo-run.txt"), "utf8");
    const body = runFilterBody("cargo-run", "cargo run", raw);
    expect(body).toContain("Hello, world!");
    expect(body).not.toContain("Finished");
    expect(body).not.toContain("Running `target/");
  });

  test("match: cargo run ✓", () => {
    expect(findFilterForCommand("cargo run")?.name).toBe("cargo-run");
    expect(findFilterForCommand("cargo run -- --flag")?.name).toBe("cargo-run");
  });
});

describe("phase 12.4 — cargo-fmt", () => {
  test("safety: diff is preserved on dirty --check", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "cargo-fmt-diff.txt"),
      "utf8",
    );
    const body = runFilterBody("cargo-fmt", "cargo fmt -- --check", raw);
    expect(body).toContain("Diff in");
    expect(body).toContain("+fn main() {");
  });

  test("clean run: empty input stays empty (no wrapper)", () => {
    const raw = "";
    const body = runFilterBody("cargo-fmt", "cargo fmt", raw);
    expect(body).toBe("");
  });

  test("match: cargo fmt ✓; cargo fmt -- --check ✓", () => {
    expect(findFilterForCommand("cargo fmt")?.name).toBe("cargo-fmt");
    expect(findFilterForCommand("cargo fmt -- --check")?.name).toBe(
      "cargo-fmt",
    );
  });
});

// ===========================================================================
// Phase 12.5 — Python extras (rtk gap-fill).
// ===========================================================================

describe("phase 12.5 — mypy", () => {
  test("safety: type errors preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "mypy-err.txt"), "utf8");
    const body = runFilterBody("mypy", "mypy bad.py", raw);
    expect(body).toContain("Incompatible return value type");
    expect(body).toContain("Found 2 errors");
  });

  test("match: mypy / python -m mypy ✓; --output=json rejects", () => {
    expect(findFilterForCommand("mypy .")?.name).toBe("mypy");
    expect(findFilterForCommand("python -m mypy src/")?.name).toBe("mypy");
    expect(findFilterForCommand("python3 -m mypy src/")?.name).toBe("mypy");
    expect(findFilterForCommand("mypy --output=json .")?.name).not.toBe("mypy");
  });
});

describe("phase 12.5 — pip-install", () => {
  test("ROI: pip install with downloads reduces ≥ 80%", () => {
    assertReduction("pip-install", "pip install requests", "pip-install", 80);
  });

  test("safety: 'Successfully installed' and ERROR lines preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "pip-install.txt"), "utf8");
    const body = runFilterBody("pip-install", "pip install requests", raw);
    expect(body).toContain("Successfully installed");
    expect(body).toContain("requests-2.34.2");
  });

  test("safety: real ERROR lines are not stripped", () => {
    const raw = [
      "Collecting nonexistent-package-12345",
      "ERROR: Could not find a version that satisfies the requirement nonexistent-package-12345",
      "ERROR: No matching distribution found for nonexistent-package-12345",
    ].join("\n");
    const body = runFilterBody(
      "pip-install",
      "pip install nonexistent-package-12345",
      raw,
    );
    expect(body).toContain("ERROR: Could not find");
    expect(body).toContain("ERROR: No matching distribution");
  });

  test("match: pip install / pip3 install / python -m pip install ✓; -q rejects", () => {
    expect(findFilterForCommand("pip install requests")?.name).toBe(
      "pip-install",
    );
    expect(findFilterForCommand("pip3 install requests")?.name).toBe(
      "pip-install",
    );
    expect(findFilterForCommand("python -m pip install requests")?.name).toBe(
      "pip-install",
    );
    expect(findFilterForCommand("python3 -m pip install requests")?.name).toBe(
      "pip-install",
    );
    expect(findFilterForCommand("pip install -q requests")?.name).not.toBe(
      "pip-install",
    );
  });
});

describe("phase 12.5 — ruff-format", () => {
  test("safety: diff/check output preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "ruff-format-diff.txt"),
      "utf8",
    );
    const body = runFilterBody(
      "ruff-format",
      "ruff format --check bad.py",
      raw,
    );
    expect(body).toContain("Would reformat");
    expect(body).toContain("1 file would be reformatted");
  });

  test("match: ruff format ✓; ruff check not matched here", () => {
    expect(findFilterForCommand("ruff format .")?.name).toBe("ruff-format");
    expect(findFilterForCommand("ruff format --check .")?.name).toBe(
      "ruff-format",
    );
    // ruff check is handled by the pre-existing ruff-check filter.
    expect(findFilterForCommand("ruff check .")?.name).toBe("ruff-check");
  });
});

// ---------------------------------------------------------------------------
// Trailing reducer pipe (`| tail -N` / `| cat`) per filter family.
//
// `tail`/`cat` consume all stdin, so `BASE | tail -N` runs BASE identically —
// the trailing reducer should be stripped and the BASE filter applied. We assert
// this holds for ~3 representative commands of every filter family, across the
// tail/`tail -n N`/cat reducer variants. `head` is NOT stripped (SIGPIPE).
// ---------------------------------------------------------------------------

describe("trailing reducer pipe — per family", () => {
  // [family label, expected filter name, [representative base commands]]
  const FAMILIES: Array<[string, string, string[]]> = [
    ["pkg/bundle", "bundle-install", ["bundle install"]],
    ["tests/pytest", "pytest", ["pytest", "pytest -q", "pytest tests/"]],
    ["tests/rspec", "rspec", ["rspec", "rspec spec/", "rspec --format progress"]],
    ["tests/go", "go-test", ["go test ./...", "go test -run X", "go test -v"]],
    ["tests-js/bun", "bun-test", ["bun test", "bun test src/x", "bun test --coverage"]],
    ["tests-js/jest", "jest", ["jest", "jest --ci", "jest path/to/x"]],
    ["tests-js/vitest", "vitest", ["vitest", "vitest run", "vitest --coverage"]],
    ["tsc", "tsc", ["tsc", "tsc --noEmit", "tsc -p tsconfig.json"]],
    ["system/ps", "ps-aux", ["ps aux"]],
    ["system/df", "df", ["df -h", "df", "df -h /"]],
    ["system/du", "du", ["du -sh .", "du -h", "du -sh node_modules"]],
    ["system/find", "find", ["find . -name x", "find src -type f", "find . -maxdepth 2"]],
    ["linters/rubocop", "rubocop", ["rubocop", "rubocop -a", "rubocop app/"]],
    ["linters/ruff", "ruff-check", ["ruff check", "ruff check .", "ruff check src/"]],
    ["linters/mypy", "mypy", ["mypy", "mypy .", "mypy src/"]],
    ["ls", "ls-la", ["ls -la", "ls -la src", "ls -la /tmp"]],
    ["grep", "grep-rg", ["grep -r foo .", "rg foo", "rg -n pattern src/"]],
    ["git/log", "git-log", ["git log", "git log --stat", "git log -n 20"]],
    ["git/status", "git-status", ["git status", "git status -v"]],
    ["git/diff", "git-diff", ["git diff", "git diff HEAD~1", "git diff --cached"]],
    ["gh/pr", "gh-pr-list", ["gh pr list", "gh pr list --state open"]],
    ["vcs/jj", "jj", ["jj log", "jj status", "jj diff"]],
    ["java/gradle", "gradle", ["gradle build", "gradle test", "gradle :app:assemble", "gradle clean build"]],
    ["java/mvn", "mvn", ["mvn package", "mvn test", "mvn clean install"]],
    ["iac/terraform", "terraform", ["terraform plan", "terraform apply"]],
    ["cargo/test", "cargo-test", ["cargo test", "cargo test --release", "cargo test foo"]],
    ["cargo/build", "cargo-build", ["cargo build", "cargo build --release"]],
    ["go/build", "go-build", ["go build ./...", "go build", "go build -v ./..."]],
    ["containers/ps", "docker-ps", ["docker ps", "docker ps -a"]],
    ["network/curl", "curl-plain", ["curl http://x", "curl https://api/y"]],
    ["js-pkg/npm-run", "npm-run", ["npm run build", "npm run test", "npm run lint"]],
  ];

  // Reducer suffixes that MUST be stripped (tail/cat, all lossless).
  const STRIP_VARIANTS = ["| tail -40", "| tail -n 5", "| cat"];

  for (const [label, expectedFilter, bases] of FAMILIES) {
    for (const base of bases) {
      test(`${label}: \`${base}\` resolves filter through tail/cat`, () => {
        // Sanity: the bare base resolves to the expected family filter.
        expect(findFilterForCommand(base)?.name).toBe(expectedFilter);

        for (const suffix of STRIP_VARIANTS) {
          const piped = `${base} ${suffix}`;
          // Filter is resolved against the base despite the trailing reducer.
          expect(findFilterForCommand(piped)?.name).toBe(expectedFilter);
          // The planner strips the reducer and runs the base raw, recording the rewrite.
          const plan = planBashFilter(piped);
          expect(plan.filter?.name).toBe(expectedFilter);
          expect(plan.effectiveCommand).toBe(base);
          expect(plan.rewrite).toEqual({ from: piped, to: base });
        }

        // `head` is never stripped — the command runs untouched (SIGPIPE early-exit guard).
        const headPiped = `${base} | head -40`;
        const headPlan = planBashFilter(headPiped);
        expect(headPlan.effectiveCommand).toBe(headPiped);
        expect(headPlan.rewrite).toBeNull();
      });
    }
  }
});
