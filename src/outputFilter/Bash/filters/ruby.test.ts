// Phase 13 — ruby family (rake).
import { describe, expect, test } from "bun:test";
import { runFilterBody, routesTo } from "./__testutils__/harness.js";
import { RAKE_OK, RAKE_FAIL } from "./__testutils__/phase13Samples.js";

describe("phase 13 — rake", () => {
  test("strips ANSI and collapses blank runs, keeps the summary", () => {
    const body = runFilterBody("rake", "rake test", RAKE_OK);
    expect(body).not.toContain("\x1b["); // ANSI stripped
    expect(body).toContain("12 runs, 20 assertions, 0 failures, 0 errors, 0 skips");
    expect(body).toContain("............");
    // blank-line runs collapsed → no triple newline survives
    expect(body).not.toContain("\n\n\n");
  });

  test("rake aborted! footer is preserved verbatim (conservative)", () => {
    const body = runFilterBody("rake", "rake db:migrate", RAKE_FAIL);
    expect(body).toContain("rake aborted!");
    expect(body).toContain("ActiveRecord::PendingMigrationError");
    expect(body).toContain("Tasks: TOP => db:migrate");
    expect(body).toContain("(See full trace by running task with --trace)");
  });

  test("routes rake; --trace keeps raw", () => {
    expect(routesTo("rake test")).toBe("rake");
    expect(routesTo("rake db:migrate")).toBe("rake");
    expect(routesTo("rake db:migrate --trace")).not.toBe("rake");
  });
});
