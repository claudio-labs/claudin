import { afterEach, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from 'src/skills/bundledSkills.js'
import { registerLoopSkill } from 'src/skills/bundled/loop.js'

afterEach(() => {
  clearBundledSkills()
})

test('bare /loop returns dynamic maintenance instructions', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  expect(skill).toBeDefined()
  expect(skill?.type).toBe('prompt')

  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('# /loop — dynamic rescheduling')
  expect(text).toContain('If .claudin/loop.md exists, read it and use it.')
  expect(text).toContain('continue any unfinished work from the conversation')
  expect(text).toContain('call ScheduleWakeup exactly once')
  // Maintenance loops reschedule via the dynamic sentinel, not an inlined
  // prompt — the runtime expands it at delivery time (cache-friendly).
  expect(text).toContain('<<autonomous-loop-dynamic>>')
  expect(text).toContain('a sentinel the runtime expands at delivery time')
})

test('prompt-only /loop returns dynamic rescheduling instructions', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('check the deploy', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('# /loop — dynamic rescheduling')
  expect(text).toContain('check the deploy')
  expect(text).toContain('call ScheduleWakeup exactly once')
  expect(text).toContain('The runtime clamps to [60, 3600] seconds.')
  // The reschedule prompt repeats the original /loop invocation verbatim.
  expect(text).toContain('/loop check the deploy')
  // Dynamic mode no longer emulates wakeups via one-shot crons.
  expect(text).toContain('Do not use CronCreate in this mode.')
  // Monitor-as-primary-wake-signal stretch (MonitorTool ships enabled).
  expect(text).toContain('Monitor')
  expect(text).toContain('fallback heartbeat')
  // Ending the loop = not calling ScheduleWakeup again.
  expect(text).toContain('do not call ScheduleWakeup')
})

test('interval /loop returns fixed recurring instructions', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('5m check the deploy', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('# /loop — fixed recurring interval')
  expect(text).toContain('Requested interval:')
  expect(text).toContain('5m')
  expect(text).toContain('Call CronCreate')
  expect(text).toContain('recurring: true')
  expect(text).toContain('Immediately execute the effective prompt now')
})

test('interval-only /loop becomes fixed maintenance mode', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('15m', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('# /loop — fixed recurring interval')
  expect(text).toContain('15m')
  expect(text).toContain('This is a maintenance loop with no explicit prompt.')
  // The recurring scheduled body is the sentinel (expanded at delivery
  // time); the full maintenance prompt is still inlined for the immediate run.
  expect(text).toContain('<<autonomous-loop>>')
  expect(text).toContain('Scheduled maintenance loop iteration.')
})

test('trailing every clause parses interval and prompt', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('check the deploy every 20m', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('# /loop — fixed recurring interval')
  expect(text).toContain('20m')
  expect(text).toContain('check the deploy')
})

test('trailing every clause with word unit parses correctly', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('run tests every 5 minutes', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('# /loop — fixed recurring interval')
  expect(text).toContain('5m')
  expect(text).toContain('run tests')
})

test('"check every PR" is not treated as an interval', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('check every PR', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('# /loop — dynamic rescheduling')
  expect(text).toContain('check every PR')
})

test('human-readable hour unit parses correctly', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('2h check logs', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('# /loop — fixed recurring interval')
  expect(text).toContain('2h')
  expect(text).toContain('check logs')
})

test('prompt delimiters are present and unambiguous', async () => {
  registerLoopSkill()

  const skill = getBundledSkills().find(command => command.name === 'loop')
  if (skill?.type !== 'prompt') throw new Error('unreachable')
  const blocks = await skill.getPromptForCommand('5m say hi', {} as never)
  const text = (blocks[0] as { text: string }).text

  expect(text).toContain('--- BEGIN PROMPT ---')
  expect(text).toContain('say hi')
  expect(text).toContain('--- END PROMPT ---')
})
