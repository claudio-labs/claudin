/**
 * Characterization of `registerPreActionHook` (src/platform/main/preActionHook.ts),
 * the setup Commander runs before any command executes, pinned before the
 * lever cut removes its remote-managed-settings and policy-limits loads.
 *
 * Driven the way main.tsx drives it: a Commander program with the hook
 * attached, a `--plugin-dir` option, and a subcommand whose action records
 * what it finds. What the action sees:
 * - init() has run (the global config environment is applied);
 * - the process is titled `claudin`, unless CLAUDIN_DISABLE_TERMINAL_TITLE;
 * - every `--plugin-dir` is an inline plugin;
 * - the config migrations have run and stamped their version;
 * - a legacy `.claudin-profile.json` in the working directory is gone.
 * Printing help runs none of it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Command, CommanderError } from '@commander-js/extra-typings'
import { getInlinePlugins, setInlinePlugins } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { useBootSandbox } from 'src/platform/main/__testutils__/bootHarness.js'
import { registerPreActionHook } from 'src/platform/main/preActionHook.js'
import { getProviderProfiles } from 'src/providers/presets/providerProfiles.js'

const MARKER = 'CHAR_PREACTION_INIT_RAN'
const sandbox = useBootSandbox([MARKER, 'CLAUDIN_DISABLE_TERMINAL_TITLE'])

let titleBefore: string
beforeAll(() => {
  titleBefore = process.title
})
afterAll(() => {
  process.title = titleBefore
  setInlinePlugins([])
})

type Seen = {
  initRan: boolean
  title: string
  inlinePlugins: string[]
  migrationVersion: unknown
  legacyFilePresent: boolean
}

function program(onAction: (seen: Seen) => void): Command {
  const root = new Command()
  root.exitOverride()
  root.configureOutput({ writeOut: () => {}, writeErr: () => {} })
  const returned = registerPreActionHook(root as never)
  expect(returned).toBe(root as never)
  root.option('--plugin-dir <path>', 'a plugin directory', (value: string, previous: string[]) => [...previous, value], [] as string[])
  root.command('probe').action(() => {
    onAction({
      initRan: process.env[MARKER] === 'yes',
      title: process.title,
      inlinePlugins: getInlinePlugins(),
      migrationVersion: getGlobalConfig().migrationVersion,
      legacyFilePresent: existsSync(join(sandbox.projectDir, '.claudin-profile.json')),
    })
  })
  return root as unknown as Command
}

async function runProbe(args: string[]): Promise<Seen> {
  let seen: Seen | undefined
  await program(s => {
    seen = s
  }).parseAsync(['node', 'claudin', ...args])
  if (!seen) throw new Error('the probe action never ran')
  return seen
}

function prepare(): void {
  saveGlobalConfig(current => ({ ...current, env: { ...current.env, [MARKER]: 'yes' }, migrationVersion: 0 }))
  setInlinePlugins([])
  process.title = 'char-before-hook'
}

describe('the preAction hook', () => {
  test('init() has finished by the time the action runs', async () => {
    prepare()
    expect(process.env[MARKER]).toBeUndefined()
    expect((await runProbe(['probe'])).initRan).toBe(true)
  })

  const titles = [
    { disable: undefined, title: 'claudin' },
    { disable: '1', title: 'char-before-hook' },
    { disable: 'true', title: 'char-before-hook' },
    { disable: '0', title: 'claudin' },
  ]
  for (const c of titles) {
    test(`CLAUDIN_DISABLE_TERMINAL_TITLE=${c.disable ?? '(unset)'}: process title is ${c.title}`, async () => {
      prepare()
      if (c.disable === undefined) delete process.env.CLAUDIN_DISABLE_TERMINAL_TITLE
      else process.env.CLAUDIN_DISABLE_TERMINAL_TITLE = c.disable
      expect((await runProbe(['probe'])).title).toBe(c.title)
    })
  }

  const pluginDirs = [
    { args: ['--plugin-dir', '/plugins/one', 'probe'], inline: ['/plugins/one'] },
    { args: ['--plugin-dir', '/plugins/one', '--plugin-dir', '/plugins/two', 'probe'], inline: ['/plugins/one', '/plugins/two'] },
    { args: ['probe'], inline: [] },
  ]
  for (const c of pluginDirs) {
    test(`${c.args.join(' ')}: inline plugins are [${c.inline.join(', ')}]`, async () => {
      prepare()
      expect((await runProbe(c.args)).inlinePlugins).toEqual(c.inline)
    })
  }

  test('an existing inline plugin list is left alone when no --plugin-dir is given', async () => {
    prepare()
    setInlinePlugins(['/plugins/kept'])
    expect((await runProbe(['probe'])).inlinePlugins).toEqual(['/plugins/kept'])
  })

  test('runs the config migrations and stamps the migration version', async () => {
    prepare()
    const seen = await runProbe(['probe'])
    expect(typeof seen.migrationVersion).toBe('number')
    expect(seen.migrationVersion as number).toBeGreaterThan(0)
  })

  test('with a profile already active, a legacy .claudin-profile.json is dropped without importing it', async () => {
    prepare()
    const legacy = join(sandbox.projectDir, '.claudin-profile.json')
    writeFileSync(
      legacy,
      JSON.stringify({ profile: 'ollama', env: { OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', OPENAI_MODEL: 'legacy-model' } }),
    )
    const profilesBefore = getProviderProfiles().map(p => p.name)
    const seen = await runProbe(['probe'])
    expect(seen.legacyFilePresent).toBe(false)
    expect(getProviderProfiles().map(p => p.name)).toEqual(profilesBefore)
  })

  test('printing help runs none of it', async () => {
    prepare()
    let actionRan = false
    let thrown: unknown
    try {
      await program(() => {
        actionRan = true
      }).parseAsync(['node', 'claudin', 'probe', '--help'])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CommanderError)
    expect((thrown as CommanderError).code).toBe('commander.helpDisplayed')
    expect({ actionRan, initRan: process.env[MARKER] === 'yes', title: process.title }).toEqual({
      actionRan: false,
      initRan: false,
      title: 'char-before-hook',
    })
    expect(getGlobalConfig().migrationVersion).toBe(0)
  })
})
