/**
 * Characterization of `registerSubcommands` (src/platform/main/registerSubcommands.ts):
 * the subcommands `claudin` answers to, and what each one nests, pinned before
 * the lever cut removes the bridge's `remote-control` registration and the
 * native `install` command. Neither of those two is pinned here.
 *
 * Commands behind a build-time feature flag (ssh, auto-mode, workflow,
 * remote-control) are off under `bun test`, so their absence is what this run
 * sees; the table records the default build.
 */
import { describe, expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { registerSubcommands } from 'src/platform/main/registerSubcommands.js'

/** Registrations the lever cut deletes; this suite neither requires nor forbids them. */
const CUT = new Set(['install', 'remote-control'])

type Node = { name: string; aliases: string[]; children: Node[] }

function tree(command: Command): Node[] {
  return command.commands.map(child => ({
    name: child.name(),
    aliases: child.aliases(),
    children: tree(child as Command),
  }))
}

const flatten = (nodes: Node[], prefix = ''): string[] =>
  nodes.flatMap(node => {
    const path = `${prefix}${node.name}`
    const label = node.aliases.length > 0 ? `${path} (${node.aliases.join('|')})` : path
    return [label, ...flatten(node.children, `${path} `)]
  })

const EXPECTED: Record<string, string[]> = {
  mcp: [
    'mcp serve',
    'mcp add',
    'mcp doctor',
    'mcp remove',
    'mcp list',
    'mcp get',
    'mcp add-json',
    'mcp add-from-claude-desktop',
    'mcp reset-project-choices',
  ],
  auth: ['auth login', 'auth status', 'auth logout'],
  'plugin (plugins)': [
    'plugin validate',
    'plugin list',
    'plugin marketplace',
    'plugin marketplace add',
    'plugin marketplace list',
    'plugin marketplace remove (rm)',
    'plugin marketplace update',
    'plugin install (i)',
    'plugin uninstall (remove|rm)',
    'plugin enable',
    'plugin disable',
    'plugin update',
  ],
  'setup-token': [],
  agents: [],
  doctor: [],
  'update (upgrade)': [],
}

describe('registerSubcommands', () => {
  const program = new Command()
  const returned = registerSubcommands(program as never)
  const kept = tree(program).filter(node => !CUT.has(node.name))

  test('hands back the program it was given', () => {
    expect(returned).toBe(program as never)
  })

  test('registers exactly these top-level commands, in this order', () => {
    expect(flatten(kept.map(node => ({ ...node, children: [] })))).toEqual(Object.keys(EXPECTED))
  })

  for (const [top, nested] of Object.entries(EXPECTED)) {
    test(`${top} nests ${nested.length === 0 ? 'nothing' : nested.length + ' subcommands'}`, () => {
      const node = kept.find(n => flatten([{ ...n, children: [] }])[0] === top)!
      expect(flatten(node.children, `${node.name} `)).toEqual(nested)
    })
  }

  test('registering twice on fresh programs gives the same tree', () => {
    const again = new Command()
    registerSubcommands(again as never)
    expect(flatten(tree(again))).toEqual(flatten(tree(program)))
  })
})
