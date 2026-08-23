/**
 * Phase 14 — ROI / regression roll-up for the measured command-gap filters.
 *
 * Same contract as phase12Report / phase13Report: one row per (filter × real
 * sample), asserting (a) a reduction floor as a regression threshold — null when
 * the sample is mostly signal, so only survival is checked — and (b) that the
 * `preserves[]` strings still make it through.
 *
 * One row carries a `null` floor for a reason worth stating, because a floor
 * that is absent for a bad reason is how a report starts lying:
 *
 *  - `docker-compose × COMPOSE_FAIL` is a failed build: almost every line is the
 *    error or its recap. Reducing it further would be losing it.
 *
 * The floors that ARE set were measured first and then set below the observed
 * value, never guessed upward. The compose capture reduces 29.1% and the bun one
 * 21.3%; the fixture is what the model really received, so those are the real
 * numbers and not the ~75% a line-shape estimate suggested.
 *
 * Samples are the real captures in filters/__testutils__/phase14Samples.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { runFilterBody, reductionPct, getFilter } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import * as S from "src/tools/shared/outputFilter/Bash/filters/__testutils__/phase14Samples.js";

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

const COMPOSE_UP_CMD = "docker compose -f docker-compose.dev.yml up -d --build legendarr";

const ROWS: Row[] = [
  // T1 — containers
  {
    phase: "14.1",
    filter: "docker-compose",
    sample: "COMPOSE_UP",
    command: COMPOSE_UP_CMD,
    floor: 25,
    preserves: [
      "#14 [builder 7/9] RUN",
      "naming to docker.io/library/legendarr-legendarr",
      "Image legendarr-legendarr Built",
      "Container legendarr-legendarr-1 Started",
    ],
  },
  {
    phase: "14.1",
    filter: "docker-compose",
    sample: "COMPOSE_FAIL",
    command: COMPOSE_UP_CMD,
    floor: null,
    preserves: [
      "#14 ERROR: process",
      "error: Failed to parse",
      "failed to solve:",
    ],
  },
  {
    phase: "14.1",
    filter: "docker-compose",
    sample: "COMPOSE_LOGS",
    command: "docker compose logs",
    floor: 20,
    preserves: ["starting web worker", "database system is ready"],
  },
  // T2 — bun run
  {
    phase: "14.2",
    filter: "bun-run",
    sample: "BUN_RUN_SMOKE",
    command: "bun run smoke",
    floor: 15,
    preserves: ["✓ Built claudin v1.1.18 → dist/cli.mjs", "1.1.18 (Claudin)"],
  },
];

const samples = S as unknown as Record<string, string>;
const measured: { phase: string; filter: string; sample: string; rawB: number; outB: number; pct: number }[] = [];

describe("phase 14 — ROI / regression report", () => {
  test("every Phase 14 filter named in a row is registered", () => {
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
    lines.push("Phase | Filter         | Sample              | Raw B | Out B | Reduction");
    lines.push("------|----------------|---------------------|-------|-------|----------");
    for (const m of measured) {
      rawTotal += m.rawB;
      outTotal += m.outB;
      lines.push(
        `${m.phase.padEnd(5)} | ${m.filter.padEnd(14)} | ${m.sample.padEnd(19)} | ${String(m.rawB).padStart(5)} | ${String(m.outB).padStart(5)} | ${`${m.pct.toFixed(1)}%`.padStart(8)}`,
      );
    }
    const totalPct = rawTotal > 0 ? (100 * (1 - outTotal / rawTotal)).toFixed(1) : "0.0";
    lines.push("------|----------------|---------------------|-------|-------|----------");
    lines.push(`TOTAL | ${String(measured.length).padEnd(14)} |                     | ${String(rawTotal).padStart(5)} | ${String(outTotal).padStart(5)} | ${`${totalPct}%`.padStart(8)}`);
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });
});
