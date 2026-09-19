// tests family — the non-JS test runners (pytest / rspec / go test).
import { describe, expect, test } from "bun:test";
import {
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

describe("phase 6.1.2 — pytest", () => {
  test("ROI: pytest-clean sample reduces ≥ 90%", () => {
    assertReduction("pytest", "pytest", "pytest-clean", 90);
  });

  test("safety: matchOutput does NOT fire when a test FAILED", () => {
    const raw = [
      "============== test session starts ==============",
      "platform linux -- Python 3.11",
      "FAILED tests/test_x.py::test_broken - AssertionError",
      "========== 1 failed, 4 passed in 0.12s ==========",
    ].join("\n");
    const body = runFilterBody("pytest", "pytest", raw);
    expect(body).toContain("FAILED");
    expect(body).not.toBe("✓ pytest: all tests passed");
  });

  test("match: pytest & python -m pytest ✓; --json-report rejects", () => {
    expect(findFilterForCommand("pytest")?.name).toBe("pytest");
    expect(findFilterForCommand("python -m pytest tests/")?.name).toBe("pytest");
    expect(findFilterForCommand("pytest --json-report")?.name).not.toBe("pytest");
  });
});

describe("phase 6.1.2 — rspec", () => {
  test("ROI: rspec sample reduces ≥ 68%", () => {
    assertReduction("rspec", "rspec", "rspec", 68);
  });

  test("safety: matchOutput does NOT fire when summary reports failures", () => {
    const raw = [
      "..F..",
      "Failures:",
      "  1) Foo does bar",
      "     Failure/Error: expect(x).to eq(y)",
      "5 examples, 1 failure",
    ].join("\n");
    const body = runFilterBody("rspec", "rspec", raw);
    expect(body).toContain("Failures:");
    expect(body).not.toBe("✓ rspec: all tests passed");
  });

  test("match: rspec & bundle exec rspec both register", () => {
    expect(findFilterForCommand("rspec")?.name).toBe("rspec");
    expect(findFilterForCommand("bundle exec rspec spec/")?.name).toBe("rspec");
  });
});

describe("phase 6.1.2 — goTest", () => {
  test("ROI: go-test sample reduces ≥ 77%", () => {
    assertReduction("go-test", "go test ./...", "go-test", 77);
  });

  test("safety: matchOutput does NOT fire on FAIL / panic", () => {
    const raw = [
      "=== RUN   TestOne",
      "--- FAIL: TestOne (0.00s)",
      "    foo_test.go:10: expected 1 got 2",
      "FAIL",
      "ok  pkg/foo  0.02s",
    ].join("\n");
    const body = runFilterBody("go-test", "go test ./...", raw);
    expect(body).toContain("--- FAIL");
    expect(body).not.toBe("✓ go test: all tests passed");
  });

  test("match: go test ✓; go build ✗", () => {
    expect(findFilterForCommand("go test ./...")?.name).toBe("go-test");
    expect(findFilterForCommand("go build")?.name).not.toBe("go-test");
  });
});
