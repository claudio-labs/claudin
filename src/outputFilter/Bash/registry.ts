import { builtInFilters } from "./filters/index.js";
import { LEADING_PREFIX_RE, matchesCommand } from "./pipeline.js";
import type { FilterSpec } from "./types.js";
import { loadUserFilters } from "./userFilters.js";

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/;

/** Strips sudo/time/nice prefixes and leading env assignments so `sudo FOO=bar ls` matches the `ls` filter. */
export function canonicalizeForMatching(command: string): string {
  let s = command.trim();
  // Strip leading prefixes (sudo, time, nice, etc.)
  s = s.replace(LEADING_PREFIX_RE, "");
  // Strip env assignments (FOO=bar, FOO=bar BAZ=qux ...)
  while (ENV_ASSIGNMENT_RE.test(s)) {
    s = s.replace(ENV_ASSIGNMENT_RE, "");
  }
  return s.trim();
}

/** Returns the first matching filter (built-ins before user filters), or null if none match. */
export function findFilterForCommand(command: string): FilterSpec | null {
  // Pre-normalize once here so every matchesCommand call below receives a clean verb.
  // matchesCommand also calls parseBashCommand internally because it can be invoked
  // standalone with a raw command — both sites must handle raw input independently.
  const canon = canonicalizeForMatching(command);
  // Check built-in filters first
  for (const filter of builtInFilters) {
    if (matchesCommand(filter, canon)) return filter;
  }
  // Then user filters
  const userFilters = loadUserFilters();
  for (const filter of userFilters) {
    if (matchesCommand(filter, canon)) return filter;
  }
  return null;
}
