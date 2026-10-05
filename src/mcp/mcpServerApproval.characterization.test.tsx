/**
 * mcp/approvalDialogs, part 3: `handleMcpjsonServerApprovals(root)`, the
 * startup step that asks about the project's `.mcp.json` servers before the
 * session may start them.
 *
 * It is driven exactly as the interactive startup drives it: an Ink root on a
 * terminal (here a fake one), real `.mcp.json` files in the session's
 * directory and above it, and real settings files for every layer. A test
 * reads which servers the user is asked about, when nobody is asked at all,
 * and what the answer leaves on disk for the next session.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  enterWorld,
  leaveWorld,
  type Json,
  type SettingsLayer,
  writeManagedMcp,
  writeMcpJson,
  writeSettings,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { handleMcpjsonServerApprovals } from 'src/mcp/mcpServerApproval.js'
import { getProjectMcpServerStatus } from 'src/mcp/utils.js'
import { flat, KEYS, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { setAllowedSettingSources, setIsInteractive } from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import type { Root } from 'src/terminal/ink/root.js'

let world: World
let opened: Array<{ root: Root; terminal: FakeTerminal }> = []

beforeEach(() => {
  world = enterWorld()
})
afterEach(async () => {
  for (const { root, terminal } of opened) {
    root.unmount()
    terminal.close()
  }
  opened = []
  await Bun.sleep(0)
  leaveWorld()
})

const stdio = (command: string) => ({ command, args: [] })

/** A root on a fake terminal, as the startup hands over, with its renders counted. */
async function startupRoot() {
  const terminal = createFakeTerminal({ columns: 100 })
  const inner = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false, exitOnCtrlC: false })
  let renders = 0
  const root: Root = {
    ...inner,
    render: node => {
      renders += 1
      inner.render(node)
    },
  }
  opened.push({ root: inner, terminal })
  return { root, terminal, renders: () => renders }
}

/** Starts the step and returns once it has painted its dialog (or has finished without one). */
async function start() {
  const { root, terminal, renders } = await startupRoot()
  let finished = false
  const run = handleMcpjsonServerApprovals(root).then(() => {
    finished = true
  })
  const deadline = Date.now() + 8_000
  while (!finished && !/Continue without|reject all/.test(terminal.screen())) {
    if (Date.now() > deadline) throw new Error(`no dialog and no end; the screen shows:\n${terminal.screen()}`)
    await Bun.sleep(15)
  }
  // Key handlers subscribe after the first paint.
  if (!finished) await Bun.sleep(200)
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      terminal.type(key)
      await Bun.sleep(key === KEYS.esc ? 150 : 70)
    }
  }
  /** Waits for the step to settle, failing fast instead of hanging the test. */
  const ended = async () => {
    await Promise.race([run, Bun.sleep(6_000)])
    if (!finished) throw new Error(`the step did not finish; the screen shows:\n${terminal.screen()}`)
  }
  return { ended, terminal, renders, press, finished: () => finished }
}

const localFile = () => join(world.project, '.claudin', 'settings.local.json')
const readLocal = (): Json | null => (existsSync(localFile()) ? (JSON.parse(readFileSync(localFile(), 'utf8')) as Json) : null)

