// Phase 13 — elixir family (mix compile / format).
import { describe, expect, test } from "bun:test";
import { runFilterBody, routesTo } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  MIX_COMPILE_WARN,
  MIX_COMPILE_OK,
  MIX_FORMAT_FILES,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/phase13Samples.js";

describe("phase 13 — mix compile", () => {
  test("strips Compiling/Generated, keeps the warning", () => {
    const body = runFilterBody("mix-compile", "mix compile", MIX_COMPILE_WARN).trim();
    expect(body).toBe('warning: variable "conn" is unused\n  lib/router.ex:42');
    expect(body).not.toContain("Compiling");
    expect(body).not.toContain("Generated");
  });

  test("clean compile collapses to onEmpty sentinel", () => {
    expect(runFilterBody("mix-compile", "mix compile", MIX_COMPILE_OK).trim()).toBe(
      "mix compile: ok",
    );
  });

  test("regression: a run of ≥2 blank lines still collapses to onEmpty (no ` (×N)` artifact)", () => {
    // collapseRuns would turn the blank run into a ` (×2)` line that MIX_BLANK
    // can no longer strip, defeating the onEmpty sentinel — see spec comment.
    const raw = "Compiling 3 files (.ex)\n\n\nGenerated my_app app\n";
    expect(runFilterBody("mix-compile", "mix compile", raw).trim()).toBe(
      "mix compile: ok",
    );
  });

  test("routes mix compile only", () => {
    expect(routesTo("mix compile")).toBe("mix-compile");
    expect(routesTo("mix compile --warnings-as-errors")).toBe("mix-compile");
    expect(routesTo("mix test")).not.toBe("mix-compile");
  });
});

describe("phase 13 — mix format", () => {
  test("--check-formatted file list passes through", () => {
    const body = runFilterBody(
      "mix-format",
      "mix format --check-formatted",
      MIX_FORMAT_FILES,
    ).trim();
    expect(body).toBe("lib/my_app.ex\ntest/my_app_test.exs");
  });

  test("routes mix format only", () => {
    expect(routesTo("mix format")).toBe("mix-format");
    expect(routesTo("mix format --check-formatted")).toBe("mix-format");
    expect(routesTo("mix compile")).not.toBe("mix-format");
  });
});
