import { feature } from 'bun:bundle'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { shouldUseSandbox } from 'src/tools/BashTool/shouldUseSandbox.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { POWERSHELL_TOOL_NAME } from 'src/tools/PowerShellTool/toolName.js'
import { logForDebugging } from 'src/shared/debug.js'
import { AbortError, isSdkApiUserAbortError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { getPlanFilePath } from 'src/agent/plans/plans.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDenyDecision,
  PermissionResult,
} from 'src/permissions/PermissionResult.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const classifierDecisionModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('src/permissions/classifierDecision.js') as typeof import('src/permissions/classifierDecision.js'))
  : null
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('src/permissions/autoModeState.js') as typeof import('src/permissions/autoModeState.js'))
  : null

import {
  addToTurnClassifierDuration,
} from 'src/platform/bootstrap/state.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from 'src/platform/analytics/growthbook.js'
import {
  clearClassifierChecking,
  setClassifierChecking,
} from 'src/permissions/classifierApprovals.js'
import {
  AUTO_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
  DONT_ASK_REJECT_MESSAGE,
} from 'src/agent/messages/messages.js'
import { calculateCostFromTokens } from 'src/providers/usage/modelCost.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonStringify } from 'src/platform/slowOperations.js'
import {
  createDenialTrackingState,
  recordDenial,
  recordSuccess,
} from 'src/permissions/denialTracking.js'
import {
  classifyYoloAction,
  formatActionForClassifier,
} from 'src/permissions/yoloClassifier.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from 'src/permissions/permissions/ruleLookup.js'
import {
  CLASSIFIER_FAIL_CLOSED_REFRESH_MS,
  handleDenialLimitExceeded,
  persistDenialState,
} from 'src/permissions/permissions/denial.js'
import {
  createPermissionRequestMessage,
  getUpdatedInputOrFallback,
  runPermissionRequestHooksForHeadlessAgent,
} from 'src/permissions/permissions/requestMessage.js'

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

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  context,
  assistantMessage,
  toolUseID,
): Promise<PermissionDecision> => {
  const result = await hasPermissionsToUseToolInner(tool, input, context)


  // Reset consecutive denials on any allowed tool use in auto mode.
  // This ensures that a successful tool use (even one auto-allowed by rules)
  // breaks the consecutive denial streak.
  if (result.behavior === 'allow') {
    const appState = context.getAppState()
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const currentDenialState =
        context.localDenialTracking ?? appState.denialTracking
      if (
        appState.toolPermissionContext.mode === 'auto' &&
        currentDenialState &&
        currentDenialState.consecutiveDenials > 0
      ) {
        const newDenialState = recordSuccess(currentDenialState)
        persistDenialState(context, newDenialState)
      }
    }
    return result
  }

  // Apply dontAsk mode transformation: convert 'ask' to 'deny'
  // This is done at the end so it can't be bypassed by early returns
  if (result.behavior === 'ask') {
    const appState = context.getAppState()

    if (appState.toolPermissionContext.mode === 'dontAsk') {
      return {
        behavior: 'deny',
        decisionReason: {
          type: 'mode',
          mode: 'dontAsk',
        },
        message: DONT_ASK_REJECT_MESSAGE(tool.name),
      }
    }
    // Apply auto mode: use AI classifier instead of prompting user
    // Check this BEFORE shouldAvoidPermissionPrompts so classifiers work in headless mode
    if (
      feature('TRANSCRIPT_CLASSIFIER') &&
      (appState.toolPermissionContext.mode === 'auto' ||
        (appState.toolPermissionContext.mode === 'plan' &&
          (autoModeStateModule?.isAutoModeActive() ?? false)))
    ) {
      // Non-classifier-approvable safetyCheck decisions stay immune to ALL
      // auto-approve paths: the acceptEdits fast-path, the safe-tool allowlist,
      // and the classifier. Step 1g only guards bypassPermissions; this guards
      // auto. classifierApprovable safetyChecks (sensitive-file paths) fall
      // through to the classifier — the fast-paths below naturally don't fire
      // because the tool's own checkPermissions still returns 'ask'.
      if (
        result.decisionReason?.type === 'safetyCheck' &&
        !result.decisionReason.classifierApprovable
      ) {
        if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
          return {
            behavior: 'deny',
            message: result.message,
            decisionReason: {
              type: 'asyncAgent',
              reason:
                'Safety check requires interactive approval and permission prompts are not available in this context',
            },
          }
        }
        return result
      }
      if (tool.requiresUserInteraction?.() && result.behavior === 'ask') {
        return result
      }

      // Use local denial tracking for async subagents (whose setAppState
      // is a no-op), otherwise read from appState as before.
      const denialState =
        context.localDenialTracking ??
        appState.denialTracking ??
        createDenialTrackingState()

      // PowerShell requires explicit user permission in auto mode: this guard
      // keeps PS out of the classifier and skips the acceptEdits fast-path
      // below.
      // Note: this runs inside the behavior === 'ask' branch, so allow rules
      // that fire earlier (step 2b toolAlwaysAllowedRule, PS prefix allow)
      // return before reaching here. Allow-rule protection on auto-mode entry
      // is stripDangerousPermissionsForAutoMode (permissionSetup.ts), whose
      // findDangerousClassifierPermissions covers PowerShell(*) along with the
      // iex/pwsh/Start-Process prefix rules. It runs on every auto-mode entry
      // (REPL toggle, ExitPlanMode, the setAutoModeActive paths); the STARTUP
      // call in mcpAndPerms.ts is additionally gated on
      // feature('TRANSCRIPT_CLASSIFIER'). An earlier pair of
      // isOverlyBroad*AllowRule predicates named here never had a caller: they
      // fed a warning list that was built empty, so they protected nothing and
      // are gone.
      if (tool.name === POWERSHELL_TOOL_NAME) {
        if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
          return {
            behavior: 'deny',
            message: 'PowerShell tool requires interactive approval',
            decisionReason: {
              type: 'asyncAgent',
              reason:
                'PowerShell tool requires interactive approval and permission prompts are not available in this context',
            },
          }
        }
        logForDebugging(
          `Skipping auto mode classifier for ${tool.name}: tool requires explicit user permission`,
        )
        return result
      }

      // Before running the auto mode classifier, check if acceptEdits mode would
      // allow this action. This avoids expensive classifier API calls for safe
      // operations like file edits in the working directory.
      // Skip for Agent — its checkPermissions returns 'allow' for acceptEdits
      // mode, which would silently bypass the classifier.
      // Skip in plan mode too: the only tool that reaches this branch there is
      // Bash (planModeHardDenyIfApplicable), and acceptEdits auto-allows
      // `rm`/`mv`/`sed` — the classifier, with its plan-mode rules, is the
      // whole point of letting the call get this far.
      if (
        result.behavior === 'ask' &&
        tool.name !== AGENT_TOOL_NAME &&
        appState.toolPermissionContext.mode !== 'plan'
      ) {
        try {
          const parsedInput = tool.inputSchema.parse(input)
          const acceptEditsResult = await tool.checkPermissions(parsedInput, {
            ...context,
            getAppState: () => {
              const state = context.getAppState()
              return {
                ...state,
                toolPermissionContext: {
                  ...state.toolPermissionContext,
                  mode: 'acceptEdits' as const,
                },
              }
            },
          })
          if (acceptEditsResult.behavior === 'allow') {
            const newDenialState = recordSuccess(denialState)
            persistDenialState(context, newDenialState)
            logForDebugging(
              `Skipping auto mode classifier for ${tool.name}: would be allowed in acceptEdits mode`,
            )
            return {
              behavior: 'allow',
              updatedInput: acceptEditsResult.updatedInput ?? input,
              decisionReason: {
                type: 'mode',
                mode: 'auto',
              },
            }
          }
        } catch (e) {
          if (e instanceof AbortError || isSdkApiUserAbortError(e)) {
            throw e
          }
          // If the acceptEdits check fails, fall through to the classifier
        }
      }

      // Allowlisted tools are safe and don't need YOLO classification.
      // This uses the safe-tool allowlist to skip unnecessary classifier API calls.
      // A tool may also be allowlisted for its READ-ONLY inputs only: a
      // `git status` batch skips the classifier while `git checkout -b` still
      // goes through it.
      const onSafeAllowlist =
        classifierDecisionModule!.isAutoModeAllowlistedTool(tool.name)
      const readsOnly =
        !onSafeAllowlist &&
        classifierDecisionModule!.isAutoModeAllowlistedReadOnlyToolUse(
          tool.name,
          () => tool.isReadOnly(tool.inputSchema.parse(input)),
        )
      if (onSafeAllowlist || readsOnly) {
        const newDenialState = recordSuccess(denialState)
        persistDenialState(context, newDenialState)
        logForDebugging(
          `Skipping auto mode classifier for ${tool.name}: ${
            onSafeAllowlist
              ? 'tool is on the safe allowlist'
              : 'this call only reads'
          }`,
        )
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: {
            type: 'mode',
            mode: 'auto',
          },
        }
      }

      // Run the auto mode classifier
      const action = formatActionForClassifier(tool.name, input)
      setClassifierChecking(toolUseID)
      let classifierResult
      try {
        classifierResult = await classifyYoloAction(
          context.messages,
          action,
          context.options.tools,
          appState.toolPermissionContext,
          context.abortController.signal,
        )
      } finally {
        clearClassifierChecking(toolUseID)
      }

      // Log classifier decision for metrics (including overhead telemetry)
      const yoloDecision = classifierResult.unavailable
        ? 'unavailable'
        : classifierResult.shouldBlock
          ? 'blocked'
          : 'allowed'

      // Compute classifier cost in USD for overhead analysis
      const classifierCostUSD =
        classifierResult.usage && classifierResult.model
          ? calculateCostFromTokens(
              classifierResult.model,
              classifierResult.usage,
            )
          : undefined

      if (classifierResult.durationMs !== undefined) {
        addToTurnClassifierDuration(classifierResult.durationMs)
      }

      if (classifierResult.shouldBlock) {
        // Deterministic classifier failures won't recover on retry: the
        // transcript exceeded the context window, or the API returned a
        // deterministic 4xx (malformed request, bad header, auth failure).
        // Skip iron_gate and fall back to normal prompting so the user can
        // approve/deny manually, rather than looping in fail-closed retries.
        // A timeout joins them: the wait already happened, and denying with
        // retry guidance would just spend it again.
        if (
          classifierResult.transcriptTooLong ||
          classifierResult.deterministic ||
          classifierResult.timedOut
        ) {
          const cause = classifierResult.transcriptTooLong
            ? 'transcript exceeded context window'
            : classifierResult.deterministic
              ? 'request failed with a deterministic error'
              : 'exceeded its time budget'
          if (!appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
            logForDebugging(
              `Auto mode classifier ${cause}, falling back to normal permission handling`,
              { level: 'warn' },
            )
            return {
              ...result,
              decisionReason: {
                type: 'other',
                reason: `Auto mode classifier ${cause} — falling back to manual approval`,
              },
            }
          }
          // Headless has no one to ask. The first two causes are permanent, and
          // deny-retry-deny wastes tokens without ever hitting the denial-limit
          // abort. A timeout is transient, so it falls through to the
          // unavailable branch below and keeps its retry guidance.
          if (!classifierResult.timedOut) {
            throw new AbortError(
              `Agent aborted: auto mode classifier ${cause} in headless mode`,
            )
          }
        }
        // When classifier is unavailable (API error), behavior depends on
        // the tengu_iron_gate_closed gate.
        if (classifierResult.unavailable) {
          if (
            getFeatureValue_CACHED_WITH_REFRESH(
              'tengu_iron_gate_closed',
              true,
              CLASSIFIER_FAIL_CLOSED_REFRESH_MS,
            )
          ) {
            logForDebugging(
              'Auto mode classifier unavailable, denying with retry guidance (fail closed)',
              { level: 'warn' },
            )
            return {
              behavior: 'deny',
              decisionReason: {
                type: 'classifier',
                classifier: 'auto-mode',
                reason: 'Classifier unavailable',
              },
              message: buildClassifierUnavailableMessage(
                tool.name,
                classifierResult.model,
              ),
            }
          }
          // Fail open: fall back to normal permission handling
          logForDebugging(
            'Auto mode classifier unavailable, falling back to normal permission handling (fail open)',
            { level: 'warn' },
          )
          return result
        }

        // Update denial tracking and check limits
        const newDenialState = recordDenial(denialState)
        persistDenialState(context, newDenialState)

        logForDebugging(
          `Auto mode classifier blocked action: ${classifierResult.reason}`,
          { level: 'warn' },
        )

        // If denial limit hit, fall back to prompting so the user
        // can review. We check after the classifier so we can include
        // its reason in the prompt.
        const denialLimitResult = handleDenialLimitExceeded(
          newDenialState,
          appState,
          classifierResult.reason,
          assistantMessage,
          tool,
          result,
          context,
        )
        if (denialLimitResult) {
          return denialLimitResult
        }

        return {
          behavior: 'deny',
          decisionReason: {
            type: 'classifier',
            classifier: 'auto-mode',
            reason: classifierResult.reason,
          },
          message: buildYoloRejectionMessage(classifierResult.reason),
        }
      }

      // Reset consecutive denials on success
      const newDenialState = recordSuccess(denialState)
      persistDenialState(context, newDenialState)

      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'classifier',
          classifier: 'auto-mode',
          reason: classifierResult.reason,
        },
      }
    }

    // When permission prompts should be avoided (e.g., background/headless agents),
    // run PermissionRequest hooks first to give them a chance to allow/deny.
    // Only auto-deny if no hook provides a decision.
    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      const hookDecision = await runPermissionRequestHooksForHeadlessAgent(
        tool,
        input,
        toolUseID,
        context,
        appState.toolPermissionContext.mode,
        result.suggestions,
      )
      if (hookDecision) {
        return hookDecision
      }
      return {
        behavior: 'deny',
        decisionReason: {
          type: 'asyncAgent',
          reason: 'Permission prompts are not available in this context',
        },
        message: AUTO_REJECT_MESSAGE(tool.name),
      }
    }
  }

  return result
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

