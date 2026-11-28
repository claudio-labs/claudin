// Characterization of the service-backed attachment producers in services.ts,
// ahead of MCP resource subscriptions (an @-mentioned resource will soon be
// subscribed): what each producer emits and when it emits nothing.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import { diagnosticTracker } from 'src/platform/diagnosticTracking.js'
import { registerPendingAsyncHook } from 'src/platform/lifecycleHooks/AsyncHookRegistry.js'
import {
  createIdleNotification,
  createShutdownApprovedMessage,
  readMailbox,
  writeToMailbox,
} from 'src/agent/coordinator/teammateMailbox.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import {
  getAsyncHookResponseAttachments,
  getDiagnosticAttachments,
  getDynamicSkillAttachments,
  getOpenedFileFromIDE,
  getSelectedLinesFromIDE,
  getTeammateMailboxAttachments,
  processAgentMentions,
  processAtMentionedFiles,
  processMcpResourceAttachments,
} from 'src/agent/attachments/services.js'

let dir: string
let configDir: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['CLAUDIN_SIMPLE', 'CLAUDIN_CONFIG_DIR', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  dir = mkdtempSync(join(tmpdir(), 'services-cover-'))
  configDir = mkdtempSync(join(tmpdir(), 'services-cover-config-'))
  // Skill discovery behind generateFileAttachment is irrelevant here.
  process.env.CLAUDIN_SIMPLE = '1'
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

function permissionContext(deny: string[] = []) {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: deny.length > 0 ? { session: deny } : {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  }
}

// An absolute-path rule (`//` prefix) for every *.secret under the temp dir.
function secretRule(): string {
  return `Read(/${dir}/**/*.secret)`
}

function makeCtx(overrides: {
  deny?: string[]
  mcpClients?: unknown[]
  mcpResources?: Record<string, unknown[]>
  tools?: Array<{ name: string }>
  dynamicSkillDirTriggers?: Set<string>
} = {}): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    dynamicSkillDirTriggers: overrides.dynamicSkillDirTriggers,
    getAppState: () => ({ toolPermissionContext: permissionContext(overrides.deny) }),
    setAppState: () => {},
    options: {
      mcpClients: overrides.mcpClients ?? [],
      mcpResources: overrides.mcpResources,
      tools: overrides.tools ?? [],
    },
  } as unknown as ToolUseContext
}

const IDE_CLIENT = {
  name: 'ide',
  type: 'connected',
  config: { type: 'ws-ide', ideName: 'VS Code', url: 'ws://127.0.0.1:1', scope: 'dynamic' },
}

describe('getSelectedLinesFromIDE', () => {
  const selection = (filePath: string) => ({
    filePath,
    text: 'a\nb\nc',
    lineStart: 10,
    lineCount: 3,
  })

  test('a selection becomes selected_lines_in_ide with an inclusive line range', async () => {
    const file = join(dir, 'sel.ts')
    const out = await getSelectedLinesFromIDE(
      selection(file) as never,
      makeCtx({ mcpClients: [IDE_CLIENT] }),
    )
    expect(out).toEqual([
      {
        type: 'selected_lines_in_ide',
        ideName: 'VS Code',
        lineStart: 10,
        lineEnd: 12,
        filename: file,
        content: 'a\nb\nc',
        displayPath: relative(getCwd(), file),
      },
    ])
  })

  test('nothing without a selected text, or for a file denied to Read', async () => {
    const file = join(dir, 'sel.ts')
    const ctx = makeCtx({ mcpClients: [IDE_CLIENT] })
    expect(await getSelectedLinesFromIDE(null, ctx)).toEqual([])
    expect(
      await getSelectedLinesFromIDE({ ...selection(file), text: '' } as never, ctx),
    ).toEqual([])
    expect(
      await getSelectedLinesFromIDE(
        selection(join(dir, 'key.secret')) as never,
        makeCtx({ mcpClients: [IDE_CLIENT], deny: [secretRule()] }),
      ),
    ).toEqual([])
  })
})

