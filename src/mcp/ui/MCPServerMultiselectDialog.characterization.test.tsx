/**
 * mcp/approvalDialogs, part 2: the dialog that asks about SEVERAL servers from
 * the project's `.mcp.json` at once, as a checklist.
 *
 * Each case drives the real keys and reads the result back from disk (the
 * local settings layer, `.claudin/settings.local.json`) and through the
 * approval status the connection code consults. The other settings layers are
 * real files in a throwaway tree.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { enterWorld, leaveWorld, type Json, writeSettings, type World } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { MCPServerMultiselectDialog } from 'src/mcp/ui/MCPServerMultiselectDialog.js'
import { getProjectMcpServerStatus } from 'src/mcp/utils.js'
import { flat, KEYS, linesOf, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

let world: World

beforeEach(() => {
  world = enterWorld()
})
afterEach(() => {
  leaveWorld()
})

const SPACE = ' '
const localFile = () => join(world.project, '.claudin', 'settings.local.json')
const readLocal = (): Json | null => (existsSync(localFile()) ? (JSON.parse(readFileSync(localFile(), 'utf8')) as Json) : null)

async function askAbout(servers: string[]) {
  let finished = 0
  const screen = await mount(<MCPServerMultiselectDialog serverNames={servers} onDone={() => (finished += 1)} />, {
    columns: 100,
    ready: frame => frame.includes('reject all'),
  })
  return { screen, finished: () => finished }
}

async function settle(finished: () => number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (finished() === 0 && Date.now() < deadline) await Bun.sleep(15)
  await Bun.sleep(200)
}

function statuses(servers: string[]): Record<string, string> {
  resetSettingsCache()
  return Object.fromEntries(servers.map(name => [name, getProjectMcpServerStatus(name)]))
}

describe('what the dialog shows', () => {
  test(
    'counts the servers, warns, and lists every name in the order given, each one already ticked',
    async () => {
      const { screen } = await askAbout(['zeta', 'alpha', 'my server'])
      const text = flat(screen.text())
      expect(text).toContain('3 new MCP servers found in .mcp.json')
      expect(text).toContain('Select any you wish to enable.')
      expect(text).toContain('MCP servers may execute code or access system resources')
      expect(text).toContain('All tool calls require approval')
      expect(text).toMatch(/❯ \[✔\] zeta \[✔\] alpha \[✔\] my server/)
      // No numbers in front of the names, and the frame's own hint line is replaced by the list's.
      expect(text).not.toMatch(/\d\. (zeta|alpha)/)
      expect(text).toContain('Space to select · Enter to confirm · Esc to reject all')
      expect(text).not.toContain('Esc to cancel')
    },
    SLOW,
  )

  test(
    'the hint line sits under the dialog, outside its border',
    async () => {
      const { screen } = await askAbout(['a', 'b'])
      const lines = linesOf(screen.text()).filter(line => line.trim() !== '')
      expect(lines.at(-1)).toContain('Esc to reject all')
      expect(lines.findIndex(line => line.includes('[✔] b'))).toBeLessThan(lines.length - 1)
    },
    SLOW,
  )
})

type Case = {
  name: string
  keys: string[]
  local: Json
  status: Record<string, string>
}

const SERVERS = ['github', 'sentry', 'linear']

const cases: Case[] = [
  {
    name: 'Enter right away approves every server listed',
    keys: [KEYS.enter],
    local: { enabledMcpjsonServers: ['github', 'sentry', 'linear'] },
    status: { github: 'approved', sentry: 'approved', linear: 'approved' },
  },
  {
    name: 'unticking one with Space approves the rest and rejects it',
    keys: [KEYS.down, SPACE, KEYS.enter],
    local: { enabledMcpjsonServers: ['github', 'linear'], disabledMcpjsonServers: ['sentry'] },
    status: { github: 'approved', sentry: 'rejected', linear: 'approved' },
  },
  {
    name: 'unticking every one rejects them all and writes no approved list',
    keys: [SPACE, KEYS.down, SPACE, KEYS.down, SPACE, KEYS.enter],
    local: { disabledMcpjsonServers: ['github', 'sentry', 'linear'] },
    status: { github: 'rejected', sentry: 'rejected', linear: 'rejected' },
  },
  {
    name: 'unticking and ticking again approves it',
    keys: [SPACE, SPACE, KEYS.enter],
    local: { enabledMcpjsonServers: ['github', 'sentry', 'linear'] },
    status: { github: 'approved', sentry: 'approved', linear: 'approved' },
  },
  {
    name: 'Esc rejects every server, whatever was ticked',
    keys: [KEYS.esc],
    local: { disabledMcpjsonServers: ['github', 'sentry', 'linear'] },
    status: { github: 'rejected', sentry: 'rejected', linear: 'rejected' },
  },
  {
    name: 'the n key rejects every server too',
    keys: ['n'],
    local: { disabledMcpjsonServers: ['github', 'sentry', 'linear'] },
    status: { github: 'rejected', sentry: 'rejected', linear: 'rejected' },
  },
]

describe('what each answer writes', () => {
  for (const c of cases) {
    test(
      `${c.name}; only the local settings file is written, and the caller hears back once`,
      async () => {
        expect(statuses(SERVERS)).toEqual({ github: 'pending', sentry: 'pending', linear: 'pending' })
        const { screen, finished } = await askAbout(SERVERS)
        await screen.press(...c.keys)
        await settle(finished)
        expect(finished()).toBe(1)
        expect(readLocal()).toEqual(c.local)
        expect(existsSync(join(world.home, 'settings.json'))).toBe(false)
        expect(existsSync(join(world.project, '.claudin', 'settings.json'))).toBe(false)
        expect(statuses(SERVERS)).toEqual(c.status)
      },
      SLOW,
    )
  }

  test(
    'Esc after unticking still rejects every server',
    async () => {
      const { screen, finished } = await askAbout(['a', 'b'])
      await screen.press(SPACE, KEYS.esc)
      await settle(finished)
      expect(readLocal()).toEqual({ disabledMcpjsonServers: ['a', 'b'] })
    },
    SLOW,
  )

  test(
    'answers are added after the entries already in the local file, without repeating a name',
    async () => {
      writeSettings('local', {
        model: 'opus',
        enabledMcpjsonServers: ['old-on', 'github'],
        disabledMcpjsonServers: ['old-off', 'sentry'],
      })
      const { screen, finished } = await askAbout(['github', 'sentry', 'linear'])
      // github stays ticked, sentry is unticked, linear stays ticked.
      await screen.press(KEYS.down, SPACE, KEYS.enter)
      await settle(finished)
      expect(readLocal()).toEqual({
        model: 'opus',
        enabledMcpjsonServers: ['old-on', 'github', 'linear'],
        disabledMcpjsonServers: ['old-off', 'sentry'],
      })
    },
    SLOW,
  )

  test(
    'an answer never takes a name off the other list',
    async () => {
      writeSettings('local', { disabledMcpjsonServers: ['github'] })
      const { screen, finished } = await askAbout(['github', 'sentry'])
      await screen.press(KEYS.enter)
      await settle(finished)
      expect(readLocal()).toEqual({ disabledMcpjsonServers: ['github'], enabledMcpjsonServers: ['github', 'sentry'] })
      // Rejection wins, so github stays off.
      expect(statuses(['github', 'sentry'])).toEqual({ github: 'rejected', sentry: 'approved' })
    },
    SLOW,
  )

  // What else lands in the local lists is not pinned (spec, finding 2: fix).
  test(
    'with entries in other layers, the answers are appended last and the other entries stay in force',
    async () => {
      writeSettings('user', { enabledMcpjsonServers: ['user-on'], disabledMcpjsonServers: ['user-off'] })
      writeSettings('project', { enabledMcpjsonServers: ['repo-on'] })
      const { screen, finished } = await askAbout(['github', 'sentry'])
      await screen.press(KEYS.down, SPACE, KEYS.enter)
      await settle(finished)
      const local = readLocal() as { enabledMcpjsonServers: string[]; disabledMcpjsonServers: string[] }
      expect(local.enabledMcpjsonServers.at(-1)).toBe('github')
      expect(local.disabledMcpjsonServers.at(-1)).toBe('sentry')
      expect(JSON.parse(readFileSync(join(world.home, 'settings.json'), 'utf8'))).toEqual({
        enabledMcpjsonServers: ['user-on'],
        disabledMcpjsonServers: ['user-off'],
      })
      expect(statuses(['user-on', 'repo-on', 'user-off', 'github', 'sentry'])).toEqual({
        'user-on': 'approved',
        'repo-on': 'approved',
        'user-off': 'rejected',
        github: 'approved',
        sentry: 'rejected',
      })
    },
    SLOW,
  )
})

describe('keys that do not answer', () => {
  test(
    'Space and the arrows change ticks only; nothing is written until Enter',
    async () => {
      const { screen, finished } = await askAbout(['a', 'b'])
      await screen.press(SPACE, KEYS.down, KEYS.up, 'y')
      await Bun.sleep(200)
      expect(finished()).toBe(0)
      expect(readLocal()).toBeNull()
      expect(flat(screen.text())).toMatch(/❯ \[ \] a \[✔\] b/)
    },
    SLOW,
  )
})
