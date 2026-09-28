/**
 * Characterization suite for the /skills dialog (src/skills/ui/SkillsMenu.tsx),
 * written BEFORE its clean-base rewrite so the new implementation has to pass
 * it unchanged. It drives the component only through its two props and the
 * keyboard, and reads only what a user sees: which commands count as skills,
 * how they are grouped, ordered and labelled, the empty state, and what each
 * key does. docs/tech/rewrite/skills/SkillsMenu.md is the spec it goes with.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import type { Command, CommandBase, PromptCommand } from 'src/commands/commands.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import { formatTokens } from 'src/shared/text/format.js'
import { estimateSkillFrontmatterTokens, getSkillsPath } from 'src/skills/loadSkillsDir.js'
import { SkillsMenu } from 'src/skills/ui/SkillsMenu.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

// Every test mounts a real Ink root and some wait on key parsing, so none of
// them should race bun's 5 s default under a loaded machine.
const TIMEOUT = 30_000

const ESC = '\x1B'
const ENTER = '\r'
const TAB = '\t'
const SHIFT_TAB = '\x1B[Z'
const UP = '\x1B[A'
const DOWN = '\x1B[B'
const RIGHT = '\x1B[C'
const LEFT = '\x1B[D'

/** The rule the pane draws above the dialog. */
const DIVIDER_RE = /^─+$/
/** A group heading: its title, then its subtitle in parentheses. */
const HEADING_RE = /^(.*?) \((.*)\)$/
const COMPACT_ESTIMATE_RE = / · ~\d+(\.\d)?k description tokens$/

type Exit = Parameters<React.ComponentProps<typeof SkillsMenu>['onExit']>
const CLOSED: Exit = ['Skills dialog dismissed', { display: 'system' }]

// --- fixtures ----------------------------------------------------------------

type SkillFields = Partial<CommandBase & PromptCommand>

/** A prompt command shaped like the skill loader's: a project skill unless told otherwise. */
function skill(name: string, fields: SkillFields = {}): Command {
  return {
    type: 'prompt',
    name,
    source: 'projectSettings',
    loadedFrom: 'skills',
    description: `what ${name} does`,
    contentLength: 0,
    progressMessage: 'running',
    getPromptForCommand: async () => [],
    ...fields,
  }
}

const mcpSkill = (name: string, fields: SkillFields = {}) => skill(name, { source: 'mcp', loadedFrom: 'mcp', ...fields })
const pluginSkill = (name: string, fields: SkillFields = {}) =>
  skill(name, { source: 'plugin', loadedFrom: 'plugin', ...fields })

function fromPlugin(name: string): NonNullable<PromptCommand['pluginInfo']> {
  return { pluginManifest: { name }, repository: `${name}@marketplace` } as NonNullable<PromptCommand['pluginInfo']>
}

function localCommand(name: string, loadedFrom: CommandBase['loadedFrom']): Command {
  return {
    type: 'local',
    name,
    description: `the ${name} command`,
    loadedFrom,
    supportsNonInteractive: false,
    load: async () => ({ call: async () => ({ type: 'skip' }) }),
  }
}

function jsxCommand(name: string, loadedFrom: CommandBase['loadedFrom']): Command {
  return {
    type: 'local-jsx',
    name,
    description: `the ${name} command`,
    loadedFrom,
    load: async () => ({ call: async () => null }),
  }
}

/** A row as the dialog prints it, with the estimate the spec prescribes. */
function row(command: Command, label: string, plugin?: string): string {
  const estimate = `~${formatTokens(estimateSkillFrontmatterTokens(command))} description tokens`
  return [label, plugin, estimate].filter(part => part !== undefined).join(' · ')
}

/** Where a source keeps its skills or commands, in the form the dialog shows a path. */
function shown(source: SettingSource | 'plugin', dir: 'skills' | 'commands'): string {
  return getDisplayPath(getSkillsPath(source, dir))
}

// --- reading the screen --------------------------------------------------------

/** The frame's lines, trimmed, in runs separated by blank lines, without the pane's rule. */
function blocks(frame: string): string[][] {
  const runs: string[][] = []
  let run: string[] = []
  for (const line of frame.split('\n').map(l => l.trim())) {
    if (DIVIDER_RE.test(line)) continue
    if (line === '') {
      if (run.length > 0) runs.push(run)
      run = []
    } else {
      run.push(line)
    }
  }
  if (run.length > 0) runs.push(run)
  return runs
}

type Group = { title: string; subtitle?: string; rows: string[] }

