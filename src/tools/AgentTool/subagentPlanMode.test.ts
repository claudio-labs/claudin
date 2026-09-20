import { describe, expect, test } from 'bun:test'
import type { AgentId } from 'src/shared/types/ids.js'
import { buildSubagentPlanModeAttachment } from 'src/tools/AgentTool/subagentPlanMode.js'

const AGENT = 'agent224' as AgentId
const WEB_ONLY: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch'])
const TEAMMATE: ReadonlySet<string> = new Set(['Read', 'Edit', 'ExitPlanMode'])

// The plan deps are injected, so nothing here touches the filesystem — and,
// more to the point, nothing here reads the real getPlanFilePath, which
// planDossier.test.ts mock.modules for the whole `bun test` run.
function makeDeps(planBody: string | null = null) {
  const seen: (AgentId | undefined)[] = []
  return {
    seen,
    deps: {
      getPlanFilePath: (id?: AgentId) => {
        seen.push(id)
        return `/plans/slug-agent-${id}.md`
      },
      getPlan: () => planBody,
    },
  }
}

describe('buildSubagentPlanModeAttachment (#224)', () => {
  test('returns null outside plan mode', () => {
    for (const mode of ['default', 'auto', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(
        buildSubagentPlanModeAttachment(
          { mode, agentId: AGENT, toolNames: WEB_ONLY },
          makeDeps().deps,
        ),
      ).toBeNull()
    }
  })

  test('in plan mode it is a sub-agent attachment on the child own plan path', () => {
    const { seen, deps } = makeDeps()
    const a = buildSubagentPlanModeAttachment(
      { mode: 'plan', agentId: AGENT, toolNames: WEB_ONLY },
      deps,
    )
    if (a?.type !== 'plan_mode') throw new Error('expected a plan_mode attachment')
    expect(a.isSubAgent).toBe(true)
    // isSubAgent is what routes the renderer to the sub-agent wording; without
    // it the child would get the main-thread brief.
    // The CHILD's id, not the parent's: the two resolve to different files.
    expect(seen).toEqual([AGENT])
    expect(a.planFilePath).toBe(`/plans/slug-agent-${AGENT}.md`)
    expect(a.planExists).toBe(false)
  })

  test('planExists reflects whether the child plan file is there', () => {
    const a = buildSubagentPlanModeAttachment(
      { mode: 'plan', agentId: AGENT, toolNames: TEAMMATE },
      makeDeps('# a plan').deps,
    )
    if (a?.type !== 'plan_mode') throw new Error('expected a plan_mode attachment')
    expect(a.planExists).toBe(true)
  })

  test('canExitPlanMode follows the child own tool list, not the parent', () => {
    const webOnly = buildSubagentPlanModeAttachment(
      { mode: 'plan', agentId: AGENT, toolNames: WEB_ONLY },
      makeDeps().deps,
    )
    const teammate = buildSubagentPlanModeAttachment(
      { mode: 'plan', agentId: AGENT, toolNames: TEAMMATE },
      makeDeps().deps,
    )
    if (webOnly?.type !== 'plan_mode' || teammate?.type !== 'plan_mode') {
      throw new Error('expected plan_mode attachments')
    }
    // A WebResearcher holds neither ExitPlanMode nor Write; telling it to file
    // a plan is what read as injected page content.
    expect(webOnly.canExitPlanMode).toBe(false)
    expect(teammate.canExitPlanMode).toBe(true)
  })
})
