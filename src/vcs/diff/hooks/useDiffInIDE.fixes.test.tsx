/**
 * The IDE diff's fix decisions (spec, findings 2, 9 and 10): an empty path
 * opens nothing, a tab is closed once and only when it was opened, and the
 * dialog going away closes its tab and lets go of its listeners.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { getCwdState, setCwdState } from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import type { FileEdit } from 'src/tools/FileEditTool/types.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { hostHook, stopAllHooks, until } from 'src/vcs/diff/hooks/__testutils__/hookHost.js'
import { useDiffInIDE } from 'src/vcs/diff/hooks/useDiffInIDE.js'

type Call = { tool: string; args: Record<string, unknown> }

/** An editor over MCP whose diffs stay open until `reply` is called. */
async function startEditor() {
  const calls: Call[] = []
  const open: Array<(result: CallToolResult) => void> = []
  const server = new Server({ name: 'editor', version: '0.0.1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  server.setRequestHandler(CallToolRequestSchema, request => {
    calls.push({ tool: request.params.name, args: request.params.arguments ?? {} })
    if (request.params.name === 'openDiff') return new Promise<CallToolResult>(resolve => open.push(resolve))
    return Promise.resolve({ content: [] })
  })
  const client = new Client({ name: 'fixes', version: '0.0.1' })
  const [serverEnd, clientEnd] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverEnd), client.connect(clientEnd)])
  const connection = {
    type: 'connected',
    name: 'ide',
    client,
    capabilities: { tools: {} },
    config: { type: 'ws-ide', ideName: 'Editor', url: 'ws://127.0.0.1:1', scope: 'dynamic' },
    cleanup: async () => {},
  } as unknown as MCPServerConnection
  return {
    connection,
    closes: () => calls.filter(call => call.tool === 'close_tab'),
    opens: () => calls.filter(call => call.tool === 'openDiff'),
    calls,
    reply: (...words: string[]) => open.shift()!({ content: words.map(text => ({ type: 'text' as const, text })) }),
    stop: () => client.close(),
  }
}

let dir: string
let cwdBefore: string
let configDirBefore: string | undefined
const editors: Array<{ stop: () => Promise<void> }> = []

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ide-diff-fixes-')))
  cwdBefore = getCwdState()
  configDirBefore = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = join(dir, 'config')
  resetGlobalConfigForTests()
})

afterEach(async () => {
  stopAllHooks()
  for (const editor of editors.splice(0)) await editor.stop()
  resetGlobalConfigForTests()
  setCwdState(cwdBefore)
  if (configDirBefore === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = configDirBefore
  rmSync(dir, { recursive: true, force: true })
})

const UPPER_B: FileEdit[] = [{ old_string: 'b', new_string: 'B', replace_all: false }]

async function mount(editor: Awaited<ReturnType<typeof startEditor>>, filePath: string, edits: FileEdit[]) {
  const decisions: unknown[] = []
  const abortController = new AbortController()
  const toolUseContext = { options: { mcpClients: [editor.connection] }, abortController } as unknown as ToolUseContext
  const host = await hostHook(useDiffInIDE, {
    onChange: (option, input) => {
      decisions.push({ option, input })
    },
    toolUseContext,
    filePath,
    edits,
    editMode: 'single',
  })
  return { host, decisions, abortController }
}

async function editorWithFile(text = 'a\nb\nc') {
  const editor = await startEditor()
  editors.push(editor)
  const filePath = join(dir, 'file.ts')
  writeFileSync(filePath, text)
  return { editor, filePath }
}

describe('an empty path is not shown (finding 2)', () => {
  test('nothing is read, nothing is sent, and there is no error', async () => {
    const { editor } = await editorWithFile()
    setCwdState(dir)
    const listenersBefore = process.listenerCount('beforeExit')

    const { host } = await mount(editor, '', [])
    expect(process.listenerCount('beforeExit')).toBe(listenersBefore)
    await host.current().closeTabInIDE()
    await Bun.sleep(100)

    expect(editor.calls).toEqual([])
    expect(host.current()).toMatchObject({ showingDiffInIDE: false, hasError: false })
  })
})

describe('a tab is closed once, and only when it was opened (finding 9)', () => {
  test('a rejection closes the tab once', async () => {
    const { editor, filePath } = await editorWithFile()
    const { decisions } = await mount(editor, filePath, UPPER_B)
    await until('the diff', () => editor.opens().length === 1)

    editor.reply('DIFF_REJECTED')
    await until('the decision', () => decisions.length === 1)
    await Bun.sleep(100)
    expect(editor.closes()).toHaveLength(1)
  })

  test('edits that do not apply open no tab, so none is closed', async () => {
    const { editor, filePath } = await editorWithFile()
    const { host } = await mount(editor, filePath, [{ old_string: 'zzz', new_string: 'y', replace_all: false }])
    await until('the error', () => host.current().hasError)

    await host.current().closeTabInIDE()
    host.stop()
    await Bun.sleep(100)
    expect(editor.calls).toEqual([])
  })

  test('closing from the terminal closes once, and a later answer decides nothing', async () => {
    const { editor, filePath } = await editorWithFile()
    const { host, decisions } = await mount(editor, filePath, UPPER_B)
    await until('the diff', () => editor.opens().length === 1)

    await host.current().closeTabInIDE()
    editor.reply('TAB_CLOSED')
    await host.current().closeTabInIDE()
    host.stop()
    await Bun.sleep(100)

    expect(editor.closes()).toHaveLength(1)
    expect(decisions).toEqual([])
  })
})

describe('the dialog going away (finding 10)', () => {
  test('unmounting without an answer closes the tab and drops the listeners', async () => {
    const { editor, filePath } = await editorWithFile()
    const listenersBefore = process.listenerCount('beforeExit')
    const { host, decisions, abortController } = await mount(editor, filePath, UPPER_B)
    await until('the diff', () => editor.opens().length === 1)
    expect(process.listenerCount('beforeExit')).toBe(listenersBefore + 1)
    const tabName = editor.opens()[0]!.args.tab_name

    host.stop()
    await until('the tab to close', () => editor.closes().length === 1)
    expect(editor.closes()[0]!.args).toEqual({ tab_name: tabName })
    expect(process.listenerCount('beforeExit')).toBe(listenersBefore)

    abortController.abort()
    process.emit('beforeExit', 0)
    editor.reply('TAB_CLOSED')
    await Bun.sleep(100)
    expect(editor.closes()).toHaveLength(1)
    expect(decisions).toEqual([])
  })

  test('after an answer, unmounting closes nothing more', async () => {
    const { editor, filePath } = await editorWithFile()
    const { host, decisions } = await mount(editor, filePath, UPPER_B)
    await until('the diff', () => editor.opens().length === 1)

    editor.reply('TAB_CLOSED')
    await until('the decision', () => decisions.length === 1)
    host.stop()
    await Bun.sleep(100)
    expect(editor.closes()).toHaveLength(1)
  })
})
