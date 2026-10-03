/**
 * The permission decision every tool call passes through: allow, ask or
 * deny, given the tool, its input and the session's permission state.
 *
 * The decision runs in two stages, each an ordered table below:
 *   1. rules and the tool's own verdict (`decideBeforeMode`): whole-tool
 *      deny and ask rules, plan mode's refusal, then `VERDICT_ROWS`;
 *   2. what the mode makes of an ask (`ASK_SETTLERS`): dontAsk, auto mode,
 *      and the `PermissionRequest` hooks of a session that cannot prompt.
 */
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { shouldUseSandbox } from 'src/tools/BashTool/shouldUseSandbox.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { AbortError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import { getPlanFilePath } from 'src/agent/plans/plans.js'
import {
  AUTO_REJECT_MESSAGE,
  DONT_ASK_REJECT_MESSAGE,
} from 'src/agent/messages/rejection.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDenyDecision,
  PermissionResult,
} from 'src/permissions/PermissionResult.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from 'src/permissions/permissions/ruleLookup.js'
import { endDenialStreak } from 'src/permissions/permissions/denial.js'
import {
  createPermissionRequestMessage,
  getUpdatedInputOrFallback,
  runPermissionRequestHooksForHeadlessAgent,
} from 'src/permissions/permissions/requestMessage.js'
import {
  askTool,
  type ParsedInput,
  parseToolInput,
  readsOnly,
} from 'src/permissions/permissions/toolVerdict.js'
import {
  loadAutoModeDeps,
  loadAutoModeState,
  settleAutoModeAsk,
} from 'src/permissions/permissions/autoMode.js'

export {
  filterDeniedAgents,
  getAllowRules,
  getAskRuleForTool,
  getAskRules,
  getDenyRuleForAgent,
  getDenyRuleForTool,
  getDenyRules,
  getRuleByContentsForTool,
  getRuleByContentsForToolName,
  permissionRuleSourceDisplayString,
  toolAlwaysAllowedRule,
} from 'src/permissions/permissions/ruleLookup.js'
export { createPermissionRequestMessage } from 'src/permissions/permissions/requestMessage.js'
export {
  applyPermissionRulesToPermissionContext,
  deletePermissionRule,
  syncPermissionRulesFromDisk,
} from 'src/permissions/permissions/ruleMutation.js'

type ToolInput = { [key: string]: unknown }

/** What the decision knows once the tool has given its verdict. */
type Situation = {
  tool: Tool
  input: ToolInput
  permissions: ToolPermissionContext
  verdict: PermissionResult
}

/** An ask the mode may still settle, with what settling it needs. */
type PendingAsk = {
  tool: Tool
  input: ToolInput
  parsed: ParsedInput
  context: ToolUseContext
  assistantMessage: AssistantMessage
  toolUseID: string
}

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  context,
  assistantMessage,
  toolUseID,
): Promise<PermissionDecision> => {
  const { decision, parsed } = await decideBeforeMode(tool, input, context)
  const settled =
    decision.behavior === 'ask'
      ? await settleAsk(decision, { tool, input, parsed, context, assistantMessage, toolUseID })
      : decision
  if (
    settled.behavior === 'allow' &&
    context.getAppState().toolPermissionContext.mode === 'auto'
  ) {
    endDenialStreak(context)
  }
  return settled
}

/**
 * Whether plan mode hands a non-read-only call to the auto-mode classifier
 * instead of the hard deny. Only Bash, and only while auto mode is active.
 *
 * The read-only allowlist is a syntactic gate — an unquoted glob, a brace in
 * a quoted pattern or `sort | uniq -c` all fail it — and plan-mode research
 * paid for that a hundred times a week (108 denials in 2026-09-14..20, most
 * inside plan-mode sub-agents), while `bun scripts/…` and a throwaway script
 * in the scratchpad have no read-only form at all. The classifier already
 * decides every Bash write in auto mode; under plan mode it does so with the
 * plan-mode rules (`buildYoloSystemPrompt`) on top. Write/Edit keep the hard
 * deny: the plan file and the scratchpad are their only targets, and both
 * pass through `checkEditableInternalPath` as an allow.
 */
export function planModeDefersToClassifier(
  toolName: string,
  autoModeActive: boolean,
): boolean {
  return autoModeActive && toolName === BASH_TOOL_NAME
}

// ---------------------------------------------------------------------------
// Stage 1: rules, plan mode and the tool's verdict
// ---------------------------------------------------------------------------

