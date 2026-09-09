import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import { getSubscriptionType } from 'src/providers/auth/auth.js'
import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'
import { isTeammate } from 'src/agent/coordinator/teammate.js'
import { isInProcessTeammate } from 'src/agent/coordinator/teammateContext.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { isForkSubagentEnabled } from 'src/tools/AgentTool/forkSubagent.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // Both defined: filter allowlist by denylist to match runtime behavior
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // Allowlist only: show the specific tools available
    return tools.join(', ')
  } else if (hasDenylist) {
    // Denylist only: show "All tools except X, Y, Z"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // No restrictions
  return 'All tools'
}

/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description. When true, getPrompt() returns a static
 * description and attachments.ts emits an agent_listing_delta attachment.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 *
 * Override with CLAUDIN_AGENT_LIST_IN_MESSAGES=true/false for testing.
 */
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDIN_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDIN_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', true)
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // Filter agents by allowed types when Agent(x,y) restricts which agents can be spawned
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // Fork subagent feature: when enabled, insert the "Fork or fresh agent"
  // section (fork semantics, the per-call re-read cost, directive-style
  // prompts) and swap in fork-aware examples.
  //
  // The section used to open with "Forks are cheap because they share your
  // prompt cache". That is true of the fork's FIRST call only: every call after
  // re-reads the whole inherited prefix, so a child that makes 27 calls under a
  // 200k parent reads 5.6M tokens where a fresh `Code` agent with the same
  // brief read 0.7M — 4× the child cost at equal answers (fork-vs-fresh-ab.ts,
  // Sonnet 5, N=3, 2026-09-09; the 2026-09 census put the inherited-prefix
  // re-read at 36% of all sub-agent spend). So the default lane is now a fresh
  // agent with a complete brief, and a fork is the exception for a child that
  // needs what is in the conversation.
  const forkEnabled = isForkSubagentEnabled()

  const whenToForkSection = forkEnabled
    ? `

## Fork or fresh agent

Omitting \`subagent_type\` forks you: the child starts with your whole conversation and re-reads all of it on every call it makes. A fresh agent (\`subagent_type: "Code"\` or a named one) starts from your prompt alone. Both keep the intermediate tool output out of your context \u2014 you get back only the report. Measured on the same task at 200k of context, the fork's child cost 4\u00d7 the fresh one and answered no better: the history bought nothing the brief had not already said.

Default to a fresh agent with a complete brief \u2014 implementation with a scoped spec, a lookup, a review, any question you can write out. Fork only when the child needs what is in this conversation and a paragraph cannot carry it: the user's own words, a long back-and-forth, output you already hold and would have to paste.
- **Research**: write the question out for a fresh \`Code\` agent. If it splits into independent questions, launch them in one message. Fork when the question is about this conversation.
- **Implementation**: brief a fresh \`Code\` agent with file paths, line numbers and what to change. Do research before jumping to implementation.

A fork is cheap on its first call only \u2014 that one hits your prompt cache \u2014 and pays the inherited context again on each call after, so the deeper the session and the longer the child's job, the more it costs. Don't set \`model\` on a fork \u2014 a different model can't reuse the parent's cache. Pass a short \`name\` (one or two words, lowercase) so the user can see the agent in the panel and steer it mid-run.

**Foreground vs background.** By default an agent runs **inline**: you wait for its report and consume the result in the same turn — like any other tool call. Pass \`run_in_background: true\` only when you have genuinely independent work to do in parallel; then the agent returns immediately with an \`output_file\` path and you'll be notified when it completes.

**When backgrounded, don't peek.** If you set \`run_in_background: true\`, do not Read or tail the \`output_file\` unless the user explicitly asks for a progress check. Trust the completion notification; reading the transcript mid-flight pulls the agent's tool noise into your context, defeating the point. After launching a background agent, you know nothing about what it found — never fabricate or predict its result. If the user asks a follow-up before the notification lands, say the agent is still running, not a guess.

**The announcement is not the launch.** Saying "launched X in the background" or "I'll report back when it's done" does nothing on its own — only the \`${AGENT_TOOL_NAME}\` tool call spawns the agent. Only write such an announcement if you actually emitted the tool call(s) in this same turn. If you are about to end a turn with a launch announcement but no \`${AGENT_TOOL_NAME}\` tool_use block, you have launched nothing: emit the call instead of narrating it. This matters most when launching several agents in parallel — write the tool calls first, then announce, never the announcement alone.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.
`
    : ''

  const writingThePromptSection = `

## Writing the prompt

${forkEnabled ? 'When spawning a fresh agent (with a `subagent_type`), it starts with zero context. ' : ''}Brief the agent like a colleague who hasn't seen this conversation: explain the goal, what you've ruled out, scope, and any output-length cap. Lookups: hand over the exact command. Investigations: hand over the question.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" — that pushes synthesis onto the agent. Include file paths, line numbers, and what specifically to change.
`

  const forkExamples = `Example usage:

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>Delegating this \u2014 it's a survey question and the brief is self-contained, so a fresh agent does it without re-reading my whole session on every call. I want the punch list, not the git output in my context.</thinking>
${AGENT_TOOL_NAME}({
  name: "ship-audit",
  description: "Branch ship-readiness audit",
  subagent_type: "Code",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list \u2014 done vs. missing. Under 200 words."
})
<commentary>
Fresh Code agent, inline \u2014 no run_in_background. The prompt carries everything the agent needs, so nothing in the conversation was worth inheriting. The tool returns the audit report in this same turn, and the coordinator answers from it directly.
</commentary>
assistant: Audit's back. Three blockers: no tests for the new prompt path, GrowthBook gate wired but not in build_flags.yaml, and one uncommitted file.
</example>

<example>
user: "Something in what we changed this session broke the footer render \u2014 find which edit."
assistant: <thinking>The child needs the edits we made and why \u2014 a dozen files and the reasoning behind each. That is this conversation, not a paragraph I can write, so this one is a fork.</thinking>
${AGENT_TOOL_NAME}({
  name: "footer-bisect",
  description: "Bisect this session's edits",
  prompt: "Find which of the edits made in this session broke the footer render. Revert them one at a time in a scratch copy, rebuild, check the footer, restore. Report the offending edit and the line. Under 150 words."
})
<commentary>
Fork \u2014 no subagent_type. The prompt is a directive, not a briefing: the fork already holds the session's edits and their intent, and re-explaining them would cost more than the inherited context does.
</commentary>
</example>

<example>
user: "Run the migration audit AND the perf benchmark \u2014 they're independent."
assistant: <thinking>Two independent jobs. Background both so they run in parallel while I keep working.</thinking>
${AGENT_TOOL_NAME}({
  name: "mig-audit",
  description: "Migration audit",
  subagent_type: "Code",
  run_in_background: true,
  prompt: "..."
})
${AGENT_TOOL_NAME}({
  name: "perf-bench",
  description: "Perf benchmark",
  subagent_type: "Code",
  run_in_background: true,
  prompt: "..."
})
assistant: Both running in the background.
<commentary>
The closing line is valid only because both ${AGENT_TOOL_NAME} calls above were actually emitted in this turn \u2014 the words alone launch nothing. Turn ends here. The agent does NOT have results yet \u2014 the notifications arrive as user-role messages in a later turn. Until then, give status, not a guess.
</commentary>
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read.</thinking>
<commentary>
A subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The briefing explains what to assess and why.
</commentary>
${AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
`

  const currentExamples = `Example usage:

<example_agent_descriptions>
"claudin-guide": use this agent when the user asks how Claudin works or how to use its features
</example_agent_descriptions>

<example>
user: "How do I configure Claudin hooks?"
<commentary>
This is a Claudin usage question, so use the claudin-guide agent
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the claudin-guide agent
</example>
`

  // When the gate is on, the agent list lives in an agent_listing_delta
  // attachment (see attachments.ts) instead of inline here. This keeps the
  // tool description static across MCP/plugin/permission changes so the
  // tools-block prompt cache doesn't bust every time an agent loads.
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // Shared core prompt used by both coordinator and non-coordinator modes
  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

