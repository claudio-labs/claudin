import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerCreateSkill } from './create.js'

beforeEach(() => {
  clearBundledSkills()
  registerCreateSkill()
})

afterEach(() => {
  clearBundledSkills()
})

function getSkill() {
  const skill = getBundledSkills().find(command => command.name === 'create')
  expect(skill).toBeDefined()
  if (skill?.type !== 'prompt') throw new Error('expected a prompt skill')
  return skill
}

async function getPromptText(args: string): Promise<string> {
  const blocks = await getSkill().getPromptForCommand(args, {} as never)
  expect(blocks.length).toBeGreaterThan(0)
  expect(blocks[0]).toMatchObject({ type: 'text' })
  return (blocks[0] as { text: string }).text
}

describe('/create registration', () => {
  test('registers as a user-invocable, model-invocable prompt skill', () => {
    const skill = getSkill()
    expect(skill.type).toBe('prompt')
    expect(skill.userInvocable).toBe(true)
    expect(skill.disableModelInvocation).toBe(false)
    expect(skill.allowedTools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
  })
})

describe('/create prompt content', () => {
  test('full guide covers all three artifact types and Claudin paths', async () => {
    const text = await getPromptText('')
    expect(text).toContain('.claudin/skills/<name>/SKILL.md')
    expect(text).toContain('.claudin/agents/<name>.md')
    expect(text).toContain('.claudin/rules/<topic>.md')
    expect(text).toContain('~/.claudin/')
    // Loader gotchas the skill exists to prevent
    expect(text).toContain('**Not supported** in agent markdown')
    expect(text).toContain('`alwaysApply`')
    expect(text).toContain('deprecated')
  })

  test('frontmatter contract matches the loaders', async () => {
    const text = await getPromptText('')
    // Skills: parseSkillFrontmatterFields (loadSkillsDir.ts)
    for (const key of [
      'when_to_use',
      'allowed-tools',
      'argument-hint',
      'disable-model-invocation',
      'user-invocable',
      '$ARGUMENTS',
    ]) {
      expect(text).toContain(key)
    }
    // Agents: parseAgentFromMarkdown (loadAgentsDir.ts)
    for (const key of ['permissionMode', 'maxTurns', 'disallowedTools', 'initialPrompt', 'mcpServers']) {
      expect(text).toContain(key)
    }
    // Rules: parseFrontmatterPaths (claudemd.ts) — `paths` is the only key
    expect(text).toContain('paths')
  })

  test('type argument narrows the guide to one section', async () => {
    const ruleText = await getPromptText('rule enforce API error handling')
    expect(ruleText).toContain('## Rules')
    expect(ruleText).not.toContain('## Agents')
    expect(ruleText).not.toContain('## Skills')
    expect(ruleText).toContain('Artifact type: rule. enforce API error handling')

    const agentText = await getPromptText('subagent')
    expect(agentText).toContain('## Agents')
    expect(agentText).not.toContain('## Rules')
  })

  test('unknown first word falls back to the full guide as the request', async () => {
    const text = await getPromptText('something to review my PRs')
    expect(text).toContain('## Skills')
    expect(text).toContain('## Rules')
    expect(text).toContain('## Agents')
    expect(text).toContain('something to review my PRs')
  })
})
