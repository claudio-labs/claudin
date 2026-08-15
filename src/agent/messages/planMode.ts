import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'
import { areExplorePlanAgentsEnabled } from 'src/tools/AgentTool/builtInAgents.js'
import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import type { UserMessage } from 'src/types/message.js'
import { getCurrentProjectConfig } from 'src/platform/config/config.js'
import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import {
  getPewterLedgerVariant,
  getPlanModeV2AgentCount,
  getPlanModeV2ExploreAgentCount,
  isPlanModeInterviewPhaseEnabled,
} from 'src/agent/plans/planModeV2.js'
import { createUserMessage } from 'src/agent/messages/factories.js'
import { wrapMessagesInSystemReminder } from 'src/agent/messages/text.js'

export function getPlanModeInstructions(attachment: {
  reminderType: 'full' | 'sparse'
  isSubAgent?: boolean
  planFilePath: string
  planExists: boolean
}): UserMessage[] {
  if (attachment.isSubAgent) {
    return getPlanModeV2SubAgentInstructions(attachment)
  }
  if (attachment.reminderType === 'sparse') {
    return getPlanModeV2SparseInstructions(attachment)
  }
  return getPlanModeV2Instructions(attachment)
}

// --
// Plan file structure experiment arms.
// Each arm returns the full Phase 4 section so the surrounding template
// stays a flat string interpolation with no conditionals inline.

export const PLAN_PHASE4_CONTROL = `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Begin with a **Context** section: explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome
- Include a **Tasks** section that breaks the work into discrete, ordered steps, each small enough to verify on its own. On approval these steps are seeded into the live task list that tracks execution, so write each in this exact format — a top-level checklist item as the task's short imperative subject, with the files it touches as indented sub-bullets:
  \`\`\`
  ## Tasks
  - [ ] <short imperative subject>
    - files: path/one.ts, path/two.ts
  - [ ] <next subject>
  \`\`\`
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)`

const PLAN_PHASE4_TRIM = `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- One-line **Context**: what is being changed and why
- Include only your recommended approach, not all alternatives
- List the paths of files to be modified
- Reference existing functions and utilities to reuse, with their file paths
- End with **Verification**: the single command to run to confirm the change works (no numbered test procedures)`

const PLAN_PHASE4_CUT = `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Do NOT write a Context or Background section. The user just told you what they want.
- List the paths of files to be modified and what changes in each (one line per file)
- Reference existing functions and utilities to reuse, with their file paths
- End with **Verification**: the single command that confirms the change works
- Most good plans are under 40 lines. Prose is a sign you are padding.`

const PLAN_PHASE4_CAP = `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Do NOT write a Context, Background, or Overview section. The user just told you what they want.
- Do NOT restate the user's request. Do NOT write prose paragraphs.
- List the paths of files to be modified and what changes in each (one bullet per file)
- Reference existing functions to reuse, with file:line
- End with the single verification command
- **Hard limit: 40 lines.** If the plan is longer, delete prose — not file paths.`

export function getPlanPhase4Section(): string {
  const variant = getPewterLedgerVariant()
  switch (variant) {
    case 'trim':
      return PLAN_PHASE4_TRIM
    case 'cut':
      return PLAN_PHASE4_CUT
    case 'cap':
      return PLAN_PHASE4_CAP
    case null:
      return PLAN_PHASE4_CONTROL
    default:
      variant satisfies never
      return PLAN_PHASE4_CONTROL
  }
}