describe('when nobody is asked', () => {
  type Skip = { name: string; mcp: Json | null; layers?: Partial<Record<SettingsLayer, Json>>; session?: () => void }
  const skips: Skip[] = [
    { name: 'there is no .mcp.json', mcp: null },
    { name: '.mcp.json lists no server', mcp: { mcpServers: {} } },
    { name: '.mcp.json is not valid JSON', mcp: '{ "mcpServers": ' as unknown as Json },
    { name: 'its one server fails the schema', mcp: { mcpServers: { bad: { type: 'http' } } } },
    { name: 'the server is on the local approved list', mcp: { mcpServers: { a: stdio('a') } }, layers: { local: { enabledMcpjsonServers: ['a'] } } },
    { name: 'the server is on the user approved list', mcp: { mcpServers: { a: stdio('a') } }, layers: { user: { enabledMcpjsonServers: ['a'] } } },
    { name: 'the server was rejected before', mcp: { mcpServers: { a: stdio('a') } }, layers: { local: { disabledMcpjsonServers: ['a'] } } },
    { name: 'every project server is enabled', mcp: { mcpServers: { a: stdio('a'), b: stdio('b') } }, layers: { local: { enableAllProjectMcpServers: true } } },
    // Kept for parity (spec, finding 1): the repository's own settings answer for it.
    { name: "the repository's own settings enable all its servers", mcp: { mcpServers: { a: stdio('a'), b: stdio('b') } }, layers: { project: { enableAllProjectMcpServers: true } } },
    { name: "the repository's own settings list its server", mcp: { mcpServers: { a: stdio('a') } }, layers: { project: { enabledMcpjsonServers: ['a'] } } },
    { name: 'bypass mode was accepted in the user settings', mcp: { mcpServers: { a: stdio('a') } }, layers: { user: { skipDangerousModePermissionPrompt: true } } },
    { name: 'an approved name that folds to the same', mcp: { mcpServers: { my_server: stdio('a') } }, layers: { local: { enabledMcpjsonServers: ['my.server'] } } },
    { name: 'the session is not interactive', mcp: { mcpServers: { a: stdio('a') } }, session: () => setIsInteractive(false) },
    {
      name: 'project settings are not a loaded source',
      mcp: { mcpServers: { a: stdio('a') } },
      session: () => setAllowedSettingSources(['userSettings', 'localSettings']),
    },
  ]
  for (const skip of skips) {
    test(
      `${skip.name}: it finishes without rendering and writes nothing`,
      async () => {
        if (skip.mcp !== null) writeMcpJson(skip.mcp)
        for (const [layer, content] of Object.entries(skip.layers ?? {})) writeSettings(layer as SettingsLayer, content)
        skip.session?.()
        resetSettingsCache()
        const before = existsSync(localFile()) ? readFileSync(localFile(), 'utf8') : null
        const step = await start()
        expect(step.renders()).toBe(0)
        await step.ended()
        expect(existsSync(localFile()) ? readFileSync(localFile(), 'utf8') : null).toBe(before)
      },
      SLOW,
    )
  }

  test(
    'a project server the repository itself rejects is not asked about, even when the user approved it',
    async () => {
      writeMcpJson({ mcpServers: { a: stdio('a') } })
      writeSettings('user', { enabledMcpjsonServers: ['a'] })
      writeSettings('project', { disabledMcpjsonServers: ['a'] })
      const step = await start()
      expect(step.renders()).toBe(0)
      await step.ended()
      expect(getProjectMcpServerStatus('a')).toBe('rejected')
    },
    SLOW,
  )
})

describe('one pending server', () => {
  test(
    'gets the single-server dialog, and the step waits for the answer',
    async () => {
      writeMcpJson({ mcpServers: { github: { type: 'http', url: 'https://mcp.example.com' } } })
      const step = await start()
      expect(flat(step.terminal.screen())).toContain('New MCP server found in .mcp.json: github')
      expect(step.renders()).toBe(1)
      await Bun.sleep(300)
      expect(step.finished()).toBe(false)
      await step.press('2')
      await step.ended()
      expect(readLocal()).toEqual({ enabledMcpjsonServers: ['github'] })
      resetSettingsCache()
      expect(getProjectMcpServerStatus('github')).toBe('approved')
    },
    SLOW,
  )

  test(
    'is the only one asked about when the other servers are already decided',
    async () => {
      writeMcpJson({ mcpServers: { on: stdio('a'), off: stdio('b'), fresh: stdio('c') } })
      writeSettings('local', { enabledMcpjsonServers: ['on'], disabledMcpjsonServers: ['off'] })
      const step = await start()
      expect(flat(step.terminal.screen())).toContain('found in .mcp.json: fresh')
      await step.press(KEYS.esc)
      await step.ended()
      expect(readLocal()).toEqual({ enabledMcpjsonServers: ['on'], disabledMcpjsonServers: ['off', 'fresh'] })
    },
    SLOW,
  )

  test(
    '"all future servers" means the next startup asks about nothing, even for a server added later',
    async () => {
      writeMcpJson({ mcpServers: { github: stdio('gh') } })
      const first = await start()
      await first.press(KEYS.enter)
      await first.ended()
      writeMcpJson({ mcpServers: { github: stdio('gh'), added: stdio('x') } })
      resetSettingsCache()
      const second = await start()
      expect(second.renders()).toBe(0)
      await second.ended()
      expect(getProjectMcpServerStatus('added')).toBe('approved')
    },
    SLOW,
  )

  test(
    'a rejected server is not asked about again',
    async () => {
      writeMcpJson({ mcpServers: { github: stdio('gh') } })
      const first = await start()
      await first.press('3')
      await first.ended()
      resetSettingsCache()
      const second = await start()
      expect(second.renders()).toBe(0)
      await second.ended()
    },
    SLOW,
  )
})

