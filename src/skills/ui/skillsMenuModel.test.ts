import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import type { Command } from 'src/commands/commands.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import { formatTokens } from 'src/shared/text/format.js'
import { estimateSkillFrontmatterTokens, getSkillsPath } from 'src/skills/loadSkillsDir.js'
import { SkillsMenu } from 'src/skills/ui/SkillsMenu.js'
import {
  groupSkills,
  isSkill,
  mcpServerOf,
  type Skill,
  type SkillGroup,
  type SkillsMenuDeps,
  skillCountText,
  skillLabel,
} from 'src/skills/ui/skillsMenuModel.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const WHITESPACE_RE = /\s+/g

/** Stand-ins that make it visible which source, directory and skill each piece of text came from. */
const deps: SkillsMenuDeps = {
  directoryOf: (source, dir) => `${source}/${dir}`,
  estimateOf: skill => `est(${skill.name})`,
}

/** A project skill, as the skills-directory loader shapes one, unless told otherwise. */
function skill(name: string, fields: Partial<Skill> = {}): Skill {
  return {
    type: 'prompt',
    name,
    description: `${name} in a sentence`,
    source: 'projectSettings',
    loadedFrom: 'skills',
    progressMessage: 'running',
    contentLength: 0,
    getPromptForCommand: async () => [],
    ...fields,
  }
}

const mcpSkill = (name: string): Skill => skill(name, { source: 'mcp', loadedFrom: 'mcp' })

function pluginSkill(name: string, pluginName?: string): Skill {
  const pluginInfo =
    pluginName === undefined ? undefined : { pluginManifest: { name: pluginName }, repository: `${pluginName}@market` }
  return skill(name, { source: 'plugin', loadedFrom: 'plugin', pluginInfo })
}

const titles = (groups: SkillGroup[]): string[] => groups.map(group => group.title)
const labels = (group: SkillGroup | undefined): string[] => group?.rows.map(row => row.label) ?? []
const lines = (group: SkillGroup | undefined): string[] => group?.rows.map(row => row.label + row.detail) ?? []

describe('isSkill', () => {
  test.each(['skills', 'commands_DEPRECATED', 'plugin', 'mcp'] as const)(
    'takes a prompt command loaded from %s',
    loadedFrom => {
      expect(isSkill(skill('x', { loadedFrom }))).toBe(true)
    },
  )

  test.each(['bundled', 'managed', undefined] as const)('leaves out a prompt command loaded from %s', loadedFrom => {
    expect(isSkill(skill('x', { loadedFrom }))).toBe(false)
  })

  test('takes a skill hidden from typeahead, from users and from the model', () => {
    expect(isSkill(skill('x', { isHidden: true, userInvocable: false, disableModelInvocation: true }))).toBe(true)
  })

  test('leaves out local and local-JSX commands whatever their origin', () => {
    const local: Command = {
      type: 'local',
      name: 'local',
      description: 'a local command',
      loadedFrom: 'skills',
      supportsNonInteractive: false,
      load: async () => ({ call: async () => ({ type: 'skip' }) }),
    }
    const localJsx: Command = {
      type: 'local-jsx',
      name: 'dialog',
      description: 'a dialog',
      loadedFrom: 'plugin',
      load: async () => ({ call: async () => null }),
    }
    expect([local, localJsx].filter(isSkill)).toEqual([])
  })
})

describe('skillLabel', () => {
  test.each([
    ['plain', 'plain'],
    ['frontend:lint', 'frontend:lint - lint'],
    ['infra:deploy:canary', 'infra:deploy:canary - canary'],
    [':leading', ':leading - leading'],
    ['odd:', 'odd: - '],
  ])('%s reads %p', (name, label) => {
    expect(skillLabel(name)).toBe(label)
  })
})

describe('mcpServerOf', () => {
  test.each([
    ['srv:deploy', 'srv'],
    ['zeta:ops:rollback', 'zeta'],
    ['odd:', 'odd'],
    ['plain', undefined],
    [':leading', undefined],
  ])('%s names %p', (name, server) => {
    expect(mcpServerOf(name)).toBe(server)
  })
})

describe('groupSkills: groups', () => {
  test('come in the order project, user, managed, plugin, MCP, and an empty one is left out', () => {
    const groups = groupSkills(
      [mcpSkill('srv:m'), skill('u', { source: 'userSettings' }), skill('p'), pluginSkill('kit:k')],
      deps,
    )
    expect(titles(groups)).toEqual(['Project skills', 'User skills', 'Plugin skills', 'MCP skills'])
    expect(groups.map(group => group.source)).toEqual(['projectSettings', 'userSettings', 'plugin', 'mcp'])
  })

  test('leave out a skill whose source has none, and a command that is no skill', () => {
    const groups = groupSkills(
      [
        skill('gitignored', { source: 'localSettings' }),
        skill('from-flag', { source: 'flagSettings' }),
        skill('built-in', { source: 'builtin' }),
        skill('shipped', { source: 'bundled' }),
        skill('bundled-prompt', { loadedFrom: 'bundled' }),
      ],
      deps,
    )
    expect(groups).toEqual([])
  })

  test('are empty for no commands at all', () => {
    expect(groupSkills([], deps)).toEqual([])
  })
})

