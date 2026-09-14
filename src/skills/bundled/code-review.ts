import type { ToolUseContext } from 'src/tools/Tool.js'
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { REPORT_FINDINGS_TOOL_NAME } from 'src/tools/ReportFindingsTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from 'src/tools/ToolSearchTool/constants.js'
import {
  EFFORT_LEVELS,
  type EffortLevel,
  convertEffortValueToLevel,
  resolveAppliedEffort,
} from 'src/providers/effort/effort.js'
import { registerBundledSkill } from 'src/skills/bundledSkills.js'
import {
  type ReviewScope,
  formatReviewScope,
  resolveReviewScope,
} from 'src/skills/bundled/codeReviewScope.js'

/**
 * Port of the upstream Claude Code `/code-review` skill (v2.1.173), minus the
 * `ultra` level — ultra routes to Anthropic's cloud multi-agent review, which
 * Claudin doesn't have, so `ultra` falls back to a local `max`-effort review.
 *
 * Levels mirror the effort enum: low → 1 inline diff pass; medium/high →
 * 3 correctness angles plus a cleanup angle; xhigh/max → a fourth correctness
 * angle (wrapper/proxy), recall mode, plus a gap sweep.
 *
 * The angle bodies are upstream's, but the *shape* around them is not, and the
 * three deliberate divergences are the reason this file is worth reading before
 * editing:
 *
 * 1. **The scope is resolved in code** (`codeReviewScope.ts`), not by a fallback
 *    chain the model walks, so every angle reviews the same range.
 * 2. **Verification is batched by file**, not spawned per candidate — upstream's
 *    one-agent-per-candidate fans out to dozens of sub-agents on a wide diff.
 * 3. **Upstream's Angle D (language pitfalls) is folded into Angle A** and its
 *    four cleanup angles into one, because each set shares a corpus and an
 *    output shape; splitting them only multiplied re-reads of the same diff.
 *
 * Two upstream inconsistencies are also fixed here: `xhigh`/`max` now get the
 * recall verdict ladder (upstream gives them the precision one plus an override,
 * so the two highest levels refuted more aggressively than `high` did), and the
 * "pass every candidate through" instruction reaches all multi-agent levels.
 */

export type CodeReviewLevel = EffortLevel

export type ParsedCodeReviewArgs = {
  /** Level explicitly passed as the first non-flag token, if any. */
  explicit: CodeReviewLevel | undefined
  /** Free-text review target (PR number, branch, path, extra instructions). */
  target: string
  comment: boolean
  fix: boolean
  /** Set when the first token looks like a misspelled level. */
  unrecognizedLevel: string | undefined
  /** Set when the user asked for `ultra` (cloud review, not available here). */
  ultraFallback: boolean
}

const LEVEL_ALIASES: Record<string, string> = { med: 'medium' }

// Matches tokens that look like a misspelled level ("highh", "maximum") so we
// can warn instead of silently treating them as the review target.
const LEVEL_LIKE_RE = new RegExp(
  `^(${EFFORT_LEVELS.map(l => l.slice(0, 3)).join('|')})[a-z]*$`,
  'i',
)

function normalizeLevel(token: string): CodeReviewLevel | undefined {
  const lowered = token.trim().toLowerCase()
  const aliased = LEVEL_ALIASES[lowered] ?? lowered
  return (EFFORT_LEVELS as readonly string[]).includes(aliased)
    ? (aliased as CodeReviewLevel)
    : undefined
}

/**
 * Parse `/code-review` arguments: an optional effort level (or `ultra`) as the
 * first token, `--comment`/`--fix` flags anywhere, and any remaining free text
 * as the review target.
 */
export function parseCodeReviewArgs(args: string): ParsedCodeReviewArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const rawFirstToken = tokens[0] ?? ''

  let comment = false
  let fix = false
  const rest: string[] = []
  for (const token of tokens) {
    if (/^--comment$/i.test(token)) comment = true
    else if (/^--fix$/i.test(token)) fix = true
    else rest.push(token)
  }

  if (rawFirstToken.toLowerCase() === 'ultra') {
    return {
      explicit: undefined,
      target: rest.slice(1).join(' '),
      comment,
      fix,
      unrecognizedLevel: undefined,
      ultraFallback: true,
    }
  }

  const first = rest[0] ?? ''
  const explicit = normalizeLevel(first)
  if (explicit !== undefined) {
    return {
      explicit,
      target: rest.slice(1).join(' '),
      comment,
      fix,
      unrecognizedLevel: undefined,
      ultraFallback: false,
    }
  }

  return {
    explicit: undefined,
    target: rest.join(' '),
    comment,
    fix,
    unrecognizedLevel: first && LEVEL_LIKE_RE.test(first) ? first : undefined,
    ultraFallback: false,
  }
}

