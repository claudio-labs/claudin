// After a compaction the model is told its /goal again, so the summary cannot
// lose the condition the stop check enforces. compact.ts runs only behind a
// real model call, so its two call sites are pinned on the source and the
// attachment itself is rendered here.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildGoalStatusAttachment } from 'src/agent/goal/goal.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/attachments.js'

describe('goal_status after compaction', () => {
  test('both compaction paths re-attach the goal, main conversation only', () => {
    const source = readFileSync(new URL('./compact.ts', import.meta.url), 'utf8')
    const site =
      '    const goalAttachment = context.agentId\n      ? null\n      : buildGoalStatusAttachment(context.getAppState().activeGoal)\n    if (goalAttachment) {\n      postCompactFileAttachments.push(createAttachmentMessage(goalAttachment))\n    }\n'
    expect(source.split(site).length - 1).toBe(2)
  })

  test('no goal, no attachment', () => {
    expect(buildGoalStatusAttachment(undefined)).toBeNull()
  })

  test('the model reads the goal as a system reminder', () => {
    const attachment = buildGoalStatusAttachment({ condition: 'tests pass', iterations: 1, setAt: 1, lastCheckReason: 'two fail' })!
    const [message] = normalizeAttachmentForAPI(attachment)
    const content = message!.message.content
    const text = typeof content === 'string' ? content : content.map(b => ('text' in b ? b.text : '')).join('')
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('confirms this condition is met: "tests pass".')
    expect(text).toContain("The evaluator's last reason it is not met: two fail")
    expect(message!.isMeta).toBe(true)
  })
})