/**
 * Plan mode hard gate. Returns a deny decision when the active permission
 * mode is `plan` AND the tool is non-readonly AND none of the escape hatches
 * apply (allow from tool.checkPermissions, inherited bypass, or ExitPlanMode).
 *
 * Lives in a shared helper so both hasPermissionsToUseToolInner (normal path)
 * and checkRuleBasedPermissions (PreToolUse hook approval path) enforce the
 * same gate — otherwise a hook returning `allow` would let writes through in
 * plan mode.
 */
function planModeHardDenyIfApplicable(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
  toolPermissionResult: PermissionResult | undefined,
): PermissionDenyDecision | null {
  const ctx = context.getAppState().toolPermissionContext
  if (
    ctx.mode !== 'plan' ||
    ctx.isBypassPermissionsModeAvailable ||
    tool.name === EXIT_PLAN_MODE_V2_TOOL_NAME ||
    toolPermissionResult?.behavior === 'allow'
  ) {
    return null
  }

  let readOnly = false
  try {
    readOnly = tool.isReadOnly(tool.inputSchema.parse(input))
  } catch {
    readOnly = false
  }
  if (readOnly) return null

  // Returning null lets the normal flow run — tool deny, ask rules, safety
  // checks, always-allow rules — and end in the 'ask' the outer function
  // routes to the classifier (its acceptEdits fast path stands down in plan
  // mode). `feature('TRANSCRIPT_CLASSIFIER')` is false under `bun test`, so
  // the module is null there and this branch is exercised through the pure
  // predicate plus the live build.
  if (
    planModeDefersToClassifier(
      tool.name,
      autoModeStateModule?.isAutoModeActive() ?? false,
    )
  ) {
    return null
  }

  // Name the one file that IS editable. A write the model believes targets the
  // plan file but that resolves elsewhere (a path it remembered from before the
  // plans dir moved, a hallucinated slug) otherwise dead-ends here, with no way
  // to tell a wrong path apart from a blanket ban on writing.
  let planFileClause = 'Only the plan file may be edited.'
  try {
    planFileClause = `Only the plan file (${getPlanFilePath(context.agentId)}) may be edited.`
  } catch (e) {
    logError(e)
  }

  return {
    behavior: 'deny',
    message: `Plan mode is active. Tool ${tool.name} is not read-only and cannot run until you call ExitPlanMode. ${planFileClause}`,
    decisionReason: {
      type: 'mode',
      mode: 'plan',
    },
  }
}

