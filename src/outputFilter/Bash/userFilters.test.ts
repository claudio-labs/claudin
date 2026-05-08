import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getGlobalConfig, saveGlobalConfig } from "src/utils/config.js";
import {
  clearUserFiltersCache,
  compileUserFilters,
  isSafeRegex,
  loadUserFilters,
} from "./userFilters.js";

// ---------------------------------------------------------------------------
// isSafeRegex
// ---------------------------------------------------------------------------

describe("isSafeRegex", () => {
  test("accepts simple literal pattern", () => {
    expect(isSafeRegex("Finished.*release")).toBe(true);
  });

  test("accepts anchored pattern", () => {
    expect(isSafeRegex("^error:")).toBe(true);
  });

  test("rejects nested quantifiers (a+)+", () => {
    expect(isSafeRegex("(a+)+")).toBe(false);
  });

  test("rejects nested quantifiers (a*)*", () => {
    expect(isSafeRegex("(a*)*")).toBe(false);
  });

  test("rejects star-of-star .*.*", () => {
    expect(isSafeRegex(".*.*")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compileUserFilters
// ---------------------------------------------------------------------------

describe("compileUserFilters", () => {
  test("returns empty array for invalid input", () => {
    expect(compileUserFilters(null)).toEqual([]);
    expect(compileUserFilters("not an object")).toEqual([]);
    expect(compileUserFilters({ filters: "not an array" })).toEqual([]);
  });

  test("compiles a valid filter", () => {
    const raw = {
      filters: [
        {
          name: "my-filter",
          matchCommand: "^mycli$",
          stripAnsi: true,
          maxLines: 50,
        },
      ],
    };
    const filters = compileUserFilters(raw);
    expect(filters).toHaveLength(1);
    expect(filters[0]!.name).toBe("my-filter");
    expect(filters[0]!.stripAnsi).toBe(true);
    expect(filters[0]!.maxLines).toBe(50);
  });

  test("skips individual filter with unsafe regex, keeps valid ones", () => {
    const raw = {
      filters: [
        {
          name: "unsafe",
          matchCommand: "(a+)+", // ReDoS
        },
        {
          name: "safe",
          matchCommand: "^mycli$",
        },
      ],
    };
    const filters = compileUserFilters(raw);
    expect(filters).toHaveLength(1);
    expect(filters[0]!.name).toBe("safe");
  });

  test("skips filter with invalid regex", () => {
    const raw = {
      filters: [
        {
          name: "invalid",
          matchCommand: "[invalid", // unclosed bracket
        },
      ],
    };
    const filters = compileUserFilters(raw);
    expect(filters).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadUserFilters — B-2: must read real file from config dir
// ---------------------------------------------------------------------------

describe("loadUserFilters", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `claudio-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.CLAUDIO_CONFIG_DIR = tmpDir;
    clearUserFiltersCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CLAUDIO_CONFIG_DIR;
    clearUserFiltersCache();
  });

  test("returns empty array when file does not exist", () => {
    const filters = loadUserFilters();
    expect(filters).toEqual([]);
  });

  test("loads and compiles filters from bash-filters.json", () => {
    const content = JSON.stringify({
      filters: [
        {
          name: "my-cli",
          matchCommand: "^mycli$",
          maxLines: 100,
        },
      ],
    });
    writeFileSync(join(tmpDir, "bash-filters.json"), content, "utf8");

    const filters = loadUserFilters();
    expect(filters).toHaveLength(1);
    expect(filters[0]!.name).toBe("my-cli");
    expect(filters[0]!.maxLines).toBe(100);
  });

  test("returns empty array for invalid JSON in file", () => {
    writeFileSync(join(tmpDir, "bash-filters.json"), "not json", "utf8");
    const filters = loadUserFilters();
    expect(filters).toEqual([]);
  });

  test("caches result across calls", () => {
    const content = JSON.stringify({
      filters: [{ name: "cached", matchCommand: "^x$" }],
    });
    writeFileSync(join(tmpDir, "bash-filters.json"), content, "utf8");

    const first = loadUserFilters();
    // Overwrite file after first load — cache should prevent re-read
    writeFileSync(join(tmpDir, "bash-filters.json"), JSON.stringify({ filters: [] }), "utf8");
    const second = loadUserFilters();

    expect(first).toBe(second); // same reference = cache hit
  });

  test("clearUserFiltersCache forces re-read", () => {
    writeFileSync(
      join(tmpDir, "bash-filters.json"),
      JSON.stringify({ filters: [{ name: "v1", matchCommand: "^x$" }] }),
      "utf8",
    );
    const first = loadUserFilters();
    expect(first).toHaveLength(1);

    clearUserFiltersCache();
    writeFileSync(
      join(tmpDir, "bash-filters.json"),
      JSON.stringify({ filters: [] }),
      "utf8",
    );
    const second = loadUserFilters();
    expect(second).toHaveLength(0);
  });

  test("returns empty array when bashOutputFilterUserEnabled is false", () => {
    const saved = getGlobalConfig().bashOutputFilterUserEnabled;
    try {
      writeFileSync(
        join(tmpDir, "bash-filters.json"),
        JSON.stringify({ filters: [{ name: "my-cli", matchCommand: "^mycli$" }] }),
        "utf8",
      );
      saveGlobalConfig((c) => ({ ...c, bashOutputFilterUserEnabled: false }));
      clearUserFiltersCache();

      const filters = loadUserFilters();
      expect(filters).toEqual([]);
    } finally {
      saveGlobalConfig((c) => ({ ...c, bashOutputFilterUserEnabled: saved }));
      clearUserFiltersCache();
    }
  });

  test("loads normally when bashOutputFilterUserEnabled is undefined", () => {
    const saved = getGlobalConfig().bashOutputFilterUserEnabled;
    try {
      writeFileSync(
        join(tmpDir, "bash-filters.json"),
        JSON.stringify({ filters: [{ name: "my-cli", matchCommand: "^mycli$" }] }),
        "utf8",
      );
      saveGlobalConfig((c) => ({ ...c, bashOutputFilterUserEnabled: undefined }));
      clearUserFiltersCache();

      const filters = loadUserFilters();
      expect(filters).toHaveLength(1);
    } finally {
      saveGlobalConfig((c) => ({ ...c, bashOutputFilterUserEnabled: saved }));
      clearUserFiltersCache();
    }
  });
});

// ---------------------------------------------------------------------------
// compileUserFilters — schema hardening (6.1.6 acceptance criteria)
// ---------------------------------------------------------------------------

describe("compileUserFilters — schema hardening", () => {
  test("rejects matchCommand exceeding 500 chars", () => {
    const raw = { filters: [{ name: "x", matchCommand: "a".repeat(501) }] };
    expect(compileUserFilters(raw)).toEqual([]);
  });

  test("accepts matchCommand exactly 500 chars", () => {
    const raw = { filters: [{ name: "x", matchCommand: "a".repeat(500) }] };
    expect(compileUserFilters(raw)).toHaveLength(1);
  });

  test("rejects replacement exceeding 500 chars", () => {
    const raw = {
      filters: [
        {
          name: "x",
          matchCommand: "^x$",
          replace: [{ pattern: "a", replacement: "b".repeat(501), flags: "g" }],
        },
      ],
    };
    expect(compileUserFilters(raw)).toEqual([]);
  });

  test("rejects filter with unknown field — rewriteCommand blocked by strict()", () => {
    const raw = {
      filters: [{ name: "x", matchCommand: "^x$", rewriteCommand: "echo safe" }],
    };
    expect(compileUserFilters(raw)).toEqual([]);
  });

  test("rejects name with uppercase letters", () => {
    const raw = { filters: [{ name: "MyFilter", matchCommand: "^x$" }] };
    expect(compileUserFilters(raw)).toEqual([]);
  });

  test("rejects name with spaces", () => {
    const raw = { filters: [{ name: "my filter", matchCommand: "^x$" }] };
    expect(compileUserFilters(raw)).toEqual([]);
  });

  test("rejects name exceeding 60 chars", () => {
    const raw = { filters: [{ name: "a".repeat(61), matchCommand: "^x$" }] };
    expect(compileUserFilters(raw)).toEqual([]);
  });

  test("accepts name with lowercase letters, digits, and hyphens", () => {
    const raw = { filters: [{ name: "my-filter-01", matchCommand: "^x$" }] };
    expect(compileUserFilters(raw)).toHaveLength(1);
  });

  test("rejects stripLinesMatching entry exceeding 500 chars", () => {
    const raw = {
      filters: [
        {
          name: "x",
          matchCommand: "^x$",
          stripLinesMatching: ["a".repeat(501)],
        },
      ],
    };
    expect(compileUserFilters(raw)).toEqual([]);
  });
});
