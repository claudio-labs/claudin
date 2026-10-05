/**
 * mcp/approvalDialogs, part 1: the dialog that asks about ONE server from the
 * project's `.mcp.json` before it may start.
 *
 * Every answer is followed to disk: the dialog writes the user's choice into
 * the local settings layer (`.claudin/settings.local.json` under the session's
 * directory), and whether the server then starts is read back through the
 * approval status that the connection code consults. The other layers are real
 * files in a throwaway tree, so the test also shows what each answer does to
 * them (nothing) and what it copies out of them (see the spec's findings).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { enterWorld, leaveWorld, type Json, writeSettings, type World } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { MCPServerApprovalDialog } from 'src/mcp/ui/MCPServerApprovalDialog.js'
import { getProjectMcpServerStatus } from 'src/mcp/utils.js'
import { flat, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

let world: World

beforeEach(() => {
  world = enterWorld()
})
afterEach(() => {
  leaveWorld()
})

const localFile = () => join(world.project, '.claudin', 'settings.local.json')
const readLocal = (): Json | null => (existsSync(localFile()) ? (JSON.parse(readFileSync(localFile(), 'utf8')) as Json) : null)

async function ask(server: string) {
  let finished = 0
  const screen = await mount(<MCPServerApprovalDialog serverName={server} onDone={() => (finished += 1)} />, {
    columns: 100,
    ready: frame => frame.includes('Continue without'),
  })
  return { screen, finished: () => finished }
}

/** Waits until the caller has heard back, then lets a stray second report land. */
async function settle(finished: () => number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (finished() === 0 && Date.now() < deadline) await Bun.sleep(15)
  await Bun.sleep(200)
}

describe('what the dialog shows', () => {
  test(
    'names the server and the file it came from, warns, and offers three answers with the broadest first and focused',
    async () => {
      const { screen } = await ask('github')
      const text = flat(screen.text())
      expect(text).toContain('New MCP server found in .mcp.json: github')
      expect(text).toContain('MCP servers may execute code or access system resources')
      expect(text).toContain('All tool calls require approval')
      expect(text).toContain('MCP documentation')
      expect(text).toMatch(
        /❯ 1\. Use this and all future MCP servers in this project 2\. Use this MCP server 3\. Continue without using this MCP server/,
      )
      expect(text).toContain('Enter to confirm')
      expect(text).toContain('Esc to cancel')
    },
    SLOW,
  )

  test(
    'the server name is printed as given, spaces and punctuation included',
    async () => {
      const { screen } = await ask('my odd.server')
      expect(flat(screen.text())).toContain('found in .mcp.json: my odd.server')
    },
    SLOW,
  )
})

type Answer = { name: string; keys: string[]; local: Json; status: 'approved' | 'rejected' }

const answers: Answer[] = [
  {
    name: 'Enter on the focused first option enables this server and every future one',
    keys: [KEYS.enter],
    local: { enabledMcpjsonServers: ['github'], enableAllProjectMcpServers: true },
    status: 'approved',
  },
  {
    name: 'pressing 1 does the same',
    keys: ['1'],
    local: { enabledMcpjsonServers: ['github'], enableAllProjectMcpServers: true },
    status: 'approved',
  },
  { name: 'pressing 2 enables this server only', keys: ['2'], local: { enabledMcpjsonServers: ['github'] }, status: 'approved' },
  {
    name: 'down and Enter enables this server only',
    keys: [KEYS.down, KEYS.enter],
    local: { enabledMcpjsonServers: ['github'] },
    status: 'approved',
  },
  { name: 'pressing 3 rejects it', keys: ['3'], local: { disabledMcpjsonServers: ['github'] }, status: 'rejected' },
  { name: 'Esc rejects it', keys: [KEYS.esc], local: { disabledMcpjsonServers: ['github'] }, status: 'rejected' },
  { name: 'the n key rejects it', keys: ['n'], local: { disabledMcpjsonServers: ['github'] }, status: 'rejected' },
]