describe('getOpenedFileFromIDE', () => {
  test('an opened file outside the working dirs is attached with no nested memory', async () => {
    const file = join(dir, 'open.ts')
    const out = await getOpenedFileFromIDE({ filePath: file } as never, makeCtx())
    expect(out).toEqual([{ type: 'opened_file_in_ide', filename: file }])
  })

  test('nothing for a selection with text, no file, or a denied file', async () => {
    const ctx = makeCtx({ deny: [secretRule()] })
    expect(await getOpenedFileFromIDE(null, ctx)).toEqual([])
    expect(
      await getOpenedFileFromIDE({ filePath: join(dir, 'open.ts'), text: 'x' } as never, ctx),
    ).toEqual([])
    expect(
      await getOpenedFileFromIDE({ filePath: join(dir, 'k.secret') } as never, ctx),
    ).toEqual([])
  })
})

describe('processAtMentionedFiles', () => {
  test('no @-mention, no work', async () => {
    expect(await processAtMentionedFiles('plain text', makeCtx())).toEqual([])
  })

  test('a directory mention lists its entries', async () => {
    const sub = join(dir, 'listing')
    mkdirSync(join(sub, 'inner'), { recursive: true })
    writeFileSync(join(sub, 'one.txt'), '1')
    const [att] = await processAtMentionedFiles(`see @${sub} please`, makeCtx())
    expect(att).toMatchObject({
      type: 'directory',
      path: sub,
      displayPath: relative(getCwd(), sub),
    })
    expect((att as { content: string }).content.split('\n').sort()).toEqual(['inner', 'one.txt'])
  })

  test('a directory past 1000 entries is cut, with a count of the rest', async () => {
    const big = join(dir, 'big')
    mkdirSync(big)
    for (let i = 0; i < 1003; i++) writeFileSync(join(big, `f${i}`), '')
    const [att] = await processAtMentionedFiles(`@${big}`, makeCtx())
    const lines = (att as { content: string }).content.split('\n')
    expect(lines).toHaveLength(1001)
    expect(lines[1000]).toBe('\u2026 and 3 more entries')
  })

  test('a file mention with a line range attaches that slice; denied and missing files drop out', async () => {
    const file = join(dir, 'lines.ts')
    writeFileSync(file, 'one\ntwo\nthree\nfour\n')
    // Exists, so only the deny rule can drop it.
    writeFileSync(join(dir, 'x.secret'), 'token')
    const out = await processAtMentionedFiles(
      `@${file}#L2-3 @${join(dir, 'x.secret')} @${join(dir, 'missing.ts')}`,
      makeCtx({ deny: [secretRule()] }),
    )
    expect(out).toHaveLength(1)
    const att = out[0] as { type: string; filename: string; content: { file: { content: string; startLine: number } } }
    expect(att.type).toBe('file')
    expect(att.filename).toBe(file)
    expect(att.content.file.startLine).toBe(2)
    expect(att.content.file.content).toBe('two\nthree')
  })
})

describe('processAgentMentions', () => {
  const agents = [{ agentType: 'reviewer' }, { agentType: 'asana:status' }] as never

  test('known agents, in both mention forms; unknown ones are dropped', () => {
    expect(
      processAgentMentions('@agent-reviewer and @"asana:status (agent)" and @agent-ghost', agents),
    ).toEqual([
      { type: 'agent_mention', agentType: 'asana:status' },
      { type: 'agent_mention', agentType: 'reviewer' },
    ])
  })

  test('no mention, no attachment', () => {
    expect(processAgentMentions('hello', agents)).toEqual([])
  })
})