/**
 * Check only the rule-based steps of the permission pipeline — the subset
 * that bypassPermissions mode respects (everything that fires before step 2a).
 *
 * Returns a deny/ask decision if a rule blocks the tool, or null if no rule
 * objects. Unlike hasPermissionsToUseTool, this does NOT run the auto mode classifier,
 * mode-based transformations (dontAsk/auto/asyncAgent), PermissionRequest hooks,
 * or bypassPermissions / always-allowed checks.
 *
 * Caller must pre-check tool.requiresUserInteraction() — step 1e is not replicated.
 */
export async function checkRuleBasedPermissions(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionAskDecision | PermissionDenyDecision | null> {
  const appState = context.getAppState()

  // 1a. Entire tool is denied by rule
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return {
      behavior: 'deny',
      decisionReason: {
        type: 'rule',
        rule: denyRule,
      },
      message: `Permission to use ${tool.name} has been denied.`,
    }
  }

  // 1b. Entire tool has an ask rule
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    const canSandboxAutoAllow =
      tool.name === BASH_TOOL_NAME &&
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
      shouldUseSandbox(input)

    if (!canSandboxAutoAllow) {
      return {
        behavior: 'ask',
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        message: createPermissionRequestMessage(tool.name),
      }
    }
    // Fall through to let tool.checkPermissions handle command-specific rules
  }

  // 1c. Tool-specific permission check (e.g. bash subcommand rules)
  let toolPermissionResult: PermissionResult = {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(tool.name),
  }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) {
    if (e instanceof AbortError || isSdkApiUserAbortError(e)) {
      throw e
    }
    logError(e)
  }

  // 1c.5. Plan mode hard gate (mirrors hasPermissionsToUseToolInner) — must
  // run here too, otherwise a PreToolUse hook returning `allow` would route
  // through this function and bypass plan mode.
  const planDeny = planModeHardDenyIfApplicable(
    tool,
    input,
    context,
    toolPermissionResult,
  )
  if (planDeny) return planDeny

  // 1d. Tool implementation denied (catches bash subcommand denies wrapped
  // in subcommandResults — no need to inspect decisionReason.type)
  if (toolPermissionResult?.behavior === 'deny') {
    return toolPermissionResult
  }

  // 1f. Content-specific ask rules from tool.checkPermissions
  // (e.g. Bash(npm publish:*) → {ask, type:'rule', ruleBehavior:'ask'})
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'rule' &&
    toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    return toolPermissionResult
  }

  // 1g. Safety checks (e.g. .git/, .claudin/, .vscode/, shell configs) are
  // bypass-immune — they must prompt even when a PreToolUse hook returned
  // allow. checkPathSafetyForAutoEdit returns {type:'safetyCheck'} for these.
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'safetyCheck'
  ) {
    return toolPermissionResult
  }

  // No rule-based objection
  return null
}

