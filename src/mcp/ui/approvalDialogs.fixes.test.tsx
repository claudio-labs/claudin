/**
 * mcp/approvalDialogs: the "fix" findings that need the rendered dialogs, and
 * the rule that each dialog answers once although it stays mounted after.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { enterWorld, leaveWorld, setUserServers, userServersOnRecord, type World } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import type { McpServerConfig } from 'src/mcp/types.js'
import { MCPServerApprovalDialog } from 'src/mcp/ui/MCPServerApprovalDialog.js'
import { MCPServerDesktopImportDialog } from 'src/mcp/ui/MCPServerDesktopImportDialog.js'
import { MCP_DOCS_URL, MCPServerDialogCopy } from 'src/mcp/ui/MCPServerDialogCopy.js'
import { MCPServerMultiselectDialog } from 'src/mcp/ui/MCPServerMultiselectDialog.js'
import { flat, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import * as shutdownModule from 'src/shared/proc/gracefulShutdown.js'

function linkUrls(node: React.ReactNode): string[] {
  if (!React.isValidElement(node)) return Array.isArray(node) ? node.flatMap(linkUrls) : []
  const props = node.props as { url?: unknown; children?: React.ReactNode }
  const own = typeof props.url === 'string' ? [props.url] : []
  return [...own, ...React.Children.toArray(props.children).flatMap(linkUrls)]
}

describe("finding 8: the copy links to this project's documentation", () => {
  test('the only link is the MCP page of the Claudin docs', () => {
    expect(MCP_DOCS_URL).toBe('https://www.claudiolabs.ai/docs/mcp')
    expect(linkUrls(MCPServerDialogCopy())).toEqual([MCP_DOCS_URL])
  })
})

describe('finding 7: a clashing import row starts unticked', () => {
  beforeEach(() => {
    enterWorld()
  })
  afterEach(() => {
    leaveWorld()
  })

  test(
    'once the clash is known, its row is unticked and the others stay ticked',
    async () => {
      setUserServers({ github: { command: 'old', args: [] } })
      const servers: Record<string, McpServerConfig> = {
        github: { command: 'npx', args: [] },
        notes: { command: 'notes', args: [] },
      }
      const screen = await mount(<MCPServerDesktopImportDialog servers={servers} scope="user" onDone={() => {}} />, {
        columns: 100,
        ready: frame => frame.includes('Esc to cancel'),
      })
      await screen.until(frame => frame.includes('already exists'), 'the clash to be marked')
      await Bun.sleep(50)
      expect(flat(screen.text())).toMatch(/\[ \] github \(already exists\) \[✔\] notes/)
    },
    SLOW,
  )
})

describe('a dialog answers once, though it stays mounted after its answer', () => {
  let world: World
  beforeEach(() => {
    world = enterWorld()
  })
  afterEach(() => {
    mock.restore()
    leaveWorld()
  })
  const readLocal = () => {
    const file = join(world.project, '.claudin', 'settings.local.json')
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null
  }
  async function settle(finished: () => number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (finished() === 0 && Date.now() < deadline) await Bun.sleep(15)
    await Bun.sleep(200)
  }

  test(
    'the single dialog: a reject after an approval writes nothing more',
    async () => {
      let finished = 0
      const screen = await mount(<MCPServerApprovalDialog serverName="github" onDone={() => (finished += 1)} />, {
        columns: 100,
        ready: frame => frame.includes('Continue without'),
      })
      await screen.press('2')
      await settle(() => finished)
      await screen.press('3')
      await Bun.sleep(200)
      expect(finished).toBe(1)
      expect(readLocal()).toEqual({ enabledMcpjsonServers: ['github'] })
    },
    SLOW,
  )

  test(
    'the checklist: Esc after Enter rejects nothing',
    async () => {
      let finished = 0
      const screen = await mount(<MCPServerMultiselectDialog serverNames={['a', 'b']} onDone={() => (finished += 1)} />, {
        columns: 100,
        ready: frame => frame.includes('reject all'),
      })
      await screen.press(KEYS.enter)
      await settle(() => finished)
      await screen.press(KEYS.esc)
      await Bun.sleep(200)
      expect(finished).toBe(1)
      expect(readLocal()).toEqual({ enabledMcpjsonServers: ['a', 'b'] })
    },
    SLOW,
  )

  test(
    'the import: Enter after Esc imports nothing and ends the process once',
    async () => {
      const shutdowns: unknown[][] = []
      spyOn(shutdownModule, 'gracefulShutdown').mockImplementation(async (...args: unknown[]) => {
        shutdowns.push(args)
      })
      spyOn(process.stdout, 'write').mockImplementation(() => true)
      let finished = 0
      const screen = await mount(
        <MCPServerDesktopImportDialog servers={{ github: { command: 'gh', args: [] } }} scope="user" onDone={() => (finished += 1)} />,
        { columns: 100, ready: frame => frame.includes('Esc to cancel') },
      )
      await Bun.sleep(150)
      await screen.press(KEYS.esc, KEYS.enter)
      await settle(() => finished)
      expect(finished).toBe(1)
      expect(shutdowns).toEqual([[]])
      expect(userServersOnRecord()).toBeUndefined()
    },
    SLOW,
  )
})