describe('groupSkills: subtitles', () => {
  test('a file-based group names its skills directory, and its commands directory once it holds a legacy command', () => {
    const groups = groupSkills(
      [
        skill('modern'),
        skill('legacy', { loadedFrom: 'commands_DEPRECATED' }),
        skill('user-modern', { source: 'userSettings' }),
        skill('managed-legacy', { source: 'policySettings', loadedFrom: 'commands_DEPRECATED' }),
      ],
      deps,
    )
    expect(groups.map(group => group.subtitle)).toEqual([
      'projectSettings/skills, projectSettings/commands',
      'userSettings/skills',
      'policySettings/skills, policySettings/commands',
    ])
  })

  test('the plugin group asks for its directory the same way; the real getSkillsPath calls it `plugin`', () => {
    expect(groupSkills([pluginSkill('kit:one')], deps)[0]?.subtitle).toBe('plugin/skills')
    expect(getDisplayPath(getSkillsPath('plugin', 'skills'))).toBe('plugin')
  })

  test('the MCP group names each server once, in the order of its rows', () => {
    const [group] = groupSkills(['zeta:deploy', 'alpha:lint', 'zeta:ops:rollback', 'alpha:test'].map(mcpSkill), deps)
    expect(group?.subtitle).toBe('alpha, zeta')
  })

  test('an MCP group whose skills name no server has no subtitle', () => {
    const [group] = groupSkills([mcpSkill('plain'), mcpSkill(':leading')], deps)
    expect(group?.title).toBe('MCP skills')
    expect(group?.subtitle).toBeUndefined()
  })
})

describe('groupSkills: rows', () => {
  test('are sorted by name the way localeCompare orders them, not by code unit', () => {
    const [group] = groupSkills(['charlie', 'Bravo', 'delta', 'alpha'].map(name => skill(name)), deps)
    expect(labels(group)).toEqual(['alpha', 'Bravo', 'charlie', 'delta'])
  })

  test('read the label, then the estimate; the description is not shown', () => {
    const [group] = groupSkills([skill('frontend:lint', { description: 'lints the frontend' })], deps)
    expect(lines(group)).toEqual(['frontend:lint - lint · ~est(frontend:lint) description tokens'])
  })

  test('name the plugin after the label only for a plugin skill whose manifest names one', () => {
    const groups = groupSkills(
      [
        pluginSkill('tools:format', 'code-tools'),
        pluginSkill('tools:bare'),
        pluginSkill('tools:unnamed', ''),
        skill('local-format', { pluginInfo: { pluginManifest: { name: 'ghost' }, repository: 'ghost@market' } }),
      ],
      deps,
    )
    expect(lines(groups[0])).toEqual(['local-format · ~est(local-format) description tokens'])
    expect(lines(groups[1])).toEqual([
      'tools:bare - bare · ~est(tools:bare) description tokens',
      'tools:format - format · code-tools · ~est(tools:format) description tokens',
      'tools:unnamed - unnamed · ~est(tools:unnamed) description tokens',
    ])
  })

  test('build the label from the name, never from the user-facing name', () => {
    const renamed = skill('tools:raw-name', { source: 'plugin', loadedFrom: 'plugin', userFacingName: () => 'Nice Name' })
    const [group] = groupSkills([renamed], deps)
    expect(labels(group)).toEqual(['tools:raw-name - raw-name'])
  })

  test('list two skills of one name both, each under a key of its own', () => {
    const [group] = groupSkills([skill('deploy'), skill('deploy', { description: 'another' }), skill('build')], deps)
    expect(labels(group)).toEqual(['build', 'deploy', 'deploy'])
    const keys = group?.rows.map(row => row.key) ?? []
    expect(new Set(keys).size).toBe(3)
  })
})

describe('skillCountText', () => {
  test('counts the rows across every group, singular for one', () => {
    expect(skillCountText(groupSkills([skill('only')], deps))).toBe('1 skill')
    expect(skillCountText(groupSkills([skill('a'), skill('b', { source: 'userSettings' }), mcpSkill('s:c')], deps))).toBe(
      '3 skills',
    )
  })

  test('does not count a skill that no group shows', () => {
    const groups = groupSkills([skill('listed'), skill('gitignored', { source: 'localSettings' })], deps)
    expect(skillCountText(groups)).toBe('1 skill')
  })
})

// The one render in this file: the layout, not the model. At a width that
// forces a wrap, a heading or a row split into sibling Texts turns into
// columns that wrap on their own and interleave (.claudin/rules/ink-tui.md §10).
describe('SkillsMenu at a narrow width', () => {
  const COLUMNS = 36

  async function paint(commands: Command[]): Promise<string> {
    const terminal = createFakeTerminal({ columns: COLUMNS })
    const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
    const menu = createElement(SkillsMenu, { onExit: () => undefined, commands })
    root.render(createElement(AppStateProvider, null, createElement(KeybindingSetup, null, menu)))
    try {
      const deadline = Date.now() + 8_000
      while (!terminal.screen().includes('to close')) {
        if (Date.now() > deadline) throw new Error(`The dialog never painted:\n${terminal.transcript().slice(-1500)}`)
        await Bun.sleep(20)
      }
      return terminal.screen()
    } finally {
      root.unmount()
      terminal.close()
      await Bun.sleep(0)
    }
  }

  const squash = (text: string): string => text.replace(WHITESPACE_RE, '')
  const estimate = (command: Command): string => `~${formatTokens(estimateSkillFrontmatterTokens(command))}`

  test(
    'keeps each heading and each row whole and in order when it wraps',
    async () => {
      const managed = skill('managed-one', { source: 'policySettings' })
      const named = pluginSkill('tools:format', 'code-tools')
      const expected = [
        `Managed skills (${getDisplayPath(getSkillsPath('policySettings', 'skills'))})`,
        `managed-one · ${estimate(managed)} description tokens`,
        `tools:format - format · code-tools · ${estimate(named)} description tokens`,
      ]
      const frame = await paint([managed, named])
      const screenLines = frame.split('\n')
      for (const text of expected) {
        // The width has to break every one of them, or this proves nothing.
        expect(screenLines.some(line => line.includes(text))).toBe(false)
        expect(squash(frame)).toContain(squash(text))
      }
    },
    30_000,
  )
})