/**
 * Resolve the review level the same way upstream does: an explicit level (or
 * the `ultra` → `max` fallback) wins, otherwise the session's effort setting
 * drives the level, clamped to what the main-loop model supports; with no
 * signal at all, medium.
 */
export function resolveReviewLevel(
  parsed: Pick<ParsedCodeReviewArgs, 'explicit' | 'ultraFallback'>,
  context?: ToolUseContext,
): CodeReviewLevel {
  const requested: CodeReviewLevel | undefined = parsed.ultraFallback
    ? 'max'
    : parsed.explicit
  const model = context?.options?.mainLoopModel
  const sessionEffort = context?.getAppState?.().effortValue
  const value = model
    ? resolveAppliedEffort(model, requested ?? sessionEffort)
    : (requested ?? sessionEffort)
  if (value === undefined) return 'medium'
  return convertEffortValueToLevel(value)
}

// ─── Scope ───────────────────────────────────────────────────────────────────

/** A `<target>` the user named: only the model can turn it into a diff. */
const targetScopeBlock = (target: string): string => `## Scope

Review target: \`${target}\`. Resolve it to a unified diff before anything else —
\`gh pr diff <n>\` for a PR number, \`git diff <branch>...HEAD\` for a branch,
\`git diff HEAD -- <path>\` for a path — and treat that diff as the review scope.
Every angle below must use that same diff.
`

/** No target and git could not answer: upstream's chain, as a last resort. */
const UNRESOLVED_SCOPE_BLOCK = `## Scope

Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there's no upstream) to get the unified diff under review, plus
\`git diff HEAD\` for uncommitted changes. Treat the union as the review scope,
and use the same range for every angle below.
`

function scopeBlockFor(
  parsed: ParsedCodeReviewArgs,
  scope: ReviewScope | null,
): string {
  if (parsed.target) return targetScopeBlock(parsed.target)
  return scope ? formatReviewScope(scope) : UNRESOLVED_SCOPE_BLOCK
}

// ─── Finder angles ───────────────────────────────────────────────────────────

// Upstream's Angle A and Angle D (language pitfalls) merged: D's list was a
// relabelled subset of A's, and both start by reading the same hunks.
const ANGLE_A = `### Angle A — line-by-line scan + language pitfalls

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Cover the language-agnostic defects and the
pitfalls specific to this diff's language/framework alike: inverted/wrong
condition, off-by-one, null/undefined deref, missing \`await\`, falsy-zero check,
wrong-variable copy-paste, error swallowed in a catch, unescaped regex
metachars, \`==\` coercion, closure-captured loop var, mutable default arg,
late-binding closure, nil-map write, range-var capture, SQL injection,
timezone/DST drift, float equality.
`

const ANGLE_B = `### Angle B — removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.
`

const ANGLE_C = `### Angle C — cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?
`

const ANGLE_D = `### Angle D — wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global — e.g. a caching provider holding a
\`delegate\` field that resolves IDs via \`session.get(...)\` instead of
\`delegate.get(...)\` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.
`

