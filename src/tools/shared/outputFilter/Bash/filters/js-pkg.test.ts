// JS package-runner family — next / biome / oxlint / turbo / nx / bun run.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runFilterBody,
  reductionPct,
  assertReduction,
  routesTo,
  findFilterForCommand,
  SAMPLES_DIR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  BUN_RUN_SMOKE,
  BUN_RUN_ECHOING_SCRIPT,
  NEXT_BUILD_OK,
  NEXT_TYPE_ERR,
  NEXT_WEBPACK_ERR,
  BIOME_DIRTY,
  BIOME_CLEAN,
  OXLINT_DIRTY,
  OXLINT_CLEAN,
  TURBO_OK,
  TURBO_ERR,
  TURBO_CACHED,
  NX_OK,
  NX_ERR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/jsPkgSamples.js";

describe("next build", () => {
  test("clean build collapses to sentinel", () => {
    expect(runFilterBody("next-build", "next build", NEXT_BUILD_OK).trim()).toBe(
      "✓ next build: compiled successfully",
    );
  });

  test("type-check failure is NOT collapsed (despite 'Compiled successfully')", () => {
    const body = runFilterBody("next-build", "next build", NEXT_TYPE_ERR);
    expect(body).not.toContain("✓ next build");
    expect(body).toContain("Failed to compile.");
    expect(body).toContain("Type error: Cannot find module");
  });

  test("webpack failure passes through", () => {
    const body = runFilterBody("next-build", "npx next build", NEXT_WEBPACK_ERR);
    expect(body).toContain("Failed to compile.");
    expect(body).toContain("Build failed because of webpack errors");
    expect(body).not.toContain("▲ Next.js");
  });

  test("warning on a successful build is NOT collapsed away", () => {
    // Compiles successfully (exit 0) but ESLint prints a warning — the model
    // must still see it, so the sentinel must not fire.
    const raw =
      "   ▲ Next.js 14.2.3\n\n   Creating an optimized production build ...\n ✓ Compiled successfully\n\n./app/page.tsx\nWarning: React Hook useEffect has a missing dependency: 'id'.\n";
    const body = runFilterBody("next-build", "next build", raw);
    expect(body).not.toContain("✓ next build: compiled successfully");
    expect(body).toContain("missing dependency");
  });

  test("routes build/lint only, never dev/start", () => {
    expect(routesTo("next build")).toBe("next-build");
    expect(routesTo("next lint")).toBe("next-build");
    expect(routesTo("npx next build")).toBe("next-build");
    expect(routesTo("next dev")).not.toBe("next-build");
    expect(routesTo("next start")).not.toBe("next-build");
  });
});

describe("biome", () => {
  test("clean check collapses to onEmpty", () => {
    expect(runFilterBody("biome", "biome check .", BIOME_CLEAN).trim()).toBe("biome: ok");
  });

  test("diagnostics survive, Checked tally stripped", () => {
    const body = runFilterBody("biome", "biome check .", BIOME_DIRTY);
    expect(body).toContain("lint/suspicious/noExplicitAny");
    expect(body).toContain("Found 2 errors.");
    expect(body).not.toContain("Checked 42 files");
  });

  test("routes; json reporter rejected", () => {
    expect(routesTo("biome check .")).toBe("biome");
    expect(routesTo("biome ci")).toBe("biome");
    expect(routesTo("biome check --reporter=json")).not.toBe("biome");
  });
});

describe("oxlint", () => {
  test("clean run collapses to onEmpty", () => {
    expect(runFilterBody("oxlint", "oxlint", OXLINT_CLEAN).trim()).toBe("oxlint: ok");
  });

  test("diagnostics survive, Found/Finished stripped", () => {
    const body = runFilterBody("oxlint", "oxlint src", OXLINT_DIRTY);
    expect(body).toContain("eslint(no-console)");
    expect(body).toContain("eslint(no-unused-vars)");
    expect(body).not.toContain("Finished in");
    expect(body).not.toContain("Found 2 warnings");
  });

  test("routes; json format rejected", () => {
    expect(routesTo("oxlint src")).toBe("oxlint");
    expect(routesTo("oxlint -f json")).not.toBe("oxlint");
  });
});

