// tsc family — the TypeScript compiler.
import { describe, expect, test } from "bun:test";
import {
  loadSample,
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

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
