import { describe, expect, test } from "bun:test";
import {
  applyPipeline,
  hasCompound,
  matchesCommand,
  maybeRewrite,
  parseBashCommand,
} from "./pipeline.js";
import type { FilterSpec } from "./types.js";

// ---------------------------------------------------------------------------
// parseBashCommand
// ---------------------------------------------------------------------------

describe("parseBashCommand", () => {
  test("parses simple command", () => {
    const ctx = parseBashCommand("npm install");
    expect(ctx.verb).toBe("npm");
    expect(ctx.args).toEqual(["install"]);
  });

  test("strips env assignments", () => {
    const ctx = parseBashCommand("FOO=bar BAZ=qux node server.js");
    expect(ctx.verb).toBe("node");
    expect(ctx.args).toEqual(["server.js"]);
  });

  test("strips sudo prefix", () => {
    const ctx = parseBashCommand("sudo apt update");
    expect(ctx.verb).toBe("apt");
    expect(ctx.args).toEqual(["update"]);
  });

  test("strips time prefix", () => {
    const ctx = parseBashCommand("time make build");
    expect(ctx.verb).toBe("make");
    expect(ctx.args).toEqual(["build"]);
  });
});

// ---------------------------------------------------------------------------
// hasCompound
// ---------------------------------------------------------------------------