/** The listing as a user reads it: the header, one block per group, the footer. */
function readDialog(frame: string): { header: string[]; groups: Group[]; footer: string[] } {
  const runs = blocks(frame)
  const groups = runs.slice(1, -1).map(([heading = '', ...rows]): Group => {
    const match = HEADING_RE.exec(heading)
    return match ? { title: match[1]!, subtitle: match[2]!, rows } : { title: heading, rows }
  })
  return { header: runs[0] ?? [], groups, footer: runs.at(-1) ?? [] }
}

/** The label part of each row: what comes before the first ` · `. */
const labels = (group: Group) => group.rows.map(r => r.split(' · ')[0])

// --- the harness ---------------------------------------------------------------

type Menu = {
  frame: () => string
  exits: Exit[]
  /** Sends one key and gives the input parser time to handle it. */
  press: (key: string) => Promise<void>
  /** Sends a key that closes the dialog and waits for onExit. */
  closeWith: (key: string) => Promise<void>
  dispose: () => Promise<void>
}

async function openMenu(commands: Command[], columns = 120): Promise<Menu> {
  const terminal = createFakeTerminal({ columns })
  const exits: Exit[] = []
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
  root.render(
    <AppStateProvider>
      <KeybindingSetup>
        <SkillsMenu
          onExit={(...args) => {
            exits.push(args)
          }}
          commands={commands}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  const frame = terminal.screen
  // Both states end with the close hint, and a frame is painted whole.
  const firstPaint = Date.now() + 8_000
  while (!frame().includes('to close')) {
    if (Date.now() > firstPaint) throw new Error(`The dialog never painted. Output:\n${terminal.transcript().slice(-1500)}`)
    await Bun.sleep(20)
  }
  // Input handlers subscribe in a passive effect after the paint.
  await Bun.sleep(100)

  return {
    frame,
    exits,
    press: async key => {
      terminal.type(key)
      await Bun.sleep(80)
    },
    // A key written before the input handlers subscribe is dropped, so it is
    // sent again if nothing happened; the window is wide enough that a press
    // which did land is always seen before the next one. A bare ESC resolves
    // only after the parser's sequence timeout.
    closeWith: async key => {
      const before = exits.length
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        terminal.type(key)
        const settle = Date.now() + 2_000
        while (Date.now() < settle) {
          await Bun.sleep(20)
          if (exits.length > before) {
            // Long enough for a second call to show up, if the key made one.
            await Bun.sleep(200)
            return
          }
        }
      }
      throw new Error(`${JSON.stringify(key)} did not close the dialog. Last frame:\n${frame()}`)
    },
    dispose: async () => {
      root.unmount()
      terminal.close()
      await Bun.sleep(0)
    },
  }
}

async function withMenu(commands: Command[], check: (menu: Menu) => Promise<void> | void): Promise<void> {
  const menu = await openMenu(commands)
  try {
    await check(menu)
  } finally {
    await menu.dispose()
  }
}

// --- the suite -----------------------------------------------------------------

describe('SkillsMenu: which commands are skills', () => {
  test(
    'lists prompt commands loaded from a skills directory, a legacy commands directory, a plugin or an MCP server',
    async () => {
      await withMenu(
        [
          skill('from-skills'),
          skill('from-commands', { loadedFrom: 'commands_DEPRECATED' }),
          // Hidden from typeahead and from the model: still a skill here.
          skill('hidden', { isHidden: true, userInvocable: false, disableModelInvocation: true }),
          pluginSkill('tools:from-plugin'),
          mcpSkill('server:from-mcp'),
        ],
        menu => {
          const { header, groups } = readDialog(menu.frame())
          expect(header).toEqual(['Skills', '5 skills'])
          expect(groups.flatMap(labels)).toEqual([
            'from-commands',
            'from-skills',
            'hidden',
            'tools:from-plugin - from-plugin',
            'server:from-mcp - from-mcp',
          ])
        },
      )
    },
    TIMEOUT,
  )

  test(
    'leaves out bundled, managed and unlabelled prompts, and local or JSX commands whatever their origin',
    async () => {
      await withMenu(
        [
          skill('the-skill'),
          skill('bundled-skill', { source: 'bundled', loadedFrom: 'bundled' }),
          skill('managed-command', { source: 'policySettings', loadedFrom: 'managed' }),
          skill('builtin-prompt', { source: 'builtin', loadedFrom: undefined }),
          skill('server:mcp-prompt', { source: 'mcp', loadedFrom: undefined }),
          skill('plugin-command', { source: 'plugin', loadedFrom: undefined }),
          localCommand('local-command', 'skills'),
          jsxCommand('jsx-command', 'plugin'),
        ],
        menu => {
          const frame = menu.frame()
          const { header, groups } = readDialog(frame)
          expect(header).toEqual(['Skills', '1 skill'])
          expect(groups.flatMap(labels)).toEqual(['the-skill'])
          for (const name of [
            'bundled-skill',
            'managed-command',
            'builtin-prompt',
            'mcp-prompt',
            'plugin-command',
            'local-command',
            'jsx-command',
          ]) {
            expect(frame).not.toContain(name)
          }
        },
      )
    },
    TIMEOUT,
  )
})