/** A Bash call the sandbox will contain may skip a whole-tool ask rule, when the user asked for that. */
function sandboxWillContain(tool: Tool, input: ToolInput): boolean {
  return (
    tool.name === BASH_TOOL_NAME &&
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input as Parameters<typeof shouldUseSandbox>[0])
  )
}

function wholeToolRuleObjection(
  tool: Tool,
  input: ToolInput,
  permissions: ToolPermissionContext,
): PermissionAskDecision | PermissionDenyDecision | null {
  const denyRule = getDenyRuleForTool(permissions, tool)
  if (denyRule) {
    return {
      behavior: 'deny',
      decisionReason: { type: 'rule', rule: denyRule },
      message: `Use of ${tool.name} is denied by a permission rule.`,
    }
  }
  const askRule = getAskRuleForTool(permissions, tool)
  if (askRule && !sandboxWillContain(tool, input)) {
    return {
      behavior: 'ask',
      decisionReason: { type: 'rule', rule: askRule },
      message: createPermissionRequestMessage(tool.name),
    }
  }
  return null
}

function planFileClause(context: ToolUseContext): string {
  try {
    return `Only the plan file (${getPlanFilePath(context.agentId)}) may be edited.`
  } catch (error) {
    logError(error)
    return 'Only the plan file may be edited.'
  }
}

/**
 * Plan mode's refusal of anything that writes. Shared by both entry points,
 * so a `PreToolUse` hook that allows cannot get a write past it. The tool's
 * own allow passes, since that is how the plan file itself gets written.
 */
function planModeRefusal(
  tool: Tool,
  parsed: ParsedInput,
  context: ToolUseContext,
  verdict: PermissionResult,
): PermissionDenyDecision | null {
  const permissions = context.getAppState().toolPermissionContext
  if (permissions.mode !== 'plan' || permissions.isBypassPermissionsModeAvailable) {
    return null
  }
  const autoModeStateModule = loadAutoModeState()
  const mayProceed =
    tool.name === EXIT_PLAN_MODE_V2_TOOL_NAME ||
    verdict.behavior === 'allow' ||
    readsOnly(tool, parsed) ||
    planModeDefersToClassifier(
      tool.name,
      autoModeStateModule?.isAutoModeActive() ?? false,
    )
  if (mayProceed) return null
  return {
    behavior: 'deny',
    decisionReason: { type: 'mode', mode: 'plan' },
    message: `Plan mode is active. Tool ${tool.name} is not read-only and cannot run until you call ${EXIT_PLAN_MODE_V2_TOOL_NAME}. ${planFileClause(context)}`,
  }
}

/** The tool's own deny, content ask rule or safety check: these stand in every mode. */
function toolObjection(
  verdict: PermissionResult,
): PermissionAskDecision | PermissionDenyDecision | null {
  if (verdict.behavior === 'deny') return verdict
  if (verdict.behavior !== 'ask') return null
  const reason = verdict.decisionReason
  const contentAskRule = reason?.type === 'rule' && reason.rule.ruleBehavior === 'ask'
  return contentAskRule || reason?.type === 'safetyCheck' ? verdict : null
}

function allowWithReason(
  s: Situation,
  decisionReason: PermissionDecision['decisionReason'],
): PermissionDecision {
  return {
    behavior: 'allow',
    updatedInput: getUpdatedInputOrFallback(s.verdict, s.input),
    decisionReason,
  }
}

/** After rules and plan mode, the first row that answers decides. Order matters. */
const VERDICT_ROWS: ReadonlyArray<{
  name: string
  decide: (s: Situation) => PermissionDecision | null
}> = [
  { name: 'tool objects', decide: s => toolObjection(s.verdict) },
  {
    name: 'tool needs the user',
    decide: s =>
      s.verdict.behavior === 'ask' && s.tool.requiresUserInteraction?.() ? s.verdict : null,
  },
  {
    name: 'bypass mode',
    decide: s => {
      const { mode, isBypassPermissionsModeAvailable } = s.permissions
      const bypassing =
        mode === 'bypassPermissions' || (mode === 'plan' && isBypassPermissionsModeAvailable)
      return bypassing ? allowWithReason(s, { type: 'mode', mode }) : null
    },
  },
  {
    name: 'allow rule',
    decide: s => {
      const rule = toolAlwaysAllowedRule(s.permissions, s.tool)
      return rule ? allowWithReason(s, { type: 'rule', rule }) : null
    },
  },
]

