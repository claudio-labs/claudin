// linters family — the python type-checkers and installers
// (uv / poetry / basedpyright / ty).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadSample,
  runFilter,
  runFilterBody,
  assertReduction,
  routesTo,
  findFilterForCommand,
  SAMPLES_DIR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  UV_OK,
  UV_INSTALL,
  POETRY_OK,
  POETRY_INSTALL,
  BASEDPYRIGHT_ERR,
  BASEDPYRIGHT_CLEAN,
  TY_ERR,
  TY_CLEAN,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/lintersSamples.js";

describe("uv", () => {
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

describe("poetry", () => {
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

describe("basedpyright", () => {
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

  // --- the bare `pyright` binary ------------------------------------------

  test("bare `pyright` routes to the same spec", () => {
    expect(routesTo("pyright src/")).toBe("basedpyright");
    expect(routesTo("pyright")).toBe("basedpyright");
    // The reject applies to both spellings, not just the one it was written for.
    expect(routesTo("pyright --outputjson")).not.toBe("basedpyright");
  });

  test("`pyright` output is filtered like `basedpyright` output", () => {
    const body = runFilterBody("basedpyright", "pyright src/", BASEDPYRIGHT_ERR);
    expect(body).toContain("3 errors, 1 warning, 0 informations");
    expect(body).not.toContain("Searching for source files");
  });

  test("negative — word boundary and lookalikes", () => {
    // A config file name is not an invocation.
    expect(routesTo("cat pyrightconfig.json")).not.toBe("basedpyright");
    expect(routesTo("pyrightconfig --check")).not.toBe("basedpyright");
  });
});

describe("ty", () => {
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

describe("phase 6.1.2 — rubocop", () => {
  test("ROI: rubocop sample reduces ≥ 78%", () => {
    assertReduction("rubocop", "rubocop", "rubocop", 78);
  });

  test("safety: output with no preamble is idempotent (no crash)", () => {
    const raw = "Inspecting 3 files\n...\n3 files inspected, no offenses detected\n";
    expect(() => runFilter("rubocop", "rubocop", raw)).not.toThrow();
  });

  test("match: rubocop & bundle exec rubocop both register", () => {
    expect(findFilterForCommand("rubocop")?.name).toBe("rubocop");
    expect(findFilterForCommand("bundle exec rubocop -a")?.name).toBe("rubocop");
  });
});

describe("phase 6.1.2 — ruffCheck", () => {
  test("ROI: ruff-clean sample collapses to sentinel", () => {
    const raw = loadSample("ruff-clean");
    const body = runFilterBody("ruff-check", "ruff check", raw);
    // M-only filter — on clean runs we expect the sentinel line.
    expect(body).toBe("✓ ruff: all checks passed");
  });

  test("safety: matchOutput does NOT fire when 'Found N errors' is present", () => {
    const raw = [
      "src/foo.py:1:1: E501 line too long",
      "Found 1 error.",
    ].join("\n");
    const body = runFilterBody("ruff-check", "ruff check", raw);
    expect(body).toContain("Found 1 error");
    expect(body).not.toBe("✓ ruff: all checks passed");
  });

  test("match: ruff check ✓; ruff format ✗", () => {
    expect(findFilterForCommand("ruff check")?.name).toBe("ruff-check");
    expect(findFilterForCommand("ruff format")?.name).not.toBe("ruff-check");
  });
});

// ===========================================================================
// Phase 12.2 — Universal linters (rtk gap-fill).
//
// Samples for yamllint / markdownlint / hadolint / pre-commit / shellcheck
// live under __fixtures__/samples/. Some are real (markdownlint via
// npx) and some are synthetic-with-source-header (the rest — tools are
// not installed in the dev container; samples mirror the official output
// formats documented in each tool's README/docs).
// ===========================================================================

describe("phase 12.2 — shellcheck", () => {
  test("ROI: shellcheck sample reduces ≥ 20% via 'For more information' strip", () => {
    assertReduction("shellcheck", "shellcheck bad.sh", "shellcheck", 20);
  });

  test("safety: SC codes and diagnostic carets are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "shellcheck.txt"), "utf8");
    const body = runFilterBody("shellcheck", "shellcheck bad.sh", raw);
    expect(body).toContain("SC2086");
    expect(body).toContain("SC2034");
    expect(body).toContain("^---^");
  });

  test("match: shellcheck ✓; --format=json rejects", () => {
    expect(findFilterForCommand("shellcheck bad.sh")?.name).toBe("shellcheck");
    expect(findFilterForCommand("shellcheck --format=json bad.sh")?.name).not.toBe(
      "shellcheck",
    );
  });
});

describe("phase 12.2 — yamllint", () => {
  test("safety: filename headers + diagnostics are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "yamllint.txt"), "utf8");
    const body = runFilterBody("yamllint", "yamllint .", raw);
    expect(body).toContain("config.yaml");
    expect(body).toContain("line-length");
    expect(body).toContain("indentation");
  });

  test("match: yamllint ✓; --format=parsable rejects", () => {
    expect(findFilterForCommand("yamllint .")?.name).toBe("yamllint");
    expect(findFilterForCommand("yamllint --format=parsable .")?.name).not.toBe(
      "yamllint",
    );
  });
});

describe("phase 12.2 — markdownlint", () => {
  test("safety: MD codes and file paths are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "markdownlint.txt"), "utf8");
    const body = runFilterBody("markdownlint", "markdownlint sample.md", raw);
    expect(body).toContain("MD019");
    expect(body).toContain("MD022");
    expect(body).toContain("sample.md");
  });

  test("match: markdownlint and mdl ✓; --json rejects", () => {
    expect(findFilterForCommand("markdownlint .")?.name).toBe("markdownlint");
    expect(findFilterForCommand("mdl .")?.name).toBe("markdownlint");
    expect(findFilterForCommand("markdownlint --json .")?.name).not.toBe(
      "markdownlint",
    );
  });
});

describe("phase 12.2 — hadolint", () => {
  test("safety: DL codes and file:line refs are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "hadolint.txt"), "utf8");
    const body = runFilterBody("hadolint", "hadolint Dockerfile", raw);
    expect(body).toContain("DL3007");
    expect(body).toContain("DL3008");
    expect(body).toContain("Dockerfile:");
  });

  test("match: hadolint ✓; --format=json rejects", () => {
    expect(findFilterForCommand("hadolint Dockerfile")?.name).toBe("hadolint");
    expect(findFilterForCommand("hadolint --format=json Dockerfile")?.name).not.toBe(
      "hadolint",
    );
  });
});

describe("phase 12.2 — pre-commit", () => {
  test("ROI: pre-commit sample reduces ≥ 45% via Passed-line strip", () => {
    assertReduction("pre-commit", "pre-commit run --all-files", "pre-commit", 45);
  });

  test("safety: Failed hooks and their diagnostic blocks are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "pre-commit.txt"), "utf8");
    const body = runFilterBody("pre-commit", "pre-commit run", raw);
    expect(body).toContain("black");
    expect(body).toContain("Failed");
    expect(body).toContain("F401");
    expect(body).toContain("E302");
  });

  test("safety: Passed-only output collapses to empty signal", () => {
    const raw = [
      "check yaml...............................................................Passed",
      "trim trailing whitespace.................................................Passed",
    ].join("\n");
    const body = runFilterBody("pre-commit", "pre-commit run", raw);
    expect(body).not.toContain("Passed");
  });

  test("match: pre-commit run ✓; pre-commit install not", () => {
    expect(findFilterForCommand("pre-commit run --all-files")?.name).toBe(
      "pre-commit",
    );
    expect(findFilterForCommand("pre-commit install")?.name).not.toBe(
      "pre-commit",
    );
  });
});

// ===========================================================================
// Phase 12.5 — Python extras (rtk gap-fill).
// ===========================================================================

describe("phase 12.5 — mypy", () => {
  test("safety: type errors preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "mypy-err.txt"), "utf8");
    const body = runFilterBody("mypy", "mypy bad.py", raw);
    expect(body).toContain("Incompatible return value type");
    expect(body).toContain("Found 2 errors");
  });

  test("match: mypy / python -m mypy ✓; --output=json rejects", () => {
    expect(findFilterForCommand("mypy .")?.name).toBe("mypy");
    expect(findFilterForCommand("python -m mypy src/")?.name).toBe("mypy");
    expect(findFilterForCommand("python3 -m mypy src/")?.name).toBe("mypy");
    expect(findFilterForCommand("mypy --output=json .")?.name).not.toBe("mypy");
  });
});

