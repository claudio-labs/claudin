// tests-js family — the JS/TS test runners (jest / vitest / bun test /
// mocha / playwright).
import { describe, expect, test } from "bun:test";
import {
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

// ---------------------------------------------------------------------------
// Phase 6.2 — JS/TS toolchain (jest, vitest, bun test, mocha, playwright)
// ---------------------------------------------------------------------------

describe("phase 6.2 — jest", () => {
  test("ROI: jest-clean ≥90% reduction (collapse to sentinel)", () => {
    assertReduction("jest", "jest", "jest-clean", 90);
  });
  test("match: jest, npx jest, yarn jest, pnpm jest", () => {
    expect(findFilterForCommand("jest")?.name).toBe("jest");
    expect(findFilterForCommand("npx jest")?.name).toBe("jest");
    expect(findFilterForCommand("yarn jest")?.name).toBe("jest");
    expect(findFilterForCommand("pnpm jest")?.name).toBe("jest");
  });
  test("reject: --watch / --listTests passthrough", () => {
    expect(findFilterForCommand("jest --watch")).toBeNull();
    expect(findFilterForCommand("jest --listTests")).toBeNull();
  });
  test("safety: failure run is not collapsed", () => {
    const failed = "PASS  src/foo.test.ts\nFAIL  src/bar.test.ts\nTests:       1 failed, 2 passed, 3 total";
    expect(runFilterBody("jest", "jest", failed)).toContain("FAIL");
  });
});

describe("phase 6.2 — vitest", () => {
  test("ROI: vitest-clean ≥90% reduction", () => {
    assertReduction("vitest", "vitest", "vitest-clean", 90);
  });
  test("match: vitest, npx vitest", () => {
    expect(findFilterForCommand("vitest")?.name).toBe("vitest");
    expect(findFilterForCommand("npx vitest")?.name).toBe("vitest");
  });
  test("reject: --ui / --watch passthrough", () => {
    expect(findFilterForCommand("vitest --ui")).toBeNull();
    expect(findFilterForCommand("vitest --watch")).toBeNull();
  });
});

describe("phase 6.2 — bun test", () => {
  test("ROI: bun-test-clean ≥90% reduction", () => {
    assertReduction("bun-test", "bun test", "bun-test-clean", 90);
  });
  test("match: bun test", () => {
    expect(findFilterForCommand("bun test")?.name).toBe("bun-test");
    expect(findFilterForCommand("bun test src/foo.test.ts")?.name).toBe("bun-test");
  });
  test("reject: --watch passthrough", () => {
    expect(findFilterForCommand("bun test --watch")).toBeNull();
  });
  test("safety: failure run is not collapsed", () => {
    const failed = "src/foo.test.ts:\n✓ a\n✗ b\n 1 pass\n 1 fail";
    expect(runFilterBody("bun-test", "bun test", failed)).toContain("fail");
  });
});

describe("phase 6.2 — mocha", () => {
  test("ROI: mocha-clean ≥80% reduction", () => {
    assertReduction("mocha", "mocha", "mocha-clean", 80);
  });
  test("match: mocha, npx mocha", () => {
    expect(findFilterForCommand("mocha")?.name).toBe("mocha");
    expect(findFilterForCommand("npx mocha")?.name).toBe("mocha");
  });
  test("reject: --reporter=json passthrough", () => {
    expect(findFilterForCommand("mocha --reporter=json")).toBeNull();
  });
});

describe("phase 6.2 — playwright", () => {
  test("ROI: playwright-clean ≥80% reduction", () => {
    assertReduction("playwright", "playwright test", "playwright-clean", 80);
  });
  test("match: playwright test, npx playwright test", () => {
    expect(findFilterForCommand("playwright test")?.name).toBe("playwright");
    expect(findFilterForCommand("npx playwright test")?.name).toBe("playwright");
  });
  test("reject: --ui / --debug passthrough", () => {
    expect(findFilterForCommand("playwright test --ui")).toBeNull();
    expect(findFilterForCommand("playwright test --debug")).toBeNull();
  });
  test("non-test playwright subcommands do not match", () => {
    expect(findFilterForCommand("playwright codegen")).toBeNull();
    expect(findFilterForCommand("playwright install")).toBeNull();
  });
});
