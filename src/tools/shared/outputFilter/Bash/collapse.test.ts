import { describe, expect, test } from "bun:test";
import { collapseDigitTemplates, collapseIdenticalRuns } from "src/tools/shared/outputFilter/Bash/collapse.js";

describe("collapseIdenticalRuns", () => {
  test("a run of identical lines becomes the line and its count", () => {
    expect(collapseIdenticalRuns(["a", "a", "a"])).toEqual(["a (×3)"]);
    expect(collapseIdenticalRuns(["a", "b", "b", "c"])).toEqual(["a", "b (×2)", "c"]);
    expect(collapseIdenticalRuns([])).toEqual([]);
  });

  test("a run of blank/whitespace lines collapses to a single blank, never ` (×N)`", () => {
    // A ` (×N)` marker on a blank run is non-blank, so it would survive a
    // `/^\s*$/` strip rule and defeat onEmpty in the Bash output-filter pipeline.
    expect(collapseIdenticalRuns(["a", "", "", "b"])).toEqual(["a", "", "b"]);
    expect(collapseIdenticalRuns(["", "", ""])).toEqual([""]);
    expect(collapseIdenticalRuns(["  ", "  "])).toEqual(["  "]);
    // Non-blank runs are still annotated.
    expect(collapseIdenticalRuns(["x", "", "", "x", "x"])).toEqual(["x", "", "x (×2)"]);
  });
});

describe("collapseDigitTemplates", () => {
  test("a run of lines differing only by digits becomes one sample and a count", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
    expect(collapseDigitTemplates(lines)).toEqual(["line 1 (5 updates)"]);
    expect(collapseDigitTemplates([])).toEqual([]);
    // Below DIGIT_TEMPLATE_MIN_RUN (5) — preserve as-is
    expect(collapseDigitTemplates(["line 1", "line 2"])).toEqual(["line 1", "line 2"]);
  });
});