describe("phase 12.5 — pip-install", () => {
  test("ROI: pip install with downloads reduces ≥ 80%", () => {
    assertReduction("pip-install", "pip install requests", "pip-install", 80);
  });

  test("safety: 'Successfully installed' and ERROR lines preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "pip-install.txt"), "utf8");
    const body = runFilterBody("pip-install", "pip install requests", raw);
    expect(body).toContain("Successfully installed");
    expect(body).toContain("requests-2.34.2");
  });

  test("safety: real ERROR lines are not stripped", () => {
    const raw = [
      "Collecting nonexistent-package-12345",
      "ERROR: Could not find a version that satisfies the requirement nonexistent-package-12345",
      "ERROR: No matching distribution found for nonexistent-package-12345",
    ].join("\n");
    const body = runFilterBody(
      "pip-install",
      "pip install nonexistent-package-12345",
      raw,
    );
    expect(body).toContain("ERROR: Could not find");
    expect(body).toContain("ERROR: No matching distribution");
  });

  test("match: pip install / pip3 install / python -m pip install ✓; -q rejects", () => {
    expect(findFilterForCommand("pip install requests")?.name).toBe(
      "pip-install",
    );
    expect(findFilterForCommand("pip3 install requests")?.name).toBe(
      "pip-install",
    );
    expect(findFilterForCommand("python -m pip install requests")?.name).toBe(
      "pip-install",
    );
    expect(findFilterForCommand("python3 -m pip install requests")?.name).toBe(
      "pip-install",
    );
    expect(findFilterForCommand("pip install -q requests")?.name).not.toBe(
      "pip-install",
    );
  });
});

describe("phase 12.5 — ruff-format", () => {
  test("safety: diff/check output preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "ruff-format-diff.txt"),
      "utf8",
    );
    const body = runFilterBody(
      "ruff-format",
      "ruff format --check bad.py",
      raw,
    );
    expect(body).toContain("Would reformat");
    expect(body).toContain("1 file would be reformatted");
  });

  test("match: ruff format ✓; ruff check not matched here", () => {
    expect(findFilterForCommand("ruff format .")?.name).toBe("ruff-format");
    expect(findFilterForCommand("ruff format --check .")?.name).toBe(
      "ruff-format",
    );
    // ruff check is handled by the pre-existing ruff-check filter.
    expect(findFilterForCommand("ruff check .")?.name).toBe("ruff-check");
  });
});
