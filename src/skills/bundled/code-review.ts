import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

export type CodeReviewEffort = 'low' | 'medium' | 'high'

export type ParsedCodeReviewArgs = {
  effort: CodeReviewEffort
  comment: boolean
  /** Set when the user passed a single token that is not a valid effort. */
  invalidEffort?: string
  /** Free-text additional focus for the review. */
  focus: string
}

const EFFORT_TOKEN_RE = /^(low|medium|high)$/i
const COMMENT_FLAG_RE = /^--comment$/i

const AGENTS_BY_EFFORT: Record<CodeReviewEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
}

/**
 * Parse `/code-review` arguments: an optional effort level, an optional
 * `--comment` flag, and any remaining free-text focus.
 *
 * Effort defaults to `high`. A single non-flag token that is not a valid
 * effort is treated as a typo'd level (recorded in `invalidEffort`) rather
 * than focus text; multiple non-flag tokens are treated as focus.
 */
export function parseCodeReviewArgs(args: string): ParsedCodeReviewArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean)

  let comment = false
  const rest: string[] = []
  for (const token of tokens) {
    if (COMMENT_FLAG_RE.test(token)) comment = true
    else rest.push(token)
  }

  let effort: CodeReviewEffort = 'high'
  let invalidEffort: string | undefined
  let focusTokens = rest

  const firstToken = rest[0]
  if (firstToken !== undefined && EFFORT_TOKEN_RE.test(firstToken)) {
    effort = firstToken.toLowerCase() as CodeReviewEffort
    focusTokens = rest.slice(1)
  } else if (firstToken !== undefined && rest.length === 1) {
    invalidEffort = firstToken
    focusTokens = []
  }

  return { effort, comment, invalidEffort, focus: focusTokens.join(' ') }
}

function buildPrompt(parsed: ParsedCodeReviewArgs): string {
  const { effort, comment, invalidEffort, focus } = parsed
  const agentCount = AGENTS_BY_EFFORT[effort]
  const isHigh = effort === 'high'

  const invalidEffortNote = invalidEffort
    ? `\n> Note: \`${invalidEffort}\` is not a valid effort level — defaulting to \`high\`. Valid levels are \`low\`, \`medium\`, \`high\`. Tell the user this once.\n`
    : ''

  const agentInstruction =
    agentCount === 1
      ? `Use the ${AGENT_TOOL_NAME} tool to launch **one** review agent. Pass it the full diff.`
      : `Use the ${AGENT_TOOL_NAME} tool to launch **${agentCount}** review agents concurrently in a single message. Pass each agent the full diff. Split the changed files roughly evenly between agents so each owns a distinct slice, but every agent sees the whole diff for context.`

  const depthInstruction = isHigh
    ? `\nThis is a **high-effort** review. ultrathink — reason deeply about each change before reporting. Trace control flow and data flow by hand, consider adversarial and boundary inputs, and verify your suspicion is a real bug (not a false positive) before including it.\n`
    : ''

  const reportSection = comment
    ? `## Phase 3: Report and Post to the PR

The user passed \`--comment\`, so findings should be posted as inline comments on the branch's open GitHub pull request. **Never post without explicit user confirmation** — follow these steps in order:

1. Run \`gh pr view --json number,headRefName,url\` to find the open PR for the current branch.
2. If there is **no open PR** (or \`gh\` is unavailable), fall back: print the full markdown report in the chat and tell the user that \`--comment\` needs an open PR to post inline comments. Stop here.
3. Review **the PR's own diff** via \`gh pr diff\` (not a local \`git diff\` — this avoids mismatches if the local branch has diverged from the remote).
4. Present the verdict and all findings in the chat first, as a markdown report.
5. Use the ${ASK_USER_QUESTION_TOOL_NAME} tool to let the user decide what to do next: post the inline comments to the PR, dig deeper into a finding, or discard. Answer any follow-up questions the user has before they decide.
6. Only if the user confirms posting, submit **one** review with all inline comments in a single request:
   \`gh api repos/{owner}/{repo}/pulls/{number}/reviews -f event=COMMENT -F 'comments[][path]=...' -F 'comments[][line]=...' -F 'comments[][body]=...'\`
   Each finding becomes one inline comment anchored at its file path and line.
7. Confirm what was posted and link the PR.`
    : `## Phase 3: Report

Wait for all review agents to finish. Aggregate their findings into a single markdown report. For each finding include:

- File and line (\`path:line\`)
- Severity (high / medium / low)
- A short description of the bug
- Why it is a bug — the concrete failure case or input that triggers it
- A suggested fix

Do **not** modify the code — this skill only reports. If a finding is a false positive or too speculative, drop it rather than padding the report. If no real bugs were found, say so plainly.`

  const focusSection = focus ? `\n\n## Additional Focus\n\n${focus}\n` : ''

  return `# Code Review: Report Correctness Bugs

Review the changed code for **correctness bugs** and report them. Effort level: **${effort}**.
${invalidEffortNote}${depthInstruction}
Focus exclusively on bugs that make the code behave incorrectly:

- Incorrect logic, inverted conditions, off-by-one errors
- Unhandled edge cases — empty inputs, boundaries, null/undefined
- Missing \`await\` on promises, unhandled rejections
- Regressions in existing behavior the change touches
- Broken or swallowed error handling
- Concrete race conditions (not theoretical ones)

Do **not** report style, naming, formatting, refactor opportunities, or general cleanup — only correctness bugs.

## Phase 1: Identify Changes

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Launch Review Agent${agentCount === 1 ? '' : 's'}

${agentInstruction} Instruct each agent to read the surrounding code as needed to confirm whether a suspected bug is real, and to report only correctness bugs with a concrete failure case.

${reportSection}${focusSection}`
}

export function registerCodeReviewSkill(): void {
  registerBundledSkill({
    name: 'code-review',
    description:
      'Report correctness bugs in changed code at a chosen effort level. Pass --comment to post findings as inline GitHub PR comments.',
    whenToUse:
      'When the user wants changed/recent code reviewed for correctness bugs (logic errors, edge cases, regressions).',
    argumentHint: '[low|medium|high] [--comment]',
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash(git diff:*)',
      'Bash(git status:*)',
      'Bash(git log:*)',
      'Bash(gh pr view:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh api:*)',
    ],
    async getPromptForCommand(args) {
      const parsed = parseCodeReviewArgs(args)
      return [{ type: 'text', text: buildPrompt(parsed) }]
    },
  })
}
