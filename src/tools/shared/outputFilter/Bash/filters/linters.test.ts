// Phase 13 — python-extras family (uv / poetry / basedpyright / ty).
import { describe, expect, test } from "bun:test";
import { runFilterBody, routesTo } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  UV_OK,
  UV_INSTALL,
  POETRY_OK,
  POETRY_INSTALL,
  BASEDPYRIGHT_ERR,
  BASEDPYRIGHT_CLEAN,
  TY_ERR,
  TY_CLEAN,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/phase13Samples.js";

describe("phase 13 — uv", () => {
  test("audited (up-to-date) collapses to sentinel", () => {
    expect(runFilterBody("uv", "uv sync", UV_OK).trim()).toBe("✓ uv: up to date");
  });

  test("install strips downloads/cached, keeps installed list", () => {
    const body = runFilterBody("uv", "uv pip install -r req.txt", UV_INSTALL);
    expect(body).toContain("Installed 5 packages in 23ms");
    expect(body).toContain("+ requests==2.31.0");
    expect(body).not.toContain("Downloading");
    expect(body).not.toContain("Using cached");
  });

  test("warning on an up-to-date sync is NOT collapsed away", () => {
    // Audited (would collapse) but a yanked-package warning is present — the
    // model must still see it, so the sentinel must not fire.
    const raw =
      "Resolved 42 packages in 123ms\nwarning: `requests==2.0.0` is yanked (reason: CVE-2018-18074)\nAudited 42 packages in 0.05ms\n";
    const body = runFilterBody("uv", "uv sync", raw);
    expect(body).not.toContain("✓ uv: up to date");
    expect(body).toContain("is yanked");
  });

  test("routes uv sync / uv pip install", () => {
    expect(routesTo("uv sync")).toBe("uv");
    expect(routesTo("uv pip install flask")).toBe("uv");
    expect(routesTo("uv run pytest")).not.toBe("uv");
  });
});

describe("phase 13 — poetry", () => {
  test("no-op run collapses to sentinel", () => {
    expect(runFilterBody("poetry", "poetry install", POETRY_OK).trim()).toBe(
      "✓ poetry: up to date",
    );
  });

  test("install strips downloads/installing, keeps lock write", () => {
    const body = runFilterBody("poetry", "poetry install", POETRY_INSTALL).trim();
    expect(body).toBe("Installing dependencies from lock file\nWriting lock file");
    expect(body).not.toContain("Downloading");
    expect(body).not.toContain("Installing certifi");
  });

  test("warning on a no-op run is NOT collapsed away", () => {
    const raw =
      "Installing dependencies from lock file\nWarning: The lock file is not up to date with the latest changes in pyproject.toml.\nNo dependencies to install or update\n";
    const body = runFilterBody("poetry", "poetry install", raw);
    expect(body).not.toContain("✓ poetry: up to date");
    expect(body).toContain("lock file is not up to date");
  });

  test("routes install/lock/update", () => {
    expect(routesTo("poetry install")).toBe("poetry");
    expect(routesTo("poetry lock --no-update")).toBe("poetry");
    expect(routesTo("poetry update")).toBe("poetry");
    expect(routesTo("poetry run pytest")).not.toBe("poetry");
  });
});

describe("phase 13 — basedpyright", () => {
  test("strips version/search banner, keeps diagnostics + summary", () => {
    const body = runFilterBody("basedpyright", "basedpyright", BASEDPYRIGHT_ERR);
    expect(body).toContain('error: "foo" is not defined (reportUndefinedVariable)');
    expect(body).toContain("3 errors, 1 warning, 0 informations");
    expect(body).not.toContain("Searching for source files");
    expect(body).not.toContain("basedpyright 1.22.0");
  });

  test("clean run keeps the 0/0 summary (not onEmpty)", () => {
    const body = runFilterBody("basedpyright", "basedpyright", BASEDPYRIGHT_CLEAN).trim();
    expect(body).toBe("0 errors, 0 warnings, 0 informations");
  });

  test("regression: an all-noise run with a ≥2 blank-line run collapses to onEmpty (no ` (×N)` artifact)", () => {
    // collapseRuns would turn the blank run into a ` (×2)` line that
    // BASEDPYRIGHT_BLANK can no longer strip, defeating the onEmpty sentinel.
    const raw =
      "basedpyright 1.22.0\nSearching for source files\n\n\nFound 1 source file\n";
    expect(runFilterBody("basedpyright", "basedpyright", raw).trim()).toBe(
      "basedpyright: ok",
    );
  });

  test("routes; --outputjson rejected", () => {
    expect(routesTo("basedpyright src")).toBe("basedpyright");
    expect(routesTo("basedpyright --outputjson")).not.toBe("basedpyright");
  });
});

describe("phase 13 — ty", () => {
  test("strips version/Checking banner, keeps diagnostics", () => {
    const body = runFilterBody("ty", "ty check", TY_ERR);
    expect(body).toContain("error[unresolved-reference]");
    expect(body).toContain("Found 1 error, 1 warning");
    expect(body).not.toContain("Checking 15 files");
    expect(body).not.toContain("ty 0.1.0");
  });

  test("clean run keeps 'All checks passed!'", () => {
    const body = runFilterBody("ty", "ty check", TY_CLEAN).trim();
    expect(body).toBe("All checks passed!");
  });

  test("routes ty; word boundary excludes lookalikes", () => {
    expect(routesTo("ty check")).toBe("ty");
    expect(routesTo("ty")).toBe("ty");
    expect(routesTo("typescript --version")).not.toBe("ty");
  });
});
