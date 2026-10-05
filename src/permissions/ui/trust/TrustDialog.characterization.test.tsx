/**
 * Characterization of TrustDialog, the workspace-trust question an interactive
 * session asks before anything a folder brings is allowed to run. Written
 * before the clean-base rewrite of permissions/sessionDialogs; the spec is
 * docs/tech/rewrite/permissions/sessionDialogs.md.
 *
 * Two kinds of test live here.
 * - In this process (NODE_ENV=test) the config store is an in-memory
 *   stand-in, so these read what an answer recorded through the config API.
 * - Every answer that ends the process, and every check of what reaches the
 *   disk, runs in a child `bun test` of this same file with NODE_ENV=production,
 *   a private config directory and a private HOME. The parent reads the
 *   child's report (exit code, whether the caller heard "done") and the
 *   config file the child left behind.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import * as React from 'react'
import type { Command } from 'src/commands/commands.js'
import { flat, isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { TrustDialog } from 'src/permissions/ui/trust/TrustDialog.js'
import {
  getCwdState,
  getSessionTrustAccepted,
  setCwdState,
  setOriginalCwd,
  setSessionTrustAccepted,
} from 'src/platform/bootstrap/state.js'
import {
  enableConfigs,
  getCurrentProjectConfig,
  getProjectPathForConfig,
  type ProjectConfig,
  resetProjectConfigForTests,
  resetTrustDialogAcceptedCacheForTesting,
  saveGlobalConfig,
} from 'src/platform/config/config.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const SCENE = 'TRUST_DIALOG_SCENE'

type Scene = { keys: string[]; report: string; folder: string; managed: string }

const scene: Scene | null = process.env[SCENE] ? (JSON.parse(process.env[SCENE]) as Scene) : null

/** What the dialog says, whatever the folder holds. */
const WARNING_FACTS = [
  'Accessing workspace:',
  'Quick safety check',
  'Is this a project you created or one you trust?',
  'your own code, a well-known open source project, or work from your team',
  "take a moment to review what's in this folder first",
  'Claudin will be able to read, edit, and execute files here.',
  'Security guide',
  'Enter to confirm · Esc to cancel',
]

const SECURITY_GUIDE_URL = 'https://code.claude.com/docs/en/security'