describe('SkillsMenu: the empty state', () => {
  const EMPTY = [
    ['Skills', 'No skills found'],
    ['Create skills in .claudin/skills/ or ~/.claudin/skills/'],
    ['Esc to close'],
  ]

  test(
    'with no commands it says so, points at the two skills directories, and offers only Esc to close',
    async () => {
      await withMenu([], menu => {
        expect(blocks(menu.frame())).toEqual(EMPTY)
      })
    },
    TIMEOUT,
  )

  test(
    'commands that are not skills leave it just as empty',
    async () => {
      await withMenu(
        [localCommand('clear', 'skills'), skill('bundled-skill', { source: 'bundled', loadedFrom: 'bundled' })],
        menu => {
          expect(blocks(menu.frame())).toEqual(EMPTY)
        },
      )
    },
    TIMEOUT,
  )
})

describe('SkillsMenu: header and footer', () => {
  test(
    'the title is "Skills" and the subtitle counts the skills across all groups, singular for one',
    async () => {
      await withMenu([skill('only')], menu => {
        expect(readDialog(menu.frame()).header).toEqual(['Skills', '1 skill'])
      })
      await withMenu([skill('a'), skill('b', { source: 'userSettings' }), mcpSkill('srv:c')], menu => {
        expect(readDialog(menu.frame()).header).toEqual(['Skills', '3 skills'])
      })
    },
    TIMEOUT,
  )

  test(
    'the only key hint is Esc to close; there is no Enter-to-confirm guide',
    async () => {
      await withMenu([skill('only')], menu => {
        const frame = menu.frame()
        expect(readDialog(frame).footer).toEqual(['Esc to close'])
        expect(frame).not.toContain('to confirm')
        expect(frame).not.toContain('to cancel')
      })
    },
    TIMEOUT,
  )
})

describe('SkillsMenu: groups', () => {
  test(
    'one group per source, in the order project, user, managed, plugin, MCP, whatever the input order',
    async () => {
      await withMenu(
        [
          mcpSkill('srv:mcp-b'),
          mcpSkill('srv:mcp-a'),
          pluginSkill('kit:plugin-b'),
          pluginSkill('kit:plugin-a'),
          skill('managed-b', { source: 'policySettings' }),
          skill('managed-a', { source: 'policySettings' }),
          skill('user-b', { source: 'userSettings' }),
          skill('user-a', { source: 'userSettings' }),
          skill('project-b'),
          skill('project-a'),
        ],
        menu => {
          const { header, groups } = readDialog(menu.frame())
          expect(header).toEqual(['Skills', '10 skills'])
          expect(groups.map(group => [group.title, labels(group)])).toEqual([
            ['Project skills', ['project-a', 'project-b']],
            ['User skills', ['user-a', 'user-b']],
            ['Managed skills', ['managed-a', 'managed-b']],
            ['Plugin skills', ['kit:plugin-a - plugin-a', 'kit:plugin-b - plugin-b']],
            ['MCP skills', ['srv:mcp-a - mcp-a', 'srv:mcp-b - mcp-b']],
          ])
        },
      )
    },
    TIMEOUT,
  )

  test(
    'a source with no skills gets no group at all',
    async () => {
      await withMenu([mcpSkill('srv:only'), skill('mine', { source: 'userSettings' })], menu => {
        const frame = menu.frame()
        expect(readDialog(frame).groups.map(group => group.title)).toEqual(['User skills', 'MCP skills'])
        for (const title of ['Project skills', 'Managed skills', 'Plugin skills']) {
          expect(frame).not.toContain(title)
        }
      })
    },
    TIMEOUT,
  )

  test(
    'a skill whose source is none of those five is not listed',
    async () => {
      const listed = skill('listed')
      await withMenu(
        [
          listed,
          skill('gitignored', { source: 'localSettings' }),
          skill('from-flag', { source: 'flagSettings' }),
          skill('built-in', { source: 'builtin' }),
          skill('shipped', { source: 'bundled' }),
        ],
        menu => {
          const frame = menu.frame()
          // The header count is left alone on purpose: see the spec's edge cases.
          expect(readDialog(frame).groups).toEqual([
            { title: 'Project skills', subtitle: shown('projectSettings', 'skills'), rows: [row(listed, 'listed')] },
          ])
          for (const name of ['gitignored', 'from-flag', 'built-in', 'shipped']) {
            expect(frame).not.toContain(name)
          }
        },
      )
    },
    TIMEOUT,
  )
})

