/**
 * ROI / regression roll-up for every built-in filter that has a real capture.
 *
 * One row per (filter × sample). Each row asserts three things:
 *
 *  - the filter does not BALLOON the output (a small epsilon covers samples
 *    saved without a trailing newline);
 *  - the reduction meets its `floor`, which is the regression threshold;
 *  - every string in `preserves[]` still makes it through.
 *
 * A `floor` of `null` means the sample is mostly signal — eslint on a dirty
 * tree, mypy errors, a failed build — so there is nothing to cut and only
 * survival is checked. That is a real state, not a missing number, and it is
 * worth saying why per case, because a floor that is absent for a bad reason is
 * how a report starts lying:
 *
 *  - `docker-compose × COMPOSE_FAIL` is a failed build: almost every line is the
 *    error or its recap. Reducing it further would be losing it.
 *
 * The floors that ARE set were measured first and then set below the observed
 * value, never guessed upward. The compose capture reduces 28.3% and the bun one
 * 21.3%; the fixture is what the model really received, so those are the real
 * numbers and not the ~75% a line-shape estimate suggested.
 *
 * `family` is the filter family that owns the spec, taken from the module it is
 * imported from in `filters/index.ts` — so `biome` is `js-pkg` and `basedpyright`
 * is `linters`, however the names read. Samples come from the matching
 * `filters/__testutils__/<family>Samples.ts`, or straight off disk in
 * `__fixtures__/samples/` when the capture is too big to read inline.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  runFilterBody,
  reductionPct,
  getFilter,
  readSample,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  COMPOSE_UP,
  COMPOSE_FAIL,
  COMPOSE_LOGS,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/containerSamples.js";
import {
  BUN_RUN_SMOKE,
  NEXT_BUILD_OK,
  NEXT_TYPE_ERR,
  BIOME_DIRTY,
  OXLINT_DIRTY,
  TURBO_OK,
  NX_OK,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/jsPkgSamples.js";
import {
  GCC_ERR,
  MAKE_OK,
  MAKE_ERR,
  PIO_ERR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/ccSamples.js";
import {
  DOTNET_BUILD_OK,
  DOTNET_BUILD_ERR,
  DOTNET_TEST_OK,
  DOTNET_TEST_FAIL,
  DOTNET_FORMAT_ERR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/dotnetSamples.js";
import {
  COMPOSER_INSTALL,
  COMPOSER_NOTHING,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/phpSamples.js";
import {
  RAKE_OK,
  RAKE_FAIL,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/rubySamples.js";
import { MIX_COMPILE_WARN } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/elixirSamples.js";
import {
  SWIFT_ERR,
  XCODE_FAIL,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/swiftSamples.js";
import {
  UV_INSTALL,
  UV_OK,
  POETRY_INSTALL,
  BASEDPYRIGHT_ERR,
  TY_ERR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/lintersSamples.js";
import {
  SPRING_OK,
  SPRING_ERR,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/javaBuildSamples.js";

type Row = {
  /** The filter family that owns the spec — matches `filters/<family>.ts`. */
  family: string;
  filter: string;
  /** Label for the table. */
  sample: string;
  /** The capture itself. */
  raw: string;
  command: string;
  /** minimum acceptable reduction %; null = mostly-signal, only assert preserves */
  floor: number | null;
  /** strings that MUST survive the filter */
  preserves: string[];
};

const COMPOSE_UP_CMD = "docker compose -f docker-compose.dev.yml up -d --build legendarr";