if (scene) {
  // --- the child: answer once, then report how the process ended ----------------
  test('answers the trust dialog and reports the ending', async () => {
    const note = (line: string) => writeFileSync(scene.report, `${line}\n`, { flag: 'a' })
    process.on('exit', code => note(`exit ${code}`))
    // The runner needs NODE_ENV=test to load the JSX runtime; the config store
    // reads it on every call, so switching here gives the real file store.
    process.env.NODE_ENV = 'production'
    enableConfigs()
    getManagedFilePath.cache.set(undefined, scene.managed)
    getManagedSettingsDropInDir.cache.set(undefined, join(scene.managed, 'managed-settings.d'))
    process.chdir(scene.folder)
    setOriginalCwd(scene.folder)
    setCwdState(scene.folder)
    resetSettingsCache()
    const screen = await mount(<TrustDialog onDone={() => note('done')} />)
    await screen.press(...scene.keys)
    await Bun.sleep(3_000)
    note('still running')
  }, SLOW)
} else {
  describe('TrustDialog', () => {
    const world = isolatedWorld()
    const saved = { dir: '', cwdState: '' }

    beforeEach(() => {
      saved.dir = process.cwd()
      saved.cwdState = getCwdState()
      // The session starts in the folder: process directory, session cwd and original cwd agree.
      process.chdir(world().project)
      setCwdState(world().project)
      setSessionTrustAccepted(false)
      resetTrustDialogAcceptedCacheForTesting()
      resetProjectConfigForTests()
      saveGlobalConfig(current => ({ ...current, projects: {} }))
    })
    afterEach(() => {
      process.chdir(saved.dir)
      setCwdState(saved.cwdState)
      setSessionTrustAccepted(false)
      resetTrustDialogAcceptedCacheForTesting()
      resetProjectConfigForTests()
      saveGlobalConfig(current => ({ ...current, projects: {} }))
    })

    const put = (relative: string, body: unknown) => {
      const target = join(world().project, relative)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
      resetSettingsCache()
    }

    test(
      'names the folder and gives the generic warning, with trusting first and focused',
      async () => {
        const screen = await mount(<TrustDialog onDone={() => {}} />, { columns: 100 })
        const text = flat(screen.text())
        for (const fact of WARNING_FACTS) expect(text).toContain(fact)
        // The folder is the process's working directory, shown on its own line.
        expect(screen.text().split('\n').map(line => line.trim())).toContain(world().project)
        expect(text).toMatch(/❯ 1\. Yes, I trust this folder 2\. No, exit/)
        // The guide is a hyperlink to the security page.
        expect(screen.styled()).toContain(SECURITY_GUIDE_URL)
        // Facts come in this order: title, folder, question, capability, guide, answers, footer.
        const order = ['Accessing workspace:', world().project, 'Quick safety check', 'read, edit, and execute', 'Security guide', 'Yes, I trust', 'No, exit', 'Enter to confirm']
        const at = order.map(fact => text.indexOf(fact))
        expect(at).toEqual([...at].sort((a, b) => a - b))
      },
      SLOW,
    )

    test(
      'a folder that brings hooks, rules, helpers, servers and commands still gets the same question',
      async () => {
        put('.claudin/settings.json', {
          hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }] },
          permissions: { allow: ['Bash(make:*)'], defaultMode: 'bypassPermissions', additionalDirectories: ['/'] },
          apiKeyHelper: 'echo key',
          awsAuthRefresh: 'aws sso login',
          gcpAuthRefresh: 'gcloud auth login',
          otelHeadersHelper: 'echo {}',
          env: { LD_PRELOAD: '/tmp/x.so' },
          enableAllProjectMcpServers: true,
        })
        put('.mcp.json', { mcpServers: { local: { command: 'node', args: ['server.js'], headersHelper: 'echo {}' } } })
        const commands = [
          { type: 'prompt', name: 'deploy', loadedFrom: 'commands_DEPRECATED', source: 'projectSettings', allowedTools: ['Bash(git push:*)'] },
          { type: 'prompt', name: 'ship', loadedFrom: 'skills', source: 'localSettings', allowedTools: ['Bash'] },
        ] as unknown as Command[]
        const screen = await mount(<TrustDialog commands={commands} onDone={() => {}} />, { columns: 100 })
        const text = flat(screen.text())
        for (const fact of WARNING_FACTS) expect(text).toContain(fact)
        expect(text).toMatch(/❯ 1\. Yes, I trust this folder 2\. No, exit/)
      },
      SLOW,
    )

    test(
      'malformed project files do not stop the question',
      async () => {
        put('.claudin/settings.json', '{ not json')
        put('.claudin/settings.local.json', '[]')
        put('.mcp.json', '{ "mcpServers": ')
        const screen = await mount(<TrustDialog onDone={() => {}} />, { columns: 100 })
        expect(flat(screen.text())).toContain('Yes, I trust this folder')
      },
      SLOW,
    )

    const accepts: Array<{ how: string; keys: string[] }> = [
      { how: 'Enter on the focused first answer', keys: [KEYS.enter] },
      { how: 'its number', keys: ['1'] },
    ]
    for (const { how, keys } of accepts) {
      test(
        `trusting by ${how} records it for the project, then tells the caller once`,
        async () => {
          let done = 0
          let recordedWhenTold: unknown = null
          const onDone = () => {
            done += 1
            recordedWhenTold = getCurrentProjectConfig().hasTrustDialogAccepted
          }
          const screen = await mount(<TrustDialog onDone={onDone} />)
          await screen.press(...keys)
          expect(done).toBe(1)
          // Recorded before the caller hears of it.
          expect(recordedWhenTold).toBe(true)
          // Persisted trust, not the session-only latch.
          expect(getSessionTrustAccepted()).toBe(false)
          // Nothing is written into the folder itself.
          expect(readdirSync(world().project)).toEqual([])
        },
        SLOW,
      )
    }

    test(
      'in the home directory, trusting lasts for the session only',
      async () => {
        setCwdState(homedir())
        let done = 0
        const screen = await mount(<TrustDialog onDone={() => (done += 1)} />)
        await screen.press(KEYS.enter)
        expect(done).toBe(1)
        expect(getSessionTrustAccepted()).toBe(true)
        expect(getCurrentProjectConfig().hasTrustDialogAccepted).toBe(false)
      },
      SLOW,
    )

    // --- already trusted: nothing is drawn and the caller moves on ------------------
    const trusted: Array<{ how: string; arrange: () => void }> = [
      {
        how: 'the project itself is recorded as trusted',
        arrange: () => trustPaths([getProjectPathForConfig()]),
      },
      {
        how: 'a parent directory is recorded as trusted',
        arrange: () => trustPaths([join(world().project, '..')]),
      },
      {
        how: 'trust was accepted earlier in this session',
        arrange: () => setSessionTrustAccepted(true),
      },
    ]
    for (const { how, arrange } of trusted) {
      test(
        `when ${how}, nothing is drawn and the caller is told once`,
        async () => {
          arrange()
          let done = 0
          const screen = await mount(<TrustDialog onDone={() => (done += 1)} />, { ready: () => true })
          await Bun.sleep(100)
          expect(done).toBe(1)
          for (const fact of [...WARNING_FACTS, 'Yes, I trust this folder']) expect(screen.text()).not.toContain(fact)
          expect(getCurrentProjectConfig().hasTrustDialogAccepted).toBe(false)
        },
        SLOW,
      )
    }

    function trustPaths(paths: string[]): void {
      saveGlobalConfig(current => ({
        ...current,
        projects: Object.fromEntries(paths.map(path => [path, { hasTrustDialogAccepted: true } as ProjectConfig])),
      }))
    }

    // --- what does NOT count as trust ------------------------------------------------
    const notTrust: Array<{ how: string; arrange: () => void }> = [
      {
        how: "the folder's own settings files claim it",
        arrange: () => {
          const claim = { hasTrustDialogAccepted: true, projects: { [world().project]: { hasTrustDialogAccepted: true } } }
          put('.claudin/settings.json', claim)
          put('.claudin/settings.local.json', claim)
        },
      },
      {
        how: 'the folder ships config files shaped like the user config',
        arrange: () => {
          const config = { projects: { [world().project]: { hasTrustDialogAccepted: true } } }
          put('.claudin.json', config)
          put('.claudin/config.json', config)
          put('.claudin/.claudin.json', config)
        },
      },
      {
        how: 'only a directory inside the folder is trusted',
        arrange: () => trustPaths([join(world().project, 'sub')]),
      },
      {
        how: 'only a sibling directory is trusted',
        arrange: () => trustPaths([`${world().project}-sibling`]),
      },
      {
        how: 'the project entry exists but says false',
        arrange: () => trustPaths([]),
      },
    ]
    for (const { how, arrange } of notTrust) {
      test(
        `still asks when ${how}`,
        async () => {
          arrange()
          let done = 0
          const screen = await mount(<TrustDialog onDone={() => (done += 1)} />)
          expect(flat(screen.text())).toContain('Yes, I trust this folder')
          expect(done).toBe(0)
        },
        SLOW,
      )
    }

    // --- the endings, in a child process with a real config file ----------------------
    type Ending = { lines: string[]; config: Record<string, unknown> | null }

    async function answerInChild(keys: string[], options: { folder?: string; home?: string } = {}): Promise<Ending> {
      const report = join(world().home, 'report.log')
      const folder = options.folder ?? world().project
      const home = options.home ?? join(world().home, 'user-home')
      mkdirSync(home, { recursive: true })
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '..', '..', '..', '..'),
        env: {
          ...process.env,
          HOME: home,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          CLAUDIN_CONFIG_DIR: world().config,
          [SCENE]: JSON.stringify({ keys, report, folder, managed: join(world().home, 'managed') } satisfies Scene),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (!existsSync(report)) throw new Error(`the child left no report:\n${out}\n${err}`)
      const configFile = join(world().config, 'config.json')
      return {
        lines: readFileSync(report, 'utf8').trim().split('\n'),
        config: existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>) : null,
      }
    }

    const trustedKeys = (config: Record<string, unknown> | null) =>
      Object.entries((config?.projects ?? {}) as Record<string, ProjectConfig>)
        .filter(([, entry]) => entry.hasTrustDialogAccepted === true)
        .map(([path]) => path)

    test(
      'trusting writes hasTrustDialogAccepted under the folder in the user config file, and the session goes on',
      async () => {
        const { lines, config } = await answerInChild([KEYS.enter])
        expect(lines).toEqual(['done', 'still running'])
        expect(trustedKeys(config)).toEqual([world().project])
      },
      60_000,
    )

    test(
      'inside a git repository, trust is recorded for the repository root',
      async () => {
        const nested = join(world().project, 'packages', 'app')
        mkdirSync(nested, { recursive: true })
        const init = Bun.spawnSync(['git', 'init', '-q', world().project], {
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: world().home },
        })
        expect(init.exitCode).toBe(0)
        const { lines, config } = await answerInChild(['1'], { folder: nested })
        expect(lines).toEqual(['done', 'still running'])
        expect(trustedKeys(config)).toEqual([world().project])
      },
      60_000,
    )

    test(
      'trusting the home directory writes nothing to disk',
      async () => {
        const { lines, config } = await answerInChild([KEYS.enter], { home: world().project })
        expect(lines).toEqual(['done', 'still running'])
        expect(trustedKeys(config)).toEqual([])
      },
      60_000,
    )

    const endings: Array<{ answer: string; keys: string[]; code: number }> = [
      { answer: '"2"', keys: ['2'], code: 1 },
      { answer: 'Enter on "No, exit"', keys: [KEYS.down, KEYS.enter], code: 1 },
      // Esc is the list's cancel, which picks "No, exit"; "n" is the confirmation's no.
      { answer: 'Esc', keys: [KEYS.esc], code: 1 },
      { answer: '"n"', keys: ['n'], code: 0 },
      { answer: 'Ctrl+C twice', keys: [KEYS.ctrlC, KEYS.ctrlC], code: 1 },
    ]
    for (const { answer, keys, code } of endings) {
      test(
        `${answer} ends the process with code ${code}, without telling the caller or recording trust`,
        async () => {
          const { lines, config } = await answerInChild(keys)
          expect(lines).toEqual([`exit ${code}`])
          expect(trustedKeys(config)).toEqual([])
        },
        60_000,
      )
    }

    test(
      'a single Ctrl+C neither trusts nor ends the process',
      async () => {
        const { lines, config } = await answerInChild([KEYS.ctrlC])
        expect(lines[0]).toBe('still running')
        expect(trustedKeys(config)).toEqual([])
      },
      60_000,
    )
  })
}