// Upstream's four cleanup angles in one: they read the same diff and emit the
// same shape, so four agents bought four re-reads and no extra lens. The axis
// becomes the finding's `category`.
const ANGLE_Z = `### Angle Z — cleanup pass (reuse, simplification, efficiency, altitude)

The angles above hunt for bugs; this one hunts for cleanup in the changed code.
Cover four axes and tag each candidate with the axis it came from:

- **reuse** — new code that re-implements something the codebase already has.
  Grep shared modules and files adjacent to the change, and name the existing
  helper to call instead.
- **simplification** — unnecessary complexity the diff adds: redundant or
  derivable state, copy-paste with slight variation, deep nesting, dead code
  left behind. Name the simpler form that does the same job.
- **efficiency** — wasted work the diff introduces: redundant computation or
  repeated I/O, independent operations run sequentially, blocking work added to
  startup or a hot path. Also long-lived objects built from closures or captured
  environments — they keep the entire enclosing scope alive for the object's
  lifetime (a memory leak when that scope holds large values); prefer a
  class/struct that copies only the fields it needs. Name the cheaper
  alternative.
- **altitude** — a change implemented at the wrong depth, as a fragile bandaid.
  Special cases layered on shared infrastructure are a sign the fix isn't deep
  enough; prefer generalizing the underlying mechanism over adding special cases.

These use the same \`file\`/\`line\`/\`summary\` shape as the correctness angles; in
\`failure_scenario\`, state the concrete cost (what is duplicated, wasted, or
harder to maintain) instead of a crash. Correctness bugs always outrank cleanup
findings when the output cap forces a cut.
`

const PASS_EVERY_CANDIDATE = `Pass every candidate with a nameable failure scenario through — finders that
silently drop half-believed candidates bypass the verify step and are the
dominant cause of misses.
`

// ─── Verify ──────────────────────────────────────────────────────────────────

const VERDICT_LADDER_PRECISION = `- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.`

const VERDICT_LADDER_RECALL = `**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.`

// One verifier per FILE, not per candidate: upstream spawns an agent per
// surviving candidate, which is ~40 sub-agents on a 7-angle run and makes every
// one of them re-read the same file to judge one line.
const verifySection = (recall: boolean): string => `## Phase 2 — Verify (batched by file)

Dedup candidates that point at the same line and mechanism, keeping the one with
the most concrete failure scenario. Then group the survivors **by file** and run
**one verifier per file** via the ${AGENT_TOOL_NAME} tool: give it that file, its hunks,
and every candidate in it. It returns one verdict per candidate${
  recall ? ', recall-biased' : ''
}:

${recall ? VERDICT_LADDER_RECALL : VERDICT_LADDER_PRECISION}

Keep CONFIRMED and PLAUSIBLE. Drop REFUTED.
`

const SWEEP_SECTION = `## Phase 3 — Sweep for gaps

Run **one more finder** as a fresh reviewer who has the verified list. Re-read
the diff and enclosing functions looking ONLY for defects not already listed.
Do not re-derive or re-confirm anything already there — the job is gaps. Focus
on what the first pass tends to miss: moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.

Surface **up to 8 additional candidates**, each naming a defect not already on
the list. If nothing new, return an empty sweep — do not pad.
`

// The schema describes the fields (and says "most-severe first"), so restating
// them here only created a second source of truth that could drift from
// `findingSchema`. This section carries what the schema can't.
const outputSection = (maxFindings: number): string => `## Output

Report the findings with a **single ${REPORT_FINDINGS_TOOL_NAME} tool call** — do not
also print them as text. ${REPORT_FINDINGS_TOOL_NAME} is a deferred tool: if it is
not already in your tool list, load it first with ${TOOL_SEARCH_TOOL_NAME}
(\`select:${REPORT_FINDINGS_TOOL_NAME}\`). Its schema names the fields; this is what
the schema can't say:

- Rank \`findings\` most-severe first, correctness before cleanup.
- Set \`verdict\` from the verify pass, \`category\` to the angle's axis, and
  \`level\` to the review effort.
- Keep the ${maxFindings} most severe if more survive, and call it with an empty
  \`findings\` array if nothing does.
`

// ─── Level prompts ───────────────────────────────────────────────────────────

type MultiAgentConfig = {
  header: string
  intro: string
  angles: string[]
  candidates: number
  recall: boolean
  sweep: boolean
  maxFindings: number
}

const CORRECTNESS_ANGLES_3 = [ANGLE_A, ANGLE_B, ANGLE_C]
const CORRECTNESS_ANGLES_4 = [...CORRECTNESS_ANGLES_3, ANGLE_D]

const MULTI_AGENT_CONFIGS: Record<
  Exclude<CodeReviewLevel, 'low'>,
  MultiAgentConfig