const ROWS: Row[] = [
  // ─────────────────────────────── js-pkg ────────────────────────────────────
  { family: "js-pkg", filter: "npm-install", sample: "npm-install", raw: readSample("npm-install.txt"), command: "npm install", floor: 35, preserves: [] },
  { family: "js-pkg", filter: "npm-install", sample: "npm-install-warn", raw: readSample("npm-install-warn.txt"), command: "npm install", floor: 0, preserves: ["deprecated"] },
  { family: "js-pkg", filter: "npm-run", sample: "npm-test", raw: readSample("npm-test.txt"), command: "npm test", floor: 70, preserves: [] },
  { family: "js-pkg", filter: "pnpm-install", sample: "pnpm-install", raw: readSample("pnpm-install.txt"), command: "pnpm install", floor: 85, preserves: [] },
  { family: "js-pkg", filter: "pnpm-run", sample: "pnpm-run", raw: readSample("pnpm-run.txt"), command: "pnpm run build", floor: 70, preserves: [] },
  { family: "js-pkg", filter: "yarn-install", sample: "yarn-install", raw: readSample("yarn-install.txt"), command: "yarn install", floor: 85, preserves: [] },
  { family: "js-pkg", filter: "eslint", sample: "eslint-errors", raw: readSample("eslint-errors.txt"), command: "eslint .", floor: null, preserves: ["no-unused-vars", "error"] },
  { family: "js-pkg", filter: "prettier", sample: "prettier-check", raw: readSample("prettier-check.txt"), command: "prettier --check .", floor: null, preserves: [] },
  { family: "js-pkg", filter: "prisma-generate", sample: "prisma-generate", raw: readSample("prisma-generate.txt"), command: "prisma generate", floor: 50, preserves: [] },
  { family: "js-pkg", filter: "prisma-migrate", sample: "prisma-migrate", raw: readSample("prisma-migrate.txt"), command: "prisma migrate dev", floor: 30, preserves: [] },
  { family: "js-pkg", filter: "next-build", sample: "NEXT_BUILD_OK", raw: NEXT_BUILD_OK, command: "next build", floor: 70, preserves: [] },
  { family: "js-pkg", filter: "next-build", sample: "NEXT_TYPE_ERR", raw: NEXT_TYPE_ERR, command: "next build", floor: null, preserves: ["Type error:", "Failed to compile."] },
  { family: "js-pkg", filter: "biome", sample: "BIOME_DIRTY", raw: BIOME_DIRTY, command: "biome check .", floor: null, preserves: ["lint/suspicious/noExplicitAny", "Found 2 errors."] },
  { family: "js-pkg", filter: "oxlint", sample: "OXLINT_DIRTY", raw: OXLINT_DIRTY, command: "oxlint src", floor: null, preserves: ["eslint(no-console)"] },
  { family: "js-pkg", filter: "turbo", sample: "TURBO_OK", raw: TURBO_OK, command: "turbo build", floor: 60, preserves: ["Compiled successfully."] },
  { family: "js-pkg", filter: "nx", sample: "NX_OK", raw: NX_OK, command: "nx build myapp", floor: 40, preserves: ["Compiled successfully.", "Output: dist/apps/myapp"] },
  { family: "js-pkg", filter: "bun-run", sample: "BUN_RUN_SMOKE", raw: BUN_RUN_SMOKE, command: "bun run smoke", floor: 15, preserves: ["✓ Built claudin v1.1.18 → dist/cli.mjs", "1.1.18 (Claudin)"] },

  // ─────────────────────────────── linters ───────────────────────────────────
  { family: "linters", filter: "shellcheck", sample: "shellcheck", raw: readSample("shellcheck.txt"), command: "shellcheck script.sh", floor: 20, preserves: ["SC2086"] },
  { family: "linters", filter: "yamllint", sample: "yamllint", raw: readSample("yamllint.txt"), command: "yamllint file.yaml", floor: null, preserves: ["error", "warning"] },
  { family: "linters", filter: "markdownlint", sample: "markdownlint", raw: readSample("markdownlint.txt"), command: "markdownlint .", floor: null, preserves: ["MD"] },
  { family: "linters", filter: "hadolint", sample: "hadolint", raw: readSample("hadolint.txt"), command: "hadolint Dockerfile", floor: null, preserves: ["DL"] },
  { family: "linters", filter: "pre-commit", sample: "pre-commit", raw: readSample("pre-commit.txt"), command: "pre-commit run --all-files", floor: 45, preserves: ["Failed"] },
  { family: "linters", filter: "mypy", sample: "mypy-err", raw: readSample("mypy-err.txt"), command: "mypy src/", floor: null, preserves: ["error"] },
  { family: "linters", filter: "pip-install", sample: "pip-install", raw: readSample("pip-install.txt"), command: "pip install -r requirements.txt", floor: 80, preserves: ["Successfully installed"] },
  { family: "linters", filter: "ruff-format", sample: "ruff-format-diff", raw: readSample("ruff-format-diff.txt"), command: "ruff format --check .", floor: null, preserves: [] },
  { family: "linters", filter: "uv", sample: "UV_INSTALL", raw: UV_INSTALL, command: "uv pip install -r r.txt", floor: 25, preserves: ["Installed 5 packages in 23ms"] },
  { family: "linters", filter: "uv", sample: "UV_OK", raw: UV_OK, command: "uv sync", floor: 50, preserves: [] },
  { family: "linters", filter: "poetry", sample: "POETRY_INSTALL", raw: POETRY_INSTALL, command: "poetry install", floor: 40, preserves: ["Writing lock file"] },
  { family: "linters", filter: "basedpyright", sample: "BASEDPYRIGHT_ERR", raw: BASEDPYRIGHT_ERR, command: "basedpyright", floor: 10, preserves: ["3 errors, 1 warning, 0 informations"] },
  { family: "linters", filter: "ty", sample: "TY_ERR", raw: TY_ERR, command: "ty check", floor: null, preserves: ["error[unresolved-reference]", "Found 1 error, 1 warning"] },

  // ───────────────────────────────── git ─────────────────────────────────────
  { family: "git", filter: "git-fetch", sample: "git-fetch", raw: readSample("git-fetch.txt"), command: "git fetch", floor: 95, preserves: ["From "] },
  { family: "git", filter: "git-branch", sample: "git-branch-a", raw: readSample("git-branch-a.txt"), command: "git branch -a", floor: null, preserves: ["main"] },
  { family: "git", filter: "git-stash", sample: "git-stash", raw: readSample("git-stash.txt"), command: "git stash list", floor: null, preserves: ["stash@{0}"] },
  { family: "git", filter: "git-worktree", sample: "git-worktree-list", raw: readSample("git-worktree-list.txt"), command: "git worktree list", floor: null, preserves: [] },

  // ───────────────────────────────── vcs ─────────────────────────────────────
  { family: "vcs", filter: "glab-list", sample: "glab-pr-list", raw: readSample("glab-pr-list.txt"), command: "glab mr list", floor: null, preserves: [] },
  { family: "vcs", filter: "gt", sample: "gt-log", raw: readSample("gt-log.txt"), command: "gt log", floor: null, preserves: [] },
  { family: "vcs", filter: "jj", sample: "jj-log", raw: readSample("jj-log.txt"), command: "jj log", floor: null, preserves: [] },

  // ────────────────────────────────── go ─────────────────────────────────────
  { family: "go", filter: "go-build", sample: "go-build", raw: readSample("go-build.txt"), command: "go build ./...", floor: 75, preserves: ["build ok"] },
  { family: "go", filter: "go-build", sample: "go-build-error", raw: readSample("go-build-error.txt"), command: "go build ./...", floor: null, preserves: ["undefined"] },
  { family: "go", filter: "go-vet", sample: "go-vet", raw: readSample("go-vet.txt"), command: "go vet ./...", floor: null, preserves: ["Sprintf"] },

  // ───────────────────────────────── cargo ───────────────────────────────────
  { family: "cargo", filter: "cargo-run", sample: "cargo-run", raw: readSample("cargo-run.txt"), command: "cargo run", floor: 80, preserves: ["Hello"] },
  { family: "cargo", filter: "cargo-fmt", sample: "cargo-fmt-diff", raw: readSample("cargo-fmt-diff.txt"), command: "cargo fmt --check", floor: null, preserves: [] },

  // ────────────────────────────────── cc ─────────────────────────────────────
  { family: "cc", filter: "gcc", sample: "GCC_ERR", raw: GCC_ERR, command: "gcc -O2 main.c", floor: 20, preserves: ["error: use of undeclared identifier 'foo'", "warning: unused variable 'x'"] },
  { family: "cc", filter: "make", sample: "MAKE_OK", raw: MAKE_OK, command: "make", floor: 30, preserves: ["gcc -O2 foo.c"] },
  { family: "cc", filter: "make", sample: "MAKE_ERR", raw: MAKE_ERR, command: "make -j4", floor: null, preserves: ["*** [Makefile:3: all] Error 2", "error: 'foo' undeclared"] },
  { family: "cc", filter: "pio-run", sample: "PIO_ERR", raw: PIO_ERR, command: "pio run", floor: 50, preserves: ["error: 'LED_BUILTINN' was not declared"] },

  // ──────────────────────────────── dotnet ───────────────────────────────────
  { family: "dotnet", filter: "dotnet-build", sample: "DOTNET_BUILD_OK", raw: DOTNET_BUILD_OK, command: "dotnet build", floor: 70, preserves: [] },
  { family: "dotnet", filter: "dotnet-build", sample: "DOTNET_BUILD_ERR", raw: DOTNET_BUILD_ERR, command: "dotnet build", floor: null, preserves: ["error CS1002", "Build FAILED."] },
  { family: "dotnet", filter: "dotnet-test", sample: "DOTNET_TEST_OK", raw: DOTNET_TEST_OK, command: "dotnet test", floor: 80, preserves: [] },
  { family: "dotnet", filter: "dotnet-test", sample: "DOTNET_TEST_FAIL", raw: DOTNET_TEST_FAIL, command: "dotnet test", floor: null, preserves: ["Failed!  - Failed:     1", "Expected: 4"] },
  { family: "dotnet", filter: "dotnet-format", sample: "DOTNET_FORMAT_ERR", raw: DOTNET_FORMAT_ERR, command: "dotnet format", floor: 20, preserves: ["error WHITESPACE:", "error IMPORTS:"] },

  // ────────────────────────────────── php ────────────────────────────────────
  { family: "php", filter: "composer", sample: "COMPOSER_INSTALL", raw: COMPOSER_INSTALL, command: "composer install", floor: 55, preserves: ["Writing lock file"] },
  { family: "php", filter: "composer", sample: "COMPOSER_NOTHING", raw: COMPOSER_NOTHING, command: "composer install", floor: 45, preserves: [] },

  // ───────────────────────────────── ruby ────────────────────────────────────
  { family: "ruby", filter: "rake", sample: "RAKE_OK", raw: RAKE_OK, command: "rake test", floor: null, preserves: ["12 runs, 20 assertions, 0 failures, 0 errors, 0 skips"] },
  { family: "ruby", filter: "rake", sample: "RAKE_FAIL", raw: RAKE_FAIL, command: "rake db:migrate", floor: null, preserves: ["rake aborted!", "Tasks: TOP => db:migrate"] },

  // ──────────────────────────────── elixir ───────────────────────────────────
  { family: "elixir", filter: "mix-compile", sample: "MIX_COMPILE_WARN", raw: MIX_COMPILE_WARN, command: "mix compile", floor: 30, preserves: ['warning: variable "conn" is unused'] },

  // ───────────────────────────────── swift ───────────────────────────────────
  { family: "swift", filter: "swift-build", sample: "SWIFT_ERR", raw: SWIFT_ERR, command: "swift build", floor: 20, preserves: ["error: use of unresolved identifier 'foo'"] },
  { family: "swift", filter: "xcodebuild", sample: "XCODE_FAIL", raw: XCODE_FAIL, command: "xcodebuild -scheme App", floor: 50, preserves: ["error: use of unresolved identifier 'foo'", "** BUILD FAILED **"] },

  // ─────────────────────────────── java-build ────────────────────────────────
  { family: "java-build", filter: "spring-boot", sample: "SPRING_OK", raw: SPRING_OK, command: "mvn spring-boot:run", floor: 50, preserves: ["Tomcat started on port 8080", "Started MyApp in 3.2 seconds"] },
  { family: "java-build", filter: "spring-boot", sample: "SPRING_ERR", raw: SPRING_ERR, command: "gradle bootRun", floor: 30, preserves: ["Application run failed", "Caused by:"] },

  // ─────────────────────────────── containers ────────────────────────────────
  { family: "containers", filter: "docker-compose", sample: "COMPOSE_UP", raw: COMPOSE_UP, command: COMPOSE_UP_CMD, floor: 25, preserves: ["#14 [builder 7/9] RUN", "naming to docker.io/library/legendarr-legendarr", "Image legendarr-legendarr Built", "Container legendarr-legendarr-1 Started"] },
  { family: "containers", filter: "docker-compose", sample: "COMPOSE_FAIL", raw: COMPOSE_FAIL, command: COMPOSE_UP_CMD, floor: null, preserves: ["#14 ERROR: process", "error: Failed to parse", "failed to solve:"] },
  { family: "containers", filter: "docker-compose", sample: "COMPOSE_LOGS", raw: COMPOSE_LOGS, command: "docker compose logs", floor: 20, preserves: ["starting web worker", "database system is ready"] },
];

