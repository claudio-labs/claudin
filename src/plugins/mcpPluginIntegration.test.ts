import { describe, expect, test } from 'bun:test'
import { resolvePluginMcpEnvironment } from 'src/plugins/mcpPluginIntegration.js'
import type { McpServerConfig } from 'src/mcp/types.js'

const plugin = { path: '/plugins/demo', source: 'demo@local' }

function resolved(config: Record<string, unknown>): { command?: string; cwd?: string } {
  return resolvePluginMcpEnvironment(config as McpServerConfig, plugin) as { command?: string; cwd?: string }
}

describe('resolvePluginMcpEnvironment — a stdio server’s cwd', () => {
  test('gets ${CLAUDIN_PLUGIN_ROOT} like its command', () => {
    const server = resolved({
      type: 'stdio',
      command: '${CLAUDIN_PLUGIN_ROOT}/bin/server',
      args: [],
      cwd: '${CLAUDIN_PLUGIN_ROOT}/server',
    })
    expect(server.command).toBe('/plugins/demo/bin/server')
    expect(server.cwd).toBe('/plugins/demo/server')
  })

  test('a relative cwd is under the plugin, not the project', () => {
    expect(resolved({ command: 'node', args: [], cwd: 'server' }).cwd).toBe('/plugins/demo/server')
  })

  test('an absolute or home cwd is kept, and no cwd stays absent', () => {
    expect(resolved({ command: 'node', args: [], cwd: '/opt/srv' }).cwd).toBe('/opt/srv')
    expect(resolved({ command: 'node', args: [], cwd: '~/srv' }).cwd).toBe('~/srv')
    expect('cwd' in resolved({ command: 'node', args: [] })).toBe(false)
  })
})
