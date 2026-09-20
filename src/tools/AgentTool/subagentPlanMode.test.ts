import { describe, expect, test } from 'bun:test'
import type { AgentId } from 'src/shared/types/ids.js'
import { buildSubagentPlanModeAttachment } from 'src/tools/AgentTool/subagentPlanMode.js'

const AGENT = 'agent224' as AgentId
const WEB_ONLY: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch'])
const TEAMMATE: ReadonlySet<string> = new Set(['Read', 'Edit', 'ExitPlanMode'])

describe('buildSubagentPlanModeAttachment (#224)', () => {
  test('returns null outside plan mode', () => {
    for (const mode of ['default', 'auto', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(
        buildSubagentPlanModeAttachment({ mode, agentId: AGENT, toolNames: WEB_ONLY }),
      ).toBeNull()
    }
  })

  test('in plan mode it is a sub-agent attachment on the child own plan path', () => {
    const a = buildSubagentPlanModeAttachment({
      mode: 'plan',
      agentId: AGENT,
      toolNames: WEB_ONLY,
    })
    if (a?.type !== 'plan_mode') throw new Error('expected a plan_mode attachment')
    expect(a.isSubAgent).toBe(true)
    // isSubAgent is what routes the renderer to the sub-agent wording; without
    // it the child would get the main-thread brief.
    expect(a.planFilePath).toContain(`agent-${AGENT}`)
  })

  test('canExitPlanMode follows the child own tool list, not the parent', () => {
    const webOnly = buildSubagentPlanModeAttachment({
      mode: 'plan',
      agentId: AGENT,
      toolNames: WEB_ONLY,
    })
    const teammate = buildSubagentPlanModeAttachment({
      mode: 'plan',
      agentId: AGENT,
      toolNames: TEAMMATE,
    })
    if (webOnly?.type !== 'plan_mode' || teammate?.type !== 'plan_mode') {
      throw new Error('expected plan_mode attachments')
    }
    // A WebResearcher holds neither ExitPlanMode nor Write; telling it to file
    // a plan is what read as injected page content.
    expect(webOnly.canExitPlanMode).toBe(false)
    expect(teammate.canExitPlanMode).toBe(true)
  })
})
