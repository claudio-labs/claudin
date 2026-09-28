/**
 * `/batch`: plans a large mechanical change in plan mode, then fans it out to
 * parallel background agents, each in its own git worktree and each opening
 * a PR, and tracks them to the end.
 *
 * It needs an instruction and a git repository, checked in that order when
 * it is invoked. The repository check is a narrow dependency, read at call
 * time and never cached here.
 */
import { type BatchOutcome, decideBatchOutcome } from 'src/skills/bundled/shared/batchOutcome.js'
import { registerBundledSkill } from 'src/skills/bundledSkills.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from 'src/tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { SKILL_TOOL_NAME } from 'src/tools/SkillTool/constants.js'
import { getIsGit } from 'src/vcs/git/git.js'

// -- Prose

const DESCRIPTION =
  'Research and plan a large change, then execute it in parallel across 5–30 background agents, each in an isolated git worktree and each opening its own PR.'

const WHEN_TO_USE =
  'For sweeping mechanical changes across many files (migrations, refactors, bulk renames) that split into independent units which can be done in parallel.'

const USAGE = `The user ran \`/batch\` without saying what to change. Tell them it takes one instruction, the change to make across the codebase, show these examples, and stop:

/batch migrate the test suite from jest to vitest
/batch rename getUserById to findUserById everywhere
/batch replace every console.log with the project's logger`

const NEEDS_REPOSITORY = `\`/batch\` cannot run here: the working directory is not inside a git repository. Each of its agents works in its own git worktree and opens a pull request, so it needs one. Tell the user to run it from inside a repository, or to create one first with \`git init\`, and stop.`

const WORKER_INSTRUCTIONS = `\`\`\`
When your change is done:
1. Review it with the \`${SKILL_TOOL_NAME}\` tool (\`skill: "code-review"\`, \`args: "medium"\`) and fix every bug it reports.
2. Find the project's tests, run them, and fix any failure.
3. Run the end-to-end check from your instructions, unless the plan skips it for your unit.
4. Commit to a new branch, push it, and open a pull request with \`gh pr create\`. If \`gh\` is not installed or the push fails, say so.
5. End your reply with exactly one line: \`PR: <url>\`, or \`PR: none — <reason>\`.
\`\`\``

function orchestrationPrompt(instruction: string): string {
  return `# Batch change

Carry out this change across the repository by splitting it into independent units and running them in parallel, one agent per unit:

${instruction}

## Phase 1: plan, in plan mode

1. Call \`${ENTER_PLAN_MODE_TOOL_NAME}\` now.
2. Research the scope with foreground subagents, since you need their results to plan: the files, patterns and call sites the change touches, and the conventions it has to follow.
3. Split the work into 5–30 units. Each unit must be implementable alone in an isolated git worktree and mergeable on its own, and the units should be roughly equal in size. Scale the count to the change, and prefer slicing by directory or module.
4. Settle an end-to-end check the workers can run unattended to show their unit works: browser automation for UI changes, driving the CLI (for example in \`tmux\`) for CLI changes, a dev server plus \`curl\` for APIs, or an existing e2e or integration suite. If you find none, ask the user with \`${ASK_USER_QUESTION_TOOL_NAME}\`, offering two or three concrete options: the workers cannot ask the user themselves.
5. Write the plan: a short summary of the research; the numbered units, each with a title, its files and a one-line description of its change; the end-to-end check, or why it is skipped; and the worker instructions below, exactly as the workers will get them.
6. Present the plan with \`${EXIT_PLAN_MODE_TOOL_NAME}\`.

## Phase 2: launch, after approval

Launch one background agent per unit with the \`${AGENT_TOOL_NAME}\` tool, all in a single message so they run in parallel. Every call sets \`isolation: "worktree"\` and \`run_in_background: true\`, and uses \`subagent_type: "${GENERAL_PURPOSE_AGENT.agentType}"\` unless a more specific agent type fits the unit. Each prompt must stand on its own: the overall goal, the unit as planned, the conventions the research found, the end-to-end check, and the worker instructions verbatim.

## Worker instructions

${WORKER_INSTRUCTIONS}

## Phase 3: track

Show a status table with every unit \`running\`:

| # | Unit | Status | PR |
|---|------|--------|----|
| 1 | <title> | running | |

As each agent's completion arrives, read its \`PR: <url>\` line and redraw the table, marking the unit \`done\` with the link, or \`failed\` with a short note on what went wrong. When every agent has finished, show the final table and one line tallying how many of the units landed as PRs.`
}

function renderPrompt(outcome: BatchOutcome): string {
  switch (outcome.kind) {
    case 'usage':
      return USAGE
    case 'needs-repository':
      return NEEDS_REPOSITORY
    case 'orchestrate':
      return orchestrationPrompt(outcome.instruction)
  }
}

// -- Registration

type BatchDeps = {
  /** Whether the session's working directory is inside a git repository. */
  readonly isInRepository: () => Promise<boolean>
}

const DEFAULT_DEPS: BatchDeps = { isInRepository: getIsGit }

export function registerBatchSkill(deps: BatchDeps = DEFAULT_DEPS): void {
  registerBundledSkill({
    name: 'batch',
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    argumentHint: '<instruction>',
    userInvocable: true,
    disableModelInvocation: true,
    async getPromptForCommand(args) {
      const instruction = args.trim()
      // The repository only matters once there is an instruction to carry out.
      const inRepository = instruction !== '' && (await deps.isInRepository())
      const outcome = decideBatchOutcome(instruction, inRepository)
      return [{ type: 'text', text: renderPrompt(outcome) }]
    },
  })
}
