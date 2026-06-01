import { describe, expect, test } from "bun:test";
import { wrapStdoutWithMarkers } from "./markers.js";
import type { PipelineResult, PreExecPlan } from "./types.js";

const NO_FILTER_PLAN: PreExecPlan = {
  effectiveCommand: "npm install",
  filter: null,
  rewrite: null,
};

describe("wrapStdoutWithMarkers", () => {
  test("passes through when no rewrite and no filter", () => {
    expect(wrapStdoutWithMarkers("hello", NO_FILTER_PLAN, null)).toBe("hello");
  });

  test("wraps with bash-output-rewritten for rewrite only", () => {
    const plan: PreExecPlan = {
      effectiveCommand: "docker build --progress=plain .",
      filter: null,
      rewrite: {
        from: "docker build .",
        to: "docker build --progress=plain .",
      },
    };
    const result = wrapStdoutWithMarkers("output", plan, null);
    expect(result).toContain("<bash-output-rewritten");
    expect(result).toContain("original=");
    expect(result).toContain("actual=");
    expect(result).toContain("</bash-output-rewritten>");
  });

  test("wraps with bash-output-filtered for filter only", () => {
    const plan: PreExecPlan = {
      effectiveCommand: "npm install",
      filter: { name: "npm", matchCommand: /^npm$/ },
      rewrite: null,
    };
    const pipelineResult: PipelineResult = {
      body: "filtered output",
      applied: ["stripAnsi"],
      shortCircuited: false,
      reductionPct: 50,
      originalLines: 40,
      bodyLines: 8,
    };
    const result = wrapStdoutWithMarkers("raw output", plan, pipelineResult);
    expect(result).toContain("<bash-output-filtered");
    expect(result).toContain('reduction="50%"');
    expect(result).toContain('lines="8/40"');
    expect(result).toContain("</bash-output-filtered>");
  });

  test("wraps with both markers when rewrite and filter", () => {
    const plan: PreExecPlan = {
      effectiveCommand: "docker build --progress=plain .",
      filter: { name: "docker", matchCommand: /^docker$/ },
      rewrite: {
        from: "docker build .",
        to: "docker build --progress=plain .",
      },
    };
    const pipelineResult: PipelineResult = {
      body: "filtered",
      applied: ["stripAnsi"],
      shortCircuited: false,
      reductionPct: 30,
      originalLines: 20,
      bodyLines: 5,
    };
    const result = wrapStdoutWithMarkers("raw", plan, pipelineResult);
    expect(result).toContain("<bash-output-filtered");
    expect(result).toContain("actual=");
    expect(result).toContain('reduction="30%"');
    expect(result).toContain('lines="5/20"');
  });

  test("does not double-wrap persisted-output", () => {
    const alreadyWrapped = "<persisted-output>content</persisted-output>";
    expect(wrapStdoutWithMarkers(alreadyWrapped, NO_FILTER_PLAN, null)).toBe(
      alreadyWrapped,
    );
  });

  test("does not double-wrap bash-output-filtered", () => {
    const alreadyWrapped =
      '<bash-output-filtered original="" reduction="10%">body</bash-output-filtered>';
    const plan: PreExecPlan = {
      effectiveCommand: "npm install",
      filter: { name: "npm", matchCommand: /^npm$/ },
      rewrite: null,
    };
    expect(wrapStdoutWithMarkers(alreadyWrapped, plan, null)).toBe(
      alreadyWrapped,
    );
  });

  test("does not double-wrap bash-output-rewritten", () => {
    const alreadyWrapped =
      '<bash-output-rewritten original="" actual="">body</bash-output-rewritten>';
    expect(wrapStdoutWithMarkers(alreadyWrapped, NO_FILTER_PLAN, null)).toBe(
      alreadyWrapped,
    );
  });

  test("escapes XML special characters in attributes", () => {
    const plan: PreExecPlan = {
      effectiveCommand: 'cmd "arg"',
      filter: null,
      rewrite: { from: 'cmd "arg"', to: "cmd other" },
    };
    const result = wrapStdoutWithMarkers("output", plan, null);
    expect(result).toContain("&quot;");
  });

  test("truncates long original attribute", () => {
    const longCmd = "x".repeat(300);
    const plan: PreExecPlan = {
      effectiveCommand: longCmd,
      filter: null,
      rewrite: { from: longCmd, to: "short" },
    };
    const result = wrapStdoutWithMarkers("output", plan, null);
    // Attribute should be truncated to ~200 chars + ellipsis
    expect(result).toContain("…");
  });
});
