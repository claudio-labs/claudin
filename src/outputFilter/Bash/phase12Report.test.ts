/**
 * Phase 12 — consolidated ROI report
 *
 * This test loads every Phase 12 sample, runs the matching filter, and prints
 * a single table with raw bytes / filtered bytes / reduction %. It also
 * enforces a minimum-reduction floor per filter so regressions show up as
 * test failures (not just a smaller table number).
 *
 * Run with:
 *   bun test src/outputFilter/Bash/phase12Report.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { builtInFilters } from "src/outputFilter/Bash/filters/index.js";
import { applyBashFilterToStdout } from "src/outputFilter/Bash/index.js";
import type { FilterSpec } from "src/outputFilter/Bash/types.js";

const SAMPLES_DIR = resolve(
  import.meta.dir,
  "__fixtures__/samples",
);

const WRAPPER_RE =
  /^<bash-output-filtered\s[^>]*>([\s\S]*)<\/bash-output-filtered>$/;

function load(name: string): string {
  return readFileSync(resolve(SAMPLES_DIR, `${name}.txt`), "utf8");
}

function getFilter(name: string): FilterSpec {
  const f = builtInFilters.find((s) => s.name === name);
  if (!f) throw new Error(`filter '${name}' not registered`);
  return f;
}

function applyAndStrip(
  filterName: string,
  command: string,
  raw: string,
): string {
  const filter = getFilter(filterName);
  const out = applyBashFilterToStdout(raw, false, {
    effectiveCommand: command,
    filter,
    rewrite: null,
  });
  const m = out.match(WRAPPER_RE);
  return m ? (m[1] ?? out) : out;
}

function pct(raw: string, body: string): number {
  if (raw.length === 0) return 0;
  return ((raw.length - body.length) / raw.length) * 100;
}

type Row = {
  phase: string;
  filter: string;
  sample: string;
  command: string;
  /** minimum acceptable reduction; null = floor-of-signal, just assert safety */
  floor: number | null;
  /** strings that MUST survive in the filtered body (errors, warnings, etc.) */
  preserves: string[];
};

// Each row is one (filter × sample) pair. Floor is the regression threshold:
// the actual reduction must be >= floor. Set to null when the sample is mostly
// signal (eslint dirty, mypy errors) — in that case we only assert preserves.
const ROWS: Row[] = [
  // ---------------------------------------------------- Phase 12.1 — JS pkg
  {
    phase: "12.1",
    filter: "npm-install",
    sample: "npm-install",
    command: "npm install",
    floor: 35,
    preserves: [],
  },
  {
    phase: "12.1",
    filter: "npm-install",
    sample: "npm-install-warn",
    command: "npm install",
    floor: 0,
    preserves: ["deprecated"],
  },
  {
    phase: "12.1",
    filter: "npm-run",
    sample: "npm-test",
    command: "npm test",
    floor: 70,
    preserves: [],
  },
  {
    phase: "12.1",
    filter: "pnpm-install",
    sample: "pnpm-install",
    command: "pnpm install",
    floor: 85,
    preserves: [],
  },
  {
    phase: "12.1",
    filter: "pnpm-run",
    sample: "pnpm-run",
    command: "pnpm run build",
    floor: 70,
    preserves: [],
  },
  {
    phase: "12.1",
    filter: "yarn-install",
    sample: "yarn-install",
    command: "yarn install",
    floor: 85,
    preserves: [],
  },
  {
    phase: "12.1",
    filter: "eslint",
    sample: "eslint-errors",
    command: "eslint .",
    floor: null,
    preserves: ["no-unused-vars", "error"],
  },
  {
    phase: "12.1",
    filter: "prettier",
    sample: "prettier-check",
    command: "prettier --check .",
    floor: null,
    preserves: [],
  },
  {
    phase: "12.1",
    filter: "prisma-generate",
    sample: "prisma-generate",
    command: "prisma generate",
    floor: 50,
    preserves: [],
  },
  {
    phase: "12.1",
    filter: "prisma-migrate",
    sample: "prisma-migrate",
    command: "prisma migrate dev",
    floor: 30,
    preserves: [],
  },

  // ---------------------------------------------------- Phase 12.2 — linters
  {
    phase: "12.2",
    filter: "shellcheck",
    sample: "shellcheck",
    command: "shellcheck script.sh",
    floor: 20,
    preserves: ["SC2086"],
  },
  {
    phase: "12.2",
    filter: "yamllint",
    sample: "yamllint",
    command: "yamllint file.yaml",
    floor: null,
    preserves: ["error", "warning"],
  },
  {
    phase: "12.2",
    filter: "markdownlint",
    sample: "markdownlint",
    command: "markdownlint .",
    floor: null,
    preserves: ["MD"],
  },
  {
    phase: "12.2",
    filter: "hadolint",
    sample: "hadolint",
    command: "hadolint Dockerfile",
    floor: null,
    preserves: ["DL"],
  },
  {
    phase: "12.2",
    filter: "pre-commit",
    sample: "pre-commit",
    command: "pre-commit run --all-files",
    floor: 45,
    preserves: ["Failed"],
  },

  // ---------------------------------------------------- Phase 12.3 — git/VCS
  {
    phase: "12.3",
    filter: "git-fetch",
    sample: "git-fetch",
    command: "git fetch",
    floor: 95,
    preserves: ["From "],
  },
  {
    phase: "12.3",
    filter: "git-branch",
    sample: "git-branch-a",
    command: "git branch -a",
    floor: null,
    preserves: ["main"],
  },
  {
    phase: "12.3",
    filter: "git-stash",
    sample: "git-stash",
    command: "git stash list",
    floor: null,
    preserves: ["stash@{0}"],
  },
  {
    phase: "12.3",
    filter: "git-worktree",
    sample: "git-worktree-list",
    command: "git worktree list",
    floor: null,
    preserves: [],
  },
  {
    phase: "12.3",
    filter: "glab-list",
    sample: "glab-pr-list",
    command: "glab mr list",
    floor: null,
    preserves: [],
  },
  {
    phase: "12.3",
    filter: "gt",
    sample: "gt-log",
    command: "gt log",
    floor: null,
    preserves: [],
  },
  {
    phase: "12.3",
    filter: "jj",
    sample: "jj-log",
    command: "jj log",
    floor: null,
    preserves: [],
  },

  // ---------------------------------------------------- Phase 12.4 — go/cargo
  {
    phase: "12.4",
    filter: "go-build",
    sample: "go-build",
    command: "go build ./...",
    floor: 75,
    preserves: ["build ok"],
  },
  {
    phase: "12.4",
    filter: "go-build",
    sample: "go-build-error",
    command: "go build ./...",
    floor: null,
    preserves: ["undefined"],
  },
  {
    phase: "12.4",
    filter: "go-vet",
    sample: "go-vet",
    command: "go vet ./...",
    floor: null,
    preserves: ["Sprintf"],
  },
  {
    phase: "12.4",
    filter: "cargo-run",
    sample: "cargo-run",
    command: "cargo run",
    floor: 80,
    preserves: ["Hello"],
  },
  {
    phase: "12.4",
    filter: "cargo-fmt",
    sample: "cargo-fmt-diff",
    command: "cargo fmt --check",
    floor: null,
    preserves: [],
  },

  // ---------------------------------------------------- Phase 12.5 — Python
  {
    phase: "12.5",
    filter: "mypy",
    sample: "mypy-err",
    command: "mypy src/",
    floor: null,
    preserves: ["error"],
  },
  {
    phase: "12.5",
    filter: "pip-install",
    sample: "pip-install",
    command: "pip install -r requirements.txt",
    floor: 80,
    preserves: ["Successfully installed"],
  },
  {
    phase: "12.5",
    filter: "ruff-format",
    sample: "ruff-format-diff",
    command: "ruff format --check .",
    floor: null,
    preserves: [],
  },
];

