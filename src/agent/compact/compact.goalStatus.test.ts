// After a compaction the model is told its /goal again, so the summary cannot
// lose the condition the stop check enforces. compact.ts runs only behind a
// real model call, so its two call sites are pinned on the source; the helper
// they call and the attachment it renders are tested here.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createGoalStatusAttachmentIfNeeded } from 'src/agent/compact/postCompactAttachments.js'
import { buildGoalStatusAttachment } from 'src/agent/goal/goal.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/attachments.js'
import type { AgentId } from 'src/shared/types/ids.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

const GOAL = { condition: 'tests pass', iterations: 1, setAt: 1, lastCheckReason: 'two fail' }
const context = (agentId?: AgentId, activeGoal: AppState['activeGoal'] = GOAL) => ({
  agentId,
  getAppState: () => ({ activeGoal }) as AppState,
})

describe('goal_status after compaction', () => {
  test('both compaction paths re-attach the goal', () => {
    const source = readFileSync(new URL('./compact.ts', import.meta.url), 'utf8')
    const site =
      '    const goalAttachment = createGoalStatusAttachmentIfNeeded(context)\n    if (goalAttachment) {\n      postCompactFileAttachments.push(goalAttachment)\n    }\n'
    expect(source.split(site).length - 1).toBe(2)
  })

  test('the main conversation gets the live goal; a sub-agent and no goal get nothing', () => {
    expect(createGoalStatusAttachmentIfNeeded(context())?.attachment).toEqual(buildGoalStatusAttachment(GOAL)!)
    expect(createGoalStatusAttachmentIfNeeded(context('agent_1' as AgentId))).toBeNull()
    expect(createGoalStatusAttachmentIfNeeded({ agentId: undefined, getAppState: () => ({}) as AppState })).toBeNull()
  })

  test('no goal, no attachment', () => {
    expect(buildGoalStatusAttachment(undefined)).toBeNull()
  })

  test('the model reads the goal as a system reminder', () => {
    const attachment = buildGoalStatusAttachment(GOAL)!
    const [message] = normalizeAttachmentForAPI(attachment)
    const content = message!.message.content
    const text = typeof content === 'string' ? content : content.map(b => ('text' in b ? b.text : '')).join('')
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('confirms this condition is met: "tests pass".')
    expect(text).toContain("The evaluator's last reason it is not met: two fail")
    expect(message!.isMeta).toBe(true)
  })
})
