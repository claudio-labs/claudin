/**
 * MCP servers that publish skills (SEP-2640) for the skills suites, on the v2
 * server SDK: a `SkillCatalog` over in-memory files (what a real server
 * serves), and a hand-built `SkillSource` whose listing and file contents the
 * test edits — to serve a file that no longer matches its entry, a
 * `"dynamic"` skill, or two skills of one name. Either is attached to a v2
 * `McpServer` and reached on the 2025 protocol over an in-memory pair, or on
 * 2026-07-28 over HTTP through `serveModern`.
 *
 * NOT a `.test` file — it exports helpers, it does not register tests.
 */
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import {
  type Skill,
  SkillCatalog,
  type SkillSource,
  SkillsExtension,
  memorySkillFiles,
  skillEntry,
} from '@modelcontextprotocol/server/ext/skills'
import { type ModernFixture, serveModern } from 'src/mcp/__testutils__/eraServers.js'
import { attachMcpWireFilter } from 'src/mcp/client/fetchCapabilities.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'

export type Era = 'legacy' | 'modern'

/** A catalog of skills built from `files`, keyed by path (`pdf-forms/SKILL.md`). */
export function skillCatalog(files: Record<string, string>): Promise<SkillCatalog> {
  return SkillCatalog.load(memorySkillFiles(files), { onWarning: () => {} })
}

export type EditableSkills = {
  extension: SkillsExtension
  /** What skills/list answers, in order; edit it to change the listing. */
  entries: Skill[]
  /** What a read of each URI answers (text, or bytes sent as a blob); edit it to serve another file. */
  files: Map<string, string | Uint8Array>
  /** Publishes the skill at `path` (`acme/deploy`) with `files` keyed by path under it. */
  add: (path: string, files: Record<string, string | Uint8Array>) => Promise<Skill>
}

/** A skills extension whose listing and file contents the test edits. */
export function editableSkills(): EditableSkills {
  const entries: Skill[] = []
  const files = new Map<string, string | Uint8Array>()
  const source: SkillSource = {
    list: async () => ({ skills: [...entries] }),
    get: async uri => entries.find(entry => entry.uri === uri),
    read: async uri => {
      const content = files.get(uri)
      if (content === undefined) return undefined
      return typeof content === 'string'
        ? { text: content, mimeType: 'text/markdown' }
        : { bytes: content, mimeType: 'application/octet-stream' }
    },
  }
  return {
    extension: new SkillsExtension({ source, onWarning: () => {} }),
    entries,
    files,
    add: async (path, skillFiles) => {
      const entry = await skillEntry(path, skillFiles)
      entries.push(entry)
      for (const [file, text] of Object.entries(skillFiles)) files.set(`skill://${path}/${file}`, text)
      return entry
    },
  }
}

export type SkillServer = {
  connection: ConnectedMCPServer
  /** The HTTP fixture, on 2026-07-28 only. */
  fixture?: ModernFixture
  /** Sends notifications/resources/list_changed (on 2026-07-28, to the listen streams). */
  resourcesChanged: () => void
  /** Sends notifications/prompts/list_changed (on 2026-07-28, to the listen streams). */
  promptsChanged: () => void
  close: () => Promise<void>
}

/**
 * `extension` served to the v2 Client the way connectToServer joins one
 * (through the wire filter). The config is `sdk`, so ensureConnectedClient
 * hands the connection straight back.
 */
export async function connectSkillServer(
  name: string,
  era: Era,
  extension: SkillsExtension,
  options: { config?: Partial<ScopedMcpServerConfig>; build?: (server: McpServer) => void } = {},
): Promise<SkillServer> {
  const build = (server: McpServer) => {
    options.build?.(server)
    extension.attach(server)
  }
  const config = { type: 'sdk', name, scope: 'local', ...options.config } as ScopedMcpServerConfig
  const wrap = (
    client: Client,
    close: () => Promise<void>,
    notify: Pick<SkillServer, 'resourcesChanged' | 'promptsChanged'>,
    fixture?: ModernFixture,
  ): SkillServer => ({
    connection: {
      type: 'connected',
      name,
      client,
      capabilities: client.getServerCapabilities() ?? {},
      config,
      cleanup: close,
    },
    fixture,
    ...notify,
    close,
  })

  if (era === 'legacy') {
    const server = new McpServer({ name: `${name}-server`, version: '2.4.0' })
    build(server)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'skills-client', version: '1.0.0' })
    await server.connect(serverTransport)
    attachMcpWireFilter(name, clientTransport)
    await client.connect(clientTransport)
    return wrap(
      client,
      async () => {
        await client.close()
        await server.close()
      },
      {
        resourcesChanged: () => server.sendResourceListChanged(),
        promptsChanged: () => server.sendPromptListChanged(),
      },
    )
  }

  const fixture = serveModern(build)
  const transport = new StreamableHTTPClientTransport(new URL(fixture.url))
  const client = new Client({ name: 'skills-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
  attachMcpWireFilter(name, transport)
  await client.connect(transport)
  return wrap(
    client,
    async () => {
      await client.close()
      await fixture.stop()
    },
    {
      resourcesChanged: () => fixture.notify.resourcesChanged(),
      promptsChanged: () => fixture.notify.promptsChanged(),
    },
    fixture,
  )
}
