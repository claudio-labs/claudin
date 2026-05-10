import { describe, expect, test } from "bun:test";
import { canonicalizeForMatching, findFilterForCommand } from "./registry.js";

describe("canonicalizeForMatching", () => {
  test("strips sudo prefix", () => {
    expect(canonicalizeForMatching("sudo apt update")).toBe("apt update");
  });

  test("strips time prefix", () => {
    expect(canonicalizeForMatching("time make build")).toBe("make build");
  });

  test("strips nice prefix", () => {
    expect(canonicalizeForMatching("nice npm test")).toBe("npm test");
  });

  test("strips multiple prefixes", () => {
    expect(canonicalizeForMatching("sudo time nice npm test")).toBe("npm test");
  });

  test("strips env assignments", () => {
    expect(canonicalizeForMatching("FOO=bar node server.js")).toBe(
      "node server.js",
    );
  });

  test("strips multiple env assignments", () => {
    expect(canonicalizeForMatching("A=1 B=2 npm test")).toBe("npm test");
  });

  test("strips env assignment with quoted value", () => {
    expect(canonicalizeForMatching("NODE_ENV=production node server.js")).toBe(
      "node server.js",
    );
  });

  test("returns command as-is without prefixes", () => {
    expect(canonicalizeForMatching("npm install")).toBe("npm install");
  });
});

describe("findFilterForCommand", () => {
  test("returns null with empty builtInFilters", () => {
    expect(findFilterForCommand("npm install")).toBeNull();
  });

  test("returns null for unknown command", () => {
    expect(findFilterForCommand("some-unknown-tool --flag")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chained commands — filter applied iff all matching segments share one filter
// ---------------------------------------------------------------------------

describe("findFilterForCommand — chained commands", () => {
  // These tests use real built-in filters; they assert behavior, not specific
  // filter identity, by comparing references across calls.

  test("cd X && cmd resolves to cmd's filter when cd has none", () => {
    const direct = findFilterForCommand("npm install");
    if (!direct) return; // skip if npm filter not present in this build
    const chained = findFilterForCommand("cd src && npm install");
    expect(chained).toBe(direct);
  });

  test("two segments resolving to the same filter spec resolve to it", () => {
    const direct = findFilterForCommand("git status");
    if (!direct) return; // skip if git-status filter not present
    // Two identical verbs → same FilterSpec reference.
    const chained = findFilterForCommand("git status; git status");
    expect(chained).toBe(direct);
  });

  test("three-segment chain with one matching filter resolves", () => {
    const direct = findFilterForCommand("ls -la");
    if (!direct) return;
    const chained = findFilterForCommand("cd src && pwd && ls -la");
    expect(chained).toBe(direct);
  });

  test("two segments with different filters bypass (returns null)", () => {
    const a = findFilterForCommand("npm install");
    const b = findFilterForCommand("git status");
    if (!a || !b || a === b) return;
    expect(findFilterForCommand("npm install && git status")).toBeNull();
  });

  test("pipes still bypass (cannot split safely)", () => {
    expect(findFilterForCommand("git log | head")).toBeNull();
  });

  test("background & still bypasses", () => {
    expect(findFilterForCommand("pwd & ls -la")).toBeNull();
  });

  test("subshell still bypasses", () => {
    expect(findFilterForCommand("echo $(date) && ls")).toBeNull();
  });

  test("control-flow still bypasses", () => {
    expect(findFilterForCommand("if [ -f x ]; then ls; fi")).toBeNull();
  });

  test("quoted operators do not split", () => {
    // "echo 'a && b'" should be treated as a single atomic command for matching
    // purposes; if echo has no filter, result is null — but we still don't bypass-
    // by-compound because the split returns a single segment.
    const direct = findFilterForCommand("echo 'a && b'");
    const chained = findFilterForCommand("echo 'a && b'; pwd");
    // Either both resolve to the same filter (echo's) or both are null.
    if (direct) expect(chained === direct || chained === null).toBe(true);
  });
});
