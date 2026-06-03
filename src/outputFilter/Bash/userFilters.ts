import { readFileSync } from "fs";
import { join } from "path";
import { getGlobalConfig } from "src/utils/config.js";
import { getClaudinConfigHomeDir } from "src/utils/envUtils.js";
import { ClaudeError } from "src/utils/errors.js";
import { logError } from "src/utils/log.js";
import { z } from "zod/v4";
import type { FilterSpec } from "./types.js";

const REGEX_MAX_LEN = 500;

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
  pattern: z.string().min(1).max(REGEX_MAX_LEN),
  replacement: z.string().max(REGEX_MAX_LEN),
  flags: z.string().optional().default("g"),
}).strict();

const MatchOutputRuleSchema = z.object({
  pattern: z.string().min(1).max(REGEX_MAX_LEN),
  message: z.string().min(1),
  unless: z.string().max(REGEX_MAX_LEN).optional(),
}).strict();

const UserFilterSpecSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).min(1).max(60),
  matchCommand: z.string().min(1).max(REGEX_MAX_LEN),
  matchCommandReject: z.string().max(REGEX_MAX_LEN).optional(),
  stripAnsi: z.boolean().optional(),
  replace: z.array(ReplaceRuleSchema).optional(),
  collapseRuns: z.boolean().optional(),
  collapseDigitTemplates: z
    .union([
      z.boolean(),
      z.object({ minRun: z.number().int().min(2).optional() }).strict(),
    ])
    .optional(),
  dedupGlobal: z.boolean().optional(),
  matchOutput: z.array(MatchOutputRuleSchema).optional(),
  stripLinesMatching: z.array(z.string().min(1).max(REGEX_MAX_LEN)).optional(),
  keepLinesMatching: z.array(z.string().min(1).max(REGEX_MAX_LEN)).optional(),
  truncateLineAt: z.number().int().min(1).optional(),
  headLines: z.number().int().min(0).optional(),
  tailLines: z.number().int().min(0).optional(),
  maxLines: z.number().int().min(1).optional(),
  onEmpty: z.string().optional(),
}).strict();

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
      new ClaudeError(
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
// Public API
// ---------------------------------------------------------------------------

const USER_FILTERS_FILENAME = "bash-filters.json";

// Module-level cache — reloaded only when the config dir changes (env var)
// or the process restarts. CLI sessions are short-lived, so this is fine.
let _cachedFilters: FilterSpec[] | null = null;
let _cachedConfigDir: string | null = null;

/** Loads and compiles user filters from `~/.claudin/bash-filters.json` (or `$CLAUDIN_CONFIG_DIR/bash-filters.json`). Returns empty array if the file doesn't exist or is invalid. Result is cached for the lifetime of the process. */
export function loadUserFilters(): FilterSpec[] {
  if (getGlobalConfig().bashOutputFilterUserEnabled === false) return [];
  const configDir = getClaudinConfigHomeDir();
  if (_cachedFilters !== null && _cachedConfigDir === configDir) {
    return _cachedFilters;
  }
  const filePath = join(configDir, USER_FILTERS_FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    // ENOENT is expected — no user filters file is normal
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logError(
        new ClaudeError(
          `bash-output-filter: failed to read ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
    _cachedFilters = [];
    _cachedConfigDir = configDir;
    return [];
  }
  const filters = compileUserFilters(raw);
  _cachedFilters = filters;
  _cachedConfigDir = configDir;
  return filters;
}

/** Clears the user-filters cache. Useful in tests that write a temporary filters file. */
export function clearUserFiltersCache(): void {
  _cachedFilters = null;
  _cachedConfigDir = null;
}

/** Validates and compiles a raw JSON object into `FilterSpec[]`, rejecting unsafe or invalid regexes. Logs and skips individual bad filters rather than failing the whole file. */
export function compileUserFilters(raw: unknown): FilterSpec[] {
  const parsed = UserFiltersFileSchema.safeParse(raw);
  if (!parsed.success) {
    logError(
      new ClaudeError(
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
        new ClaudeError(
          `bash-output-filter: user filter "${spec.name}" rejected (unsafe/invalid regex), skipping`,
        ),
      );
    }
  }
  return results;
}