describe('processMcpResourceAttachments against a real MCP server', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
  })

  async function docsServer(onRead?: (uri: string) => void) {
    const server = new McpServer({ name: 'docs', version: '1.0.0' })
    server.registerResource('readme', 'docs://readme', { mimeType: 'text/plain' }, async uri => {
      onRead?.(uri.href)
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Hello.' }] }
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'cover', version: '1.0.0' })
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    closers.push(async () => {
      await client.close()
      await server.close()
    })
    return { name: 'docs', type: 'connected', client, config: { type: 'sdk', name: 'docs', scope: 'local' } }
  }

  const listed = {
    docs: [
      { uri: 'docs://readme', name: 'README', description: 'The readme', server: 'docs' },
      { uri: 'docs://gone', name: 'Gone', server: 'docs' },
      { uri: 'docs://unnamed', name: '', server: 'docs' },
    ],
  }

  test('a listed resource is read and attached with its listing metadata', async () => {
    const reads: string[] = []
    const docs = await docsServer(uri => reads.push(uri))
    const out = await processMcpResourceAttachments(
      'look at @docs:docs://readme now',
      makeCtx({ mcpClients: [docs], mcpResources: listed }),
    )
    expect(out).toEqual([
      {
        type: 'mcp_resource',
        server: 'docs',
        uri: 'docs://readme',
        name: 'README',
        description: 'The readme',
        content: { contents: [{ uri: 'docs://readme', mimeType: 'text/plain', text: 'Hello.' }] },
      },
    ])
    expect(reads).toEqual(['docs://readme'])
  })

  test('the same mention twice is read once', async () => {
    const reads: string[] = []
    const docs = await docsServer(uri => reads.push(uri))
    const out = await processMcpResourceAttachments(
      '@docs:docs://readme and again @docs:docs://readme',
      makeCtx({ mcpClients: [docs], mcpResources: listed }),
    )
    expect(out).toHaveLength(1)
    expect(reads).toEqual(['docs://readme'])
  })

  test('drops a resource the listing lacks, an unknown or unconnected server, and a failed read', async () => {
    const reads: string[] = []
    const docs = await docsServer(uri => reads.push(uri))
    const out = await processMcpResourceAttachments(
      [
        '@docs:docs://unlisted', // connected, but not in mcpResources: never read
        '@nobody:docs://readme', // no such server
        '@down:docs://readme', // server not connected
        '@docs:docs://gone', // listed, but the server cannot read it
        '@::x', // no server name
        '@C:/Users/me/file.txt', // a Windows drive, not a server
      ].join(' '),
      makeCtx({
        mcpClients: [docs, { name: 'down', type: 'failed' }],
        mcpResources: { ...listed, down: listed.docs },
      }),
    )
    expect(out).toEqual([])
    expect(reads).toEqual([])
  })

  test('a resource listed without a name is named by its uri', async () => {
    const server = new McpServer({ name: 'docs', version: '1.0.0' })
    server.registerResource('u', 'docs://unnamed', {}, async uri => ({
      contents: [{ uri: uri.href, text: 'u' }],
    }))
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'cover', version: '1.0.0' })
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    closers.push(async () => {
      await client.close()
      await server.close()
    })
    const [att] = await processMcpResourceAttachments(
      '@docs:docs://unnamed',
      makeCtx({ mcpClients: [{ name: 'docs', type: 'connected', client }], mcpResources: listed }),
    )
    expect(att).toMatchObject({ type: 'mcp_resource', name: 'docs://unnamed', description: undefined })
  })

  test('no resource mention, or no listing at all, yields nothing', async () => {
    const docs = await docsServer()
    expect(await processMcpResourceAttachments('no mention', makeCtx({ mcpClients: [docs] }))).toEqual([])
    expect(
      await processMcpResourceAttachments('@docs:docs://readme', makeCtx({ mcpClients: [docs] })),
    ).toEqual([])
  })
})