export function getPlanModeV2Instructions(attachment: {
  isSubAgent?: boolean
  planFilePath?: string
  planExists?: boolean
}): UserMessage[] {
  if (attachment.isSubAgent) {
    return []
  }

  // When interview phase is enabled, use the iterative workflow.
  if (isPlanModeInterviewPhaseEnabled()) {
    return getPlanModeInterviewInstructions(attachment)
  }

  const agentCount = getPlanModeV2AgentCount()
  const exploreAgentCount = getPlanModeV2ExploreAgentCount()
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath}. You can read it and make incremental edits using the ${FileEditTool.name} tool.`
    : `No plan file exists yet. You should create your plan at ${attachment.planFilePath} using the ${FileWriteTool.name} tool.`

  const content = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the ${EXPLORE_AGENT.agentType} subagent type.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.

2. **Launch up to ${exploreAgentCount} ${EXPLORE_AGENT.agentType} agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - ${exploreAgentCount} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns

### Phase 2: Design
Goal: Design an implementation approach.

Launch ${PLAN_AGENT.agentType} agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to ${agentCount} agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)
${
  agentCount > 1
    ? `- **Multiple agents**: Use up to ${agentCount} agents for complex tasks that benefit from different perspectives

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture
`
    : ''
}
In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Stress-test the plan(s) from Phase 2 — look for gaps, simpler alternatives, and existing utilities you'd be duplicating.
1. Read the critical files identified by agents to deepen your understanding
2. Challenge the plan: missing edge cases, error handling, code that already does what you're proposing to write — surface these with file:line evidence
3. Decision sweep: list decisions the user hasn't addressed — defaults, naming, scope boundaries, error behavior, tradeoffs. Surface them with your recommended default; don't pre-decide silently. Skip trivia.
4. Use ${ASK_USER_QUESTION_TOOL_NAME} to resolve those decisions and any other gaps

${getPlanPhase4Section()}

### Phase 5: Call ${ExitPlanModeV2Tool.name}
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ${ExitPlanModeV2Tool.name} to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the ${ASK_USER_QUESTION_TOOL_NAME} tool OR calling ${ExitPlanModeV2Tool.name}. Do not stop unless it's for these 2 reasons

**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${ExitPlanModeV2Tool.name} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${ExitPlanModeV2Tool.name}.

NOTE: Don't wait until you "hit" an ambiguity to ask. Actively sweep for decisions the user hasn't addressed (defaults, naming, scope, error behavior, tradeoffs) and surface them with ${ASK_USER_QUESTION_TOOL_NAME}, each paired with your recommended default so the user can approve with one click. Filter by criticality — only ask what actually changes the plan. The goal is to present a well-researched plan with no hidden assumptions, not to interrogate the user.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

export function getReadOnlyToolNames(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools from the registry, so point at find/grep via
  // Bash instead.
  const tools = hasEmbeddedSearchTools()
    ? [FILE_READ_TOOL_NAME, '`find`', '`grep`']
    : [FILE_READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]
  const { allowedTools } = getCurrentProjectConfig()
  // allowedTools is a tool-name allowlist. find/grep are shell commands, not
  // tool names, so the filter is only meaningful for the non-embedded branch.
  const filtered =
    allowedTools && allowedTools.length > 0 && !hasEmbeddedSearchTools()
      ? tools.filter(t => allowedTools.includes(t))
      : tools
  return filtered.join(', ')
}

/**
 * Iterative interview-based plan mode workflow.
 * Instead of forcing Explore/Plan agents, this workflow has the model:
 * 1. Read files and ask questions iteratively
 * 2. Build up the spec/plan file incrementally as understanding grows
 * 3. Use AskUserQuestion throughout to clarify and gather input
 */
export function getPlanModeInterviewInstructions(attachment: {
  planFilePath?: string
  planExists?: boolean
}): UserMessage[] {
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath}. You can read it and make incremental edits using the ${FileEditTool.name} tool.`
    : `No plan file exists yet. You should create your plan at ${attachment.planFilePath} using the ${FileWriteTool.name} tool.`

  const content = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planFileInfo}

## Collaborative Planning Workflow

You are co-designing the plan WITH the user — a two-way discovery, not an interview. Both sides bring suggestions; you converge only when NEITHER of you has open doubts. Explore the code to build context, bring up the points you see, voice your OWN uncertainties (don't just extract the user's), and write everything into the plan file as you go. The plan file (above) is the ONLY file you may edit — it starts as a rough skeleton and gradually becomes the final plan.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use ${getReadOnlyToolNames()} to read code. Look for existing functions, utilities, and patterns to reuse.${areExplorePlanAgentsEnabled() ? ` You can use the ${EXPLORE_AGENT.agentType} agent type to parallelize complex searches without filling your context, though for straightforward queries direct tools are simpler.` : ''}
2. **Update the plan file** — After each discovery, immediately capture what you learned; don't wait until the end. Log settled choices under **Agreed Decisions** and anything unresolved (from EITHER side) under **Open Questions**. Keep the work continuously organized under **Tasks** — an ordered checklist you co-build WITH the user: surface your proposed breakdown as you go, let the user split/merge/reorder steps, and re-organize it as understanding changes. On approval these items are seeded verbatim into the live task list that tracks execution, so make each step small and independently verifiable, and write them in the exact format below.
3. **Surface the points you see** — As you go, BRING THINGS UP rather than quizzing the user. Narrate what you notice: relevant code, an alternative, a dependency or ordering constraint ("if we do it this way, we'd need to handle X first"), a gotcha — each with file:line. State them as observations a senior engineer would think out loud, not as a barrage of questions.
4. **Voice your own uncertainty** — If YOU are unsure or are assuming something the user didn't state, add it to **Open Questions** and resolve it (read the code, or surface it). Your doubts count as much as the user's.
5. **Ask ONLY for genuine decisions** — Reserve ${ASK_USER_QUESTION_TOOL_NAME} for choices only the user can make and that you can't settle from the code (see "Surfacing Decisions Proactively" below). Default to surfacing findings and implications as statements, not questions. Then go back to step 1.