describe("turbo", () => {
  test("strips cache/scope/Tasks/Duration, keeps task output", () => {
    const body = runFilterBody("turbo", "turbo build", TURBO_OK).trim();
    expect(body).toBe("> myapp:build\nCompiled successfully.");
  });

  test("error output is preserved", () => {
    const body = runFilterBody("turbo", "turbo lint", TURBO_ERR);
    expect(body).toContain("> myapp:lint");
    expect(body).toContain("Error: src/index.ts(5,1): error TS2304");
  });

  test("all-cached run collapses to onEmpty", () => {
    expect(runFilterBody("turbo", "turbo build", TURBO_CACHED).trim()).toBe("turbo: ok");
  });

  test("routes; --dry-run rejected", () => {
    expect(routesTo("turbo build")).toBe("turbo");
    expect(routesTo("turbo run test")).toBe("turbo");
    expect(routesTo("turbo build --dry-run")).not.toBe("turbo");
  });
});

describe("nx", () => {
  test("strips NX banners + separators, keeps build output", () => {
    const body = runFilterBody("nx", "nx build myapp", NX_OK).trim();
    expect(body).toBe("Compiled successfully.\nOutput: dist/apps/myapp");
  });

  test("error output is preserved", () => {
    const body = runFilterBody("nx", "nx build myapp", NX_ERR);
    expect(body).toContain("ERROR: Cannot find module '@myapp/shared'");
    expect(body).toContain("Failed at step: build");
    expect(body).not.toContain("> NX   Running target");
  });

  test("routes nx and pnpm nx", () => {
    expect(routesTo("nx build myapp")).toBe("nx");
    expect(routesTo("pnpm nx build myapp")).toBe("nx");
    expect(routesTo("npx nx run-many -t build")).toBe("nx");
  });
});

describe("bun run", () => {
  test("strips the `$ ` script echo, keeps what the script printed", () => {
    const body = runFilterBody("bun-run", "bun run smoke", BUN_RUN_SMOKE);
    // Both echo lines go — `smoke` nests into `build`, so bun prints two.
    expect(body).not.toContain("$ bun run build &&");
    expect(body).not.toContain("$ bun run scripts/build/build.ts");
    // The build's own output survives, including its result line.
    expect(body).toContain("✓ Built claudin v1.1.18 → dist/cli.mjs");
    expect(body).toContain("1.1.18 (Claudin)");
    expect(reductionPct(BUN_RUN_SMOKE, body)).toBeGreaterThan(15);
  });

  test("KNOWN GAP: a `$ ` line printed BY the script is stripped too", () => {
    // The stages are stateless per line, so "only the echo at the top" is not
    // expressible. `npm-run` has had the same exposure with `> ` since Phase 12;
    // this pins the behaviour rather than leaving it to be discovered.
    const body = runFilterBody("bun-run", "bun run deploy", BUN_RUN_ECHOING_SCRIPT);
    expect(body).not.toContain("$ rsync -a dist/");
    expect(body).toContain("preparing release 1.2.3");
    expect(body).toContain("uploaded 412 files");
  });

  test("the `bun run vX.Y.Z` banner is stripped", () => {
    // No committed capture carries the banner (bun only prints it on some
    // paths), so without this the regex is unexercised.
    const raw = "bun run v1.1.18 (af24e281)\n$ tsc --noEmit\nok\n";
    const body = runFilterBody("bun-run", "bun run typecheck", raw).trim();
    expect(body).toBe("ok");
  });

  test("regression: an all-echo body with a blank run leaves no ` (×N)` artifact", () => {
    const raw = "$ tsc --noEmit\n\n\n$ echo done\n";
    const body = runFilterBody("bun-run", "bun run typecheck", raw).trim();
    expect(body).not.toContain("(×");
    expect(body).toBe("");
  });

  test("routes `bun run <script>`, never `bun test` or a bare `bun run`", () => {
    expect(routesTo("bun run build")).toBe("bun-run");
    expect(routesTo("bun run test:floor")).toBe("bun-run");
    expect(routesTo("bun run scripts/build/build.ts")).toBe("bun-run");
    // The only real overlap in this phase: `bunTest` owns `bun test`.
    expect(routesTo("bun test")).toBe("bun-test");
    // A bare `bun run` LISTS the scripts, it does not run one.
    expect(routesTo("bun run")).not.toBe("bun-run");
  });

  test("negative: --silent rejected, sibling verbs untouched", () => {
    expect(routesTo("bun run build --silent")).not.toBe("bun-run");
    expect(routesTo("bun install")).not.toBe("bun-run");
    expect(routesTo("bunx prettier --write .")).not.toBe("bun-run");
  });
});

// ===========================================================================
// Phase 12 — JS package managers (rtk gap-fill).
//
// Measurements taken on real samples captured from npm 10.x / pnpm 9.x /
// yarn 1.x / prisma 7.x. Reduction targets reflect realistic per-sample
// signal-to-noise ratios — small clean samples (npm-install / prettier)
// have low absolute reduction because most of the bytes ARE the signal.
// ===========================================================================

