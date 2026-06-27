/**
 * Phase 13 — ROI / regression roll-up for the language-toolchain filters.
 *
 * Mirrors phase12Report.test.ts: one row per (filter × real sample). Each row
 * asserts (a) the reduction floor (regression threshold; null when the sample
 * is mostly signal — diagnostics — so we only check survival) and (b) that the
 * `preserves[]` strings (errors/warnings/summaries) survive the filter.
 *
 * Samples are the real captures in filters/__testutils__/phase13Samples.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { runFilterBody, reductionPct, getFilter } from "./filters/__testutils__/harness.js";
import * as S from "./filters/__testutils__/phase13Samples.js";

type Row = {
  phase: string;
  filter: string;
  sample: string; // key into S
  command: string;
  /** minimum acceptable reduction %; null = mostly-signal, only assert preserves */
  floor: number | null;
  /** strings that MUST survive the filter */
  preserves: string[];
};

const ROWS: Row[] = [
  // T1 — cc
  { phase: "13.1", filter: "gcc", sample: "GCC_ERR", command: "gcc -O2 main.c", floor: 20, preserves: ["error: use of undeclared identifier 'foo'", "warning: unused variable 'x'"] },
  { phase: "13.1", filter: "make", sample: "MAKE_OK", command: "make", floor: 30, preserves: ["gcc -O2 foo.c"] },
  { phase: "13.1", filter: "make", sample: "MAKE_ERR", command: "make -j4", floor: null, preserves: ["*** [Makefile:3: all] Error 2", "error: 'foo' undeclared"] },
  { phase: "13.1", filter: "pio-run", sample: "PIO_ERR", command: "pio run", floor: 50, preserves: ["error: 'LED_BUILTINN' was not declared"] },
  // T2 — dotnet
  { phase: "13.2", filter: "dotnet-build", sample: "DOTNET_BUILD_OK", command: "dotnet build", floor: 70, preserves: [] },
  { phase: "13.2", filter: "dotnet-build", sample: "DOTNET_BUILD_ERR", command: "dotnet build", floor: null, preserves: ["error CS1002", "Build FAILED."] },
  { phase: "13.2", filter: "dotnet-test", sample: "DOTNET_TEST_OK", command: "dotnet test", floor: 80, preserves: [] },
  { phase: "13.2", filter: "dotnet-test", sample: "DOTNET_TEST_FAIL", command: "dotnet test", floor: null, preserves: ["Failed!  - Failed:     1", "Expected: 4"] },
  { phase: "13.2", filter: "dotnet-format", sample: "DOTNET_FORMAT_ERR", command: "dotnet format", floor: 20, preserves: ["error WHITESPACE:", "error IMPORTS:"] },
  // T3 — php
  { phase: "13.3", filter: "composer", sample: "COMPOSER_INSTALL", command: "composer install", floor: 55, preserves: ["Writing lock file"] },
  { phase: "13.3", filter: "composer", sample: "COMPOSER_NOTHING", command: "composer install", floor: 45, preserves: [] },
  // T4 — ruby
  { phase: "13.4", filter: "rake", sample: "RAKE_OK", command: "rake test", floor: null, preserves: ["12 runs, 20 assertions, 0 failures, 0 errors, 0 skips"] },
  { phase: "13.4", filter: "rake", sample: "RAKE_FAIL", command: "rake db:migrate", floor: null, preserves: ["rake aborted!", "Tasks: TOP => db:migrate"] },
  // T5 — elixir
  { phase: "13.5", filter: "mix-compile", sample: "MIX_COMPILE_WARN", command: "mix compile", floor: 30, preserves: ['warning: variable "conn" is unused'] },
  // T6 — swift
  { phase: "13.6", filter: "swift-build", sample: "SWIFT_ERR", command: "swift build", floor: 20, preserves: ["error: use of unresolved identifier 'foo'"] },
  { phase: "13.6", filter: "xcodebuild", sample: "XCODE_FAIL", command: "xcodebuild -scheme App", floor: 50, preserves: ["error: use of unresolved identifier 'foo'", "** BUILD FAILED **"] },
  // T7 — js extras
  { phase: "13.7", filter: "next-build", sample: "NEXT_BUILD_OK", command: "next build", floor: 70, preserves: [] },
  { phase: "13.7", filter: "next-build", sample: "NEXT_TYPE_ERR", command: "next build", floor: null, preserves: ["Type error:", "Failed to compile."] },
  { phase: "13.7", filter: "biome", sample: "BIOME_DIRTY", command: "biome check .", floor: null, preserves: ["lint/suspicious/noExplicitAny", "Found 2 errors."] },
  { phase: "13.7", filter: "oxlint", sample: "OXLINT_DIRTY", command: "oxlint src", floor: null, preserves: ["eslint(no-console)"] },
  { phase: "13.7", filter: "turbo", sample: "TURBO_OK", command: "turbo build", floor: 60, preserves: ["Compiled successfully."] },
  { phase: "13.7", filter: "nx", sample: "NX_OK", command: "nx build myapp", floor: 40, preserves: ["Compiled successfully.", "Output: dist/apps/myapp"] },
  // T8 — python extras
  { phase: "13.8", filter: "uv", sample: "UV_INSTALL", command: "uv pip install -r r.txt", floor: 25, preserves: ["Installed 5 packages in 23ms"] },
  { phase: "13.8", filter: "uv", sample: "UV_OK", command: "uv sync", floor: 50, preserves: [] },
  { phase: "13.8", filter: "poetry", sample: "POETRY_INSTALL", command: "poetry install", floor: 40, preserves: ["Writing lock file"] },
  { phase: "13.8", filter: "basedpyright", sample: "BASEDPYRIGHT_ERR", command: "basedpyright", floor: 10, preserves: ["3 errors, 1 warning, 0 informations"] },
  { phase: "13.8", filter: "ty", sample: "TY_ERR", command: "ty check", floor: null, preserves: ["error[unresolved-reference]", "Found 1 error, 1 warning"] },
  // T9 — java extras
  { phase: "13.9", filter: "spring-boot", sample: "SPRING_OK", command: "mvn spring-boot:run", floor: 50, preserves: ["Tomcat started on port 8080", "Started MyApp in 3.2 seconds"] },
  { phase: "13.9", filter: "spring-boot", sample: "SPRING_ERR", command: "gradle bootRun", floor: 30, preserves: ["Application run failed", "Caused by:"] },
];

