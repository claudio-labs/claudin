import type { ToolUseContext } from 'src/Tool.js'
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { REPORT_FINDINGS_TOOL_NAME } from 'src/tools/ReportFindingsTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from 'src/tools/ToolSearchTool/constants.js'
import {
  EFFORT_LEVELS,
  type EffortLevel,
  convertEffortValueToLevel,
  resolveAppliedEffort,
} from 'src/utils/effort.js'
import { registerBundledSkill } from 'src/skills/bundledSkills.js'

/**
 * Port of the upstream Claude Code `/code-review` skill (v2.1.173), minus the
 * `ultra` level — ultra routes to Anthropic's cloud multi-agent review, which
 * Claudin doesn't have, so `ultra` falls back to a local `max`-effort review.
 *
 * Levels mirror the effort enum: low → 1 inline diff pass; medium/high →
 * 3 correctness + 4 cleanup finder angles with a 1-vote verify; xhigh/max →
 * 5 correctness angles, recall mode, plus a gap sweep. All prompt bodies are
 * copied verbatim from upstream so findings behave identically.
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

// ─── Prompt fragments (verbatim from upstream) ───────────────────────────────

const PHASE0_GATHER_DIFF = `## Phase 0 — Gather the diff

Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.
`

const ANGLE_A = `### Angle A — line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing \`await\`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.
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

const ANGLE_D = `### Angle D — language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework — for example:
JS falsy-zero, \`==\` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.
`

const ANGLE_E = `### Angle E — wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global — e.g. a caching provider holding a
\`delegate\` field that resolves IDs via \`session.get(...)\` instead of
\`delegate.get(...)\` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.
`

const CORRECTNESS_ANGLES_3 = `${ANGLE_A}
${ANGLE_B}
${ANGLE_C}`

const CORRECTNESS_ANGLES_5 = `${CORRECTNESS_ANGLES_3}
${ANGLE_D}
${ANGLE_E}`

const REUSE_SECTION = `### Reuse

The angles above hunt for bugs; this one and the next two hunt for cleanup in
the changed code. Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.
`

const SIMPLIFICATION_SECTION = `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.
`

const EFFICIENCY_SECTION = `### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments — they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.
`

const ALTITUDE_SECTION = `### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.
`

const CLEANUP_PRECEDENCE = `Cleanup and altitude candidates use the same \`file\`/\`line\`/\`summary\` shape; in
\`failure_scenario\`, state the concrete cost (what is duplicated, wasted, or
harder to maintain) instead of a crash. Correctness bugs always outrank
cleanup and altitude findings when the output cap forces a cut.
`

const VERDICT_LADDER = `- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
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

const VERIFY_PRECISION = `## Phase 2 — Verify (1-vote, 3-state)

Dedup candidates that point at the same line/mechanism, keeping the one with
the most concrete failure scenario. For each remaining candidate, run **one
verifier** via the ${AGENT_TOOL_NAME} tool: give it the diff, the relevant
file(s), and the candidate, and have it return exactly one of:

${VERDICT_LADDER}

Keep candidates where the vote is CONFIRMED or PLAUSIBLE.
`

const VERIFY_RECALL = `## Phase 2 — Verify (1-vote, recall-biased)

Dedup near-duplicates (same defect, same location, same reason → keep one). For
each remaining candidate, run **one verifier** via the ${AGENT_TOOL_NAME} tool:
give it the diff, the relevant file(s), and the candidate; it returns exactly
one of **CONFIRMED / PLAUSIBLE / REFUTED**.

${VERDICT_LADDER_RECALL}

Keep **CONFIRMED and PLAUSIBLE**. Drop REFUTED.
`

const SWEEP_GAP_FOCUS = `moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.`

const SWEEP_SECTION = `## Phase 3 — Sweep for gaps

Run **one more finder** as a fresh reviewer who has the verified list. Re-read
the diff and enclosing functions looking ONLY for defects not already listed.
Do not re-derive or re-confirm anything already there — the job is gaps. Focus
on what the first pass tends to miss: ${SWEEP_GAP_FOCUS}

Surface **up to 8 additional candidates**, each naming a defect not already on
the list. If nothing new, return an empty sweep — do not pad.
`

const outputSection = (maxFindings: number): string => `## Output

Report the findings with a **single ${REPORT_FINDINGS_TOOL_NAME} tool call** — do not
also print them as text. ${REPORT_FINDINGS_TOOL_NAME} is a deferred tool: if it is
not already in your tool list, load it first with ${TOOL_SEARCH_TOOL_NAME}
(\`select:${REPORT_FINDINGS_TOOL_NAME}\`). Each finding is one object:

- \`file\` (required) — repo-relative path.
- \`line\` — 1-indexed line the finding anchors to.
- \`summary\` (required) — one-sentence statement of the bug.
- \`failure_scenario\` (required) — concrete inputs/state → wrong output/crash.
- \`verdict\` — \`CONFIRMED\` or \`PLAUSIBLE\` from the verify pass.
- \`category\` — kebab-case slug (\`correctness\`, \`simplification\`, \`efficiency\`, …).

Pass \`findings\` ranked most-severe first, and set \`level\` to the review effort.
If more than ${maxFindings} survive, keep the ${maxFindings} most severe. If nothing
survives verification, call ${REPORT_FINDINGS_TOOL_NAME} with an empty \`findings\` array.
`

const LOW_PROMPT = `\`low effort → 1 diff pass → no verify → ≤4 findings\`

## Turn 1 — read

One tool call: read the unified diff (\`git diff @{upstream}...HEAD; git diff HEAD\`
to cover both committed and uncommitted changes, or \`git diff main...HEAD\` /
the target passed as an argument). Skip test/fixture
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

const MEDIUM_PROMPT = `\`medium effort → 3+4 angles × 6 candidates → 1-vote verify → ≤8 findings\`

You are reviewing for **precision** at medium effort: every finding you surface
should be one a maintainer would act on.

${PHASE0_GATHER_DIFF}
## Phase 1 — Find candidates (3 correctness angles + 3 cleanup angles + 1 altitude angle, up to 6 each)

Run **7 independent finder angles** via the ${AGENT_TOOL_NAME} tool. Each
surfaces **up to 6 candidate findings** with \`file\`, \`line\`, a one-line
\`summary\`, and a concrete \`failure_scenario\`.

${CORRECTNESS_ANGLES_3}
${REUSE_SECTION}
${SIMPLIFICATION_SECTION}
${EFFICIENCY_SECTION}
${ALTITUDE_SECTION}
${CLEANUP_PRECEDENCE}
Pass every candidate with a nameable failure scenario through — finders that
silently drop half-believed candidates bypass the verify step and are the
dominant cause of misses.

${VERIFY_PRECISION}
${outputSection(8)}`

const HIGH_PROMPT = `\`high effort → 3+4 angles × 6 candidates → 1-vote verify (recall-biased) → ≤10 findings\`

You are reviewing for **recall** at high effort: catch every real bug a careful
reviewer would catch in one sitting. At this level, catching real bugs matters
more than avoiding false positives. Err on the side of surfacing.

${PHASE0_GATHER_DIFF}
## Phase 1 — Find candidates (3 correctness angles + 3 cleanup angles + 1 altitude angle, up to 6 each)

Run **7 independent finder angles** via the ${AGENT_TOOL_NAME} tool. Each
surfaces **up to 6 candidate findings** with \`file\`, \`line\`, a one-line
\`summary\`, and a concrete \`failure_scenario\`.

${CORRECTNESS_ANGLES_3}
${REUSE_SECTION}
${SIMPLIFICATION_SECTION}
${EFFICIENCY_SECTION}
${ALTITUDE_SECTION}
${CLEANUP_PRECEDENCE}
Pass every candidate with a nameable failure scenario through — finders that
silently drop half-believed candidates bypass the verify step and are the
dominant cause of misses.

${VERIFY_RECALL}
${outputSection(10)}`

const recallMaxPrompt = (
  level: 'xhigh' | 'max',
): string => `\`${level} effort → 5+4 angles × 8 candidates → 1-vote verify → sweep → ≤15 findings\`

You are reviewing for **recall** at ${level === 'max' ? 'maximum' : 'extra-high'} effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives — a
missed bug ships. Err on the side of surfacing.

${PHASE0_GATHER_DIFF}
## Phase 1 — Find candidates (5 correctness angles + 3 cleanup angles + 1 altitude angle, up to 8 each)

Run **9 independent finder angles** via the ${AGENT_TOOL_NAME} tool. Each
surfaces **up to 8 candidate findings**. Do NOT let one angle's conclusions
suppress another's — if two angles flag the same line for different reasons,
record both.

${CORRECTNESS_ANGLES_5}
${REUSE_SECTION}
${SIMPLIFICATION_SECTION}
${EFFICIENCY_SECTION}
${ALTITUDE_SECTION}
${CLEANUP_PRECEDENCE}
${VERIFY_PRECISION}
This is recall mode — a single non-REFUTED vote carries the finding. Do NOT
drop on uncertainty.

${SWEEP_SECTION}
${outputSection(15)}`

const LEVEL_PROMPTS: Record<CodeReviewLevel, string> = {
  low: LOW_PROMPT,
  medium: MEDIUM_PROMPT,
  high: HIGH_PROMPT,
  xhigh: recallMaxPrompt('xhigh'),
  max: recallMaxPrompt('max'),
}

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
render is not shown. In addition to the ${REPORT_FINDINGS_TOOL_NAME} call, also
print the findings as a JSON array to stdout so text-mode consumers still
receive them:

\`\`\`json
[
  {
    "file": "path/to/file.ext",
    "line": 123,
    "summary": "one-sentence statement of the bug",
    "failure_scenario": "concrete inputs/state → wrong output/crash"
  }
]
\`\`\`

Ranked most-severe first; \`[]\` if nothing survived.
`

export function buildCodeReviewPrompt(
  parsed: ParsedCodeReviewArgs,
  context?: ToolUseContext,
): string {
  const level = resolveReviewLevel(parsed, context)

  let note = ''
  if (parsed.ultraFallback) {
    note = `(ultra (cloud review) isn't available in Claudin — running a local ${level}-effort review${parsed.fix ? ' and applying its findings' : ''}.)\n`
  } else if (parsed.unrecognizedLevel !== undefined) {
    note = `(Ignoring unrecognized effort "${parsed.unrecognizedLevel}"; valid: ${EFFORT_LEVELS.join(', ')}. Using ${level}.)\n`
  }

  const targetLine = parsed.target
    ? `Review target: \`${parsed.target}\`\n`
    : ''

  // Low effort already prints a text list, so it needs no headless fallback.
  const headless =
    level !== 'low' && getIsNonInteractiveSession() ? HEADLESS_ADDENDUM : ''

  return `${note}${targetLine}${LEVEL_PROMPTS[level]}${parsed.comment ? COMMENT_ADDENDUM : ''}${parsed.fix ? FIX_ADDENDUM : ''}${headless}`
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
      return [{ type: 'text', text: buildCodeReviewPrompt(parsed, context) }]
    },
  })
}