describe('SkillsMenu: group subtitles', () => {
  test(
    'a file-based group shows the display form of its skills directory',
    async () => {
      await withMenu(
        [skill('p'), skill('u', { source: 'userSettings' }), skill('m', { source: 'policySettings' })],
        menu => {
          expect(readDialog(menu.frame()).groups.map(group => [group.title, group.subtitle])).toEqual([
            ['Project skills', shown('projectSettings', 'skills')],
            ['User skills', shown('userSettings', 'skills')],
            ['Managed skills', shown('policySettings', 'skills')],
          ])
        },
      )
    },
    TIMEOUT,
  )

  test(
    'a group holding a legacy command also shows its commands directory',
    async () => {
      await withMenu(
        [
          skill('modern'),
          skill('legacy', { loadedFrom: 'commands_DEPRECATED' }),
          skill('user-modern', { source: 'userSettings' }),
          skill('managed-legacy', { source: 'policySettings', loadedFrom: 'commands_DEPRECATED' }),
        ],
        menu => {
          expect(readDialog(menu.frame()).groups.map(group => group.subtitle)).toEqual([
            `${shown('projectSettings', 'skills')}, ${shown('projectSettings', 'commands')}`,
            shown('userSettings', 'skills'),
            `${shown('policySettings', 'skills')}, ${shown('policySettings', 'commands')}`,
          ])
        },
      )
    },
    TIMEOUT,
  )

  test(
    'the plugin group\'s subtitle is the word "plugin"',
    async () => {
      const kit = pluginSkill('kit:one', { pluginInfo: fromPlugin('kit') })
      await withMenu([kit], menu => {
        expect(readDialog(menu.frame()).groups).toEqual([
          { title: 'Plugin skills', subtitle: 'plugin', rows: [row(kit, 'kit:one - one', 'kit')] },
        ])
      })
    },
    TIMEOUT,
  )

  test(
    'the MCP group names its servers once each, in the order its rows are listed',
    async () => {
      await withMenu(
        ['zeta:deploy', 'alpha:lint', 'zeta:ops:rollback', 'alpha:test'].map(name => mcpSkill(name)),
        menu => {
          const [group] = readDialog(menu.frame()).groups
          expect(group!.title).toBe('MCP skills')
          expect(group!.subtitle).toBe('alpha, zeta')
          expect(labels(group!)).toEqual([
            'alpha:lint - lint',
            'alpha:test - test',
            'zeta:deploy - deploy',
            'zeta:ops:rollback - rollback',
          ])
        },
      )
    },
    TIMEOUT,
  )

  test(
    'an MCP skill with no server prefix names no server; with none at all the group has no subtitle',
    async () => {
      await withMenu([mcpSkill('plain'), mcpSkill(':leading-colon')], menu => {
        const [group] = readDialog(menu.frame()).groups
        expect(group!.title).toBe('MCP skills')
        expect(group!.subtitle).toBeUndefined()
        expect(labels(group!)).toEqual([':leading-colon - leading-colon', 'plain'])
      })
      await withMenu([mcpSkill('plain'), mcpSkill(':leading-colon'), mcpSkill('srv:real')], menu => {
        expect(readDialog(menu.frame()).groups[0]!.subtitle).toBe('srv')
      })
    },
    TIMEOUT,
  )
})

