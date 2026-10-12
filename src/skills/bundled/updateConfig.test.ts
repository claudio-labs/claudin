import { afterEach, expect, test } from 'bun:test'

import { HOOK_EVENTS } from 'src/platform/entrypoints/agentSdkTypes.js'
import { clearBundledSkills, getBundledSkills } from 'src/skills/bundledSkills.js'
import { registerUpdateConfigSkill } from 'src/skills/bundled/updateConfig.js'

afterEach(() => {
  clearBundledSkills()
})

async function getPromptText(args: string): Promise<string> {
  registerUpdateConfigSkill()
  const skill = getBundledSkills().find(command => command.name === 'update-config')
  if (skill?.type !== 'prompt') throw new Error('expected a prompt skill')
  const blocks = await skill.getPromptForCommand(args, {} as never)
  expect(blocks[0]).toMatchObject({ type: 'text' })
  return (blocks[0] as { text: string }).text
}

test('update-config skill can generate its prompt without JSON Schema conversion errors', async () => {
  registerUpdateConfigSkill()

  const skill = getBundledSkills().find(command => command.name === 'update-config')
  expect(skill).toBeDefined()
  expect(skill?.type).toBe('prompt')
  if (skill?.type !== 'prompt') throw new Error('unreachable')

  const blocks = await skill.getPromptForCommand('', {} as never)
  expect(blocks.length).toBeGreaterThan(0)
  expect(blocks[0]).toMatchObject({ type: 'text' })
  expect((blocks[0] as { text: string }).text).toContain(
    '## Full Settings JSON Schema',
  )
})

// `/init` loads the hook reference through `[hooks-only]` (src/commands/init.ts),
// so this text is a contract with a caller, not only with the user.
test('[hooks-only] returns exactly the hook reference and verification flow', async () => {
  expect(await getPromptText('[hooks-only]')).toMatchSnapshot()
})

test('[hooks-only] appends the request as a Task section', async () => {
  const text = await getPromptText('[hooks-only] format on save with ruff')
  expect(text.startsWith('## Hooks Configuration')).toBe(true)
  expect(text.endsWith('\n\n## Task\n\nformat on save with ruff')).toBe(true)
  expect(text).not.toContain('# Update Config Skill')
})

test('[hooks-only] without a request has no Task section', async () => {
  expect(await getPromptText('[hooks-only]')).not.toContain('## Task')
})

test('the events table has a row for every event the schema accepts', async () => {
  const text = await getPromptText('[hooks-only]')
  for (const event of HOOK_EVENTS) {
    expect(text).toContain(`| ${event} |`)
  }
  // Generated rows carry the matcher the /hooks menu knows about.
  expect(text).toContain('| SessionEnd | "clear"/"logout"/')
  expect(text).toContain('| SubagentStart | `agent_type` |')
})

test('every hook type the schema accepts is documented', async () => {
  const text = await getPromptText('[hooks-only]')
  for (const type of ['command', 'prompt', 'agent', 'http']) {
    expect(text).toContain(`{ "type": "${type}"`)
  }
  expect(text).toContain('allowedHttpHookUrls')
})

test('full prompt embeds the hook reference and the user request', async () => {
  const text = await getPromptText('allow npm commands')
  expect(text.startsWith('# Update Config Skill')).toBe(true)
  expect(text).toContain('## Hooks Configuration')
  expect(text).toContain('## Constructing a Hook (with verification)')
  expect(text).toContain('`claudin --debug`')
  expect(text).not.toContain('`claude --debug`')
  expect(text.endsWith('## User Request\n\nallow npm commands')).toBe(true)
})