describe("hasCompound", () => {
  test("returns false for simple command", () => {
    expect(hasCompound("npm install")).toBe(false);
  });

  test("returns true for &&", () => {
    expect(hasCompound("npm install && npm test")).toBe(true);
  });

  test("returns true for ||", () => {
    expect(hasCompound("npm install || echo fail")).toBe(true);
  });

  test("returns true for $(...)", () => {
    expect(hasCompound("echo $(date)")).toBe(true);
  });

  test("returns true for backticks", () => {
    expect(hasCompound("echo `date`")).toBe(true);
  });

  test("returns true for if/then", () => {
    expect(hasCompound("if [ -f foo ]; then echo ok; fi")).toBe(true);
  });

  test("returns true for single pipe |", () => {
    expect(hasCompound("git log | head -10")).toBe(true);
  });

  test("returns true for single semicolon ;", () => {
    expect(hasCompound("git log; ls")).toBe(true);
  });

  test("returns false for --for-each-ref (P1: for inside flag name)", () => {
    expect(hasCompound("git log --for-each-ref")).toBe(false);
  });

  test("returns false for 'echo task done' (P2: done as argument word)", () => {
    expect(hasCompound('echo "task done"')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchesCommand
// ---------------------------------------------------------------------------

describe("matchesCommand", () => {
  const filter: FilterSpec = {
    name: "npm",
    matchCommand: /^npm$/,
  };

  test("matches simple command", () => {
    expect(matchesCommand(filter, "npm install")).toBe(true);
  });

  test("rejects compound command", () => {
    expect(matchesCommand(filter, "npm install && npm test")).toBe(false);
  });

  test("rejects non-matching command", () => {
    expect(matchesCommand(filter, "yarn install")).toBe(false);
  });

  test("respects matchCommandReject", () => {
    const filterWithReject: FilterSpec = {
      name: "npm",
      matchCommand: /^npm$/,
      matchCommandReject: /npm\s+run/,
    };
    expect(matchesCommand(filterWithReject, "npm install")).toBe(true);
    expect(matchesCommand(filterWithReject, "npm run build")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeRewrite
// ---------------------------------------------------------------------------

describe("maybeRewrite", () => {
  test("returns null when no rewriteCommand", () => {
    const filter: FilterSpec = { name: "test", matchCommand: /^test$/ };
    expect(maybeRewrite(filter, "test foo")).toBeNull();
  });

  test("returns null when rewrite returns same command", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      rewriteCommand: () => "test foo",
    };
    expect(maybeRewrite(filter, "test foo")).toBeNull();
  });

  test("returns rewrite result when different", () => {
    const filter: FilterSpec = {
      name: "docker",
      matchCommand: /^docker$/,
      rewriteCommand: (ctx) =>
        ctx.args[0] === "build" ? `${ctx.command} --progress=plain` : null,
    };
    const result = maybeRewrite(filter, "docker build .");
    expect(result).toEqual({
      rewritten: "docker build . --progress=plain",
      original: "docker build .",
    });
  });

  test("returns null when rewriteCommand returns null", () => {
    const filter: FilterSpec = {
      name: "docker",
      matchCommand: /^docker$/,
      rewriteCommand: (ctx) =>
        ctx.args[0] === "build" ? `${ctx.command} --progress=plain` : null,
    };
    expect(maybeRewrite(filter, "docker run .")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyPipeline — individual stages
// ---------------------------------------------------------------------------

describe("applyPipeline", () => {
  test("stripAnsi removes escape sequences", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      stripAnsi: true,
    };
    const result = applyPipeline(filter, "\x1b[32mHello\x1b[0m World");
    expect(result.body).toBe("Hello World");
    expect(result.applied).toContain("stripAnsi");
  });

  test("replace applies replacement rules", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      replace: [{ pattern: /foo/g, replacement: "bar" }],
    };
    const result = applyPipeline(filter, "foo baz foo");
    expect(result.body).toBe("bar baz bar");
  });

  test("collapseRuns collapses identical lines", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      collapseRuns: true,
    };
    const input = ["line1", "line2", "line2", "line2", "line3"].join("\n");
    const result = applyPipeline(filter, input);
    expect(result.applied).toContain("collapseRuns");
    expect(result.body).toContain("line2");
  });

  test("collapseDigitTemplates collapses digit-varying lines", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      collapseDigitTemplates: true,
    };
    const input = [
      "file 1",
      "file 2",
      "file 3",
      "file 4",
      "file 5",
      "file 6",
    ].join("\n");
    const result = applyPipeline(filter, input);
    expect(result.applied).toContain("collapseDigitTemplates");
  });

  test("collapseDigitTemplates with custom minRun", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      collapseDigitTemplates: { minRun: 3 },
    };
    const input = ["file 1", "file 2", "file 3", "file 4"].join("\n");
    const result = applyPipeline(filter, input);
    expect(result.applied).toContain("collapseDigitTemplates");
  });

  test("dedupGlobal removes duplicate lines", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      dedupGlobal: true,
    };
    const input = ["alpha", "beta", "alpha", "gamma", "beta"].join("\n");
    const result = applyPipeline(filter, input);
    expect(result.applied).toContain("dedupGlobal");
    const lines = result.body.split("\n");
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
  });

  test("matchOutput short-circuits", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      matchOutput: [{ pattern: /ERROR/, message: "Build failed" }],
    };
    const result = applyPipeline(
      filter,
      "some output\nERROR: something broke\nmore output",
    );
    expect(result.shortCircuited).toBe(true);
    expect(result.body).toBe("Build failed");
  });

  test("matchOutput respects unless", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      matchOutput: [
        { pattern: /ERROR/, message: "Build failed", unless: /WARNING/ },
      ],
    };
    const result = applyPipeline(
      filter,
      "WARNING: something\nERROR: something broke",
    );
    expect(result.shortCircuited).toBe(false);
  });

  test("stripLinesMatching removes matching lines", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      stripLinesMatching: [/^\s*$/],
    };
    const result = applyPipeline(filter, "line1\n\nline2\n\nline3");
    expect(result.applied).toContain("stripLinesMatching");
    expect(result.body).toBe("line1\nline2\nline3");
  });

  test("keepLinesMatching keeps only matching lines", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      keepLinesMatching: [/^ERR/],
    };
    const result = applyPipeline(filter, "line1\nERR: bad\nline3\nERR: worse");
    expect(result.applied).toContain("keepLinesMatching");
    expect(result.body).toBe("ERR: bad\nERR: worse");
  });

  test("truncateLineAt truncates long lines", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      truncateLineAt: 10,
    };
    const result = applyPipeline(
      filter,
      "short\nthis is a very long line that exceeds the limit",
    );
    expect(result.applied).toContain("truncateLineAt");
    const lines = result.body.split("\n");
    expect(lines[0]).toBe("short");
    expect(lines[1]?.length ?? 0).toBeLessThanOrEqual(11);
  });

  test("headLines + tailLines keeps bookends", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      headLines: 2,
      tailLines: 1,
    };
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const result = applyPipeline(filter, lines.join("\n"));
    expect(result.applied).toContain("headTailLines");
    expect(result.body).toContain("line0");
    expect(result.body).toContain("line19");
  });

  test("maxLines truncates long output", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      maxLines: 5,
      headLines: 2,
      tailLines: 2,
    };
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const result = applyPipeline(filter, lines.join("\n"));
    expect(result.applied).toContain("maxLines");
    expect(result.body).toContain("line0");
    expect(result.body).toContain("line99");
  });

  test("onEmpty substitutes empty result", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      stripLinesMatching: [/.*/],
      onEmpty: "(no output)",
    };
    const result = applyPipeline(filter, "anything");
    expect(result.body).toBe("(no output)");
    expect(result.applied).toContain("onEmpty");
  });

  test("P5: maxLines with headLines+tailLines >= lines.length does not expand output", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      maxLines: 10,
      headLines: 20,
      tailLines: 20,
    };
    const input = Array.from({ length: 15 }, (_, i) => `line${i}`).join("\n");
    const result = applyPipeline(filter, input);
    const resultLines = result.body.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(input.split("\n").length + 1);
  });

  test("empty input returns empty with no reduction", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      stripAnsi: true,
    };
    const result = applyPipeline(filter, "");
    expect(result.body).toBe("");
    expect(result.reductionPct).toBe(0);
  });

  test("reductionPct is computed correctly", () => {
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      stripLinesMatching: [/line/],
    };
    const result = applyPipeline(filter, "line1\nline2\nline3");
    expect(result.reductionPct).toBeGreaterThan(0);
  });

  test("locale degrade: matchCommand miss returns no marker, no exception", () => {
    // Simulates non-EN locale where command output regex doesn't match.
    // matchOutput pattern doesn't fire → pipeline runs cleanly, no short-circuit.
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^test$/,
      matchOutput: [{ pattern: /ENGLISH-ONLY/, message: "Build failed" }],
    };
    const result = applyPipeline(filter, "FALLOU: idioma diferente\nlinha 2");
    expect(result.shortCircuited).toBe(false);
    expect(result.body).toBe("FALLOU: idioma diferente\nlinha 2");
  });

  // B-1: stripAnsi must run before matchOutput so ANSI-colorized sentinels match
  test("matchOutput fires on ANSI-colorized output when stripAnsi:true", () => {
    const ansiGreen = "\x1b[32m";
    const ansiReset = "\x1b[0m";
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^cargo$/,
      stripAnsi: true,
      matchOutput: [
        { pattern: /Finished.*release/, message: "Build succeeded" },
      ],
    };
    // Output contains ANSI codes around the sentinel text
    const raw = `${ansiGreen}Finished release [optimized] target(s)${ansiReset}`;
    const result = applyPipeline(filter, raw);
    expect(result.shortCircuited).toBe(true);
    expect(result.body).toBe("Build succeeded");
    expect(result.applied).toContain("stripAnsi");
  });

  test("matchOutput does NOT fire on ANSI-colorized output when pattern anchored and stripAnsi:false", () => {
    const ansiGreen = "\x1b[32m";
    const ansiReset = "\x1b[0m";
    const filter: FilterSpec = {
      name: "test",
      matchCommand: /^cargo$/,
      // stripAnsi intentionally omitted
      // Anchored pattern: only matches clean text, not ANSI-wrapped text
      matchOutput: [{ pattern: /^Finished release/, message: "Build succeeded" }],
    };
    // "\x1b[32m" prefix prevents "^Finished" from matching at the start of the string
    const raw = `${ansiGreen}Finished release [optimized] target(s)${ansiReset}`;
    const result = applyPipeline(filter, raw);
    expect(result.shortCircuited).toBe(false);
  });
});
