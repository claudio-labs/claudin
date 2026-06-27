// Shared test harness for the Phase 13 per-family filter tests.
//
// Phase ≤12 keeps its helpers inline in `bashFilter.test.ts`; this module
// re-exports the same behavior so each `filters/<family>.test.ts` can drive a
// single FilterSpec against real captured output without duplicating the
// marker-stripping / reduction-measuring boilerplate.
//
// NOT a `.test` file — it exports helpers, it does not register tests.

import { applyBashFilterToStdout } from "../../index.js";
import { findFilterForCommand } from "../../registry.js";
import { builtInFilters } from "../index.js";
import type { FilterSpec } from "../../types.js";

/** Locate a registered built-in spec by its `name`. Throws if absent so a
 * typo in a test surfaces immediately rather than silently passing. */
export function getFilter(name: string): FilterSpec {
  const f = builtInFilters.find((s) => s.name === name);
  if (!f) throw new Error(`filter '${name}' not registered in builtInFilters`);
  return f;
}

// `<bash-output-filtered ...>BODY</bash-output-filtered>` → BODY. Tests assert
// on the content, not the marker overhead (markers covered by markers.test.ts).
const WRAPPER_RE =
  /^<bash-output-filtered\s[^>]*>([\s\S]*)<\/bash-output-filtered>$/;

export function stripWrapper(s: string): string {
  const m = s.match(WRAPPER_RE);
  return m ? (m[1] ?? s) : s;
}

/** Run a single named filter over raw stdout (success path: isError=false) and
 * return the wrapped result exactly as the model would see it. */
export function runFilter(
  filterName: string,
  command: string,
  raw: string,
): string {
  const filter = getFilter(filterName);
  return applyBashFilterToStdout(raw, false, {
    effectiveCommand: command,
    filter,
    rewrite: null,
  });
}

/** Same as `runFilter` but with the marker wrapper stripped — the filtered body. */
export function runFilterBody(
  filterName: string,
  command: string,
  raw: string,
): string {
  return stripWrapper(runFilter(filterName, command, raw));
}

/** Byte-level reduction percentage of `body` vs `raw` (0–100). */
export function reductionPct(raw: string, body: string): number {
  return 100 * (1 - body.length / Math.max(1, raw.length));
}

/** Assert that `command` routes to the spec named `expected` (and to nothing
 * else). Mirrors the routing tests in bashFilter.test.ts. */
export function routesTo(command: string): string | undefined {
  return findFilterForCommand(command)?.name;
}

export { findFilterForCommand };