type Measurement = Row & {
  rawBytes: number;
  filteredBytes: number;
  reduction: number;
};

const measurements: Measurement[] = [];

describe("Phase 12 — ROI report (per-filter)", () => {
  for (const row of ROWS) {
    test(`${row.phase} · ${row.filter} · ${row.sample}`, () => {
      const raw = load(row.sample);
      const body = applyAndStrip(row.filter, row.command, raw);
      const reduction = pct(raw, body);

      measurements.push({
        ...row,
        rawBytes: raw.length,
        filteredBytes: body.length,
        reduction,
      });

      // Safety: filter must not balloon the output. Allow a tiny epsilon for
      // newline normalization (some samples are saved without trailing \n).
      expect(body.length).toBeLessThanOrEqual(raw.length + 8);

      // Floor: regression guard for filters with a measurable ROI.
      if (row.floor !== null) {
        expect(reduction).toBeGreaterThanOrEqual(row.floor);
      }

      // Preserves: critical strings must survive the filter.
      for (const s of row.preserves) {
        expect(body).toContain(s);
      }
    });
  }
});

describe("Phase 12 — ROI report (summary)", () => {
  test("prints aggregate reduction table", () => {
    // Re-measure independently so the table renders even if one assertion
    // above failed (jest/bun stops the `it` block at first failure).
    const rows: Measurement[] = ROWS.map((row) => {
      const raw = load(row.sample);
      const body = applyAndStrip(row.filter, row.command, raw);
      return {
        ...row,
        rawBytes: raw.length,
        filteredBytes: body.length,
        reduction: pct(raw, body),
      };
    });

    const totalRaw = rows.reduce((a, r) => a + r.rawBytes, 0);
    const totalFiltered = rows.reduce((a, r) => a + r.filteredBytes, 0);
    const aggregate = pct("x".repeat(totalRaw), "x".repeat(totalFiltered));

    const lines: string[] = [];
    lines.push("");
    lines.push(
      "Phase | Filter           | Sample                | Raw B | Out B | Reduction",
    );
    lines.push(
      "------|------------------|-----------------------|-------|-------|----------",
    );
    for (const r of rows) {
      lines.push(
        `${r.phase.padEnd(5)} | ${r.filter.padEnd(16)} | ${r.sample.padEnd(21)} | ${String(r.rawBytes).padStart(5)} | ${String(r.filteredBytes).padStart(5)} | ${r.reduction.toFixed(1).padStart(5)}%`,
      );
    }
    lines.push(
      "------|------------------|-----------------------|-------|-------|----------",
    );
    lines.push(
      `TOTAL | ${rows.length} samples           |                       | ${String(totalRaw).padStart(5)} | ${String(totalFiltered).padStart(5)} | ${aggregate.toFixed(1).padStart(5)}%`,
    );
    lines.push("");
    console.log(lines.join("\n"));

    // Sanity: aggregate must be positive (filters net-reduce overall).
    expect(aggregate).toBeGreaterThan(0);
  });
});
