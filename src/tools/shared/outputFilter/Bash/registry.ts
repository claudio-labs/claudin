import { builtInFilters } from "src/tools/shared/outputFilter/Bash/filters/index.js";
import {
  consumeExecutionPrefix,
  hasCompound,
  matchesAtomicCommand,
  splitTopLevelSegments,
  splitTrailingReducerPipe,
} from "src/tools/shared/outputFilter/Bash/pipeline.js";
import type { FilterSpec } from "src/tools/shared/outputFilter/Bash/types.js";
import { loadUserFilters } from "src/tools/shared/outputFilter/Bash/userFilters.js";

/** Strips sudo/time/nice prefixes, leading env assignments and runner prefixes
 * (npx, poetry run, pnpm dlx, …) — in any interleaving — so `sudo FOO=bar ls`
 * matches the `ls` filter and `poetry run pytest` matches the `pytest` filter. */
export function canonicalizeForMatching(command: string): string {
  const s = command.trim();
  return s.slice(consumeExecutionPrefix(s)).trim();
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
