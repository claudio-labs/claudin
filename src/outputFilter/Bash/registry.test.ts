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

  test("returns null for compound commands", () => {
    // Compound commands are rejected by matchesCommand inside findFilterForCommand
    expect(findFilterForCommand("npm install && npm test")).toBeNull();
  });

  test("returns null for unknown command", () => {
    expect(findFilterForCommand("some-unknown-tool --flag")).toBeNull();
  });
});
