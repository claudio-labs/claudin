# Architecture: command-aware bash output filter

> **Status:** v1 spec (rev 2 — post-review).
> **Owner:** BashTool runtime
> **Scope:** v1 (everything below is v1 unless explicitly tagged "v2 / deferred")
> **Discovery references:**
> - Decision log: `docs/discovery/bash-output-filter/README.md`
> - Empirical ROI: `docs/discovery/bash-output-filter/optimization-matrix.md`
> - Pipeline reference impl: `docs/discovery/bash-output-filter/validation/pipeline.ts`

This document IS the spec. PRs against it land before code does.

---

## Changelog vs rev 1

Rev 2 incorporates 14 concrete fixes from a critical architectural review (verdict: "ship com rev"; 4 blockers + 5 misalignments + 10 over-engineering opportunities identified and resolved). The biggest architectural change:

**Markers are now written into `result.stdout` inside `BashTool.call()`**, not via a `filterMeta` field on `Out`. This single change resolves four review findings simultaneously:

- No zod schema change to `Out` (review §"Misalignments #1")
- No transcript-replay implications
- Error-exit path automatically carries markers — `ShellError` inherits the filtered stdout (review §"Misalignments #2")
- `mapToolResultToToolResultBlockParam` does not need to be modified (markers already in stdout)

Other rev 2 changes:
- Drop `Promise.race` 200ms timeout (theatre against sync regex backtracking)
- Drop `verb: string` required field on FilterSpec (linear scan of 20 filters is fine)
- Drop 4 standalone files (safety/analytics/debug/parse) — inline at callers
- Reuse `escapeXmlAttr` from `src/utils/xml.ts`, `collapseIdenticalRuns`/`collapseDigitTemplates` from `toolResultSummarizer.ts`
- Phase 0 added: extend `isAlreadyCompacted` in summarizer + register config keys
- Tests colocated (not `__tests__/`); samples in `__fixtures__/`
- Flat config keys (`bashOutputFilterEnabled`), registered in `GLOBAL_CONFIG_KEYS`
- LoC budget: ~4675 → ~1800 (-60%)

---

## 1. What we are building

A pure, command-aware compression layer running inside `BashTool` on every shell invocation. **Two phases:**

1. **Rewrite** (pre-execution): mutates `input.command` to a more compact equivalent (e.g. `git log` → `git log --oneline`).
2. **Pipeline** (post-execution): runs captured `result.stdout` through declarative stages (strip ANSI → replace → dedup → match-output → strip/keep → truncate → head/tail → maxLines → onEmpty), then prepends marker tags to the stdout string.

Both phases are driven by ~20 built-in `FilterSpec` objects. Markers (`<bash-output-rewritten>`, `<bash-output-filtered>`) are written directly into `result.stdout` so they flow naturally through both the success path (`mapToolResultToToolResultBlockParam`) and the error path (`ShellError` → `toolExecution`).

Existing `toolResultSummarizer.ts` has **one** required edit: `isAlreadyCompacted` learns about the new tags. Otherwise it remains the threshold-based safety net.

Failure mode at every layer: return raw stdout unchanged. The filter must never break a turn.

---

## 2. Where it plugs into claudin

**Files modified:**

| File | Change | LoC |
|---|---|---|
| `src/utils/toolResultSummarizer.ts:242-248` (`isAlreadyCompacted`) | Add 2 string startsWith checks for `<bash-output-rewritten` and `<bash-output-filtered` | +2 |
| `src/utils/config.ts:705+` (`GLOBAL_CONFIG_KEYS`) | Register `bashOutputFilterEnabled`, `bashOutputFilterRewriteEnabled`, `bashOutputFilterUserEnabled` | +3 |
| `src/tools/BashTool/BashTool.tsx` | Two ~7-line insertions: rewrite hook before `runShellCommand` (~line 656); pipeline + marker injection on `result.stdout` after capture, before error/success branching (~line 720) | +15 |

**Files NOT modified:**

- `src/tools/BashTool/BashTool.tsx:563` (`mapToolResultToToolResultBlockParam`) — receives stdout that already has markers; renders them as part of the body
- `src/tools/BashTool/BashTool.tsx:547` (`checkPermissions`) — runs against `input.command` (original), unchanged
- `src/tools/BashTool/BashTool.tsx:287-304` (`outputSchema`/`Out`) — no schema change
- `src/services/tools/toolExecution.ts:1636` (error rendering) — naturally inherits filtered stdout from the thrown `ShellError`'s captured output
- `src/utils/toolResultStorage.ts:209` (`processToolResultBlock`) — sees stdout-with-markers like everything else

**Why mark in stdout, not in `Out` metadata:**

- `Out` is `z.infer<typeof outputSchema>` (`BashTool.tsx:287-304`). Adding a field requires a zod schema change with transcript-replay implications. No such change is needed if the marker is in the stdout string.
- `mapToolResult...` is bypassed when `interpretationResult.isError && !isInterrupt` throws `ShellError` (`BashTool.tsx:724-728`). For genuine command failures (`cargo build` syntax error, `pytest` failure), a metadata-driven approach would lose the marker. Stdout-embedded markers survive both code paths.
- Output-as-string is what the model actually consumes; metadata-on-Out is plumbing the model never sees directly.

---

## 3. Module layout

```
src/outputFilter/Bash/
├── index.ts                    # public API: planFilter, applyFilter, types
├── pipeline.ts                 # 11 stages (port of validation/pipeline.ts)
├── registry.ts                 # findFilterForCommand: linear scan
├── markers.ts                  # wrapStdoutWithMarkers, uses escapeXmlAttr from src/utils/xml.ts
├── userFilters.ts              # zod schema + safe loader for ~/.claudin/filters.json
├── filters/
│   ├── index.ts                # builtInFilters: FilterSpec[] (alphabetized export)
│   ├── git.ts                  # git-status, git-log, git-blame, git-pull, git-add-commit-push
│   ├── ls.ts                   # ls-la
│   ├── cargo.ts                # cargo-build, cargo-test, cargo-check
│   ├── tests.ts                # pytest, rspec, go-test
│   ├── linters.ts              # rubocop, prettier (passive), ruff (with rewrite)
│   ├── containers.ts           # docker-ps, docker-images, docker-logs
│   ├── system.ts               # ps, top, journalctl
│   ├── network.ts              # curl, wget, dig
│   ├── pkg.ts                  # bundle-install, npm-install
│   └── grep-rg.ts
├── bashFilter.test.ts    # integration harness (port of validate.ts)
├── pipeline.test.ts            # per-stage unit tests
├── registry.test.ts
├── markers.test.ts
├── userFilters.test.ts
└── __fixtures__/
    └── samples/                # captured stdout fixtures (~30 files)
```