const samples = S as unknown as Record<string, string>;
const measured: { phase: string; filter: string; sample: string; rawB: number; outB: number; pct: number }[] = [];

describe("phase 13 — ROI / regression report", () => {
  test("every Phase 13 filter named in a row is registered", () => {
    for (const r of ROWS) expect(getFilter(r.filter).name).toBe(r.filter);
  });

  for (const r of ROWS) {
    test(`${r.filter} × ${r.sample} — reduction ${r.floor === null ? "(signal)" : `>= ${r.floor}%`} + preserves`, () => {
      const raw = samples[r.sample];
      expect(raw, `sample ${r.sample} missing`).toBeDefined();
      const body = runFilterBody(r.filter, r.command, raw!);
      const pct = reductionPct(raw!, body);
      measured.push({ phase: r.phase, filter: r.filter, sample: r.sample, rawB: raw!.length, outB: body.length, pct });
      for (const needle of r.preserves) {
        expect(body, `${r.filter}/${r.sample} must preserve "${needle}"`).toContain(needle);
      }
      if (r.floor !== null) {
        expect(pct, `${r.filter}/${r.sample} reduction ${pct.toFixed(1)}% < floor ${r.floor}%`).toBeGreaterThanOrEqual(r.floor);
      }
    });
  }

  afterAll(() => {
    let rawTotal = 0;
    let outTotal = 0;
    const lines: string[] = [];
    lines.push("");
    lines.push("Phase | Filter        | Sample              | Raw B | Out B | Reduction");
    lines.push("------|---------------|---------------------|-------|-------|----------");
    for (const m of measured) {
      rawTotal += m.rawB;
      outTotal += m.outB;
      lines.push(
        `${m.phase.padEnd(5)} | ${m.filter.padEnd(13)} | ${m.sample.padEnd(19)} | ${String(m.rawB).padStart(5)} | ${String(m.outB).padStart(5)} | ${`${m.pct.toFixed(1)}%`.padStart(8)}`,
      );
    }
    const totalPct = rawTotal > 0 ? (100 * (1 - outTotal / rawTotal)).toFixed(1) : "0.0";
    lines.push("------|---------------|---------------------|-------|-------|----------");
    lines.push(`TOTAL | ${String(measured.length).padEnd(13)} |                     | ${String(rawTotal).padStart(5)} | ${String(outTotal).padStart(5)} | ${`${totalPct}%`.padStart(8)}`);
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });
});