> = {
  medium: {
    header:
      '`medium effort → 4 angles × 6 candidates → verify by file → ≤8 findings`',
    intro: `You are reviewing for **precision** at medium effort: every finding you surface
should be one a maintainer would act on.`,
    angles: [...CORRECTNESS_ANGLES_3, ANGLE_Z],
    candidates: 6,
    recall: false,
    sweep: false,
    maxFindings: 8,
  },
  high: {
    header:
      '`high effort → 4 angles × 6 candidates → verify by file (recall) → ≤10 findings`',
    intro: `You are reviewing for **recall** at high effort: catch every real bug a careful
reviewer would catch in one sitting. At this level, catching real bugs matters
more than avoiding false positives. Err on the side of surfacing.`,
    angles: [...CORRECTNESS_ANGLES_3, ANGLE_Z],
    candidates: 6,
    recall: true,
    sweep: false,
    maxFindings: 10,
  },
  xhigh: {
    header:
      '`xhigh effort → 5 angles × 8 candidates → verify by file (recall) → sweep → ≤15 findings`',
    intro: `You are reviewing for **recall** at extra-high effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives — a
missed bug ships. Err on the side of surfacing.`,
    angles: [...CORRECTNESS_ANGLES_4, ANGLE_Z],
    candidates: 8,
    recall: true,
    sweep: true,
    maxFindings: 15,
  },
  max: {
    header:
      '`max effort → 5 angles × 8 candidates → verify by file (recall) → sweep → ≤15 findings`',
    intro: `You are reviewing for **recall** at maximum effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives — a
missed bug ships. Err on the side of surfacing.`,
    angles: [...CORRECTNESS_ANGLES_4, ANGLE_Z],
    candidates: 8,
    recall: true,
    sweep: true,
    maxFindings: 15,
  },
}

function multiAgentPrompt(cfg: MultiAgentConfig, scopeBlock: string): string {
  const correctnessCount = cfg.angles.length - 1
  return `${cfg.header}

${cfg.intro}

${scopeBlock}
## Phase 1 — Find candidates (${correctnessCount} correctness angles + 1 cleanup angle, up to ${cfg.candidates} each)

Run **${cfg.angles.length} independent finder angles** via the ${AGENT_TOOL_NAME} tool. Each surfaces
**up to ${cfg.candidates} candidate findings** with \`file\`, \`line\`, a one-line \`summary\`, and a
concrete \`failure_scenario\`. Do NOT let one angle's conclusions suppress
another's — if two angles flag the same line for different reasons, record both.

${cfg.angles.join('\n')}
${PASS_EVERY_CANDIDATE}
${verifySection(cfg.recall)}${cfg.sweep ? `\n${SWEEP_SECTION}` : ''}
${outputSection(cfg.maxFindings)}`
}

const lowPrompt = (scopeBlock: string): string => `\`low effort → 1 diff pass → no verify → ≤4 findings\`

${scopeBlock}
## Turn 1 — read

One tool call: read the diff named in the Scope section above. Skip test/fixture
hunks (\`test/\`, \`spec/\`, \`__tests__/\`, \`*_test.*\`, \`*.test.*\`,
\`fixtures/\`, \`testdata/\`) — test-file changes are not reviewed at this level.
No subagents, no full-file reads.

## Turn 2 — findings

Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong
condition, off-by-one, null/undefined deref where adjacent lines show the value
can be absent, removed guard, falsy-zero check, missing \`await\`,
wrong-variable copy-paste, error swallowed in a catch that should propagate.
Also flag — still from the hunk alone — new code that duplicates an existing
helper visible in the diff context, and dead code the diff leaves behind.

Do **not** flag style, naming, perf, missing tests, or anything outside the
hunk.

Output at most **4 findings**, most-severe first, one line each:
\`path/to/file.ext:123 — what's wrong and the concrete failure\`. If nothing
qualifies, output exactly \`(none)\`.
`

const COMMENT_ADDENDUM = `

## Posting to GitHub (--comment)

The \`--comment\` flag was passed. In addition to producing the findings report
(the ${REPORT_FINDINGS_TOOL_NAME} call at medium+ effort, or the text list at
low effort), if the review target is a GitHub PR, post each finding as an inline
PR comment via \`gh api\` (repos/{owner}/{repo}/pulls/{pr}/comments; one call per
finding; include a suggestion block only when it fully fixes the issue). If
\`gh\` is not available in this session, or the target is not a PR, just produce
the findings report and note that \`--comment\` was ignored.
`