**Layout decisions:**

1. **One file per command family**, not per command. `git.ts` exports 5 specs that share `^git\b` infrastructure. This keeps each file 50–150 LoC and the module flat.
2. **All specs statically imported.** Total spec data <8 KB; lazy-loading complicates the bundler with no runtime win.
3. **Tests colocated** per `.claudin/rules/testing.md` ("Tests are colocated as `*.test.ts(x)` next to the code they cover"). No `__tests__/` subdir — that's only used in claudin for cross-cutting tests at `src/__tests__/`.
4. **Fixtures in `__fixtures__/`** (singular) matching the existing precedent at `src/services/api/__fixtures__/`.
5. **No subclasses, no plugins.** A custom-code filter (e.g. `tsc` parsing, JSON reformat) is a v2 native parser — see §17.
6. **No standalone `safety.ts`/`analytics.ts`/`debug.ts`/`parse.ts`.** Each was <30 LoC; inline at callers (review §"Over-engineering #2-6").

---

## 4. Filter spec syntax

The authoring shape, final:

```ts
// src/outputFilter/Bash/filters/git.ts
import type { FilterSpec } from '../index.js'

const LOG_MATCH = /^git(\s+-[^\s]+)*\s+log\b/
const LOG_REJECT = /--oneline|--format=|--pretty=|-p\b|--patch|\s-[1-9]\b/

export const gitLog: FilterSpec = {
  name: 'git-log',
  matchCommand: LOG_MATCH,
  matchCommandReject: LOG_REJECT,

  rewriteCommand: ({ args }) => {
    const rest = args.filter(a => a !== 'log').join(' ')
    return `git log --oneline ${rest}`.replace(/\s+/g, ' ').trim()
  },

  // pipeline applied to the OUTPUT of the rewritten command (no-op when rewrite fired,
  // active when rewrite was skipped due to compound)
  stripAnsi: true,
  stripLinesMatching: [
    /^\s*Reviewed-on:/,
    /^\s*Co-authored-by:/,
    /^\s*Signed-off-by:/,
  ],
}
```

**Hard rules** (typescript-patterns.md):

- Module-level regex consts only. Never compile inside callbacks.
- `rewriteCommand` is sync, deterministic, pure of `RewriteContext` (the `{ command, verb, args }` shape).
- No async filters. A filter that calls out is by definition not safe in the BashTool hot path.

**Spec interface** (`src/outputFilter/Bash/index.ts`):

```ts
export interface RewriteContext {
  readonly command: string
  readonly verb: string
  readonly args: readonly string[]
}

export interface ReplaceRule {
  readonly pattern: RegExp
  readonly replacement: string
}

export interface MatchOutputRule {
  readonly pattern: RegExp
  readonly message: string
  readonly unless?: RegExp
}

export interface FilterSpec {
  readonly name: string
  readonly matchCommand: RegExp
  readonly matchCommandReject?: RegExp
  readonly rewriteCommand?: (ctx: RewriteContext) => string | null | undefined
  readonly stripAnsi?: boolean
  readonly replace?: readonly ReplaceRule[]
  readonly collapseRuns?: boolean
  readonly collapseDigitTemplates?: boolean | { readonly minRun?: number }
  readonly dedupGlobal?: boolean
  readonly matchOutput?: readonly MatchOutputRule[]
  readonly stripLinesMatching?: readonly RegExp[]
  readonly keepLinesMatching?: readonly RegExp[]
  readonly truncateLineAt?: number
  readonly headLines?: number
  readonly tailLines?: number
  readonly maxLines?: number
  readonly onEmpty?: string
}
```

No `verb: string` field. With ~20 filters, linear scan is sub-microsecond and dominated by the regex test in matchCommand anyway. Hashmap optimization deferred.

---

## 5. Pipeline composition

11 stages, fixed order, no extensibility, no plugins:

```
parse + match → rewrite (pre-exec) ──► runShellCommand ──► result.stdout
                                                              ↓
   stripAnsi → replace → collapseRuns → collapseDigitTemplates → dedupGlobal
   → matchOutput (with unless) → stripLines | keepLines → truncateLineAt
   → headLines + tailLines → maxLines → onEmpty
                                                              ↓
                                                  prepend markers; in-place
                                                  on result.stdout
```

**Implementation surface:**

```ts
// src/outputFilter/Bash/pipeline.ts
export interface PipelineResult {
  readonly body: string
  readonly applied: readonly string[]
  readonly shortCircuited: boolean
  readonly reductionPct: number
}

export function applyPipeline(filter: FilterSpec, raw: string): PipelineResult
```

Each stage is a private top-level function in `pipeline.ts`, takes `string[]` (lines) in and out. They are not exported.

**Reuse from existing code:**

- `collapseIdenticalRuns` and `collapseDigitTemplates` already exist (private) at `toolResultSummarizer.ts:475` and `:500`. Phase 0 makes them exported (or moves them to a new `src/utils/textCompaction.ts` and re-exports from `toolResultSummarizer.ts` for backwards-compat). Pipeline imports the canonical version. **Saves ~80 LoC of duplicate logic.**

**No `Promise.race` timeout.** Sync regex backtracking is not preempted by Promise.race; the race only fires after the regex returns. The actual ReDoS defense is length cap + denylist (§8). Removing this also removes ~30 LoC of orchestration-layer async wrapping.

---

## 6. Rewrite + pipeline coordination — markers go into stdout

The orchestration lives in **two functions** in `index.ts` that `BashTool.call` invokes:

```ts
// src/outputFilter/Bash/index.ts

export interface PreExecPlan {
  readonly effectiveCommand: string
  readonly filter: FilterSpec | null
  readonly rewrite: { readonly from: string; readonly to: string } | null
}

/** Cheap. Resolve filter + maybe rewrite. Returns the (possibly mutated) command. */
export function planFilter(command: string): PreExecPlan

/**
 * Apply pipeline to stdout, prepend markers, return the new stdout string.
 * No throws — internally caught and falls back to raw on any error.
 * Pipeline is skipped when isError is true; rewrite marker still prepended if applicable.
 */
export function applyFilterToStdout(
  rawStdout: string,
  isError: boolean,
  plan: PreExecPlan,
): string
```

**The BashTool integration**, in full:

```ts
// In BashTool.call(), right after `result = generatorResult.value`:

// 1. plan happens BEFORE runShellCommand (above this point in the function)
//    — see §2 for line numbers. plan is captured in scope.

// 2. apply pipeline to stdout BEFORE the isError branching
result.stdout = applyFilterToStdout(result.stdout, result.isError, plan)

// 3. continue normally — ShellError throw on isError will carry the filtered stdout;
//    success path through mapToolResult will see the same.
```

**Why this works for both error and success paths:**

- `result.stdout` is captured before the `interpretationResult.isError && !isInterrupt` branch (`BashTool.tsx:724-728`).
- **Error path** (`isError && !isInterrupt`): `BashTool.tsx:728` constructs `new ShellError('', outputWithSbFailures, code, interrupted)`. Note: `outputWithSbFailures` is `SandboxManager.annotateStderrWithSandboxFailures(input.command, result.stdout)` — i.e., **our filtered stdout flows into `error.stderr`**, not `error.stdout`. The catch at `toolExecution.ts:1636` calls `formatError(error)` (`src/utils/toolErrors.ts:5`), which calls `getErrorParts(error)` (line 24) → for `ShellError`, returns `[Exit code N, interruptMsg, error.stderr, error.stdout]` joined with `\n\n`. **Our markers travel via `error.stderr`.**
- **Success path** returns `Out` containing `result.stdout` — markers go to `mapToolResult...:563` which renders `data.stdout` as part of the body. No code change needed.
- The single integration point (filter in `BashTool.call` mutating `result.stdout` before the `isError` branch) works for both paths because `outputWithSbFailures` derives from `result.stdout` and `mapToolResult...` reads from `result.stdout` — same source.

**Interaction with `EndTruncatingAccumulator` (`BashTool.tsx:646`):**

`result.stdout` is the output of `stdoutAccumulator.toString()`, which has a `MAX_STRING_LENGTH = 32 MB` cap. If a command emits >32 MB, the accumulator appends `\n... [output truncated - NKB removed]` at the end and stops accepting new data. Filter receives the **already-truncated** stdout. Implications:

- Filter pipeline sees the truncation marker as a regular line; no strip pattern in v1 matches it → survives intact at the end of the filtered output.
- Marker `reduction="N%"` is computed over the **truncated input**, not the original. In the rare case where >32 MB output is filtered, the percentage is honest about what the filter saw.
- 32 MB is high enough that this is essentially a corner-case in v1 (we'd have other problems first if a tool emits this much).
- `mkdir`, `touch`, `chmod` etc. that produce empty stdout hit early-return rule #1 (no marker), regardless of accumulator state.

**Early-return rules in `applyFilterToStdout` (in order):**

1. **Empty stdout** (`rawStdout.trim() === ''`) → return `rawStdout` unchanged, no marker. General rule for any caller. Covers `mkdir`, `touch`, `chmod`, silent successes, dry-runs that yield nothing.
2. **No filter matched** (`plan.filter === null`) → return `rawStdout` unchanged.
3. **Pipeline-disabled config** (env var or config flag) → return `rawStdout` unchanged. Rewrite marker still prepended if `plan.rewrite` is set.

**`is_error: true` handling:**

- Rewrite marker is prepended (the rewrite already committed before execution; the model needs to know).
- Pipeline (P/M/D stages) is **skipped** — errors are sacred. `applyFilterToStdout` checks `isError` and returns `wrapWithRewriteMarkerOnly(rawStdout, plan)` for the error case.
- The single `<bash-output-rewritten>` line is prepended; the rest of stdout is the raw error output.

**Why rewrite is NOT just another pipeline stage:**

It mutates a future input; pipeline transforms a past output. Stages compose `string → string`; rewrite composes `command → command`. Two semantics, two functions.

---

## 7. Filter registry — linear scan

`registry.ts`:

```ts
export function findFilterForCommand(command: string): FilterSpec | null {
  // Strip leading env assignments (FOO=bar) and `sudo`. Cheap.
  const canonical = canonicalizeForMatching(command)
  if (canonical.length === 0) return null

  for (const filter of builtInFilters) {
    if (matchesCommand(filter, canonical)) return filter
  }
  for (const filter of userFilters()) {
    if (matchesCommand(filter, canonical)) return filter
  }
  return null
}
```

With ~20 built-ins, linear scan is ~10 µs worst case. `BashTool.call` involves `child_process.spawn` (~10–50 ms baseline); the scan is rounding-error overhead. Verb-hash optimization deferred to v2 (review §"Over-engineering #8").

`canonicalizeForMatching` strips:
- Leading env assignments (`FOO=bar git status` → `git status`)
- Leading `sudo ` (`sudo apt list` → `apt list`)
- Leading `time `, `nice `, similar prefixes

It does NOT decompose pipes/compound — that's `hasCompound`'s job, called separately to gate rewrite (see §6).

User filters are second priority after built-ins. Same-name conflicts: built-in wins (the user has not explicitly opted out of the built-in; if they want override, they re-define the spec name and the registry resolves to the user version because user filters appear after built-ins in the merged list — TODO during impl: confirm precedence direction matches the rule "user override wins").

---

## 8. User-defined filters via JSON

`~/.claudin/filters.json` is the v1 surface. Schema validated with zod (zod/v4, the standard import in this codebase per ~112 occurrences).

```ts
// src/outputFilter/Bash/userFilters.ts
import { z } from 'zod/v4'

const REGEX_MAX_LEN = 500

const UserReplaceRule = z.object({
  pattern: z.string().min(1).max(REGEX_MAX_LEN),
  flags: z.string().regex(/^[gimsu]*$/).optional(),
  replacement: z.string().max(REGEX_MAX_LEN),
}).strict()

const UserFilterSpec = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).min(1).max(60),
  matchCommand: z.string().min(1).max(REGEX_MAX_LEN),
  matchCommandReject: z.string().max(REGEX_MAX_LEN).optional(),
  // No rewriteCommand from JSON — too dangerous.
  stripAnsi: z.boolean().optional(),
  replace: z.array(UserReplaceRule).max(20).optional(),
  collapseRuns: z.boolean().optional(),
  collapseDigitTemplates: z.boolean().optional(),
  dedupGlobal: z.boolean().optional(),
  stripLinesMatching: z.array(z.string().max(REGEX_MAX_LEN)).max(20).optional(),
  keepLinesMatching: z.array(z.string().max(REGEX_MAX_LEN)).max(20).optional(),
  truncateLineAt: z.number().int().positive().max(2000).optional(),
  headLines: z.number().int().positive().max(500).optional(),
  tailLines: z.number().int().positive().max(500).optional(),
  maxLines: z.number().int().positive().max(1000).optional(),
  onEmpty: z.string().max(200).optional(),
}).strict()

const UserFiltersFile = z.object({
  filters: z.array(UserFilterSpec).max(50),
}).strict()
```

**ReDoS mitigation:**

1. **Length cap** on every regex source (500 chars). Most catastrophic-backtracking patterns require contrived complexity that won't fit.
2. **Pattern denylist** for known-bad shapes (`(.+)+`, `(.*)*`, `(a+)+b`). Vendored from `safe-regex` heuristics (~80 LoC inline in `userFilters.ts`).
3. **Build-time test** (`scripts/regex-redos-scan.test.ts`) runs the same denylist against every `RegExp` literal in `filters/*.ts`. Catches built-in patterns at PR-review time.

**No `Promise.race` timeout.** It does not interrupt sync regex (review §"Misalignments #5"). If a regex genuinely backtracks, BashTool will appear to hang; the user can ctrl-C. The mitigation pyramid above prevents this from happening in practice.

User filters live as JSON because users can't author TS in their config. Filter authors who contribute built-ins write TS object literals.

---

## 9. Markers — written into stdout

Two marker shapes, single open tag with no close (matching `<persisted-output>` and `<tool-result-summary>` precedent):

```
<bash-output-rewritten filter="git-log" original="git log -10" actual="git log --oneline -10">
abc1234 fix(api): foo
def5678 feat(cli): bar
...
```

```
<bash-output-filtered name="cargo-build" reduction="55%">
   Compiling foo v1.0.0
warning: unused variable
    Finished `dev` profile in 1s
```

When both apply (rewrite fired AND pipeline reduced):

```
<bash-output-rewritten filter="cargo-build" original="cargo build" actual="cargo build --message-format=json">
<bash-output-filtered name="cargo-build" reduction="78%">
{ ...one-line-per-message... }
```

**`markers.ts` shape** (~50 LoC, uses existing helpers):

```ts
import { escapeXmlAttr } from 'src/utils/xml.js'

const MAX_ATTR_LEN = 200

const REWRITE_TAG = '<bash-output-rewritten'
const FILTER_TAG = '<bash-output-filtered'

export function wrapStdoutWithMarkers(
  rawStdout: string,
  plan: PreExecPlan,
  pipelineResult: PipelineResult | null,
): string {
  // Idempotency: if stdout already has summarizer or persistence wrappers,
  // OR our own markers (re-entry path), don't double-wrap.
  if (
    rawStdout.startsWith('<persisted-output>') ||
    rawStdout.startsWith('<tool-result-summary') ||
    rawStdout.startsWith(REWRITE_TAG) ||
    rawStdout.startsWith(FILTER_TAG)
  ) {
    return rawStdout
  }

  let out = ''
  if (plan.rewrite) {
    out += `${REWRITE_TAG} filter="${escapeXmlAttr(plan.filter!.name)}" original="${escapeXmlAttr(truncate(plan.rewrite.from))}" actual="${escapeXmlAttr(truncate(plan.rewrite.to))}">\n`
  }
  if (pipelineResult && pipelineResult.reductionPct > 0) {
    out += `${FILTER_TAG} name="${escapeXmlAttr(plan.filter!.name)}" reduction="${pipelineResult.reductionPct}%">\n`
  }
  return out + (pipelineResult?.body ?? rawStdout)
}

function truncate(s: string): string {
  return s.length > MAX_ATTR_LEN ? s.slice(0, MAX_ATTR_LEN - 1) + '…' : s
}
```

**Reuse:** `escapeXmlAttr` from `src/utils/xml.ts` (already in use at `src/commands/insights.ts:32`). Spec rev 1 invented this; rev 2 imports.

**Truncation:** `original`/`actual` capped at 200 chars to prevent a 10 KB heredoc-bearing command from blowing up the marker. The model already saw the full command in the `tool_use` block.

**Idempotency under summarizer:** §10 documents the `isAlreadyCompacted` extension that prevents the summarizer from re-wrapping our marker.

---

## 10. Summarizer interaction — Phase 0 fix

The existing `toolResultSummarizer.ts:242-248` `isAlreadyCompacted` check determines whether the threshold-based summarizer skips an already-compacted result:

```ts
function isAlreadyCompacted(text: string): boolean {
  return (
    text.startsWith('<persisted-output>') ||
    text.startsWith(TOOL_RESULT_SUMMARY_TAG)
  )
}
```

**Phase 0 change** (~2 LoC):

```ts
function isAlreadyCompacted(text: string): boolean {
  return (
    text.startsWith('<persisted-output>') ||
    text.startsWith(TOOL_RESULT_SUMMARY_TAG) ||
    text.startsWith('<bash-output-rewritten') ||
    text.startsWith('<bash-output-filtered')
  )
}
```

Without this, a filtered output >8 KB (the `BASH_SUMMARIZE_THRESHOLD` at line 32) would re-enter `summarizeBashOutput` and get head/tail-collapsed on top of our filter, possibly cutting the marker line.

**Tradeoff documented:** when our filter doesn't get a >8 KB output below 8 KB (e.g. tsc errors are 590 KB, our filter gets ~15% reduction → 500 KB still over threshold, **but tsc has no built-in filter** so the summarizer fires alone). For commands with filters, ROI is high enough that filter output is typically far below 8 KB; the few exceptions (huge cargo builds with many warnings) get the summarizer running on top of our filter, which is a degraded but acceptable outcome — the marker survives because of the `isAlreadyCompacted` extension.

---

## 11. Telemetry events

Three events. All names use the privacy convention from `BashTool.tsx:766` (suffix on metadata cast, not event name).

| Event | When | Payload |
|---|---|---|
| `claudin_bash_filter_applied` | Pipeline ran | `filter_name: string` (filter ID), `reduction_pct: number` (0–100), `applied_stage_count: number`, `was_short_circuited: boolean`, `is_error: boolean` |
| `claudin_bash_rewrite_applied` | Rewrite fired and changed the command | `filter_name: string` |
| `claudin_bash_filter_skipped` | Filter matched but errored or yielded zero reduction | `filter_name: string`, `reason_code: number` (1=no-reduction, 2=error, 3=json-passthrough) |

`logEvent` only accepts `boolean | number | undefined` metadata values (`src/services/analytics/index.ts:60-61`); the spec's payload uses only those types. No string values except via the suffix-cast pattern, which is reserved for IDs in our enumerated set.

**Privacy:**

- `filter_name` is one of our enumerated filter IDs (e.g. `'git-status'`, `'cargo-build'`). Bounded set, no PII. Cast: `filter_name: filterName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`.
- We do **not** emit raw command strings, file paths, output content, or verb. Verb extraction for analytics is unnecessary in v1 (filter name is more specific anyway).
- The pattern at `BashTool.tsx:765` (`logEvent('tengu_bash_command', { command_type: ..., is_in_worktree: ... })`) is the template. Events emitted inline in `applyFilterToStdout` and at the rewrite site.

No new GrowthBook flags. Future opt-out is the env var or config (§12).

**Volume:** existing `tengu_bash_command` already fires on every bash call (`BashTool.tsx:765`) — ~100/session. Our 3 events add ~30-60/session in a typical workflow (filter matches happen on ~50-70% of bash calls; not every call gets a filter). No sampling needed for v1.

**Avoid no-op events:** when filter matches but yields `reductionPct === 0` AND no rewrite fired, emit `claudin_bash_filter_skipped { reason_code: 1 }` instead of `claudin_bash_filter_applied`. Keeps the `applied` event meaningful (always represents real compression). Document the routing logic in `analytics.ts` (or inline in `index.ts` orchestrator).

---

## 12. Configuration surface

**Precedence (highest first):**

1. `CLAUDIN_DISABLE_BASH_OUTPUT_FILTER=1` — global kill switch (rewrite + pipeline both off). Hot-path test: `isEnvTruthy(process.env.CLAUDIN_DISABLE_BASH_OUTPUT_FILTER)`.
2. `CLAUDIN_DISABLE_REWRITE=1` — pipeline still runs, rewrite suppressed.
3. `CLAUDIN_BASH_FILTER_DEBUG=1` — emits `logForDebugging` for every filter decision. Debug-only.
4. Per-call: `is_error: true` skips pipeline (always; not configurable).
5. Global config (cached via `getGlobalConfig()`):
   ```ts
   bashOutputFilterEnabled: boolean         // default true
   bashOutputFilterRewriteEnabled: boolean  // default true
   bashOutputFilterUserEnabled: boolean     // default true (reads ~/.claudin/filters.json)
   ```
   **Flat keys**, matching the existing `toolResultSummarizerEnabled` precedent. Every config field in `GLOBAL_CONFIG_KEYS` (`config.ts:705`) is flat. Nested objects break the convention.
6. Built-in filter set (always available unless `enabled: false`).

**Phase 0 step:** register the three new keys in `GLOBAL_CONFIG_KEYS` at `config.ts:705+`. Without this, the new fields aren't recognized by `/config`.

**Runtime-toggleable:** the env vars take effect on next `BashTool.call()`. The config fields take effect on next `getGlobalConfig()` re-read (cached, effectively next session unless invalidated).

**Install-only:** the set of built-in filters. No way to disable a single built-in via config in v1. Workaround: define a user filter with the same `name` (last-wins). v2 may add `disabledBuiltins: string[]`.

**`/filters` slash command:** **deferred to v2.** `CLAUDIN_BASH_FILTER_DEBUG=1` covers the v1 debugging needs.

---

## 13. Error handling — fail-open

`logError` accepts a single argument (`src/utils/log.ts:159`). All call sites use `logError(error)`, not `logError(message, error)`. The spec's prior two-arg example was wrong.

**Fail-open touchpoints:**

```ts
// inline in index.ts — no separate safety.ts
function safeApply<T>(label: string, raw: T, run: () => T): T {
  try {
    return run()
  } catch (e) {
    logError(e)
    logForDebugging(`bashOutputFilter: ${label} failed; returning raw input unchanged`, { level: 'warn' })
    return raw
  }
}
```

| Layer | What can fail | What we do |
|---|---|---|
| `findFilterForCommand` | Bad regex from user filter, bug | Catch → log → return null |
| `planFilter.rewriteCommand` callback | Programmer bug in built-in | Catch → log → no rewrite, fall through to pipeline |
| `applyPipeline` (called by `applyFilterToStdout`) | Pathological input/regex, programmer bug | Catch → log → return `{ body: raw, ... }` |
| `userFilters.load` | Malformed JSON, malformed schema | Catch per-entry → log → drop bad entry, keep valid ones |
| Dynamic regex compile (user filter) | Invalid regex literal | Caught in `userFilters.load`; the filter is dropped |

**Concrete answers:**

- **Catastrophic backtracking on builtin regex:** prevented at PR time by `scripts/regex-redos-scan.test.ts`. If one slips through, BashTool appears to hang; user can ctrl-C; we log the offending filter on the next regex review.
- **Catastrophic backtracking on user regex:** prevented by length cap + denylist. Same fallback as above.
- **Filter spec malformed at load time:** zod validation rejects per-entry. Bad entry dropped, others load. One-line warning to stderr at startup.
- **`rewriteCommand` returns garbage** (empty, command without verb): post-rewrite validation in `planFilter`: must be non-empty, must start with `verb` (the first token of the original). Validation failure → log → no rewrite.

No silent swallow. Every catch calls `logError(e)`.

---

## 14. Testing strategy

Tests **colocated** per `.claudin/rules/testing.md`. Layout:

```
src/outputFilter/Bash/
├── bashFilter.test.ts     # the integration harness — port of validate.ts
├── pipeline.test.ts             # unit tests for each stage (pure)
├── registry.test.ts             # canonicalization, lookup, sudo/env prefix, compound bypass
├── markers.test.ts              # idempotency, escaping, truncation
├── userFilters.test.ts          # malformed JSON, ReDoS denylist, length cap, valid spec
└── __fixtures__/
    └── samples/                  # *.txt files, fixtures from discovery
```

**Single integration harness, not per-filter test files.** The harness asserts ROI ≥ predicted-5pp for every (filter, sample) pair. A separate per-filter `.test.ts` would duplicate the harness assertions — review §"Testing strategy critique" called this out.

**Conversion of `validation/validate.ts`:**

- Each `CASES[i]` becomes a `test('...')` body inside `bashFilter.test.ts`. Wrap in `describe('integration harness', ...)`. Predicted reductions become `expect(reductionPct).toBeGreaterThanOrEqual(predicted - 5)`.
- The 3 safety tests + new ones (sandbox annotation preservation, etc.) live inline in the same file as their own `describe('safety', ...)` block.
- Rewrite tests → `describe('rewrite', ...)` block. Each asserts `effectiveCommand`.
- Samples are checked in to `__fixtures__/samples/`. Discovery samples are the source of truth; we copy at Phase 1.

**Coverage targets** (from `.claudin/rules/testing.md` `src/utils/*` 75%+ guideline):

- `pipeline.ts` 90%+ (pure logic)
- `registry.ts` 85%+
- `markers.ts` 90%+
- `userFilters.ts` 80%+
- Overall module 80%+

**Running:**

```bash
bun test src/outputFilter/Bash
bun run verify:privacy   # required (3 new event names with the suffix proof)
```

`bun run test:provider` is N/A (we don't touch `src/services/api/*`).

---

## 15. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Engulfing a real error via `match_output` | **Critical** | `unless` clause is mandatory in every `matchOutput` rule. `bashFilter.test.ts` has a `safety` describe block with one assertion per `matchOutput` rule across all built-in filters. CI fails if a `matchOutput` is added without `unless`. |
| Catastrophic backtracking on user regex | High | Length cap (500 chars) + `safe-regex`-style denylist + build-time test scanning all builtin regex (`scripts/regex-redos-scan.test.ts`). |
| Catastrophic backtracking on built-in regex | Medium | Same build-time scan + PR review. |
| Determinism break (rewrite varies across runs) | High | Spec contract: `rewriteCommand` is pure of `RewriteContext`. Test: each rewrite filter has a "determinism" assertion (call rewrite twice on same input, expect equality). Cache-key implications for any future cache layer: the **transcript** records the original command; the **effective command** is what runs. A cache keyed on either alone would desync. v2 cache must canonicalize. |
| Filter strips a real warning the model needed | Medium | Per-filter safety case in the harness. Build-time invariant: `matchOutput` rules without `unless` rejected. |
| 590 KB tsc output blows the pipeline | Medium | tsc has no v1 filter (matrix decision). Pipeline only fires when a filter matches — `tsc` matches none. The 8 KB summarizer catches it via head/tail. |
| Compound-command rewrite breaks pipe semantics | High | `hasCompound(command)` skips rewrite (pipeline still runs). Test: `git log -5 \| wc -l` → no rewrite. |
| Sandbox annotation lost via filter strip | Medium | `BashTool.tsx:720` calls `SandboxManager.annotateStderrWithSandboxFailures(input.command, result.stdout)` BEFORE our filter. If the filter strips the annotation, that's a real safety signal lost. New test: `bashFilter.test.ts` includes a sample with sandbox-violation lines and asserts the filter does not strip them across all builtin filters. |
| Background-task path has empty stdout for filtering | Low | `applyFilterToStdout` returns raw early when `rawStdout.trim() === ''`. Background task stdout is the preview; full output is read later via FileReadTool. No marker on background-task results. |
| Image content path bypasses filter | Low | `mapToolResult...` line 585 short-circuits to `buildImageToolResult` when `data.isImage`. No issue: filter ran on `result.stdout` upstream; if `isImage` is set, stdout is metadata, not output. |
| Persisted output strips our marker | Low | `wrapStdoutWithMarkers` skips wrap if `<persisted-output>` is already present. Persistence runs on the post-filter stdout (markers already there, then persistence wraps). The mapper unwraps persistence and shows preview; filter marker is inside the preview if it fits. Acceptable v1 trade-off. |
| `_simulatedSedEdit` path bypasses filter | None | `BashTool.call` returns at line 638 before our hooks. Filter never runs. Correct — sed edit output is not shell output. |
| Filter marker confuses the model | Low | Open-tag convention is established (`<persisted-output>`, `<tool-result-summary>`); models handle it. Empirical: validated across Claude/GPT/Gemini in discovery. |
| Existing BashTool snapshot tests break | Medium | Filter is gated by config; tests in default config (`enabled: false` in early phases, `enabled: true` only after Phase 7) see no marker. After flip, snapshot updates land in the same PR. |
| Non-English locale (`LANG=fr_FR.UTF-8`, etc.) | Low | **v1 is English-only.** Filter regex assumes English tool output (e.g., `git status` matches "Changes not staged for commit:"). In non-English locales, regex doesn't match → filter returns raw stdout (no marker, no error). Zero implementation cost; fail-open natural. v2 may add locale-specific patterns or `LANG`-based bail. **Auto-detect rejected** for v1: `LANG=C.UTF-8` emits English, containers without installed locales fall back to English — too brittle to gate on. |

---

## 16. Trade-offs considered and rejected

1. **Plug into `processToolResultBlock` instead of BashTool.** Rejected: forces command + isError through every tool's mapper.
2. **Single mega-file `bashOutputFilters.ts`.** Rejected: > 1000 LoC of regex unreviewable. Family-per-file is the sweet spot.
3. **TOML for built-in filters (mirror rtk).** Rejected: TS gets type-checking, autocomplete, syntax highlighting. TOML for users only because they can't author TS.
4. **Builder API for FilterSpec.** Rejected: object literals are simpler.
5. **Native parsers in v1** (`ls -la` → tree, etc.). Rejected: declarative gets 80%+; +6pp not worth ~200 LoC each.
6. **Project-local `.claudin/filters.json` with trust dialog.** Rejected for v1: trust UX non-trivial. v2.
7. **`filterMeta` on `Out` type to carry markers.** Rejected: zod schema change with transcript-replay risk; markers in stdout achieve the same goal more naturally and survive the error path.
8. **Caching pipeline results.** Rejected: hot path is fast already; cache-key is large.
9. **`re2-wasm` for ReDoS-proof regex.** Rejected for v1: 1 MB+ WASM bundle. Length cap + denylist + build scan suffices.
10. **Filter only when stdout > 8 KB.** Rejected: discovery showed 26%+ wins on small outputs.
11. **Skip rewrite when `is_error: true`.** Rejected: rewrite committed before execution. Pipeline skip is the correct response.
12. **Run rewrite on non-leading parts of compound commands.** Rejected: complexity high, value low. v2.
13. **Per-filter `Promise.race` timeout.** Rejected: doesn't interrupt sync regex anyway. Build-time scan + length cap is the real defense.
14. **`verb: string` field on FilterSpec for hash lookup.** Rejected: linear scan over 20 filters is sub-microsecond and dominated by regex cost. Hashmap optimization deferred.
15. **Standalone files for `safety.ts`/`analytics.ts`/`debug.ts`/`parse.ts`.** Rejected: each <30 LoC with single-digit callers; inline at use sites.
16. **`__tests__/` subdir layout.** Rejected: violates `.claudin/rules/testing.md` colocation rule. Only `src/__tests__/` (cross-cutting) exists in this repo.
17. **Per-filter `.test.ts` smoke files.** Rejected: duplicates the harness. One harness is the source of truth.
18. **Nested config keys (`bashOutputFilter.{enabled, ...}`).** Rejected: every existing key in `GLOBAL_CONFIG_KEYS` is flat.
19. **Inventing `escapeXml` in `markers.ts`.** Rejected: `escapeXmlAttr` already exists at `src/utils/xml.ts`.
20. **Porting `collapseIdenticalRuns`/`collapseDigitTemplates`.** Rejected: they live in `toolResultSummarizer.ts:475/500`; export and import.

---

## 17. Estimated LoC

After review-driven simplifications (rev 2 cuts ~60% from rev 1):

| Module | Production LoC | Test LoC | Notes |
|---|---|---|---|
| `pipeline.ts` | ~200 | included in harness | Port of `validation/pipeline.ts`; reuses `collapseIdenticalRuns`/`collapseDigitTemplates` from summarizer (saves ~80 LoC) |
| `registry.ts` | ~70 | ~80 | Linear scan + canonicalization |
| `markers.ts` | ~40 | ~80 | Reuses `escapeXmlAttr` |
| `userFilters.ts` | ~140 | ~150 | Zod schema + ReDoS guards + safe-regex denylist (vendored ~80 LoC) |
| `index.ts` (orchestrator + types) | ~120 | ~100 | `planFilter`, `applyFilterToStdout`, type exports, inline `safeApply` |
| `filters/index.ts` | ~20 | n/a | Aggregator |
| `filters/*.ts` (10 family files) | ~60 each = ~600 | n/a | Specs |
| `bashFilter.test.ts` (harness) | n/a | ~500 | Port of `validate.ts` |
| `BashTool.tsx` patches | ~20 | included in BashTool.test | Two ~10-line insertions; one-line `result.stdout = applyFilterToStdout(...)` |
| `toolResultSummarizer.ts` patch | ~2 | included in summarizer.test | `isAlreadyCompacted` extension |
| `config.ts` patch | ~3 | n/a | `GLOBAL_CONFIG_KEYS` registration |
| `scripts/regex-redos-scan.test.ts` (build-time scan) | ~80 | n/a | One file |
| **Total** | **~1295** | **~910** | **~2200 LoC overall** |

The earlier rev 1 estimate (~4675) over-counted by ~50% via duplicated tests, invented helpers, and unnecessary file boundaries.

---

## 18. Implementation sequencing

7 PRs, each shippable behind `bashOutputFilterEnabled: false` until Phase 7.

**Phase 0 — Plumbing (1 PR, ~10 LoC).**
- Extend `isAlreadyCompacted` in `toolResultSummarizer.ts:242` (+2 lines).
- Export `collapseIdenticalRuns` and `collapseDigitTemplates` from `toolResultSummarizer.ts` (or move to `src/utils/textCompaction.ts`; whichever is cleaner during impl).
- Register `bashOutputFilterEnabled`, `bashOutputFilterRewriteEnabled`, `bashOutputFilterUserEnabled` in `GLOBAL_CONFIG_KEYS` at `config.ts:705`.
- No behavior change yet.

**Phase 1 — Skeleton + harness port (1 PR, ~700 LoC).**
- Create `src/outputFilter/Bash/` with `pipeline.ts`, `registry.ts`, `markers.ts`, `userFilters.ts`, `index.ts`.
- Copy fixtures from `docs/discovery/bash-output-filter/validation/samples/` to `__fixtures__/samples/`.
- Port `validation/validate.ts` to `bashFilter.test.ts`.
- Add `scripts/regex-redos-scan.test.ts`.
- Module is dead code (not yet wired to BashTool). Tests pass against the empty registry.
- Coverage gate: 80%.

**Phase 2 — Built-in filters batch 1 (1 PR, ~400 LoC).**
- 5 family files for the 10 highest-ROI filters: `pkg.ts` (bundle install), `tests.ts` (pytest, rspec, go-test), `system.ts` (ps, top), `linters.ts` (rubocop, ruff sans rewrite), `ls.ts`, `grep-rg.ts`, `cargo.ts` (build/check/test/clippy).
- Each lands with harness-asserted ROI ≥ predicted-5pp.

**Phase 3 — BashTool integration (pipeline only, no rewrite) (1 PR, ~30 LoC).**
- Insert `applyFilterToStdout(result.stdout, result.isError, plan)` after stdout capture in `BashTool.call()`.
- Wire env vars (`CLAUDIN_DISABLE_BASH_OUTPUT_FILTER`, `CLAUDIN_BASH_FILTER_DEBUG`).
- Default config: `bashOutputFilterEnabled: false`.
- Smoke test by setting true locally and running 5 commands. Verify: `<bash-output-filtered>` markers appear, no marker when disabled, error commands carry the filter marker through `ShellError`.

**Phase 4 — Rewrite layer (1 PR, ~150 LoC).**
- Add `rewriteCommand` field handling in `planFilter`.
- BashTool hook: capture plan before `runShellCommand`, mutate `input.command` if rewrite fires.
- 6 rewrite filters: `git-log` (force `--oneline`), `git-status` (force `--porcelain`), `ruff` (force `--output-format=json` — note: this requires JSON parsing in the pipeline, which we **don't** want in v1 — drop ruff rewrite; document as v2), `gh` (force `--json`).
- Final v1 rewrite list: **git-log, git-status, gh-pr-list, gh-issue-list, gh-run-list**. The JSON-parsing rewrites (ruff, kubectl, cargo build) move to v2 native parsers.
- `<bash-output-rewritten>` marker.
- `CLAUDIN_DISABLE_REWRITE` env var.
- Compound-command skip test.

**Phase 5 — Built-in filters batch 2 (1 PR, ~250 LoC).**
- `git.ts` family (status, log, blame, pull, add-commit-push), `containers.ts` (docker-ps, docker-images, docker-logs), `network.ts` (curl, wget, dig).
- Plus journalctl in `system.ts`.

**Phase 6 — User filters (1 PR, ~290 LoC).**
- `userFilters.ts` + zod schema + ReDoS guards.
- Cache loader at startup; rebuild on `getGlobalConfig()` invalidation.
- Tests for malformed JSON, denylist, length cap, valid spec.

**Phase 7 — Default-on (1 PR, ~3 LoC).**
- Flip `bashOutputFilterEnabled` default to `true` in `getGlobalConfig` defaults.
- Run a real-world session for one week; review `claudin_bash_filter_applied` event metrics.
- Update `BashTool.test.ts` and `processToolResultBlock` test surface (in `toolResultStorage.test.ts` if it exists, else new test) to cover filter+summarizer interaction.

**Total:** 7 PRs. Phase 0 is throwaway plumbing; the meat is Phases 1–6. Phase 7 is the flip.

---

## 19. Deferred to v2

Each has a stable path forward without rearchitecture.

| Feature | Why deferred | v2 hook |
|---|---|---|
| Project-local filters (`.claudin/filters.json`) with trust dialog | Trust UX non-trivial (sha256 storage, edit invalidation). | `userFilters.ts` separates load from merge; adding a third source is one extra `load()` + trust-check. |
| Cycle detection in dedup | ~5% of remaining cases. | New stage between `dedupGlobal` and `matchOutput` in `pipeline.ts`. |
| Native parsers (`ls -la` → tree, `kubectl get -o json` → compact rows, `ruff --output-format=json` → text) | ~200 LoC per parser; declarative gets 80%+ already. | `FilterSpec` adds optional `nativeFormatter?: (raw: string) => string`. |
| JSON rewrite + reformat for ruff/cargo/kubectl | Requires parser + reformat code. | `rewriteCommand` (already there) + `nativeFormatter` (v2). |
| `/filters` slash command | Not blocking; debug env var covers v1 needs. | New file in `src/commands/filters/`; mirror `src/commands/provider/`. |
| `disabledBuiltins: string[]` in config | v1 user-filter override is a workaround. | Add field, registry checks at lookup time. |
| Streaming pipeline (filter chunks before whole output captured) | Significant complexity; v1 outputs bounded by `EndTruncatingAccumulator`. | Pipeline interface to `Iterable<string>`. |
| Compound-command rewrite of leading verb (`cd foo && git log`) | Low-value, high-complexity. | Detect, parse, rewrite the matching segment, recompose. |
| `re2-wasm` for ReDoS-proof regex | 1 MB+ WASM. v1 defenses sufficient. | Drop-in replacement in `userFilters.ts`. |
| Verb-hash registry optimization | Linear scan over 20 filters is fast enough. | Add `verb: string` field, build `Map<string, FilterSpec[]>` at module init. |
| Per-filter ROI dashboard / `/usage filters` | Telemetry events emit in v1; UI later. | Existing analytics infra. |
| **Tier 1.5 commands** (mvn, gradle, terraform, kubectl, helm, vitest, jest, playwright, prisma, next build, mypy, npm test wrapper, real npm install, real gh pr list, ruff JSON rewrite, cargo JSON rewrite) | No empirical samples captured during discovery (tools not installed locally OR sample collection blocked). Specs estimated only. | Add filter spec in `filters/<family>.ts` + capture sample fixture + harness assertion. **Promotion process:** open issue with sample, write spec, run harness, merge as point release. No architectural change required. |

---

## 20. Filter author contract

When you write a new filter (built-in or PR):

1. Pick the family. New family = new file in `filters/`. Existing family (e.g. `git`) = add a spec to that file.
2. Capture a real sample. Save to `__fixtures__/samples/<filter-name>.txt`. Add a case to `bashFilter.test.ts` that asserts ROI ≥ your prediction − 5pp.
3. If your spec uses `matchOutput`, you MUST add a `safety` test case that confirms a real error/warning is preserved when present in the output. Failing this rejects the PR.
4. Module-level regex consts only. Naming: `SCREAMING_SNAKE_RE`. Compile once.
5. `rewriteCommand`, if present:
   - Deterministic. No `Date.now`, no random.
   - Returns string (or null/undefined). Validation enforces non-empty + verb prefix.
   - You don't need to handle compound — `hasCompound` skips you.
6. Spec file size: aim for <80 LoC per spec. Larger means you're either doing too much or you need a v2 native parser.
7. Don't import from outside `bashOutputFilter/` except: `escapeXmlAttr` from `src/utils/xml.js`, `collapseIdenticalRuns`/`collapseDigitTemplates` from `src/utils/toolResultSummarizer.js`, `logForDebugging` from `src/utils/debug.js`, `logError` from `src/utils/log.js`, `isEnvTruthy` from `src/utils/envUtils.js`.

---

## 21. Acceptance criteria for v1

- [ ] `bun run build` clean.
- [ ] `bun test src/outputFilter/Bash` — 100% pass (~20 filter cases + safety + rewrite + harness).
- [ ] `bun run verify:privacy` — passes (3 new event names with the suffix proof).
- [ ] `bun run typecheck` — zero errors.
- [ ] `scripts/regex-redos-scan.test.ts` — passes (no built-in filter has a denylisted pattern).
- [ ] Smoke test (Phase 7): `bun run dev` then 5 commands across `git status`, `cargo build`, `pytest`, `ls -la`, `bundle install`. Debug logs (`CLAUDIN_BASH_FILTER_DEBUG=1`) show the right filter chosen for each. Marker injected. Reduction matches the matrix.
- [ ] `git log -5 | wc -l` (compound) — no rewrite (no `<bash-output-rewritten>` marker), output count unchanged.
- [ ] `cargo build` on intentionally broken code (exit 1) — `<bash-output-rewritten>` marker IS shown (rewrite committed pre-execution); pipeline skipped (errors preserved).
- [ ] User filter at `~/.claudin/filters.json` with one custom rule for `make` — loads, applies, takes precedence on the verb `make` only when no built-in matches.
- [ ] Sandbox annotation preserved across all built-in filters (one test per filter that adds `stripLines`).
- [ ] Existing `BashTool.test` snapshots updated only where the marker is intentionally injected (post-Phase-7).
- [ ] `bun run build:verified` clean (privacy verifier on dist).
- [ ] Coverage ≥ 80% on the new module.
- [ ] `processToolResultBlock` test surface (`toolResultStorage.test.ts`) covers the case of filter+summarizer interaction (filtered output >8 KB triggers summarizer's `isAlreadyCompacted` correctly, marker survives).

---

## 22. One-line summary

`src/outputFilter/Bash/` is a pure, fail-open, command-aware compression module: a registry of ~20 `FilterSpec` objects scanned linearly, called from `BashTool.call()` to (a) rewrite `input.command` before `runShellCommand` and (b) apply a declarative pipeline + prepend `<bash-output-rewritten>`/`<bash-output-filtered>` markers directly into `result.stdout` — bounded by env-var kill-switches, length-cap and denylist defenses against ReDoS, and the existing `toolResultSummarizer` (with a 2-line `isAlreadyCompacted` extension) as the threshold-based safety net.
