// swift family (swift build / xcodebuild).
import { describe, expect, test } from "bun:test";
import { runFilterBody, routesTo } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  SWIFT_OK,
  SWIFT_ERR,
  SWIFT_WARN,
  XCODE_OK,
  XCODE_FAIL,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/swiftSamples.js";

describe("swift build", () => {
  test("clean build collapses to sentinel", () => {
    expect(runFilterBody("swift-build", "swift build", SWIFT_OK).trim()).toBe(
      "✓ swift build: complete",
    );
  });

  test("errors pass through after Compiling/Linking strip", () => {
    const body = runFilterBody("swift-build", "swift build", SWIFT_ERR);
    expect(body).not.toContain("✓ swift build");
    expect(body).toContain("error: use of unresolved identifier 'foo'");
    expect(body).toContain("error: build had 1 command failure");
    expect(body).not.toContain("Linking MyApp");
  });

  test("'Build complete! (with warnings)' is NOT swallowed", () => {
    const body = runFilterBody("swift-build", "swift build", SWIFT_WARN);
    expect(body).not.toContain("✓ swift build");
    expect(body).toContain("warning: unused variable 'x'");
    expect(body).toContain("Build complete! (with warnings)");
  });

  test("routes swift build only", () => {
    expect(routesTo("swift build")).toBe("swift-build");
    expect(routesTo("swift build -c release")).toBe("swift-build");
    expect(routesTo("swift test")).not.toBe("swift-build");
  });
});

describe("xcodebuild", () => {
  test("clean build strips phases, keeps BUILD SUCCEEDED", () => {
    const body = runFilterBody("xcodebuild", "xcodebuild -scheme App", XCODE_OK).trim();
    expect(body).toBe("** BUILD SUCCEEDED **");
    expect(body).not.toContain("CompileSwift");
    expect(body).not.toContain("CodeSign");
    expect(body).not.toContain("builtin-codesign");
  });

  test("failure keeps diagnostics and BUILD FAILED", () => {
    const body = runFilterBody("xcodebuild", "xcodebuild -scheme App", XCODE_FAIL);
    expect(body).toContain("error: use of unresolved identifier 'foo'");
    expect(body).toContain("warning: variable 'x' was never used");
    expect(body).toContain("** BUILD FAILED **");
    expect(body).not.toContain("CompileSwift");
    expect(body).not.toContain("note: Using new build system");
  });

  test("regression: a ≥2 blank-line run between phase lines still hits onEmpty (no ` (×N)` artifact)", () => {
    // Before the root collapseIdenticalRuns fix, collapseRuns turned the blank
    // run into ` (×2)`, which survived the phase strip and defeated onEmpty.
    const raw =
      "CompileSwift normal x86_64 A.swift\n\n\nCompileSwift normal x86_64 B.swift\n";
    const body = runFilterBody("xcodebuild", "xcodebuild -scheme App", raw).trim();
    expect(body).not.toContain("(×");
    expect(body).toBe("xcodebuild: ok");
  });

  test("routes; -json rejected", () => {
    expect(routesTo("xcodebuild -scheme App build")).toBe("xcodebuild");
    expect(routesTo("xcodebuild -list -json")).not.toBe("xcodebuild");
  });
});
