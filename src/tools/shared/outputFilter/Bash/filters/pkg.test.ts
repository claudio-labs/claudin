// pkg family — the Ruby bundler installer (`bundle install`).
import { describe, expect, test } from "bun:test";
import {
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

// ===========================================================================
// Phase 6.1.2 — active tests for the 14 built-in filters.
//
// Three layers per filter:
//   1. ROI test    — predicted byte reduction against a real sample
//   2. Safety test — `unless` guard must preserve error signal
//   3. Match test  — matchCommand / matchCommandReject sanity
// ===========================================================================

describe("phase 6.1.2 — bundleInstall", () => {
  test("ROI: bundle-install sample reduces ≥ 91%", () => {
    assertReduction("bundle-install", "bundle install", "bundle-install", 91);
  });

  test("safety: matchOutput does NOT fire when 'error' is present", () => {
    const raw = [
      "Fetching rake 13.0.6",
      "Installing rake 13.0.6",
      "error: could not resolve rails 7.0.0",
      "Bundle complete!",
    ].join("\n");
    const body = runFilterBody("bundle-install", "bundle install", raw);
    expect(body).toContain("error: could not resolve");
    expect(body).not.toBe("✓ bundle install completed");
  });

  test("match: 'bundle install' → matches; 'bundle check' → no match", () => {
    expect(findFilterForCommand("bundle install")?.name).toBe("bundle-install");
    expect(findFilterForCommand("bundle check")?.name).not.toBe("bundle-install");
  });
});
