import { builtInFilters } from "./filters/index.js";
import {
  ENV_ASSIGNMENT_RE,
  findEnvAssignmentEnd,
  hasCompound,
  LEADING_PREFIX_RE,
  matchesAtomicCommand,
  splitTopLevelSegments,
  splitTrailingReducerPipe,
} from "./pipeline.js";
import type { FilterSpec } from "./types.js";
import { loadUserFilters } from "./userFilters.js";

/** Strips sudo/time/nice prefixes and leading env assignments so `sudo FOO=bar ls` matches the `ls` filter. */
export function canonicalizeForMatching(command: string): string {
  let s = command.trim();
  // Strip leading prefixes (sudo, time, nice, etc.)
  s = s.replace(LEADING_PREFIX_RE, "");
  // Strip env assignments (FOO=bar, FOO="quoted val", FOO=bar BAZ=qux ...).
  // Quote-aware via `findEnvAssignmentEnd` so `FOO="a b" git status` doesn't lose the verb.
  while (ENV_ASSIGNMENT_RE.test(s)) {
    const end = findEnvAssignmentEnd(s);
    if (end === -1) break;
    s = s.slice(end).trimStart();
  }
  return s.trim();
}

function findAtomicFilter(canon: string): FilterSpec | null {
  const userFilters = loadUserFilters();
  for (const filter of builtInFilters) {
    if (matchesAtomicCommand(filter, canon)) return filter;
  }
  for (const filter of userFilters) {
    if (matchesAtomicCommand(filter, canon)) return filter;
  }
  return null;
}

/**
 * Returns the first matching filter (built-ins before user filters), or null if none match.
 *
 * For chained commands (`a && b`, `a; b`, `a || b`) we attempt a safe top-level split:
 * if every segment that has a filter resolves to the *same* filter (and others have none),
 * we apply that single filter. This catches the common `cd X && cmd` and `git status && git diff`
 * patterns without risking mis-filtering when verbs disagree. Pipes, subshells, backgrounding,
 * and control-flow keywords still bypass — they cannot be split safely.
 */
export function findFilterForCommand(command: string): FilterSpec | null {
  const canon = canonicalizeForMatching(command);

  // `BASE | tail -N` / `BASE | cat` is a manual reducer the filter does better — resolve the
  // filter against BASE so the trailing pipe doesn't bypass it (see plan / pipeline helper).
  const reducer = splitTrailingReducerPipe(canon);
  if (reducer) return findFilterForCommand(reducer.base);

  if (hasCompound(canon)) {
    const segments = splitTopLevelSegments(canon);
    if (!segments) return null;
    let chosen: FilterSpec | null = null;
    for (const seg of segments) {
      const segCanon = canonicalizeForMatching(seg);
      const f = findAtomicFilter(segCanon);
      if (!f) continue;
      if (chosen && chosen !== f) return null; // disagreement → bypass
      chosen = f;
    }
    return chosen;
  }

  return findAtomicFilter(canon);
}