When the user questions or pushes back on something you proposed: defend it with file:line evidence OR revise and update the ledger — never agree by reflex just to please (no sycophancy).

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then write a skeleton plan (headers and rough notes) and seed **Open Questions** with YOUR OWN initial assumptions. Lead with the salient points you already see rather than an opening questionnaire; ask the user only where a real decision is needed. Don't explore exhaustively before engaging the user.

If you spot a clearer alternative, a missing edge case, or an existing utility the user's approach would duplicate, raise it with file:line evidence — otherwise proceed. Disagreement with citations is more valuable than agreement, but don't manufacture it on tasks where the proposed approach is already sound.

### Surfacing Decisions Proactively

Don't wait to "hit" an ambiguity — actively look for decisions the user hasn't addressed. Before each round of questions, do a quick sweep:

- **Defaults**: any value the user didn't specify (timeouts, retry counts, log levels, fallback behavior) — what should it be?
- **Naming**: new files, functions, flags, config keys — propose names, confirm the important ones.
- **Scope boundaries**: what's explicitly in vs. out? Any adjacent code the change could touch but maybe shouldn't?
- **Error behavior**: on failure, does it fall back, throw, log, or block?
- **Tradeoffs**: any choice where the "right" answer depends on user priorities (simplicity vs. flexibility, speed vs. safety, etc.)?

Surface these as concrete ${ASK_USER_QUESTION_TOOL_NAME} options with your recommended default pre-selected — don't pre-decide silently, but also don't make the user redraft answers from scratch. Filter by criticality: only surface decisions that actually change the plan. Skip trivia (formatting, name of a local loop counter, etc.).

### Asking Good Questions

- Never ask what you could find out by reading the code
- Batch related questions together (use multi-question ${ASK_USER_QUESTION_TOOL_NAME} calls)
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge case priorities
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none

### Plan File Structure
Your plan file should be divided into clear sections using markdown headers, based on the request. Fill out these sections as you go.
- Begin with a **Context** section: explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome
- **Agreed Decisions**: the choices both of you have settled, each a one-liner
- **Open Questions**: unresolved items from either side — MUST be empty before you exit
- Include a **Tasks** section: an ordered checklist, kept organized as you go; keep each step small enough to verify on its own. On approval these items are seeded into the live task list that tracks execution, so write each one in this exact format — a top-level checklist item as the task's short imperative subject, with the files it touches (and any one-line note) as indented sub-bullets:
  \`\`\`
  ## Tasks
  - [ ] <short imperative subject>
    - files: path/one.ts, path/two.ts
    - <optional one-line note>
  - [ ] <next subject>
  \`\`\`
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### When to Converge

Converge only when (a) **Open Questions** is empty — neither you nor the user has remaining doubts — AND (b) you've surfaced the salient points you see and the user has nothing more to raise. Don't rush the exit. The plan must cover what to change, which files to modify, what existing code to reuse (with file paths), and how to verify the changes. If the user explicitly tells you to proceed while items are still open, move those items into **Agreed Decisions** as accepted assumptions (recorded, not dropped), then call ${ExitPlanModeV2Tool.name}.

### Ending Your Turn

Your turn should only end by either:
- Using ${ASK_USER_QUESTION_TOOL_NAME} to gather more information
- Calling ${ExitPlanModeV2Tool.name} when **Open Questions** is empty and the plan is ready for approval

**Important:** Use ${ExitPlanModeV2Tool.name} to request plan approval. Do NOT ask about plan approval via text or AskUserQuestion.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

export function getPlanModeV2SparseInstructions(attachment: {
  planFilePath: string
}): UserMessage[] {
  const workflowDescription = isPlanModeInterviewPhaseEnabled()
    ? 'Co-design with the user: explore, bring up the points you see (don\'t just quiz), track Agreed Decisions + Open Questions in the plan, and keep Open Questions empty before you exit.'
    : 'Follow 5-phase workflow.'

  const content = `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${attachment.planFilePath}). ${workflowDescription} End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${ExitPlanModeV2Tool.name} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

export function getPlanModeV2SubAgentInstructions(attachment: {
  planFilePath: string
  planExists: boolean
}): UserMessage[] {
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath}. You can read it and make incremental edits using the ${FileEditTool.name} tool if you need to.`
    : `No plan file exists yet. You should create your plan at ${attachment.planFilePath} using the ${FileWriteTool.name} tool if you need to.`

  const content = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received (for example, to make edits). Instead, you should:

## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.
Answer the user's query comprehensively, using the ${ASK_USER_QUESTION_TOOL_NAME} tool to proactively surface decisions the user hasn't addressed (defaults, naming, scope, error behavior, tradeoffs) — don't silently pre-decide them. Pair each question with your recommended default so the user can approve with one click. Filter by criticality: only ask what actually changes the plan.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}
