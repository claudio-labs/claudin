// ls family — the long listing (`ls -la`).
import { describe, expect, test } from "bun:test";
import {
  loadSample,
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

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