describe("phase 12 — npm-install", () => {
  test("ROI: npm-install clean sample reduces ≥ 40%", () => {
    assertReduction("npm-install", "npm install express", "npm-install", 40);
  });

  test("safety: deprecation warnings are preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "npm-install-warn.txt"),
      "utf8",
    );
    const body = runFilterBody("npm-install", "npm install request", raw);
    expect(body).toContain("npm warn deprecated");
    expect(body).toContain("vulnerabilities");
  });

  test("match: install/i/ci/add ✓; --json rejects", () => {
    expect(findFilterForCommand("npm install")?.name).toBe("npm-install");
    expect(findFilterForCommand("npm i express")?.name).toBe("npm-install");
    expect(findFilterForCommand("npm ci")?.name).toBe("npm-install");
    expect(findFilterForCommand("npm add lodash")?.name).toBe("npm-install");
    expect(findFilterForCommand("npm install --json")?.name).not.toBe(
      "npm-install",
    );
  });
});

describe("phase 12 — npm-run", () => {
  test("ROI: npm-test sample reduces ≥ 75%", () => {
    assertReduction("npm-run", "npm test", "npm-test", 75);
  });

  test("safety: script body errors are preserved", () => {
    const raw = [
      "> myapp@1.0.0 test",
      "> jest --coverage",
      "",
      "FAIL src/foo.test.ts",
      "  ✕ does the thing",
      "    Error: AssertionError: expected 1 to equal 2",
    ].join("\n");
    const body = runFilterBody("npm-run", "npm test", raw);
    expect(body).toContain("FAIL src/foo.test.ts");
    expect(body).toContain("AssertionError");
  });

  test("match: test/t/run/start ✓; --silent rejects", () => {
    expect(findFilterForCommand("npm test")?.name).toBe("npm-run");
    expect(findFilterForCommand("npm t")?.name).toBe("npm-run");
    expect(findFilterForCommand("npm run build")?.name).toBe("npm-run");
    expect(findFilterForCommand("npm start")?.name).toBe("npm-run");
    expect(findFilterForCommand("npm test --silent")?.name).not.toBe("npm-run");
  });
});

describe("phase 12 — pnpm-install", () => {
  test("ROI: pnpm-install sample reduces ≥ 85%", () => {
    assertReduction("pnpm-install", "pnpm add express", "pnpm-install", 85);
  });

  test("safety: dependencies section is preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "pnpm-install.txt"),
      "utf8",
    );
    const body = runFilterBody("pnpm-install", "pnpm add express", raw);
    expect(body).toContain("dependencies:");
    expect(body).toContain("express");
    expect(body).toContain("Done in");
  });

  test("match: install/i/add ✓; --json rejects", () => {
    expect(findFilterForCommand("pnpm install")?.name).toBe("pnpm-install");
    expect(findFilterForCommand("pnpm add lodash")?.name).toBe("pnpm-install");
    expect(findFilterForCommand("pnpm install --json")?.name).not.toBe(
      "pnpm-install",
    );
  });
});

describe("phase 12 — pnpm-run", () => {
  test("ROI: pnpm-run sample reduces ≥ 70%", () => {
    assertReduction("pnpm-run", "pnpm run lint", "pnpm-run", 70);
  });

  test("match: run ✓; exec resolves to the inner tool's filter", () => {
    expect(findFilterForCommand("pnpm run build")?.name).toBe("pnpm-run");
    // `pnpm exec <tool>` runs the bin directly (no pnpm script ceremony) —
    // runner-prefix canonicalization hands it to the tool's own filter.
    expect(findFilterForCommand("pnpm exec eslint .")?.name).toBe("eslint");
  });
});

describe("phase 12 — yarn-install", () => {
  test("ROI: yarn-install sample reduces ≥ 85%", () => {
    assertReduction(
      "yarn-install",
      "yarn add express body-parser cors morgan",
      "yarn-install",
      85,
    );
  });

  test("safety: error lines are preserved", () => {
    const raw = [
      "yarn add v1.22.22",
      "[1/4] Resolving packages...",
      "error An unexpected error occurred: \"https://registry.yarnpkg.com/foo: not found\".",
      "info Visit https://yarnpkg.com/en/docs/cli/add for documentation.",
    ].join("\n");
    const body = runFilterBody("yarn-install", "yarn add foo", raw);
    expect(body).toContain("error An unexpected error");
  });

  test("match: bare yarn / add / install / upgrade / remove ✓", () => {
    expect(findFilterForCommand("yarn")?.name).toBe("yarn-install");
    expect(findFilterForCommand("yarn install")?.name).toBe("yarn-install");
    expect(findFilterForCommand("yarn add lodash")?.name).toBe("yarn-install");
    expect(findFilterForCommand("yarn upgrade")?.name).toBe("yarn-install");
    expect(findFilterForCommand("yarn remove foo")?.name).toBe("yarn-install");
  });
});

