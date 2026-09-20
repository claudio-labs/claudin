// grep/rg family — the match-line searchers.
import { describe, expect, test } from "bun:test";
import {
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

describe("phase 6.1.2 — grepRg", () => {
  test("ROI: grep sample reduces ≥ 28%", () => {
    assertReduction("grep-rg", "grep -rn isAbortError .", "grep", 28);
  });

  test("safety: relative paths are left untouched (idempotent)", () => {
    const raw = "src/shared/errors.ts:42:throw new Error\n";
    const body = runFilterBody("grep-rg", "rg 'new Error' src/", raw);
    expect(body).toBe(raw);
  });

  test("match: grep, rg, ag ✓; rg --json rejects", () => {
    expect(findFilterForCommand("grep -rn foo .")?.name).toBe("grep-rg");
    expect(findFilterForCommand("rg foo")?.name).toBe("grep-rg");
    expect(findFilterForCommand("ag foo")?.name).toBe("grep-rg");
    expect(findFilterForCommand("rg --json foo")?.name).not.toBe("grep-rg");
  });
});
