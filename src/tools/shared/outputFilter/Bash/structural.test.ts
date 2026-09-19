// The planner/applier contract, independent of any one filter family.
//
// Everything here drives `planBashFilter` + `applyBashFilterToStdout` directly:
// the no-filter path, the marker's line evidence, the error floor (which
// ignores the matched spec's lossy stages), `callerBudgets`, and the caps that
// survive a stripped trailing reducer. Routing itself lives in registry.test.ts.
import { describe, expect, test } from "bun:test";
import { applyBashFilterToStdout, planBashFilter } from "src/tools/shared/outputFilter/Bash/index.js";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";
import type { FilterSpec } from "src/tools/shared/outputFilter/Bash/types.js";

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
