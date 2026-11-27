// Characterization of ReadMcpResourceTool.call against a real MCP server, ahead
// of the SDK v2 migration and of resource subscriptions: what a text resource,
// a blob resource and a failing read hand back to the model.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { ReadMcpResourceTool } from 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { DESCRIPTION, PROMPT } from 'src/tools/ReadMcpResourceTool/prompt.js'
import { getToolResultsDir } from 'src/agent/tools/toolResultFiles.js'
import { getProjectDir } from 'src/sessions/pure/paths.js'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let configDir: string
let priorConfigDir: string | undefined
const closers: Array<() => Promise<void>> = []

beforeAll(() => {
  priorConfigDir = process.env.CLAUDIN_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'read-mcp-resource-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  // getProjectDir is memoized by cwd alone, not by the config dir.
  getProjectDir.cache.clear?.()
})

afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = priorConfigDir
  getProjectDir.cache.clear?.()
  rmSync(configDir, { recursive: true, force: true })
})

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function connectedResourceServer(name: string) {
  const server = new McpServer({ name, version: '1.0.0' })
  server.registerResource(
    'readme',
    'docs://readme',
    { description: 'The readme', mimeType: 'text/plain' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Hello.' }] }),
  )
  server.registerResource('logo', 'docs://logo', { mimeType: 'image/png' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'image/png', blob: PNG_BYTES.toString('base64') }],
  }))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'cover', version: '1.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return {
    name,
    type: 'connected' as const,
    client,
    capabilities: client.getServerCapabilities(),
    config: { type: 'sdk' as const, name, scope: 'local' as const },
    cleanup: async () => {},
  }
}

function ctxWithClients(mcpClients: unknown[]): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: { mcpClients },
  } as unknown as ToolUseContext
}

describe('ReadMcpResourceTool.call against a real MCP server', () => {
  test('a text resource comes back as its uri, mime type and text', async () => {
    const docs = await connectedResourceServer('docs')
    const { data } = await ReadMcpResourceTool.call(
      { server: 'docs', uri: 'docs://readme' },
      ctxWithClients([docs]),
    )
    expect(data).toEqual({
      contents: [{ uri: 'docs://readme', mimeType: 'text/plain', text: 'Hello.' }],
    })
    expect(ReadMcpResourceTool.outputSchema!.safeParse(data).success).toBe(true)
  })

  test('a blob is decoded to disk with a mime-derived extension, and the model gets the path', async () => {
    const docs = await connectedResourceServer('docs')
    const { data } = await ReadMcpResourceTool.call(
      { server: 'docs', uri: 'docs://logo' },
      ctxWithClients([docs]),
    )
    const [content] = data.contents
    expect(content!.uri).toBe('docs://logo')
    expect(content!.mimeType).toBe('image/png')
    const saved = content!.blobSavedTo!
    expect(saved.startsWith(join(getToolResultsDir(), 'mcp-resource-'))).toBe(true)
    expect(saved.endsWith('.png')).toBe(true)
    // Raw bytes, not the base64 the server sent.
    expect(readFileSync(saved)).toEqual(PNG_BYTES)
    expect(content!.text).toBe(
      `[Resource from docs at docs://logo] Binary content (image/png, 11 bytes) saved to ${saved}`,
    )
    // No base64 reaches the model-facing block.
    const block = ReadMcpResourceTool.mapToolResultToToolResultBlockParam(data, 'u1')
    expect(String(block.content)).not.toContain(PNG_BYTES.toString('base64'))
  })

  test('a blob that cannot be written says so in the text instead of failing the read', async () => {
    const docs = await connectedResourceServer('docs')
    // Occupy the session directory with a file, so neither the mkdir nor the
    // write under it can succeed.
    const sessionDir = dirname(getToolResultsDir())
    rmSync(sessionDir, { recursive: true, force: true })
    mkdirSync(dirname(sessionDir), { recursive: true })
    writeFileSync(sessionDir, 'not a directory')
    try {
      const { data } = await ReadMcpResourceTool.call(
        { server: 'docs', uri: 'docs://logo' },
        ctxWithClients([docs]),
      )
      const [content] = data.contents
      expect(content!.blobSavedTo).toBeUndefined()
      expect(content!.text).toStartWith('Binary content could not be saved to disk: ')
    } finally {
      rmSync(sessionDir, { force: true })
    }
    expect(existsSync(sessionDir)).toBe(false)
  })

  test('an unknown uri rejects with the server error', async () => {
    const docs = await connectedResourceServer('docs')
    await expect(
      ReadMcpResourceTool.call({ server: 'docs', uri: 'docs://missing' }, ctxWithClients([docs])),
    ).rejects.toThrow('docs://missing')
  })

  test('the unknown-server error lists every server it knows', async () => {
    const docs = await connectedResourceServer('docs')
    await expect(
      ReadMcpResourceTool.call(
        { server: 'nope', uri: 'docs://readme' },
        ctxWithClients([docs, { name: 'other', type: 'failed' }]),
      ),
    ).rejects.toThrow('Server "nope" not found. Available servers: docs, other')
  })
})

describe('ReadMcpResourceTool.call content shapes', () => {
  // A content item with neither text nor a string blob cannot pass the SDK's
  // result schema, so this fake skips the parse to reach the fallback arm.
  function rawServer(contents: unknown[]) {
    const asked: Array<{ method: string; params: unknown }> = []
    return {
      asked,
      conn: {
        name: 'raw',
        type: 'connected',
        capabilities: { resources: {} },
        config: { type: 'sdk', name: 'raw', scope: 'local' },
        client: {
          request: async (req: { method: string; params: unknown }) => {
            asked.push(req)
            return { contents }
          },
        },
      },
    }
  }

  test('sends resources/read with the uri, and keeps only uri and mime type of an item with no payload', async () => {
    const { asked, conn } = rawServer([{ uri: 'raw://x', mimeType: 'application/octet-stream' }])
    const { data } = await ReadMcpResourceTool.call(
      { server: 'raw', uri: 'raw://x' },
      ctxWithClients([conn]),
    )
    expect(asked).toEqual([{ method: 'resources/read', params: { uri: 'raw://x' } }])
    expect(data).toEqual({
      contents: [{ uri: 'raw://x', mimeType: 'application/octet-stream' }],
    })
  })

  test('an empty text is still a text item', async () => {
    const { conn } = rawServer([{ uri: 'raw://e', text: '' }])
    const { data } = await ReadMcpResourceTool.call(
      { server: 'raw', uri: 'raw://e' },
      ctxWithClients([conn]),
    )
    expect(data.contents).toEqual([{ uri: 'raw://e', mimeType: undefined, text: '' }])
  })
})

describe('ReadMcpResourceTool surface', () => {
  test('description and prompt come from prompt.ts', async () => {
    expect(await ReadMcpResourceTool.description()).toBe(DESCRIPTION)
    expect(await ReadMcpResourceTool.prompt()).toBe(PROMPT)
  })

  test('isResultTruncated is false even for a many-line text (current behavior)', () => {
    // It counts newlines in the COMPACT JSON, where a text's newlines are
    // escaped, so no result ever reads as truncated. Pinned as it is.
    expect(ReadMcpResourceTool.isResultTruncated!({ contents: [{ uri: 'a', text: 'x' }] })).toBe(false)
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    expect(ReadMcpResourceTool.isResultTruncated!({ contents: [{ uri: 'a', text }] })).toBe(false)
  })
})
