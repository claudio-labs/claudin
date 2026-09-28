import { afterEach, expect, test } from 'bun:test'

import { registerUpdateConfigSkill } from 'src/skills/bundled/updateConfig.js'
import { clearBundledSkills, getBundledSkills } from 'src/skills/bundledSkills.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

afterEach(() => clearBundledSkills())

// The inherited prompts told users to run another product's binary; the
// rewrite takes the name from CLI_COMMAND, and this is what keeps it there.
test('command-line advice in the prompts names this CLI', async () => {
  registerUpdateConfigSkill()
  const updateConfig = getBundledSkills().find(command => command.name === 'update-config')
  if (updateConfig === undefined) throw new Error('update-config did not register')

  const blocks = await updateConfig.getPromptForCommand('', {} as ToolUseContext)
  const text = blocks.map(block => (block.type === 'text' ? block.text : '')).join('\n')

  expect(text).toContain('`claudin --debug`')
  expect(text).not.toContain('`claude --debug`')
})
