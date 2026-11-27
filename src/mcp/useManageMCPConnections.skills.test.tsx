// The connections hook and a server's skills, on both protocol eras: the
// skills share the server's slice of mcp.commands with its prompts, so a
// prompts/list_changed must keep them, and a resources/list_changed (the only
// change notice the skills extension has) lists them again.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clientTypes,
  type Fakes,
  type Harness,
  httpConfig,
  installMcpFakes,
  mountConnections,
} from 'src/mcp/__testutils__/mcpConnectionsHarness.js'
import { connectSkillServer, editableSkills, type SkillServer } from 'src/mcp/__testutils__/skillServers.js'
import type { McpServer } from '@modelcontextprotocol/server'
import { fetchCommandsForClient, fetchSkillsForClient } from 'src/mcp/client/fetchCapabilities.js'
import { clearLoadedMcpSkills } from 'src/mcp/mcpSkills.js'
import 'src/skills/loadSkillsDir.js'
import type { AppState } from 'src/terminal/state/AppState.js'

let installed: Fakes
let ui: Harness | undefined
const servers: SkillServer[] = []

beforeEach(() => {
  installed = installMcpFakes()
  // Real requests run here: their 60 s timeouts must not shrink to 1 ms.
  installed.fakes.shrinkBackoff = false
})

afterEach(async () => {
  await ui?.cleanup()
  ui = undefined
  for (const server of servers.splice(0)) {
    server.connection.client.onclose = undefined
    fetchCommandsForClient.cache.delete(server.connection.name)
    fetchSkillsForClient.cache.delete(server.connection.name)
    await server.close()
  }
  clearLoadedMcpSkills()
  installed.restore()
})

function commandNames(s: AppState): string[] {
  return s.mcp.commands.map(c => c.name).sort()
}

describe.each(['legacy', 'modern'] as const)('skills in the connections hook, %s era', era => {
  test('a prompts/list_changed keeps the skills; a resources/list_changed lists them again', async () => {
    const skills = editableSkills()
    await skills.add('notes', { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nKeep notes.\n' })
    let promptNames = ['greet']
    // The 2025 server is built once; the 2026-07-28 one on every request.
    let built: McpServer | undefined
    const register = (mcp: McpServer, prompt: string) =>
      mcp.registerPrompt(prompt, { description: prompt }, () => ({ messages: [] }))
    const config = httpConfig('http://127.0.0.1:9/mcp')
    installed.fakes.connect = async name => {
      const server = await connectSkillServer(name, era, skills.extension, {
        config,
        build: mcp => {
          built = mcp
          for (const prompt of promptNames) register(mcp, prompt)
        },
      })
      servers.push(server)
      const { connection } = server
      expect(connection.capabilities.resources?.listChanged).toBe(true)
      expect(connection.capabilities.prompts?.listChanged).toBe(true)
      return {
        client: connection,
        tools: [],
        commands: [...(await fetchCommandsForClient(connection)), ...(await fetchSkillsForClient(connection))],
      }
    }

    ui = await mountConnections({ live: config })
    await ui.until(s => clientTypes(s).live === 'connected', 'live connected')
    expect(commandNames(ui.state())).toEqual(['live:notes', 'mcp__live__greet'])
    const server = servers[0]!
    if (era === 'modern') await ui.until(() => server.fixture!.listens() === 1, 'the listen stream')
    // The ack lands before a notification is routed to the stream.
    await Bun.sleep(50)

    promptNames = ['greet', 'wave']
    if (era === 'legacy') register(built!, 'wave')
    server.promptsChanged()
    await ui.until(s => commandNames(s).includes('mcp__live__wave'), 'the new prompt')
    expect(commandNames(ui.state())).toEqual(['live:notes', 'mcp__live__greet', 'mcp__live__wave'])

    await skills.add('todo', { 'SKILL.md': '---\nname: todo\ndescription: Track todos\n---\nTrack them.\n' })
    server.resourcesChanged()
    await ui.until(s => commandNames(s).includes('live:todo'), 'the new skill')
    expect(commandNames(ui.state())).toEqual(['live:notes', 'live:todo', 'mcp__live__greet', 'mcp__live__wave'])
  })
})