async function hasPermissionsToUseToolInner(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionDecision> {
  if (context.abortController.signal.aborted) {
    throw new AbortError()
  }

  let appState = context.getAppState()

  // 1. Check if the tool is denied
  // 1a. Entire tool is denied
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return {
      behavior: 'deny',
      decisionReason: {
        type: 'rule',
        rule: denyRule,
      },
      message: `Permission to use ${tool.name} has been denied.`,
    }
  }

  // 1b. Check if the entire tool should always ask for permission
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    // When autoAllowBashIfSandboxed is on, sandboxed commands skip the ask rule and
    // auto-allow via Bash's checkPermissions. Commands that won't be sandboxed (excluded
    // commands, dangerouslyDisableSandbox) still need to respect the ask rule.
    const canSandboxAutoAllow =
      tool.name === BASH_TOOL_NAME &&
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
      shouldUseSandbox(input)

    if (!canSandboxAutoAllow) {
      return {
        behavior: 'ask',
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        message: createPermissionRequestMessage(tool.name),
      }
    }
    // Fall through to let Bash's checkPermissions handle command-specific rules
  }

  // 1c. Ask the tool implementation for a permission result
  // Overridden unless tool input schema is not valid
  let toolPermissionResult: PermissionResult = {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(tool.name),
  }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) {
    // Rethrow abort errors so they propagate properly
    if (e instanceof AbortError || isSdkApiUserAbortError(e)) {
      throw e
    }
    logError(e)
  }

  // 1c.5. Plan mode hard gate. Runs before 1d–1g so PowerShell-interactive,
  // explicit ask-rules, and safety checks all become hard-deny in plan mode
  // without a prompt. Also runs before 2b so plan mode beats user Edit(*)
  // always-allow rules. Sub-agents inherit toolPermissionContext.mode from
  // the parent (src/tools/AgentTool/runAgent.ts), so this gate covers them too.
  const planDeny = planModeHardDenyIfApplicable(
    tool,
    input,
    context,
    toolPermissionResult,
  )
  if (planDeny) return planDeny

  // 1d. Tool implementation denied permission
  if (toolPermissionResult?.behavior === 'deny') {
    return toolPermissionResult
  }

  // 1e. Tool requires user interaction even in bypass mode
  if (
    tool.requiresUserInteraction?.() &&
    toolPermissionResult?.behavior === 'ask'
  ) {
    return toolPermissionResult
  }

  // 1f. Content-specific ask rules from tool.checkPermissions take precedence
  // over bypassPermissions mode. When a user explicitly configures a
  // content-specific ask rule (e.g. Bash(npm publish:*)), the tool's
  // checkPermissions returns {behavior:'ask', decisionReason:{type:'rule',
  // rule:{ruleBehavior:'ask'}}}. This must be respected even in bypass mode,
  // just as deny rules are respected at step 1d.
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'rule' &&
    toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    return toolPermissionResult
  }

  // 1g. Safety checks (e.g. .git/, .claudin/, .vscode/, shell configs) are
  // bypass-immune — they must prompt even in bypassPermissions mode.
  // checkPathSafetyForAutoEdit returns {type:'safetyCheck'} for these paths.
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'safetyCheck'
  ) {
    return toolPermissionResult
  }

  // 2a. Check if mode allows the tool to run
  // IMPORTANT: Call getAppState() to get the latest value
  appState = context.getAppState()
  // Check if permissions should be bypassed:
  // - Direct bypassPermissions mode
  // - Plan mode when the user originally started with bypass mode (isBypassPermissionsModeAvailable)
  const shouldBypassPermissions =
    appState.toolPermissionContext.mode === 'bypassPermissions' ||
    (appState.toolPermissionContext.mode === 'plan' &&
      appState.toolPermissionContext.isBypassPermissionsModeAvailable)
  if (shouldBypassPermissions) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: 'mode',
        mode: appState.toolPermissionContext.mode,
      },
    }
  }

  // 2b. Entire tool is allowed
  const alwaysAllowedRule = toolAlwaysAllowedRule(
    appState.toolPermissionContext,
    tool,
  )
  if (alwaysAllowedRule) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: 'rule',
        rule: alwaysAllowedRule,
      },
    }
  }

  // 3. Convert "passthrough" to "ask"
  const result: PermissionDecision =
    toolPermissionResult.behavior === 'passthrough'
      ? {
          ...toolPermissionResult,
          behavior: 'ask' as const,
          message: createPermissionRequestMessage(
            tool.name,
            toolPermissionResult.decisionReason,
          ),
        }
      : toolPermissionResult

  if (result.behavior === 'ask' && result.suggestions) {
    logForDebugging(
      `Permission suggestions for ${tool.name}: ${jsonStringify(result.suggestions, null, 2)}`,
    )
  }

  return result
}