describe('several pending servers', () => {
  test(
    'get the checklist, in .mcp.json order, and the step waits for Enter',
    async () => {
      writeMcpJson({ mcpServers: { zeta: stdio('z'), alpha: stdio('a'), mid: stdio('m') } })
      const step = await start()
      const text = flat(step.terminal.screen())
      expect(text).toContain('3 new MCP servers found in .mcp.json')
      expect(text).toMatch(/\[✔\] zeta \[✔\] alpha \[✔\] mid/)
      await Bun.sleep(300)
      expect(step.finished()).toBe(false)
      await step.press(KEYS.down, ' ', KEYS.enter)
      await step.ended()
      expect(readLocal()).toEqual({ enabledMcpjsonServers: ['zeta', 'mid'], disabledMcpjsonServers: ['alpha'] })
    },
    SLOW,
  )

  test(
    'lists only the servers still pending, and counts only those',
    async () => {
      writeMcpJson({ mcpServers: { on: stdio('o'), first: stdio('f'), off: stdio('x'), second: stdio('s') } })
      writeSettings('local', { enabledMcpjsonServers: ['on'], disabledMcpjsonServers: ['off'] })
      const step = await start()
      const text = flat(step.terminal.screen())
      expect(text).toContain('2 new MCP servers found in .mcp.json')
      expect(text).toMatch(/❯ \[✔\] first \[✔\] second Space/)
      await step.press(KEYS.enter)
      await step.ended()
      expect(readLocal()).toEqual({ enabledMcpjsonServers: ['on', 'first', 'second'], disabledMcpjsonServers: ['off'] })
    },
    SLOW,
  )

  test(
    'Esc rejects them all, and the next startup asks about nothing',
    async () => {
      writeMcpJson({ mcpServers: { a: stdio('a'), b: stdio('b') } })
      const step = await start()
      await step.press(KEYS.esc)
      await step.ended()
      expect(readLocal()).toEqual({ disabledMcpjsonServers: ['a', 'b'] })
      resetSettingsCache()
      const again = await start()
      expect(again.renders()).toBe(0)
      await again.ended()
    },
    SLOW,
  )

  test(
    'servers from a .mcp.json above the session directory are asked about too; for a shared name the nearer file wins',
    async () => {
      writeMcpJson({ mcpServers: { outer: stdio('o'), shared: stdio('far') } }, world.outer)
      writeMcpJson({ mcpServers: { inner: stdio('i'), shared: stdio('near') } })
      const step = await start()
      const text = flat(step.terminal.screen())
      expect(text).toContain('3 new MCP servers found in .mcp.json')
      // Farthest file first; a name the nearer file redefines keeps its place.
      expect(text).toMatch(/\[✔\] outer \[✔\] shared \[✔\] inner/)
    },
    SLOW,
  )

  test(
    'a broken .mcp.json in the session directory does not hide the servers of one above it',
    async () => {
      writeMcpJson({ mcpServers: { outer: stdio('o') } }, world.outer)
      writeMcpJson('{ not json')
      const step = await start()
      expect(flat(step.terminal.screen())).toContain('New MCP server found in .mcp.json: outer')
    },
    SLOW,
  )
})

// Kept for parity (spec, finding 4): the list is the project scope as written,
// before the managed allow/deny policy and the managed take-over are applied.
describe('servers that will never start are still asked about', () => {
  test(
    'a server the managed policy denies',
    async () => {
      writeMcpJson({ mcpServers: { blocked: stdio('b') } })
      writeSettings('policy', { deniedMcpServers: [{ serverName: 'blocked' }] })
      const step = await start()
      expect(flat(step.terminal.screen())).toContain('found in .mcp.json: blocked')
    },
    SLOW,
  )

  test(
    'project servers while a managed-mcp.json has exclusive control',
    async () => {
      writeManagedMcp({ mcpServers: { corp: stdio('corp') } })
      writeMcpJson({ mcpServers: { local1: stdio('a'), local2: stdio('b') } })
      const step = await start()
      expect(flat(step.terminal.screen())).toContain('2 new MCP servers found in .mcp.json')
    },
    SLOW,
  )
})
