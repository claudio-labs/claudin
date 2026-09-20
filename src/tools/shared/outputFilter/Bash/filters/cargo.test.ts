// cargo family — build / check / test / clippy, plus run and fmt.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadSample,
  runFilter,
  runFilterBody,
  assertReduction,
  findFilterForCommand,
  SAMPLES_DIR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import { applyBashFilterToStdout, planBashFilter } from "src/tools/shared/outputFilter/Bash/index.js";

describe("phase 6.1.2 — cargoBuild", () => {
  test("ROI: cargo-build sample reduces ≥ 50%", () => {
    assertReduction("cargo-build", "cargo build", "cargo-build", 50);
  });

  test("safety: error[E0308] preserves body, no sentinel", () => {
    const raw = [
      "   Compiling foo v0.1.0 (/work/foo)",
      "error[E0308]: mismatched types",
      "  --> src/platform/main.rs:5:9",
      "   |",
      "5  |     let x: u32 = \"\";",
      "   |                  ^^ expected u32, found &str",
      "error: could not compile `foo`",
    ].join("\n");
    const body = runFilterBody("cargo-build", "cargo build", raw);
    expect(body).toContain("error[E0308]");
    expect(body).not.toMatch(/^✓ cargo build/);
  });

  test("safety: warnings on a Finished build preserve body, no sentinel", () => {
    // Non-`unused` warning on an exit-0 (Finished) build: the old guard only
    // treated `warning: unused` as a problem, so this would collapse to the
    // sentinel and drop the warning text.
    const raw = [
      "   Compiling foo v0.1.0 (/work/foo)",
      "warning: associated function `new` is never used",
      "  --> src/core/stream.rs:95:12",
      'warning: `foo` (bin "foo") generated 1 warning',
      "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.20s",
    ].join("\n");
    const body = runFilterBody("cargo-build", "cargo build", raw);
    expect(body).toContain("is never used");
    expect(body).not.toMatch(/^✓ cargo build/);
  });

  test("match: cargo build ✓; cargo clippy ✗", () => {
    expect(findFilterForCommand("cargo build")?.name).toBe("cargo-build");
    expect(findFilterForCommand("cargo clippy")?.name).not.toBe("cargo-build");
  });
});

describe("phase 6.1.2 — cargoCheck", () => {
  test("ROI: cargo-check sample reduces ≥ 59%", () => {
    assertReduction("cargo-check", "cargo check", "cargo-check", 59);
  });

  test("safety: warnings on a Finished check preserve body, no sentinel", () => {
    const raw = [
      "    Checking foo v0.1.0 (/work/foo)",
      "warning: function `helper` is never used",
      "  --> src/platform/main.rs:10:4",
      "warning: `foo` (lib) generated 1 warning",
      "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.30s",
    ].join("\n");
    const body = runFilterBody("cargo-check", "cargo check", raw);
    expect(body).toContain("is never used");
    expect(body).not.toMatch(/^✓ cargo check/);
  });

  test("match: cargo check ✓", () => {
    expect(findFilterForCommand("cargo check")?.name).toBe("cargo-check");
  });
});

describe("phase 6.1.2 — cargoTest", () => {
  test("ROI: cargo-test-norun sample is passthrough (reject active)", () => {
    // cargo test --no-run is rejected by cargoTest AND not matched by
    // cargoBuild (different verb), so it goes through unfiltered. We only
    // assert the filter didn't crash and returned something reasonable.
    const raw = loadSample("cargo-test-norun");
    const plan = planBashFilter("cargo test --no-run");
    // No filter should claim this command line.
    expect(plan.filter).toBeNull();
    const filtered = applyBashFilterToStdout(raw, false, plan);
    expect(filtered).toBe(raw);
  });

  test("safety: FAILED keyword preserves the failures block", () => {
    const raw = [
      "running 3 tests",
      "test foo ... ok",
      "test bar ... FAILED",
      "failures:",
      "    bar",
      "test result: FAILED. 2 passed; 1 failed; 0 ignored",
    ].join("\n");
    const body = runFilterBody("cargo-test", "cargo test", raw);
    expect(body).toContain("FAILED");
    expect(body).toContain("failures:");
    expect(body).not.toMatch(/^✓ cargo test/);
  });

  test("match: cargo test ✓; cargo test --no-run rejects; cargo test -q rejects", () => {
    expect(findFilterForCommand("cargo test")?.name).toBe("cargo-test");
    expect(findFilterForCommand("cargo test --no-run")?.name).not.toBe("cargo-test");
    expect(findFilterForCommand("cargo test -q")?.name).not.toBe("cargo-test");
  });
});

describe("phase 6.1.2 — cargoClippy", () => {
  test("ROI: cargo-clippy sample passes through without crashing", () => {
    const raw = loadSample("cargo-clippy");
    expect(() => runFilter("cargo-clippy", "cargo clippy", raw)).not.toThrow();
    // Warnings must survive — clippy warnings *are* the signal.
    const body = runFilterBody("cargo-clippy", "cargo clippy", raw);
    // The sample contains at least one `warning:` line; verify preservation.
    if (raw.includes("warning:")) {
      expect(body).toContain("warning:");
    }
  });

  test("match: cargo clippy ✓", () => {
    expect(findFilterForCommand("cargo clippy")?.name).toBe("cargo-clippy");
  });
});

describe("phase 12.4 — cargo-run", () => {
  test("ROI: cargo run strips Finished + Running, preserves program output ≥ 80%", () => {
    assertReduction("cargo-run", "cargo run", "cargo-run", 80);
  });

  test("safety: program stdout is preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "cargo-run.txt"), "utf8");
    const body = runFilterBody("cargo-run", "cargo run", raw);
    expect(body).toContain("Hello, world!");
    expect(body).not.toContain("Finished");
    expect(body).not.toContain("Running `target/");
  });

  test("match: cargo run ✓", () => {
    expect(findFilterForCommand("cargo run")?.name).toBe("cargo-run");
    expect(findFilterForCommand("cargo run -- --flag")?.name).toBe("cargo-run");
  });
});

describe("phase 12.4 — cargo-fmt", () => {
  test("safety: diff is preserved on dirty --check", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "cargo-fmt-diff.txt"),
      "utf8",
    );
    const body = runFilterBody("cargo-fmt", "cargo fmt -- --check", raw);
    expect(body).toContain("Diff in");
    expect(body).toContain("+fn main() {");
  });

  test("clean run: empty input stays empty (no wrapper)", () => {
    const raw = "";
    const body = runFilterBody("cargo-fmt", "cargo fmt", raw);
    expect(body).toBe("");
  });

  test("match: cargo fmt ✓; cargo fmt -- --check ✓", () => {
    expect(findFilterForCommand("cargo fmt")?.name).toBe("cargo-fmt");
    expect(findFilterForCommand("cargo fmt -- --check")?.name).toBe(
      "cargo-fmt",
    );
  });
});