const measured: { family: string; filter: string; sample: string; rawB: number; outB: number; pct: number }[] = [];

describe("reduction floors — ROI / regression report", () => {
  test("every filter named in a row is registered", () => {
    for (const r of ROWS) expect(getFilter(r.filter).name).toBe(r.filter);
  });

  for (const r of ROWS) {
    test(`${r.filter} × ${r.sample} — reduction ${r.floor === null ? "(signal)" : `>= ${r.floor}%`} + preserves`, () => {
      const body = runFilterBody(r.filter, r.command, r.raw);
      const pct = reductionPct(r.raw, body);
      measured.push({ family: r.family, filter: r.filter, sample: r.sample, rawB: r.raw.length, outB: body.length, pct });

      // Safety: a filter must never balloon the output. The epsilon covers
      // samples saved without a trailing newline.
      expect(body.length, `${r.filter}/${r.sample} grew`).toBeLessThanOrEqual(r.raw.length + 8);

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
    lines.push("Family     | Filter          | Sample              | Raw B | Out B | Reduction");
    lines.push("-----------|-----------------|---------------------|-------|-------|----------");
    for (const m of measured) {
      rawTotal += m.rawB;
      outTotal += m.outB;
      lines.push(
        `${m.family.padEnd(10)} | ${m.filter.padEnd(15)} | ${m.sample.padEnd(19)} | ${String(m.rawB).padStart(5)} | ${String(m.outB).padStart(5)} | ${`${m.pct.toFixed(1)}%`.padStart(8)}`,
      );
    }
    const aggregate = rawTotal > 0 ? 100 * (1 - outTotal / rawTotal) : 0;
    lines.push("-----------|-----------------|---------------------|-------|-------|----------");
    lines.push(`TOTAL      | ${String(measured.length).padEnd(15)} |                     | ${String(rawTotal).padStart(5)} | ${String(outTotal).padStart(5)} | ${`${aggregate.toFixed(1)}%`.padStart(8)}`);
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));

    // Sanity: aggregate must be positive (filters net-reduce overall).
    expect(aggregate).toBeGreaterThan(0);
  });
});
