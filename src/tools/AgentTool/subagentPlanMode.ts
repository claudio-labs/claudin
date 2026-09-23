// The plan-mode brief a sub-agent gets, built once at spawn and pushed into
// its OPENING turn by runAgent.
//
// It used to come from the attachment pipeline instead, and for a sub-agent
// that pipeline only ever runs mid-tool-loop — src/agent/query.ts calls it
// with `input === null` after each batch of tool results. The reminder was
// therefore merged into the same user turn as the tool_result before it
// (reorderAttachmentsForAPI + normalizeMessagesForAPI) and read as text
// injected by whatever the child had just fetched: two WebResearcher agents
// reported it as a prompt-injection attempt (#224).
//
// Seeding the child's own opening turn costs nothing in coverage. The
// pipeline throttle counts HUMAN turns (getPlanModeAttachmentTurnCount), and
// a sub-agent only ever has one, so it fired at most once per child anyway.
import type { Attachment } from 'src/agent/attachments/types.js'
import { snapshotPlanModeReminder } from 'src/agent/messages/planMode.js'
import { getPlan, getPlanFilePath } from 'src/agent/plans/plans.js'
import type { AgentId } from 'src/shared/types/ids.js'
import type { PermissionMode } from 'src/shared/types/permissions.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'

type PlanFileDeps = {
  getPlan: typeof getPlan
  getPlanFilePath: typeof getPlanFilePath
}

export function buildSubagentPlanModeAttachment(
  args: {
    /** The mode the CHILD resolved to (resolveAgentPermissionMode), not the parent's raw mode. */
    mode: PermissionMode
    agentId: AgentId
    /** The child's own tool names — what decides which wording it gets. */
    toolNames: ReadonlySet<string>
  },
  // Injected rather than reached for directly: planDossier.test.ts mock.modules
  // src/agent/plans/plans.js, and Bun applies that override for the WHOLE test
  // run, so a test asserting on the real plan path passes alone and fails in
  // the suite (it did). Same shape as postCompactAttachments.ts.
  deps: PlanFileDeps = { getPlan, getPlanFilePath },
): Attachment | null {
  if (args.mode !== 'plan') return null

  const planMode = {
    type: 'plan_mode' as const,
    reminderType: 'full' as const,
    isSubAgent: true,
    // Only an agent that can actually submit a plan hears about the plan file.
    // ExitPlanMode survives the sub-agent tool filter exclusively in plan mode
    // (filterToolsForAgent in agentToolUtils.ts), for in-process teammates.
    canExitPlanMode: args.toolNames.has(EXIT_PLAN_MODE_V2_TOOL_NAME),
    planFilePath: deps.getPlanFilePath(args.agentId),
    planExists: deps.getPlan(args.agentId) !== null,
  }
  // The brief as it renders now: a resumed child re-sends it rather than
  // re-reading the scratchpad gate and path it is built from.
  return { ...planMode, rendered: snapshotPlanModeReminder(planMode) }
}