describe('getDynamicSkillAttachments', () => {
  test('lists the sub-directories holding a SKILL.md, then clears the triggers', async () => {
    const skills = join(dir, 'skills')
    mkdirSync(join(skills, 'has-skill'), { recursive: true })
    writeFileSync(join(skills, 'has-skill', 'SKILL.md'), '# s')
    mkdirSync(join(skills, 'no-skill'))
    writeFileSync(join(skills, 'loose.md'), 'x')
    const empty = join(dir, 'skills-empty')
    mkdirSync(empty)
    const triggers = new Set([skills, empty, join(dir, 'does-not-exist')])
    const out = await getDynamicSkillAttachments(makeCtx({ dynamicSkillDirTriggers: triggers }))
    expect(out).toEqual([
      {
        type: 'dynamic_skill',
        skillDir: skills,
        skillNames: ['has-skill'],
        displayPath: relative(getCwd(), skills),
      },
    ])
    expect(triggers.size).toBe(0)
  })

  test('nothing without triggers', async () => {
    expect(await getDynamicSkillAttachments(makeCtx())).toEqual([])
    expect(await getDynamicSkillAttachments(makeCtx({ dynamicSkillDirTriggers: new Set() }))).toEqual([])
  })
})

describe('getDiagnosticAttachments', () => {
  // Each test restores its own spy in a finally, so no stub outlives it.
  const file = { uri: 'file:///a.ts', diagnostics: [] }

  test('new IDE diagnostics become one diagnostics attachment when Bash is available', async () => {
    const spy = spyOn(diagnosticTracker, 'getNewDiagnosticsCompat').mockResolvedValue([file] as never)
    try {
      expect(await getDiagnosticAttachments(makeCtx({ tools: [{ name: BASH_TOOL_NAME }] }))).toEqual([
        { type: 'diagnostics', files: [file], isNew: true },
      ])
    } finally {
      spy.mockRestore()
    }
  })

  test('none when nothing is new, and the tracker is not even asked without Bash', async () => {
    const spy = spyOn(diagnosticTracker, 'getNewDiagnosticsCompat').mockResolvedValue([])
    try {
      expect(await getDiagnosticAttachments(makeCtx({ tools: [{ name: BASH_TOOL_NAME }] }))).toEqual([])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(await getDiagnosticAttachments(makeCtx({ tools: [{ name: 'Read' }] }))).toEqual([])
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('getAsyncHookResponseAttachments', () => {
  test('a completed async hook is delivered once, with its parsed JSON response', async () => {
    const stdout = 'progress line\n{"decision":"approve","reason":"ok"}\n'
    registerPendingAsyncHook({
      processId: 'cover-proc-1',
      hookId: 'cover-hook-1',
      asyncResponse: { async: true },
      hookName: 'PostToolUse:Bash',
      hookEvent: 'PostToolUse',
      command: 'echo',
      toolName: 'Bash',
      shellCommand: {
        status: 'completed',
        taskOutput: { getStdout: async () => stdout, getStderr: () => 'warn' },
        result: Promise.resolve({ code: 0 }),
        cleanup: () => {},
      } as never,
    })
    const out = await getAsyncHookResponseAttachments()
    expect(out).toEqual([
      {
        type: 'async_hook_response',
        processId: 'cover-proc-1',
        hookName: 'PostToolUse:Bash',
        hookEvent: 'PostToolUse',
        toolName: 'Bash',
        response: { decision: 'approve', reason: 'ok' },
        stdout,
        stderr: 'warn',
        exitCode: 0,
      },
    ])
    expect(await getAsyncHookResponseAttachments()).toEqual([])
  })
})

describe('getTeammateMailboxAttachments (leader)', () => {
  const TEAM = 'services-cover-team'
  const LEAD = 'boss'

  afterEach(() => {
    rmSync(join(configDir, 'teams'), { recursive: true, force: true })
    rmSync(join(configDir, 'tasks'), { recursive: true, force: true })
  })

  function leaderCtx(inbox: Array<Record<string, unknown>> = []) {
    let state = {
      tasks: {},
      viewingAgentTaskId: undefined as string | undefined,
      inbox: { messages: inbox },
      teamContext: {
        teamName: TEAM,
        leadAgentId: 'lead-uuid',
        teammates: {
          'lead-uuid': { name: LEAD },
          'worker-uuid': { name: 'worker' },
        } as Record<string, { name: string }>,
      },
      toolPermissionContext: permissionContext(),
    }
    const ctx = {
      options: { tools: [], mcpClients: [] },
      getAppState: () => state,
      setAppState: (f: (prev: typeof state) => typeof state) => {
        state = f(state)
      },
    } as unknown as ToolUseContext
    return { ctx, state: () => state }
  }

  const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()

  test('merges file mail and pending inbox, dedups, keeps the latest idle per agent, and marks both read', async () => {
    await writeToMailbox(LEAD, { from: 'alice', text: 'hello lead', timestamp: ts(1) }, TEAM)
    await writeToMailbox(
      LEAD,
      { from: 'alice', text: jsonStringify(createIdleNotification('alice')), timestamp: ts(2) },
      TEAM,
    )
    await writeToMailbox(
      LEAD,
      { from: 'alice', text: jsonStringify({ ...createIdleNotification('alice'), summary: 'later' }), timestamp: ts(3) },
      TEAM,
    )
    // Structured protocol mail is left unread for the inbox poller.
    await writeToMailbox(
      LEAD,
      { from: 'bob', text: jsonStringify({ type: 'permission_request', id: 'p1' }), timestamp: ts(4) },
      TEAM,
    )
    const { ctx, state } = leaderCtx([
      // Same as the file message: deduplicated.
      { id: 'i1', from: 'alice', text: 'hello lead', timestamp: ts(1), status: 'pending' },
      { id: 'i2', from: 'carol', text: 'from the poller', timestamp: ts(5), status: 'pending', color: 'blue' },
      { id: 'i3', from: 'dave', text: 'old', timestamp: ts(0), status: 'processed' },
    ])

    const out = await getTeammateMailboxAttachments(ctx)

    expect(out).toHaveLength(1)
    const messages = (out[0] as { type: string; messages: Array<{ from: string; text: string; color?: string }> }).messages
    expect(out[0]!.type).toBe('teammate_mailbox')
    expect(messages.map(m => [m.from, m.text.includes('idle_notification') ? 'idle' : m.text])).toEqual([
      ['alice', 'hello lead'],
      ['alice', 'idle'],
      ['carol', 'from the poller'],
    ])
    expect(messages[1]!.text).toContain('later')
    expect(messages[2]!.color).toBe('blue')

    const file = await readMailbox(LEAD, TEAM)
    expect(file.map(m => m.read)).toEqual([true, true, true, false])
    expect(state().inbox.messages.map(m => m.status)).toEqual(['processed', 'processed', 'processed'])
  })

  test('a shutdown_approved in the inbox removes that teammate from the team context', async () => {
    const approval = jsonStringify(createShutdownApprovedMessage({ requestId: 'r1', from: 'worker' }))
    const { ctx, state } = leaderCtx([
      { id: 'i1', from: 'worker', text: approval, timestamp: ts(1), status: 'pending' },
    ])
    const out = await getTeammateMailboxAttachments(ctx)
    expect(out).toHaveLength(1)
    expect(Object.keys(state().teamContext.teammates)).toEqual(['lead-uuid'])
  })

  test('nothing to deliver returns [] and leaves the state alone', async () => {
    const { ctx, state } = leaderCtx()
    const before = state()
    expect(await getTeammateMailboxAttachments(ctx)).toEqual([])
    expect(state()).toBe(before)
  })

  test('no agent name and no team lead: the mailbox is not read', async () => {
    await writeToMailbox(LEAD, { from: 'alice', text: 'hi', timestamp: ts(1) }, TEAM)
    const ctx = {
      options: { tools: [], mcpClients: [] },
      getAppState: () => ({ tasks: {}, inbox: { messages: [] }, teamContext: undefined }),
      setAppState: () => {},
    } as unknown as ToolUseContext
    expect(await getTeammateMailboxAttachments(ctx)).toEqual([])
    expect((await readMailbox(LEAD, TEAM)).map(m => m.read)).toEqual([false])
  })

  test('swarms off: nothing, whatever is waiting', async () => {
    const { ctx } = leaderCtx([{ id: 'i1', from: 'a', text: 't', timestamp: ts(1), status: 'pending' }])
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    try {
      expect(await getTeammateMailboxAttachments(ctx)).toEqual([])
    } finally {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    }
  })
})