${
  forkEnabled
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself — a fork inherits your full conversation context and re-reads all of it on every call it makes.`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the Code agent is used.`
}`

  // Coordinator mode gets the slim prompt -- the coordinator system prompt
  // already covers usage notes, examples, and when-not-to-use guidance.
  if (isCoordinator) {
    return shared
  }

  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find via Bash instead.
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // The "class Foo" example is about content search. Non-embedded stays Glob
  // (original intent: find-the-file-containing). Embedded gets grep because
  // find -name doesn't look at file contents.
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- For known file paths or content searches in 1-3 specific files, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} / ${contentSearchHint} directly — they're faster
- Other tasks that are not related to the agent descriptions above
`

  // When listing via attachment, the "launch multiple agents" note is in the
  // attachment message (conditioned on subscription there). When inline, keep
  // the existing per-call getSubscriptionType() check.
  const concurrencyNote =
    !listViaAttachment && getSubscriptionType() !== 'pro'
      ? `
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses`
      : ''

  // Non-coordinator gets the full prompt with all sections
  return `${shared}
${whenNotToUseSection}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do${concurrencyNote}
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.${
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammate() &&
    !forkEnabled
      ? `
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- Announcing a launch does not perform it. Only tell the user you launched an agent (e.g. "running in the background", "I'll report back") if you actually emitted the ${AGENT_TOOL_NAME} tool call in the same turn — the announcement text spawns nothing. Never end a turn with a launch announcement but no ${AGENT_TOOL_NAME} tool_use block.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.`
      : ''
  }
- To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved. ${forkEnabled ? 'Each fresh Agent invocation with a subagent_type starts without context — provide a complete task description.' : 'Each Agent invocation starts fresh — provide a complete task description.'}
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkEnabled ? '' : ", since it is not aware of the user's intent"}
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- Delegate autonomously for any "investigate across N files" intent (tracing a feature, mapping a subsystem, finding all call sites). Don't wait for the user to ask — one agent replaces a serial chain of Reads and costs less context than narrating between them.${forkEnabled ? ' Write the question out for a fresh `Code` agent; fork only when the question is about this conversation.' : ''}
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.${
    isInProcessTeammate()
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammate()
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${whenToForkSection}${writingThePromptSection}

${forkEnabled ? forkExamples : currentExamples}`
}
