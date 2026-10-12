import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from 'src/skills/bundledSkills.js'
import { registerCreateSkill } from 'src/skills/bundled/create.js'

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
    expect(skill.argumentHint).toBe('[skill|rule|agent|hook|plugin] [description]')
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

  test('the full guide points at hooks and plugins instead of embedding them', async () => {
    const text = await getPromptText('')
    expect(text).toContain('## Hooks and plugins')
    expect(text).toContain('args\n`hook <the request>` or `plugin <the request>`')
    expect(text).not.toContain('## Hooks Configuration')
    expect(text).not.toContain('## Plugins')
  })
})

describe('/create hook', () => {
  test('narrows to the hook contract, shared with /update-config', async () => {
    const text = await getPromptText('hooks run prettier after every edit')
    expect(text).toContain('## Hooks\n')
    expect(text).toContain('## Hooks Configuration')
    expect(text).toContain('## Constructing a Hook (with verification)')
    expect(text).not.toContain('## Skills')
    expect(text).not.toContain('## Plugins')
    expect(text).toContain('Artifact type: hook. run prettier after every edit')
  })

  test('names every place a hook can live', async () => {
    const text = await getPromptText('hook')
    for (const place of [
      '`~/.claudin/settings.json`',
      '`.claudin/settings.json`',
      '`.claudin/settings.local.json`',
      '`hooks:` in the skill',
      '`hooks:` in `.claudin/agents/<name>.md`',
      '`hooks/hooks.json`',
    ]) {
      expect(text).toContain(place)
    }
    // registerFrontmatterHooks renames an agent's Stop hook.
    expect(text).toContain('`SubagentStop`')
  })
})

describe('/create plugin', () => {
  test('narrows to the plugin contract', async () => {
    const text = await getPromptText('plugins bundle my review skills')
    expect(text).toContain('## Plugins')
    expect(text).not.toContain('## Hooks Configuration')
    expect(text).not.toContain('## Skills')
    expect(text).toContain('Artifact type: plugin. bundle my review skills')
  })

  test('plugin contract matches the loader', async () => {
    const text = await getPromptText('plugin')
    // pluginLoader.ts reads the manifest from .claude-plugin/, not .claudin-plugin/
    expect(text).toContain('.claude-plugin/')
    expect(text).toContain('plugin.json')
    expect(text).not.toContain('.claudin-plugin')
    expect(text).toContain('${CLAUDIN_PLUGIN_ROOT}')
    expect(text).toContain('${CLAUDIN_PLUGIN_DATA}')
    expect(text).toContain('`/my-plugin:review`')
    // loadPluginAgents.ts: model is read, these three are ignored
    expect(text).toContain('Plugin agents **do** accept `model`')
    expect(text).toContain('`permissionMode`, `hooks` and `mcpServers`')
    expect(text).toContain('.claude-plugin/marketplace.json')
  })

  test('verification uses the real CLI entry points', async () => {
    const text = await getPromptText('plugin')
    expect(text).toContain('claudin plugin validate <plugin-dir>')
    expect(text).toContain('claudin --plugin-dir <plugin-dir>')
  })
})