describe("phase 12 — eslint", () => {
  // ROI test omitted: a real error sample is *all* signal (diagnostics
  // are what the user asked for). The filter is here for the dirty-run
  // case where eslint prints summary + collapse-friendly blank lines.
  test("safety: diagnostics and ✖ summary are preserved", () => {
    const raw = readFileSync(resolve(SAMPLES_DIR, "eslint-errors.txt"), "utf8");
    const body = runFilterBody("eslint", "npx eslint sample.js", raw);
    expect(body).toContain("no-unused-vars");
    expect(body).toContain("no-undef");
    expect(body).toContain("✖ 2 problems");
  });

  test("match: eslint / npx eslint ✓; --format=json rejects", () => {
    expect(findFilterForCommand("eslint src/")?.name).toBe("eslint");
    expect(findFilterForCommand("npx eslint src/")?.name).toBe("eslint");
    expect(findFilterForCommand("eslint --format=json src/")?.name).not.toBe(
      "eslint",
    );
  });
});

describe("phase 12 — prettier", () => {
  // ROI test omitted: dirty sample is all signal (file list is the diagnostic).
  test("safety: warn diagnostics preserved on --check failure", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "prettier-check.txt"),
      "utf8",
    );
    const body = runFilterBody("prettier", "npx prettier --check src/", raw);
    expect(body).toContain("[warn]");
    expect(body).toContain("Code style issues found");
  });

  test("preamble strip: 'Checking formatting...' line is removed", () => {
    const raw = "Checking formatting...\n[warn] foo.ts\n";
    const body = runFilterBody("prettier", "prettier --check .", raw);
    expect(body).not.toContain("Checking formatting...");
    expect(body).toContain("[warn] foo.ts");
  });

  test("match: prettier / npx prettier ✓; --loglevel=silent rejects", () => {
    expect(findFilterForCommand("prettier --check .")?.name).toBe("prettier");
    expect(findFilterForCommand("npx prettier --write src/")?.name).toBe(
      "prettier",
    );
    expect(
      findFilterForCommand("prettier --loglevel=silent --check .")?.name,
    ).not.toBe("prettier");
  });
});

describe("phase 12 — prisma-generate", () => {
  test("ROI: prisma-generate sample reduces ≥ 60%", () => {
    assertReduction(
      "prisma-generate",
      "npx prisma generate",
      "prisma-generate",
      60,
    );
  });

  test("safety: Generated Prisma Client line is preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "prisma-generate.txt"),
      "utf8",
    );
    const body = runFilterBody(
      "prisma-generate",
      "npx prisma generate",
      raw,
    );
    expect(body).toContain("Generated Prisma Client");
  });

  test("match: prisma generate / npx prisma generate ✓", () => {
    expect(findFilterForCommand("prisma generate")?.name).toBe(
      "prisma-generate",
    );
    expect(findFilterForCommand("npx prisma generate")?.name).toBe(
      "prisma-generate",
    );
  });
});

describe("phase 12 — prisma-migrate", () => {
  test("ROI: prisma-migrate sample reduces ≥ 35%", () => {
    assertReduction(
      "prisma-migrate",
      "npx prisma migrate dev --name init",
      "prisma-migrate",
      35,
    );
  });

  test("safety: 'created the following migration' line is preserved", () => {
    const raw = readFileSync(
      resolve(SAMPLES_DIR, "prisma-migrate.txt"),
      "utf8",
    );
    const body = runFilterBody(
      "prisma-migrate",
      "npx prisma migrate dev",
      raw,
    );
    expect(body).toContain("created the following migration");
  });

  test("match: prisma migrate ✓; not generate", () => {
    expect(findFilterForCommand("prisma migrate dev")?.name).toBe(
      "prisma-migrate",
    );
    expect(findFilterForCommand("npx prisma migrate deploy")?.name).toBe(
      "prisma-migrate",
    );
    expect(findFilterForCommand("prisma generate")?.name).not.toBe(
      "prisma-migrate",
    );
  });
});
