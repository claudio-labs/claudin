// go family — the Go toolchain (go build / go vet / golangci-lint).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runFilterBody,
  assertReduction,
  findFilterForCommand,
  SAMPLES_DIR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

// ===========================================================================
// Phase 12.4 — Go toolchain + Rust extras (rtk gap-fill).
// ===========================================================================

describe("phase 12.4 — go-build", () => {
  test("ROI: cold-cache download-only output collapses to positive marker", () => {
    // Cold-cache success (only `go: downloading/finding/found` lines) is
    // short-circuited via matchOutput to a positive marker so the LLM doesn't
    // see an empty body and wonder if the build ran at all. Floor of 75%
    // accounts for the marker string itself (~50 chars).
    assertReduction("go-build", "go build ./...", "go-build", 75);
  });

  test("matchOutput: cold-cache success emits positive marker", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "go-build.txt"), "utf8");
    const body = runFilterBody("go-build", "go build ./...", raw);
    expect(body).toContain("go build: dependencies downloaded, build ok");
  });

  test("safety: compile errors are preserved (no positive marker on error)", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "go-build-error.txt"), "utf8");
    const body = runFilterBody("go-build", "go build ./...", raw);
    expect(body).toContain("declared and not used");
    expect(body).toContain("undefined: fmt.Prinln");
    // The positive marker must not appear when an error is present.
    expect(body).not.toContain("dependencies downloaded, build ok");
  });

  test("match: go build ✓; -json rejects", () => {
    expect(findFilterForCommand("go build ./...")?.name).toBe("go-build");
    expect(findFilterForCommand("go build -json ./...")?.name).not.toBe(
      "go-build",
    );
  });
});

describe("phase 12.4 — go-vet", () => {
  test("safety: vet diagnostics are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "go-vet.txt"), "utf8");
    const body = runFilterBody("go-vet", "go vet ./...", raw);
    expect(body).toContain("format %d has arg");
  });

  test("match: go vet ✓; -json rejects", () => {
    expect(findFilterForCommand("go vet ./...")?.name).toBe("go-vet");
    expect(findFilterForCommand("go vet -json ./...")?.name).not.toBe("go-vet");
  });
});

describe("phase 12.4 — golangci-lint", () => {
  test("safety: lint diagnostics preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "golangci-lint.txt"),
      "utf8",
    );
    const body = runFilterBody("golangci-lint", "golangci-lint run", raw);
    // The sample includes real linter diagnostics; assert it's not stripped.
    expect(body.length).toBeGreaterThan(0);
    expect(body).toBe(raw); // passthrough (signal floor)
  });

  test("match: golangci-lint run ✓; --out-format=json rejects", () => {
    expect(findFilterForCommand("golangci-lint run")?.name).toBe(
      "golangci-lint",
    );
    expect(
      findFilterForCommand("golangci-lint run --out-format=json")?.name,
    ).not.toBe("golangci-lint");
  });
});
