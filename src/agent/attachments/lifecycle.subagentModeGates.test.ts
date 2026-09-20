// #224: a sub-agent was receiving the parent session's plan-mode and auto-mode
// reminders. For a child the attachment pipeline only ever runs mid-tool-loop
// (query.ts calls it with input === null), so the reminder arrived merged into
// the same user turn as the tool_result before it, and two WebResearcher agents
// reported it as a prompt-injection attempt inside the page they had just
// fetched. The child's plan-mode brief now comes from runAgent
// (src/tools/AgentTool/subagentPlanMode.ts); these four producers must emit
// nothing for a child, and must not touch the process-global one-shots.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAutoModeAttachments,
  getAutoModeExitAttachment,
  getPlanModeAttachments,
  getPlanModeExitAttachment,
} from 'src/agent/attachments/lifecycle.js'
import {
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from 'src/platform/bootstrap/state.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

function makeContext(args: { agentId?: string; mode: string }): ToolUseContext {
  return {
    agentId: args.agentId,
    options: {
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({
      toolPermissionContext: { mode: args.mode },
      mcp: { commands: [] },
    }),
    setAppState: () => {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

const CHILD = 'agent_224'

describe('mode reminders are main-thread only (#224)', () => {
  afterEach(() => {
    // Both are process-global one-shots; a leaked `true` would fire in whatever
    // file `bun test` reaches next.
    setNeedsPlanModeExitAttachment(false)
    setNeedsAutoModeExitAttachment(false)
  })

  test('plan_mode: nothing for a sub-agent, even in plan mode', async () => {
    const ctx = makeContext({ agentId: CHILD, mode: 'plan' })
    expect(await getPlanModeAttachments([], ctx)).toEqual([])
  })

  test('plan_mode: the main thread still gets it', async () => {
    const out = await getPlanModeAttachments([], makeContext({ mode: 'plan' }))
    expect(out.some(a => a.type === 'plan_mode')).toBe(true)
  })

  test('plan_mode_exit: a sub-agent does not consume the parent one-shot', async () => {
    setNeedsPlanModeExitAttachment(true)
    const ctx = makeContext({ agentId: CHILD, mode: 'default' })
    expect(await getPlanModeExitAttachment(ctx)).toEqual([])
    // The gate has to sit BEFORE the flag read, because the producer clears it:
    // a child reaching it first would swallow the parent's notice.
    expect(needsPlanModeExitAttachment()).toBe(true)
  })

  test('plan_mode_exit: the main thread gets it, once', async () => {
    setNeedsPlanModeExitAttachment(true)
    const out = await getPlanModeExitAttachment(makeContext({ mode: 'default' }))
    expect(out).toHaveLength(1)
    expect(needsPlanModeExitAttachment()).toBe(false)
  })

  test('auto_mode: nothing for a sub-agent', async () => {
    const ctx = makeContext({ agentId: CHILD, mode: 'auto' })
    expect(await getAutoModeAttachments([], ctx)).toEqual([])
  })

  test('auto_mode: the main thread still gets it', async () => {
    const out = await getAutoModeAttachments([], makeContext({ mode: 'auto' }))
    expect(out.some(a => a.type === 'auto_mode')).toBe(true)
  })

  test('auto_mode_exit: a sub-agent does not consume the parent one-shot', async () => {
    setNeedsAutoModeExitAttachment(true)
    const ctx = makeContext({ agentId: CHILD, mode: 'default' })
    expect(await getAutoModeExitAttachment(ctx)).toEqual([])
    expect(needsAutoModeExitAttachment()).toBe(true)
  })

  test('auto_mode_exit: the main thread gets it, once', async () => {
    setNeedsAutoModeExitAttachment(true)
    const out = await getAutoModeExitAttachment(makeContext({ mode: 'default' }))
    expect(out).toHaveLength(1)
    expect(needsAutoModeExitAttachment()).toBe(false)
  })
})