describe('SkillsMenu: rows', () => {
  test(
    'a row is the name, then the estimated description tokens; the description itself is not shown',
    async () => {
      const deploy = skill('deploy', { description: 'ship the build to production' })
      await withMenu([deploy], menu => {
        const frame = menu.frame()
        expect(readDialog(frame).groups[0]!.rows).toEqual([row(deploy, 'deploy')])
        expect(frame).not.toContain('ship the build')
      })
    },
    TIMEOUT,
  )

  test(
    'a namespaced name is followed by " - " and its last segment',
    async () => {
      const twoParts = skill('frontend:lint')
      const threeParts = skill('infra:deploy:canary')
      await withMenu([threeParts, twoParts], menu => {
        expect(readDialog(menu.frame()).groups[0]!.rows).toEqual([
          row(twoParts, 'frontend:lint - lint'),
          row(threeParts, 'infra:deploy:canary - canary'),
        ])
      })
    },
    TIMEOUT,
  )

  test(
    'a plugin skill names its plugin after the label; a skill from any other source never does',
    async () => {
      const named = pluginSkill('tools:format', { pluginInfo: fromPlugin('code-tools') })
      const bare = pluginSkill('tools:bare')
      const project = skill('local-format', { pluginInfo: fromPlugin('ghost-plugin') })
      await withMenu([named, bare, project], menu => {
        const frame = menu.frame()
        const { groups } = readDialog(frame)
        expect(groups.map(group => group.title)).toEqual(['Project skills', 'Plugin skills'])
        expect(groups[0]!.rows).toEqual([row(project, 'local-format')])
        expect(groups[1]!.rows).toEqual([
          row(bare, 'tools:bare - bare'),
          row(named, 'tools:format - format', 'code-tools'),
        ])
        expect(frame).not.toContain('ghost-plugin')
      })
    },
    TIMEOUT,
  )

  test(
    'the estimate covers the name, description and when-to-use, and one in the thousands is compact',
    async () => {
      const longDescription = skill('long-description', { description: 'x'.repeat(6000) })
      const longWhenToUse = skill('long-when-to-use', { description: 'short', whenToUse: 'y'.repeat(8000) })
      await withMenu([longWhenToUse, longDescription], menu => {
        const rows = readDialog(menu.frame()).groups[0]!.rows
        expect(rows).toEqual([row(longDescription, 'long-description'), row(longWhenToUse, 'long-when-to-use')])
        for (const line of rows) {
          expect(line).toMatch(COMPACT_ESTIMATE_RE)
        }
      })
    },
    TIMEOUT,
  )

  test(
    'the label is built from the command name, not its user-facing name',
    async () => {
      const renamed = pluginSkill('tools:raw-name', { userFacingName: () => 'Friendly Name' })
      await withMenu([renamed], menu => {
        const frame = menu.frame()
        expect(readDialog(frame).groups[0]!.rows).toEqual([row(renamed, 'tools:raw-name - raw-name')])
        expect(frame).not.toContain('Friendly Name')
      })
    },
    TIMEOUT,
  )
})

describe('SkillsMenu: order within a group', () => {
  test(
    'rows are sorted by name the way localeCompare orders them, not by code unit',
    async () => {
      await withMenu(['charlie', 'Bravo', 'delta', 'alpha'].map(name => skill(name)), menu => {
        // Code-unit order would put "Bravo" first.
        expect(labels(readDialog(menu.frame()).groups[0]!)).toEqual(['alpha', 'Bravo', 'charlie', 'delta'])
      })
    },
    TIMEOUT,
  )

  test(
    'two skills with the same name in one group are both listed',
    async () => {
      const first = skill('deploy', { description: 'the first deploy skill' })
      const second = skill('deploy', { description: 'another' })
      await withMenu([first, second], menu => {
        const rows = readDialog(menu.frame()).groups[0]!.rows
        expect(rows.toSorted()).toEqual([row(first, 'deploy'), row(second, 'deploy')].toSorted())
      })
    },
    TIMEOUT,
  )
})

describe('SkillsMenu: keys', () => {
  test(
    'Esc closes it: onExit("Skills dialog dismissed", { display: "system" }), once',
    async () => {
      await withMenu([skill('alpha'), mcpSkill('srv:beta')], async menu => {
        await menu.closeWith(ESC)
        expect(menu.exits).toEqual([CLOSED])
      })
    },
    TIMEOUT,
  )

  test(
    'n closes it the same way',
    async () => {
      await withMenu([skill('alpha')], async menu => {
        await menu.closeWith('n')
        expect(menu.exits).toEqual([CLOSED])
      })
    },
    TIMEOUT,
  )

  test(
    'Esc closes the empty dialog the same way',
    async () => {
      await withMenu([], async menu => {
        await menu.closeWith(ESC)
        expect(menu.exits).toEqual([CLOSED])
      })
    },
    TIMEOUT,
  )

  test(
    'nothing else closes it or changes it, and it never closes on its own',
    async () => {
      await withMenu([skill('alpha'), skill('beta', { source: 'userSettings' })], async menu => {
        await Bun.sleep(300)
        expect(menu.exits).toEqual([])
        // Keys are handled in order, so closing before and after the keys
        // under test proves each of them was handled, not dropped.
        await menu.closeWith('n')
        const before = menu.frame()
        for (const key of [ENTER, 'y', UP, DOWN, LEFT, RIGHT, TAB, SHIFT_TAB, ' ', 'j', 'k', 'q']) {
          await menu.press(key)
        }
        await menu.closeWith('n')
        expect(menu.exits).toEqual([CLOSED, CLOSED])
        expect(menu.frame()).toBe(before)
      })
    },
    TIMEOUT,
  )
})