describe('what each answer writes', () => {
  for (const answer of answers) {
    test(
      `${answer.name}; only the local settings file is written`,
      async () => {
        expect(getProjectMcpServerStatus('github')).toBe('pending')
        const { screen, finished } = await ask('github')
        await screen.press(...answer.keys)
        await settle(finished)
        expect(finished()).toBe(1)
        expect(readLocal()).toEqual(answer.local)
        // Nothing lands in the user's or the repository's own settings.
        expect(existsSync(join(world.home, 'settings.json'))).toBe(false)
        expect(existsSync(join(world.project, '.claudin', 'settings.json'))).toBe(false)
        resetSettingsCache()
        expect(getProjectMcpServerStatus('github')).toBe(answer.status)
      },
      SLOW,
    )
  }

  test(
    'the local file is written as two-space JSON ending in a newline, and keeps its other keys',
    async () => {
      writeSettings('local', { model: 'opus', permissions: { allow: ['Read'] } })
      const { screen, finished } = await ask('github')
      await screen.press('2')
      await settle(finished)
      const bytes = readFileSync(localFile(), 'utf8')
      expect(bytes.endsWith('}\n')).toBe(true)
      expect(bytes).toContain('\n  "enabledMcpjsonServers": [\n    "github"\n  ]')
      expect(JSON.parse(bytes)).toEqual({ model: 'opus', permissions: { allow: ['Read'] }, enabledMcpjsonServers: ['github'] })
    },
    SLOW,
  )

  test(
    'approving appends to the list already in the local file, at its end',
    async () => {
      writeSettings('local', { enabledMcpjsonServers: ['sentry'] })
      const { screen, finished } = await ask('github')
      await screen.press('2')
      await settle(finished)
      expect(readLocal()).toEqual({ enabledMcpjsonServers: ['sentry', 'github'] })
    },
    SLOW,
  )

  test(
    'rejecting appends to the rejected list and leaves the approved list alone',
    async () => {
      writeSettings('local', { enabledMcpjsonServers: ['sentry'], disabledMcpjsonServers: ['linear'] })
      const { screen, finished } = await ask('github')
      await screen.press('3')
      await settle(finished)
      expect(readLocal()).toEqual({ enabledMcpjsonServers: ['sentry'], disabledMcpjsonServers: ['linear', 'github'] })
    },
    SLOW,
  )

  // What else lands in the local lists is not pinned (spec, finding 2: fix).
  test(
    'approving with entries in other layers keeps them in force and leaves their files alone',
    async () => {
      writeSettings('user', { enabledMcpjsonServers: ['from-user'] })
      writeSettings('project', { enabledMcpjsonServers: ['from-repo'] })
      const { screen, finished } = await ask('github')
      await screen.press('2')
      await settle(finished)
      const local = readLocal() as { enabledMcpjsonServers: string[] }
      expect(local.enabledMcpjsonServers.at(-1)).toBe('github')
      expect(JSON.parse(readFileSync(join(world.home, 'settings.json'), 'utf8'))).toEqual({ enabledMcpjsonServers: ['from-user'] })
      expect(JSON.parse(readFileSync(join(world.project, '.claudin', 'settings.json'), 'utf8'))).toEqual({
        enabledMcpjsonServers: ['from-repo'],
      })
      resetSettingsCache()
      for (const name of ['from-user', 'from-repo', 'github']) expect(getProjectMcpServerStatus(name)).toBe('approved')
    },
    SLOW,
  )

  test(
    'rejecting with entries in other layers keeps them in force',
    async () => {
      writeSettings('user', { disabledMcpjsonServers: ['from-user'] })
      const { screen, finished } = await ask('github')
      await screen.press('3')
      await settle(finished)
      expect((readLocal() as { disabledMcpjsonServers: string[] }).disabledMcpjsonServers.at(-1)).toBe('github')
      resetSettingsCache()
      expect(getProjectMcpServerStatus('from-user')).toBe('rejected')
      expect(getProjectMcpServerStatus('github')).toBe('rejected')
    },
    SLOW,
  )

  const already: Array<{ name: string; local: Json; key: string; after: Json }> = [
    { name: 'approving a name already on the local approved list', local: { enabledMcpjsonServers: ['github'] }, key: '2', after: { enabledMcpjsonServers: ['github'] } },
    {
      name: '"all future" with the name already listed adds only the switch',
      local: { enabledMcpjsonServers: ['github'] },
      key: '1',
      after: { enabledMcpjsonServers: ['github'], enableAllProjectMcpServers: true },
    },
    { name: 'rejecting a name already on the local rejected list', local: { disabledMcpjsonServers: ['github'] }, key: '3', after: { disabledMcpjsonServers: ['github'] } },
  ]
  for (const c of already) {
    test(
      `${c.name} does not repeat it`,
      async () => {
        writeSettings('local', c.local)
        const { screen, finished } = await ask('github')
        await screen.press(c.key)
        await settle(finished)
        expect(readLocal()).toEqual(c.after)
      },
      SLOW,
    )
  }

  test(
    'a local file that is not JSON is left alone, and the caller still hears back',
    async () => {
      writeSettings('local', {})
      writeFileSync(localFile(), '{ "enabledMcpjsonServers": [')
      resetSettingsCache()
      const { screen, finished } = await ask('github')
      await screen.press('2')
      await settle(finished)
      expect(finished()).toBe(1)
      expect(readFileSync(localFile(), 'utf8')).toBe('{ "enabledMcpjsonServers": [')
      resetSettingsCache()
      expect(getProjectMcpServerStatus('github')).toBe('pending')
    },
    SLOW,
  )
})

describe('keys that do not answer', () => {
  test(
    'y, the arrows and an unused digit move nothing to disk and finish nothing',
    async () => {
      const { screen, finished } = await ask('github')
      await screen.press('y', KEYS.down, KEYS.up, '9')
      await Bun.sleep(200)
      expect(finished()).toBe(0)
      expect(readLocal()).toBeNull()
    },
    SLOW,
  )

  test(
    'one Ctrl+C neither answers nor writes; it asks for a second press',
    async () => {
      const { screen, finished } = await ask('github')
      await screen.press(KEYS.ctrlC)
      await Bun.sleep(200)
      expect(finished()).toBe(0)
      expect(readLocal()).toBeNull()
      expect(flat(screen.text())).toMatch(/Press Ctrl-C again to exit/)
    },
    SLOW,
  )
})
