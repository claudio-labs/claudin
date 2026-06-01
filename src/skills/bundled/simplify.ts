import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * `/simplify` — quality-only cleanup of the changed code.
 *
 * Ported from the upstream built-in skill. Spawns four parallel review agents
 * (reuse, simplification, efficiency, altitude) and applies the fixes. Pure
 * agent-loop behavior, so it works on any provider — no Anthropic infra.
 */
function buildPrompt(args: string): string {
  const focus = args.trim()
  const focusSection = focus
    ? `\n\n## Additional Focus\n\n${focus}\n`
    : ''

  return `# Simplify: Quality Cleanup of Changed Code

You are improving the quality of the changed code, not hunting for bugs. Review
it for reuse, simplification, efficiency, and altitude issues, then fix what you
find. Do not look for correctness bugs — that is what \`/code-review\` is for.

## Phase 0 — Gather the diff

Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.

## Phase 1 — Review (4 cleanup agents in parallel)

Use the ${AGENT_TOOL_NAME} tool to launch **4 independent review agents**, all in
a single message so they run concurrently. Pass each agent the diff and one of
the four angles below. Each returns its findings with \`file\`, \`line\`, a
one-line \`summary\`, and the concrete cost (what is duplicated, wasted, or
harder to maintain).

### Reuse

Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.

### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.

### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Name the cheaper alternative.

### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.

## Phase 2 — Apply the fixes

Wait for all four agents to complete, dedup findings that point at the same
line or mechanism, and fix each remaining one directly. Skip any finding whose
fix would change intended behavior, require changes well outside the reviewed
diff, or that you judge to be a false positive — note the skip rather than
arguing with it. Finish with a brief summary of what was fixed and what was
skipped (or confirm the code was already clean).${focusSection}`
}

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'simplify',
    description:
      'Clean up changed code for reuse, simplification, efficiency, and altitude, then apply the fixes. Quality only — use /code-review for correctness bugs.',
    whenToUse:
      'When the user wants the changed/recent code refactored for clarity and reuse (not bug-hunting).',
    argumentHint: '[focus]',
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Bash(git diff:*)',
      'Bash(git status:*)',
      'Bash(git log:*)',
    ],
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildPrompt(args) }]
    },
  })
}
