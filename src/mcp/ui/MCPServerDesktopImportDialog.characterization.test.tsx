/**
 * mcp/approvalDialogs, part 4: the checklist behind
 * `claudin mcp add-from-claude-desktop`, which copies the servers found in
 * Claude Desktop's config into one of this project's config scopes.
 *
 * The servers already configured are real (the global config, this project's
 * entry in it, and a real `.mcp.json`), and every import is read back from
 * where it landed. Every way out of the dialog ends the process, so the
 * process end is the one boundary replaced: the shutdown is recorded instead
 * of run. What the command prints goes to the real stdout and is captured.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import {
  enterWorld,
  leaveWorld,
  localRecord,
  setLocalServers,
  setUserServers,
  userServersOnRecord,
  writeMcpJson,
  writeSettings,
  type Json,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'
import type { ConfigScope, McpServerConfig } from 'src/mcp/types.js'
import { flat, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

// --- the process-end boundary -------------------------------------------------------

const realShutdown = { ...(await import('src/shared/proc/gracefulShutdown.js')) }
let shutdowns: unknown[][] | null = null
mock.module('src/shared/proc/gracefulShutdown.js', () => ({
  ...realShutdown,
  gracefulShutdown: async (...args: unknown[]) => {
    if (shutdowns === null) return realShutdown.gracefulShutdown(...(args as Parameters<typeof realShutdown.gracefulShutdown>))
    shutdowns.push(args)
  },
}))
const { MCPServerDesktopImportDialog } = await import('src/mcp/ui/MCPServerDesktopImportDialog.js')

afterAll(() => {
  mock.module('src/shared/proc/gracefulShutdown.js', () => realShutdown)
})

// --- what the command prints ----------------------------------------------------------

let printed = ''
const realWrite = process.stdout.write.bind(process.stdout)

let world: World

beforeEach(() => {
  world = enterWorld()
  shutdowns = []
  printed = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
})
afterEach(() => {
  process.stdout.write = realWrite
  shutdowns = null
  leaveWorld()
})

const DESKTOP: Record<string, McpServerConfig> = {
  github: { command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 'abc' } },
  notes: { type: 'http', url: 'https://notes.example.com/mcp' } as McpServerConfig,
}

async function importDialog(servers: Record<string, McpServerConfig>, scope: ConfigScope) {
  let finished = 0
  const screen = await mount(
    <MCPServerDesktopImportDialog servers={servers} scope={scope} onDone={() => (finished += 1)} />,
    { columns: 100, ready: frame => frame.includes('Esc to cancel') },
  )
  // The list of servers already configured arrives after the first paint.
  await Bun.sleep(150)
  return { screen, finished: () => finished }
}

async function settle(finished: () => number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (finished() === 0 && Date.now() < deadline) await Bun.sleep(15)
  await Bun.sleep(200)
}

const projectFile = () => join(world.project, '.mcp.json')
const projectServers = (): Json | null =>
  existsSync(projectFile()) ? ((JSON.parse(readFileSync(projectFile(), 'utf8')) as { mcpServers: Json }).mcpServers) : null

describe('what the dialog shows', () => {
  test(
    'a title, how many servers were found, and every one ticked when none clashes',
    async () => {
      const { screen } = await importDialog(DESKTOP, 'user')
      const text = flat(screen.text())
      expect(text).toContain('Import MCP Servers from Claude Desktop')
      expect(text).toContain('Found 2 MCP servers in Claude Desktop.')
      expect(text).toContain('Please select the servers you want to import:')
      expect(text).toMatch(/❯ \[✔\] github \[✔\] notes/)
      expect(text).not.toContain('already exist')
      expect(text).toContain('Space to select · Enter to confirm · Esc to cancel')
    },
    SLOW,
  )

  test(
    'one server is counted in the singular',
    async () => {
      const { screen } = await importDialog({ github: DESKTOP.github! }, 'user')
      expect(flat(screen.text())).toContain('Found 1 MCP server in Claude Desktop.')
    },
    SLOW,
  )

  const clashes: Array<{ where: string; seed: () => void }> = [
    { where: 'the user scope', seed: () => setUserServers({ github: { command: 'old', args: [] } }) },
    { where: 'the local scope', seed: () => setLocalServers({ github: { command: 'old', args: [] } }) },
    {
      where: "the project's .mcp.json, approved",
      seed: () => {
        writeMcpJson({ mcpServers: { github: { command: 'old', args: [] } } })
        writeSettings('local', { enabledMcpjsonServers: ['github'] })
      },
    },
  ]
  // Whether a clashing row starts ticked is not pinned (spec, finding 7: fix).
  for (const { where, seed } of clashes) {
    test(
      `a name already configured in ${where} is marked and explained; the others are not`,
      async () => {
        seed()
        const { screen } = await importDialog(DESKTOP, 'user')
        await screen.until(frame => frame.includes('already exists'), 'the clash to be marked')
        const text = flat(screen.text())
        expect(text).toMatch(/\] github \(already exists\) \[✔\] notes/)
        expect(text).not.toContain('notes (already exists)')
        expect(text).toContain('Some servers already exist with the same name')
        expect(text).toContain('imported with a numbered suffix')
      },
      SLOW,
    )
  }

  // Kept for parity (spec, finding 5): the clash check sees only servers that would start.
  test(
    "a server in the project's .mcp.json that nobody approved yet is not marked",
    async () => {
      writeMcpJson({ mcpServers: { github: { command: 'old', args: [] } } })
      const { screen } = await importDialog(DESKTOP, 'user')
      await Bun.sleep(300)
      const text = flat(screen.text())
      expect(text).toMatch(/\[✔\] github \[✔\] notes/)
      expect(text).not.toContain('already exist')
    },
    SLOW,
  )
})

/** Ticks the focused first row if it is not ticked yet. */
async function tickFirst(screen: Awaited<ReturnType<typeof importDialog>>['screen'], name: string): Promise<void> {
  if (flat(screen.text()).includes(`[ ] ${name}`)) await screen.press(' ')
  expect(flat(screen.text())).toContain(`[✔] ${name}`)
}