function verdictAsDecision(tool: Tool, verdict: PermissionResult): PermissionDecision {
  if (verdict.behavior !== 'passthrough') return verdict
  return {
    ...verdict,
    behavior: 'ask',
    message: createPermissionRequestMessage(tool.name, verdict.decisionReason),
  }
}

async function decideBeforeMode(
  tool: Tool,
  input: ToolInput,
  context: ToolUseContext,
): Promise<{ decision: PermissionDecision; parsed: ParsedInput }> {
  if (context.abortController.signal.aborted) throw new AbortError()
  const permissions = context.getAppState().toolPermissionContext
  const parsed = parseToolInput(tool, input)

  const ruled = wholeToolRuleObjection(tool, input, permissions)
  if (ruled) return { decision: ruled, parsed }

  const verdict = await askTool(tool, parsed, context)
  const refusal = planModeRefusal(tool, parsed, context, verdict)
  if (refusal) return { decision: refusal, parsed }

  const situation: Situation = { tool, input, permissions, verdict }
  for (const row of VERDICT_ROWS) {
    const decision = row.decide(situation)
    if (decision) return { decision, parsed }
  }
  return { decision: verdictAsDecision(tool, verdict), parsed }
}

// ---------------------------------------------------------------------------
// Stage 2: what the mode makes of an ask
// ---------------------------------------------------------------------------

async function refuseInDontAskMode(
  ask: PermissionAskDecision,
  call: PendingAsk,
): Promise<PermissionDecision> {
  const mode = call.context.getAppState().toolPermissionContext.mode
  if (mode !== 'dontAsk') return ask
  return {
    behavior: 'deny',
    decisionReason: { type: 'mode', mode: 'dontAsk' },
    message: DONT_ASK_REJECT_MESSAGE(call.tool.name),
  }
}

async function settleInAutoMode(
  ask: PermissionAskDecision,
  call: PendingAsk,
): Promise<PermissionDecision> {
  const { tool } = call
  const appState = call.context.getAppState()
  const { mode } = appState.toolPermissionContext
  const autoModeActive = loadAutoModeState()?.isAutoModeActive() ?? false
  const deps = mode === 'auto' || (mode === 'plan' && autoModeActive) ? loadAutoModeDeps() : null
  if (deps === null) return ask
  return settleAutoModeAsk(
    {
      ...call,
      ask,
      acceptEditsMayAllow:
        tool.name !== AGENT_TOOL_NAME &&
        appState.toolPermissionContext.mode !== 'plan',
    },
    deps,
  )
}

async function askHeadlessHooks(
  ask: PermissionAskDecision,
  call: PendingAsk,
): Promise<PermissionDecision> {
  const permissions = call.context.getAppState().toolPermissionContext
  if (!permissions.shouldAvoidPermissionPrompts) return ask
  const hookDecision = await runPermissionRequestHooksForHeadlessAgent(
    call.tool,
    call.input,
    call.toolUseID,
    call.context,
    permissions.mode,
    ask.suggestions,
  )
  return (
    hookDecision ?? {
      behavior: 'deny',
      decisionReason: {
        type: 'asyncAgent',
        reason: 'Permission prompts are not available in this context, and no PermissionRequest hook decided',
      },
      message: AUTO_REJECT_MESSAGE(call.tool.name),
    }
  )
}

/** Each settler sees the ask the previous one left; the first non-ask ends the run. */
const ASK_SETTLERS: ReadonlyArray<
  (ask: PermissionAskDecision, call: PendingAsk) => Promise<PermissionDecision>
> = [refuseInDontAskMode, settleInAutoMode, askHeadlessHooks]

async function settleAsk(
  ask: PermissionAskDecision,
  call: PendingAsk,
): Promise<PermissionDecision> {
  let current: PermissionDecision = ask
  for (const settle of ASK_SETTLERS) {
    if (current.behavior !== 'ask') break
    current = await settle(current, call)
  }
  return current
}

/**
 * The rule-only subset, for a call a `PreToolUse` hook already allowed:
 * whole-tool deny and ask rules, plan mode's refusal, and the tool's own
 * objections. Null when none of them objects.
 */
export async function checkRuleBasedPermissions(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionAskDecision | PermissionDenyDecision | null> {
  const permissions = context.getAppState().toolPermissionContext
  const ruled = wholeToolRuleObjection(tool, input, permissions)
  if (ruled) return ruled
  const parsed = parseToolInput(tool, input)
  const verdict = await askTool(tool, parsed, context)
  return planModeRefusal(tool, parsed, context, verdict) ?? toolObjection(verdict)
}
