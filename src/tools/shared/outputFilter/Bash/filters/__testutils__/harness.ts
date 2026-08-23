// Shared test harness for the Phase 13 per-family filter tests.
//
// Phase ≤12 keeps its helpers inline in `bashFilter.test.ts`; this module
// re-exports the same behavior so each `filters/<family>.test.ts` can drive a
// single FilterSpec against real captured output without duplicating the
// marker-stripping / reduction-measuring boilerplate.
//
// NOT a `.test` file — it exports helpers, it does not register tests.

import {
  applyBashFilterToStdout,
  planBashFilter,
} from "src/tools/shared/outputFilter/Bash/index.js";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";
import { builtInFilters } from "src/tools/shared/outputFilter/Bash/filters/index.js";
import type { FilterSpec } from "src/tools/shared/outputFilter/Bash/types.js";

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

/**
 * Run a command's output through the REAL plan, and return the filtered body.
 *
 * `runFilter` above builds its `PreExecPlan` by hand, which is what a per-family
 * test wants — it names the spec it is exercising. The cost is that the plan is
 * always a well-formed atomic one: `isCompound` is never set and `filter` is
 * never null, so two decisions in `applyBashFilterToStdout` have no test
 * coverage from that direction at all. Both matter now.
 *
 * `isCompound` gates `allowShortCircuit`: a `matchOutput` sentinel replaces the
 * WHOLE body, so on `a && b` one segment's "✓ up to date" would delete the
 * other's output. And `filter === null` is what admits the generic floor's lossy
 * stages, which is the path most real commands now take, the registry bypassing
 * every pipe and every chain whose segments disagree.
 *
 * So this one resolves the plan the way production does — from the command
 * string alone — with rewrites off, since no command was executed here and a
 * plan may not claim a rewrite that did not happen.
 */
export function runCompoundBody(command: string, raw: string): string {
  const plan = planBashFilter(command, { allowRewrite: false });
  return stripWrapper(applyBashFilterToStdout(raw, false, plan));
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
