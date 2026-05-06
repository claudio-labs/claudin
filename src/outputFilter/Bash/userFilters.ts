import { logError } from "src/utils/log.js";
import { z } from "zod/v4";
import type { FilterSpec } from "./types.js";

// ---------------------------------------------------------------------------
// ReDoS safety
// ---------------------------------------------------------------------------

// Patterns known to cause catastrophic backtracking. Compiled from
// safe-regex heuristics + common footguns.
const REDOS_PATTERNS = [
  // Nested quantifiers: (a+)+, (a*)*, (a+)*, (a*)+
  /\([^)]*[+*]\)[+*]/,
  // Quantified overlapping alternation: (a|a)+, (a|a)*
  /\([^)]*\|[^)]*\)[+*]/,
  // Double-quantified character class: [a-z]+[a-z]+
  /\[[^\]]+\]\+\[[^\]]+\]\+/,
  // Star-of-star: .*.*, .*\s*.*, .+.*+ (two quantified dot atoms, optionally separated)
  /\.\*\S{0,3}\*|\.\+\S?\*|\.\*\S?\+/,
  // Nested optional groups: (a?)+, (a+)?, (a*)?
  /\([^)]*[+*?]\)\?/,
];

/** Rejects regex patterns that exhibit catastrophic backtracking (nested quantifiers, overlapping alternation, etc.). */
export function isSafeRegex(pattern: string): boolean {
  for (const redos of REDOS_PATTERNS) {
    if (redos.test(pattern)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// User filter schema (zod)
// ---------------------------------------------------------------------------

const ReplaceRuleSchema = z.object({
  pattern: z.string().min(1),
  replacement: z.string(),
  flags: z.string().optional().default("g"),
});

const MatchOutputRuleSchema = z.object({
  pattern: z.string().min(1),
  message: z.string().min(1),
  unless: z.string().optional(),
});

const UserFilterSpecSchema = z.object({
  name: z.string().min(1),
  matchCommand: z.string().min(1),
  matchCommandReject: z.string().optional(),
  stripAnsi: z.boolean().optional(),
  replace: z.array(ReplaceRuleSchema).optional(),
  collapseRuns: z.boolean().optional(),
  collapseDigitTemplates: z
    .union([
      z.boolean(),
      z.object({ minRun: z.number().int().min(2).optional() }),
    ])
    .optional(),
  dedupGlobal: z.boolean().optional(),
  matchOutput: z.array(MatchOutputRuleSchema).optional(),
  stripLinesMatching: z.array(z.string().min(1)).optional(),
  keepLinesMatching: z.array(z.string().min(1)).optional(),
  truncateLineAt: z.number().int().min(1).optional(),
  headLines: z.number().int().min(0).optional(),
  tailLines: z.number().int().min(0).optional(),
  maxLines: z.number().int().min(1).optional(),
  onEmpty: z.string().optional(),
});

/** Zod schema for the user filters JSON file (`{ filters: [...] }`). */
export const UserFiltersFileSchema = z.object({
  filters: z.array(UserFilterSpecSchema),
});

export type UserFiltersFile = z.infer<typeof UserFiltersFileSchema>;

// ---------------------------------------------------------------------------
// Compile user JSON → FilterSpec[]
// ---------------------------------------------------------------------------

function safeRegExp(pattern: string, flags?: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    logError(
      new Error(
        `bash-output-filter: invalid regex /${pattern}/${flags ?? ""}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    return null;
  }
}

function compileUserSpec(
  raw: z.infer<typeof UserFilterSpecSchema>,
): FilterSpec | null {
  // Validate regex safety
  const allPatterns = [
    raw.matchCommand,
    raw.matchCommandReject,
    ...(raw.replace?.map((r) => r.pattern) ?? []),
    ...(raw.matchOutput?.map((r) => r.pattern) ?? []),
    ...(raw.matchOutput?.map((r) => r.unless).filter((u): u is string => !!u) ??
      []),
    ...(raw.stripLinesMatching ?? []),
    ...(raw.keepLinesMatching ?? []),
  ];

  for (const p of allPatterns) {
    if (!p) continue;
    if (!isSafeRegex(p)) return null;
  }

  // Compile regexes — invalid patterns are rejected
  const matchCommand = safeRegExp(raw.matchCommand);
  if (!matchCommand) return null;

  const matchCommandReject = raw.matchCommandReject
    ? safeRegExp(raw.matchCommandReject)
    : undefined;
  if (raw.matchCommandReject && !matchCommandReject) return null;

  const replace = raw.replace?.map((r) => {
    const pattern = safeRegExp(r.pattern, r.flags);
    if (!pattern) return null;
    return { pattern, replacement: r.replacement };
  });
  if (replace?.some((r) => r === null)) return null;

  const matchOutput = raw.matchOutput?.map((r) => {
    const pattern = safeRegExp(r.pattern);
    if (!pattern) return null;
    const unless = r.unless ? safeRegExp(r.unless) : undefined;
    if (r.unless && !unless) return null;
    return { pattern, message: r.message, unless };
  });
  if (matchOutput?.some((r) => r === null)) return null;

  const stripLinesMatching = raw.stripLinesMatching?.map((p) => {
    const re = safeRegExp(p);
    if (!re) return null;
    return re;
  });
  if (stripLinesMatching?.some((r) => r === null)) return null;

  const keepLinesMatching = raw.keepLinesMatching?.map((p) => {
    const re = safeRegExp(p);
    if (!re) return null;
    return re;
  });
  if (keepLinesMatching?.some((r) => r === null)) return null;

  return {
    name: raw.name,
    matchCommand,
    matchCommandReject: matchCommandReject ?? undefined,
    stripAnsi: raw.stripAnsi,
    replace: replace as
      | { pattern: RegExp; replacement: string }[]
      | undefined,
    collapseRuns: raw.collapseRuns,
    collapseDigitTemplates: raw.collapseDigitTemplates,
    dedupGlobal: raw.dedupGlobal,
    matchOutput: matchOutput as
      | { pattern: RegExp; message: string; unless?: RegExp }[]
      | undefined,
    stripLinesMatching: stripLinesMatching as RegExp[] | undefined,
    keepLinesMatching: keepLinesMatching as RegExp[] | undefined,
    truncateLineAt: raw.truncateLineAt,
    headLines: raw.headLines,
    tailLines: raw.tailLines,
    maxLines: raw.maxLines,
    onEmpty: raw.onEmpty,
  };
}

// ---------------------------------------------------------------------------
// Public API (stub — Phase 6 adds real file loading)
// ---------------------------------------------------------------------------

/** Stub — returns empty until Phase 6 adds file loading from `~/.claudio/bash-filters.json`. */
export function loadUserFilters(): FilterSpec[] {
  // Phase 6 will load from ~/.claudio/bash-filters.json
  return [];
}

/** Validates and compiles a raw JSON object into `FilterSpec[]`, rejecting unsafe or invalid regexes. Logs and skips individual bad filters rather than failing the whole file. */
export function compileUserFilters(raw: unknown): FilterSpec[] {
  const parsed = UserFiltersFileSchema.safeParse(raw);
  if (!parsed.success) {
    logError(
      new Error(
        `bash-output-filter: user filters file failed validation, ignoring`,
      ),
    );
    return [];
  }
  const results: FilterSpec[] = [];
  for (const spec of parsed.data.filters) {
    const compiled = compileUserSpec(spec);
    if (compiled) {
      results.push(compiled);
    } else {
      logError(
        new Error(
          `bash-output-filter: user filter "${spec.name}" rejected (unsafe/invalid regex), skipping`,
        ),
      );
    }
  }
  return results;
}
