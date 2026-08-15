// Phase 13 — dotnet family (build / test / format).
import { describe, expect, test } from "bun:test";
import { runFilterBody, routesTo } from "src/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  DOTNET_BUILD_OK,
  DOTNET_BUILD_WARN,
  DOTNET_BUILD_ERR,
  DOTNET_TEST_OK,
  DOTNET_TEST_FAIL,
  DOTNET_FORMAT_OK,
  DOTNET_FORMAT_ERR,
} from "src/outputFilter/Bash/filters/__testutils__/phase13Samples.js";

describe("phase 13 — dotnet build", () => {
  test("clean 0/0 build collapses to sentinel", () => {
    expect(runFilterBody("dotnet-build", "dotnet build", DOTNET_BUILD_OK).trim()).toBe(
      "✓ dotnet build: succeeded",
    );
  });

  test("warnings are NOT collapsed (strict 0/0)", () => {
    const body = runFilterBody("dotnet-build", "dotnet build", DOTNET_BUILD_WARN);
    expect(body).not.toContain("✓ dotnet build");
    expect(body).toContain("3 Warning(s)");
    expect(body).toContain("Build succeeded.");
    expect(body).not.toContain("Microsoft (R) Build Engine");
  });

  test("build errors pass through, no sentinel", () => {
    const body = runFilterBody("dotnet-build", "dotnet build", DOTNET_BUILD_ERR);
    expect(body).not.toContain("✓ dotnet build");
    expect(body).toContain("error CS1002: ; expected");
    expect(body).toContain("Build FAILED.");
  });

  test("routes; binlog/getProperty rejected", () => {
    expect(routesTo("dotnet build")).toBe("dotnet-build");
    expect(routesTo("dotnet build -c Release")).toBe("dotnet-build");
    expect(routesTo("dotnet build -bl")).not.toBe("dotnet-build");
    expect(routesTo("dotnet build --getProperty:Version")).not.toBe("dotnet-build");
  });
});

describe("phase 13 — dotnet test", () => {
  test("all-pass / no-skip run collapses to sentinel", () => {
    expect(runFilterBody("dotnet-test", "dotnet test", DOTNET_TEST_OK).trim()).toBe(
      "✓ dotnet test: all passed",
    );
  });

  test("failing run keeps the Failed! summary and the stack trace", () => {
    const body = runFilterBody("dotnet-test", "dotnet test", DOTNET_TEST_FAIL);
    expect(body).not.toContain("✓ dotnet test");
    expect(body).toContain("Failed Calculator.Tests.CalcTests.Add");
    expect(body).toContain("Expected: 4");
    expect(body).toContain("Actual:   5");
    expect(body).toContain("Failed!  - Failed:     1");
    // banner ceremony stripped
    expect(body).not.toContain("Starting test execution");
    expect(body).not.toContain("Microsoft (R) Test Execution");
  });

  test("routes; trx/json logger rejected", () => {
    expect(routesTo("dotnet test")).toBe("dotnet-test");
    expect(routesTo("dotnet test --logger trx")).not.toBe("dotnet-test");
    expect(routesTo('dotnet test --logger "trx;LogFileName=r.trx"')).not.toBe(
      "dotnet-test",
    );
  });
});

describe("phase 13 — dotnet format", () => {
  test("clean format collapses to onEmpty sentinel", () => {
    expect(
      runFilterBody("dotnet-format", "dotnet format", DOTNET_FORMAT_OK).trim(),
    ).toBe("dotnet format: ok");
  });

  test("regression: a ≥2 blank-line run still hits onEmpty (no ` (×N)` artifact)", () => {
    // Before the root collapseIdenticalRuns fix, collapseRuns turned the blank
    // run into ` (×2)`, which survived the banner strip and defeated onEmpty.
    const raw =
      "Microsoft (R) Build Engine version 17.8.3\n\n\n  Determining projects to restore...\n";
    const body = runFilterBody("dotnet-format", "dotnet format", raw).trim();
    expect(body).not.toContain("(×");
    expect(body).toBe("dotnet format: ok");
  });

  test("verify-no-changes diagnostics pass through", () => {
    const body = runFilterBody(
      "dotnet-format",
      "dotnet format --verify-no-changes",
      DOTNET_FORMAT_ERR,
    );
    expect(body).toContain("error WHITESPACE:");
    expect(body).toContain("error IMPORTS:");
    expect(body).not.toContain("Determining projects");
    expect(body).not.toContain("Restored");
  });

  test("routes; report rejected", () => {
    expect(routesTo("dotnet format")).toBe("dotnet-format");
    expect(routesTo("dotnet format whitespace")).toBe("dotnet-format");
    expect(routesTo("dotnet format --report out.json")).not.toBe("dotnet-format");
  });
});