const FIX_ADDENDUM = `

## Applying fixes (--fix)

The \`--fix\` flag was passed. After producing the findings report, apply the
findings to the working tree instead of stopping at the report: fix each one
directly — correctness bugs and reuse/simplification/efficiency cleanups alike.
Skip any finding whose fix would change intended behavior, require changes well
outside the reviewed diff, or that you judge to be a false positive — note the
skip rather than arguing with it. Then report each finding's outcome
(\`fixed\` / \`skipped\` / \`no_change_needed\`): at medium+ effort, re-call
${REPORT_FINDINGS_TOOL_NAME} with the \`outcome\` field set on each finding; at
low effort, note it inline. Finish with a brief summary of what was fixed and
what was skipped.
`

// Non-interactive (`-p`) sessions render no TUI, so the ${REPORT_FINDINGS_TOOL_NAME}
// call is invisible to a text-mode stdout consumer (CI, pipes). Restore the old
// printed-JSON contract in that case ONLY — in the interactive TUI the tool
// render is shown, so we do not ask for a duplicate text dump there. Not needed
// at low effort, whose output is already a printed text list.
const HEADLESS_ADDENDUM = `

## Headless output (non-interactive session)

You are running non-interactively (\`-p\`), where the ${REPORT_FINDINGS_TOOL_NAME}
render is not shown. After the tool call, print the same findings as a JSON array
to stdout — one object per finding with the schema's fields (\`file\`, \`line\`,
\`summary\`, \`failure_scenario\`), ranked most-severe first, \`[]\` if nothing
survived — so text-mode consumers still receive them.
`

export function buildCodeReviewPrompt(
  parsed: ParsedCodeReviewArgs,
  context?: ToolUseContext,
  scope?: ReviewScope | null,
): string {
  const level = resolveReviewLevel(parsed, context)

  let note = ''
  if (parsed.ultraFallback) {
    note = `(ultra (cloud review) isn't available in Claudin — running a local ${level}-effort review${parsed.fix ? ' and applying its findings' : ''}.)\n`
  } else if (parsed.unrecognizedLevel !== undefined) {
    note = `(Ignoring unrecognized effort "${parsed.unrecognizedLevel}"; valid: ${EFFORT_LEVELS.join(', ')}. Using ${level}.)\n`
  }

  const scopeBlock = scopeBlockFor(parsed, scope ?? null)
  const body =
    level === 'low'
      ? lowPrompt(scopeBlock)
      : multiAgentPrompt(MULTI_AGENT_CONFIGS[level], scopeBlock)

  // Low effort already prints a text list, so it needs no headless fallback.
  const headless =
    level !== 'low' && getIsNonInteractiveSession() ? HEADLESS_ADDENDUM : ''

  return `${note}${body}${parsed.comment ? COMMENT_ADDENDUM : ''}${parsed.fix ? FIX_ADDENDUM : ''}${headless}`
}

export function registerCodeReviewSkill(): void {
  registerBundledSkill({
    name: 'code-review',
    description:
      'Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups at the given effort level (low/medium: fewer, high-confidence findings; high→max: broader coverage, may include uncertain findings). Pass --comment to post findings as inline PR comments, or --fix to apply the findings to the working tree after the review.',
    whenToUse:
      'When the user wants changed/recent code reviewed for correctness bugs and reuse/simplification/efficiency cleanups.',
    argumentHint: `[${EFFORT_LEVELS.join('|')}] [--fix] [--comment] [<target>]`,
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: [
      AGENT_TOOL_NAME,
      // ReportFindings is deferred; ToolSearch loads it on demand.
      TOOL_SEARCH_TOOL_NAME,
      REPORT_FINDINGS_TOOL_NAME,
      'Read',
      'Grep',
      'Glob',
      'Bash(git diff:*)',
      'Bash(git status:*)',
      'Bash(git log:*)',
      'Bash(gh pr view:*)',
      'Bash(gh pr diff:*)',
    ],
    async getPromptForCommand(args, context) {
      const parsed = parseCodeReviewArgs(args)
      // A named target is the model's to resolve; only the default "review what
      // changed here" path can be pinned to one range up front.
      const scope = parsed.target ? null : await resolveReviewScope()
      return [
        { type: 'text', text: buildCodeReviewPrompt(parsed, context, scope) },
      ]
    },
  })
}
