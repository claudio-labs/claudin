/**
 * Characterization of `McpParsingWarnings`, the "MCP Config Diagnostics"
 * block shown above the /mcp list and in /doctor. It reads the four config
 * scopes from disk when it mounts and lists what each one got wrong.
 *
 * Every config is a real file or a real global-config entry in a temp world.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'path'
import React from 'react'
import {
  enterWorld,
  leaveWorld,
  setLocalServers,
  setUserServers,
  withEnv,
  writeManagedMcp,
  writeMcpJson,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { McpParsingWarnings } from 'src/mcp/ui/McpParsingWarnings.js'
import { flat, linesOf, mount, SLOW, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'
import { Box, Text } from 'src/terminal/ink.js'

let world: World
const undo: Array<() => void> = []
beforeEach(() => {
  world = enterWorld()
})
afterEach(() => {
  while (undo.length) undo.pop()?.()
  leaveWorld()
})

/** Mounts the block between two markers, so "draws nothing" can be told from "not drawn yet". */
async function show(columns = 200) {
  const screen = await mount(
    <Box flexDirection="column">
      <Text>[above]</Text>
      <McpParsingWarnings />
      <Text>[below]</Text>
    </Box>,
    { columns, ready: frame => frame.includes('[below]') },
  )
  const lines = linesOf(screen.text()).filter(Boolean)
  return { screen, lines, text: flat(screen.text()) }
}

const UNSET = 'SETTINGS_UI_UNSET'
const ALSO_UNSET = 'SETTINGS_UI_ALSO_UNSET'

function unsetVars(): void {
  undo.push(withEnv({ [UNSET]: undefined, [ALSO_UNSET]: undefined }))
}

describe('when every scope reads cleanly', () => {
  test(
    'nothing is drawn',
    async () => {
      writeMcpJson({ mcpServers: { fine: { command: 'run' } } })
      setUserServers({ fine: { command: 'run' } })
      setLocalServers({ fine: { type: 'http', url: 'https://fine.test/mcp' } })
      writeManagedMcp({ mcpServers: { fine: { command: 'run' } } })
      const { lines } = await show()
      expect(lines).toEqual(['[above]', '[below]'])
    },
    SLOW,
  )

  test(
    'nothing is drawn when no scope has a config at all',
    async () => {
      const { lines } = await show()
      expect(lines).toEqual(['[above]', '[below]'])
    },
    SLOW,
  )
})

describe('the diagnostics block', () => {
  test(
    'one section per troubled scope, in the order user, project, local, enterprise',
    async () => {
      unsetVars()
      writeMcpJson('{ not json')
      setUserServers({ needy: { command: 'run', args: [`\${${UNSET}}`, `\${${ALSO_UNSET}}`] } })
      setLocalServers({ broken: { type: 'http' } })
      writeManagedMcp({ mcpServers: { corp: { command: 'x', env: { A: `\${${UNSET}}` } } } })
      const globalFile = getGlobalClaudeFile()
      const { lines } = await show()
      expect(lines).toEqual([
        '[above]',
        'MCP Config Diagnostics',
        'For help configuring MCP servers, see: https://code.claude.com/docs/en/mcp',
        '[Contains warnings] User config (available in all your projects)',
        `Location: ${globalFile}`,
        ` └ [Warning] [needy] mcpServers.needy: Missing environment variables: ${UNSET}, ${ALSO_UNSET}`,
        '[Failed to parse] Project config (shared via .mcp.json)',
        `Location: ${join(world.project, '.mcp.json')}`,
        ' └ [Error] MCP config is not a valid JSON',
        '[Failed to parse] Local config (private to you in this project)',
        `Location: ${globalFile} [project: ${world.project}]`,
        ' └ [Error] mcpServers.broken: Does not adhere to MCP server configuration schema',
        '[Contains warnings] Enterprise config (managed by your organization)',
        `Location: ${join(world.admin, 'managed-mcp.json')}`,
        ` └ [Warning] [corp] mcpServers.corp: Missing environment variables: ${UNSET}`,
        '[below]',
      ])
    },
    SLOW,
  )

  test(
    'a scope with both lists its errors first and is headed as failed',
    async () => {
      unsetVars()
      // The project scope reads every .mcp.json from the outer directory down.
      writeMcpJson({ mcpServers: { inner: { command: 'run', args: [`\${${UNSET}}`] } } })
      writeMcpJson({ mcpServers: { outer: { type: 'sse' } } }, world.outer)
      const { lines } = await show()
      const at = lines.indexOf('[Failed to parse] Project config (shared via .mcp.json)')
      expect(at).toBeGreaterThan(0)
      expect(lines.slice(at + 2, at + 4)).toEqual([
        ' └ [Error] mcpServers.outer: Does not adhere to MCP server configuration schema',
        ` └ [Warning] [inner] mcpServers.inner: Missing environment variables: ${UNSET}`,
      ])
      expect(lines.some(line => line.startsWith('[Contains warnings]'))).toBe(false)
    },
    SLOW,
  )

  test(
    'only the scope that has a problem gets a section',
    async () => {
      unsetVars()
      writeMcpJson({ mcpServers: { fine: { command: 'run' } } })
      setUserServers({ needy: { command: 'run', env: { K: `\${${UNSET}}` } } })
      const { text } = await show()
      expect(text).toContain('[Contains warnings] User config')
      for (const absent of ['Project config', 'Local config', 'Enterprise config', '[Error]']) expect(text).not.toContain(absent)
    },
    SLOW,
  )

  describe('in colour', () => {
    withTruecolor()

    const colourOf = (styled: string, label: string) => {
      const line = styled.split('\n').find(l => l.includes(label))
      if (!line) throw new Error(`${label} is not on the screen`)
      return line.slice(0, line.indexOf(label)).match(/\u001B\[38;[0-9;]*m/g)?.at(-1) ?? ''
    }

    test(
      'failure is drawn in the error colour and warnings in the warning colour',
      async () => {
        unsetVars()
        writeMcpJson('{ not json')
        setUserServers({ needy: { command: 'run', args: [`\${${UNSET}}`] } })
        const { screen } = await show()
        const styled = screen.styled()
        const error = colourOf(styled, '[Error]')
        const warning = colourOf(styled, '[Warning]')
        expect(error).toMatch(/38;2;/)
        expect(warning).toMatch(/38;2;/)
        expect(error).not.toBe(warning)
        expect(colourOf(styled, '[Failed to parse]')).toBe(error)
        expect(colourOf(styled, '[Contains warnings]')).toBe(warning)
      },
      SLOW,
    )
  })
})
