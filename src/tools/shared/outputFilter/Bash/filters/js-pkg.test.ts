// Phase 13 — js-extras family (next / biome / oxlint / turbo / nx).
import { describe, expect, test } from "bun:test";
import { runFilterBody, routesTo } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
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
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/phase13Samples.js";

describe("phase 13 — next build", () => {
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

describe("phase 13 — biome", () => {
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

describe("phase 13 — oxlint", () => {
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

describe("phase 13 — turbo", () => {
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

describe("phase 13 — nx", () => {
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