describe('importing', () => {
  test(
    'Enter imports every ticked server into the user scope, prints a count, then ends the process',
    async () => {
      const { screen, finished } = await importDialog(DESKTOP, 'user')
      await screen.press(KEYS.enter)
      await settle(finished)
      expect(Object.keys(userServersOnRecord() ?? {})).toEqual(['github', 'notes'])
      expect(userServersOnRecord()?.github).toEqual({ command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 'abc' } })
      expect(stripAnsi(printed)).toBe('\nSuccessfully imported 2 MCP servers to user config.\n')
      expect(finished()).toBe(1)
      expect(shutdowns).toEqual([[]])
    },
    SLOW,
  )

  test(
    'the success line is coloured',
    async () => {
      const chalk = (await import('chalk')).default
      const level = chalk.level
      chalk.level = 3
      try {
        const { screen, finished } = await importDialog({ github: DESKTOP.github! }, 'user')
        await screen.press(KEYS.enter)
        await settle(finished)
        expect(printed).toMatch(/\u001B\[[0-9;]*mSuccessfully imported 1 MCP server to user config\.\u001B\[[0-9;]*m/)
      } finally {
        chalk.level = level
      }
    },
    SLOW,
  )

  test(
    'into the local scope, the entries go to this project in the global config',
    async () => {
      const { screen, finished } = await importDialog(DESKTOP, 'local')
      await screen.press(KEYS.enter)
      await settle(finished)
      expect(Object.keys(localRecord().mcpServers ?? {})).toEqual(['github', 'notes'])
      expect(userServersOnRecord()).toBeUndefined()
      expect(stripAnsi(printed)).toContain('Successfully imported 2 MCP servers to local config.')
    },
    SLOW,
  )

  test(
    "into the project scope, the entries are written to the session directory's .mcp.json",
    async () => {
      const { screen, finished } = await importDialog(DESKTOP, 'project')
      await screen.press(KEYS.enter)
      await settle(finished)
      expect(projectServers()).toEqual({
        github: { command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 'abc' } },
        notes: { type: 'http', url: 'https://notes.example.com/mcp' },
      })
      expect(stripAnsi(printed)).toContain('Successfully imported 2 MCP servers to project config.')
    },
    SLOW,
  )

  test(
    'an unticked server is left out of the import and out of the count',
    async () => {
      const { screen, finished } = await importDialog(DESKTOP, 'user')
      await screen.press(' ', KEYS.enter)
      await settle(finished)
      expect(Object.keys(userServersOnRecord() ?? {})).toEqual(['notes'])
      expect(stripAnsi(printed)).toBe('\nSuccessfully imported 1 MCP server to user config.\n')
    },
    SLOW,
  )

  test(
    'a clashing server ticked by hand is imported under the first free numbered name',
    async () => {
      setUserServers({ github: { command: 'old', args: [] }, github_1: { command: 'older', args: [] } })
      const { screen, finished } = await importDialog(DESKTOP, 'user')
      await screen.until(frame => frame.includes('already exists'), 'the clash to be marked')
      await tickFirst(screen, 'github')
      await screen.press(KEYS.enter)
      await settle(finished)
      const record = userServersOnRecord() ?? {}
      expect(Object.keys(record).sort()).toEqual(['github', 'github_1', 'github_2', 'notes'])
      expect(record.github).toEqual({ command: 'old', args: [] })
      expect(record.github_2).toEqual({ command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 'abc' } })
      expect(stripAnsi(printed)).toContain('Successfully imported 2 MCP servers to user config.')
    },
    SLOW,
  )

  // Kept for parity (spec, finding 5): a clash is any scope, not just the target.
  test(
    'a name taken in another scope is still renamed in the target scope',
    async () => {
      setUserServers({ github: { command: 'old', args: [] } })
      const { screen, finished } = await importDialog({ github: DESKTOP.github! }, 'project')
      await screen.until(frame => frame.includes('already exists'), 'the clash to be marked')
      await tickFirst(screen, 'github')
      await screen.press(KEYS.enter)
      await settle(finished)
      expect(Object.keys(projectServers() ?? {})).toEqual(['github_1'])
    },
    SLOW,
  )
})

describe('leaving without importing', () => {
  const exits: Array<{ name: string; keys: string[] }> = [
    { name: 'Esc', keys: [KEYS.esc] },
    { name: 'the n key', keys: ['n'] },
    { name: 'Enter with nothing ticked', keys: [' ', KEYS.down, ' ', KEYS.enter] },
  ]
  for (const { name, keys } of exits) {
    test(
      `${name} imports nothing, says so, then ends the process`,
      async () => {
        const { screen, finished } = await importDialog(DESKTOP, 'user')
        await screen.press(...keys)
        await settle(finished)
        expect(userServersOnRecord()).toBeUndefined()
        expect(printed).toBe('\nNo servers were imported.')
        expect(finished()).toBe(1)
        expect(shutdowns).toEqual([[]])
      },
      SLOW,
    )
  }
})
