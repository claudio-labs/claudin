/**
 * Characterization of `useDiffInIDE`, which sends a proposed file edit to the
 * connected IDE as a diff tab and turns the IDE's answer into a permission
 * decision for the file permission dialog.
 *
 * The boundary is the IDE's MCP server. The suite runs a real MCP server that
 * plays the IDE extension (its `openDiff` waits until the test answers, as the
 * editor waits for the user) behind a real SDK client, over the SDK's
 * in-memory transport, and hands the hook that connection the way the session
 * does. Files are real, in temp directories.
 *
 * Texts in exact-edit cases never end with a newline: the recomputed edits
 * drop a final newline, a defect this suite leaves free (spec, finding 3).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MCPServerConnection } from 'src/mcp/types.js'
import type { PermissionOption } from 'src/permissions/ui/FilePermissionDialog/permissionOptions.js'
import { getCwdState, setCwdState } from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests, saveGlobalConfig } from 'src/platform/config/config.js'
import { getConnectedIdeName } from 'src/platform/ide/ide.js'
import type { FileEdit } from 'src/tools/FileEditTool/types.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { hostHook, stopAllHooks, until } from 'src/vcs/diff/hooks/__testutils__/hookHost.js'
import { useDiffInIDE } from 'src/vcs/diff/hooks/useDiffInIDE.js'

type IdeRequest = { tool: string; args: Record<string, unknown> }
type Decision = { option: PermissionOption; input: { file_path: string; edits: FileEdit[] } }

/** The IDE extension, as an MCP server. `openDiff` answers only when told to. */
class FakeIde {
  readonly requests: IdeRequest[] = []
  private readonly waiting: Array<(answer: CallToolResult) => void> = []
  private constructor(
    readonly connection: MCPServerConnection,
    private readonly client: Client,
  ) {}

  static async start(config: { type: 'ws-ide' | 'sse-ide'; ideName: string }): Promise<FakeIde> {
    const server = new Server({ name: 'fake-ide', version: '1.0.0' }, { capabilities: { tools: {} } })
    const client = new Client({ name: 'characterization', version: '1.0.0' })
    const connection = {
      type: 'connected',
      name: 'ide',
      client,
      capabilities: { tools: {} },
      config: { ...config, url: 'ws://127.0.0.1:1', scope: 'dynamic' },
      cleanup: async () => {},
    } as unknown as MCPServerConnection
    const ide = new FakeIde(connection, client)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    server.setRequestHandler(CallToolRequestSchema, async request => {
      ide.requests.push({ tool: request.params.name, args: request.params.arguments ?? {} })
      if (request.params.name !== 'openDiff') return { content: [] }
      return new Promise<CallToolResult>(resolve => ide.waiting.push(resolve))
    })
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    return ide
  }

  /** Plays the user's action in the editor on the oldest open diff. */
  answer(result: CallToolResult): void {
    const reply = this.waiting.shift()
    if (!reply) throw new Error('no diff is waiting for an answer')
    reply(result)
  }

  asked(tool: string): IdeRequest[] {
    return this.requests.filter(request => request.tool === tool)
  }

  async shutdown(): Promise<void> {
    await this.client.close()
  }
}

const text = (...lines: string[]): CallToolResult => ({
  content: lines.map(line => ({ type: 'text' as const, text: line })),
})

let workdir: string
let ides: FakeIde[] = []
let sessionCwdBefore: string
let configDirBefore: string | undefined

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), 'ide-diff-')))
  sessionCwdBefore = getCwdState()
  configDirBefore = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = join(workdir, 'config')
  resetGlobalConfigForTests()
})

afterEach(async () => {
  stopAllHooks()
  for (const ide of ides) await ide.shutdown()
  ides = []
  resetGlobalConfigForTests()
  setCwdState(sessionCwdBefore)
  if (configDirBefore === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = configDirBefore
  rmSync(workdir, { recursive: true, force: true })
})

async function connectIde(
  config: { type: 'ws-ide' | 'sse-ide'; ideName: string } = { type: 'ws-ide', ideName: 'Fake Editor' },
): Promise<FakeIde> {
  const ide = await FakeIde.start(config)
  ides.push(ide)
  return ide
}

function sourceFile(name: string, content: string): string {
  const path = join(workdir, name)
  writeFileSync(path, content)
  return path
}

type HookProps = Parameters<typeof useDiffInIDE>[0]

/** The session's MCP servers, the file, the proposed edits, and how to rebuild them. */
type Scenario = Pick<HookProps, 'filePath' | 'edits'> & {
  servers: readonly MCPServerConnection[]
  mode?: HookProps['editMode']
}

async function openDialog(scenario: Scenario) {
  const decisions: Decision[] = []
  const abortController = new AbortController()
  const toolUseContext = {
    options: { mcpClients: [...scenario.servers] },
    abortController,
  } as unknown as ToolUseContext
  const props: HookProps = {
    onChange: (option, input) => {
      decisions.push({ option, input })
    },
    toolUseContext,
    filePath: scenario.filePath,
    edits: scenario.edits,
    editMode: scenario.mode ?? 'single',
  }
  const host = await hostHook(useDiffInIDE, props)
  return { host, decisions, abortController, props }
}

const THREE = 'alpha\nbeta\ngamma'
const BETA_UP: FileEdit[] = [{ old_string: 'beta', new_string: 'BETA', replace_all: false }]
const TAB_NAME = /^✻ \[Claudin\] (.+) \(([0-9a-f]{6})\) ⧉$/

describe('whether the diff goes to the IDE', () => {
  const gates: Array<{
    name: string
    clients: (ide: FakeIde) => MCPServerConnection[]
    diffTool?: 'terminal' | 'auto'
    file?: string
    shown: boolean
  }> = [
    { name: 'a connected IDE and a source file', clients: ide => [ide.connection], shown: true },
    {
      name: 'the IDE among other servers',
      clients: ide => [{ ...ide.connection, name: 'github' } as MCPServerConnection, ide.connection],
      shown: true,
    },
    { name: 'no IDE connection', clients: () => [], shown: false },
    {
      name: 'an IDE entry that is not connected',
      clients: ide => [{ type: 'pending', name: 'ide', config: ide.connection.config } as MCPServerConnection],
      shown: false,
    },
    {
      name: 'a connected server that is not the IDE',
      clients: ide => [{ ...ide.connection, name: 'github' } as MCPServerConnection],
      shown: false,
    },
    { name: 'the diff tool set to terminal', clients: ide => [ide.connection], diffTool: 'terminal', shown: false },
    { name: 'a notebook', clients: ide => [ide.connection], file: 'analysis.ipynb', shown: false },
  ]

  for (const row of gates) {
    test(`${row.shown ? 'shown' : 'not shown'} for ${row.name}`, async () => {
      const ide = await connectIde()
      if (row.diffTool) saveGlobalConfig(config => ({ ...config, diffTool: row.diffTool }))
      const filePath = sourceFile(row.file ?? 'notes.md', THREE)

      const { host, decisions } = await openDialog({ servers: row.clients(ide), filePath, edits: BETA_UP })
      expect(host.current()).toMatchObject({ showingDiffInIDE: row.shown, hasError: false })

      if (row.shown) await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)
      else await Bun.sleep(200)
      expect(ide.asked('openDiff')).toHaveLength(row.shown ? 1 : 0)
      expect(decisions).toEqual([])
    })
  }

  test('the IDE name comes from the IDE connection', async () => {
    const cases = [
      { config: { type: 'ws-ide' as const, ideName: 'Fake Editor' }, name: 'Fake Editor' },
      { config: { type: 'sse-ide' as const, ideName: 'Other Editor' }, name: 'Other Editor' },
    ]
    for (const row of cases) {
      const ide = await connectIde(row.config)
      const { host } = await openDialog({
        servers: [ide.connection],
        filePath: sourceFile('named.ts', THREE),
        edits: BETA_UP,
      })
      expect(host.current().ideName).toBe(row.name)
      host.stop()
    }
  })

  test('without an IDE connection the name falls back to "IDE" when the terminal names none', async () => {
    const { host } = await openDialog({ servers: [], filePath: sourceFile('x.ts', THREE), edits: BETA_UP })
    expect(host.current().ideName).toBe(getConnectedIdeName([]) ?? 'IDE')
  })
})

describe('what the IDE is asked to show', () => {
  test('one openDiff with the file path twice, the edited text, and a tab name', async () => {
    const ide = await connectIde()
    const filePath = sourceFile('notes.md', THREE)

    await openDialog({ servers: [ide.connection], filePath, edits: BETA_UP })
    await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)

    const [request] = ide.asked('openDiff')
    expect(Object.keys(request!.args).sort()).toEqual([
      'new_file_contents',
      'new_file_path',
      'old_file_path',
      'tab_name',
    ])
    expect(request!.args).toMatchObject({
      old_file_path: filePath,
      new_file_path: filePath,
      new_file_contents: 'alpha\nBETA\ngamma',
    })
    expect(String(request!.args.tab_name)).toMatch(TAB_NAME)
    expect(TAB_NAME.exec(String(request!.args.tab_name))![1]).toBe('notes.md')
    expect(readFileSync(filePath, 'utf8')).toBe(THREE)
  })

  const proposals: Array<{ name: string; file: string | null; edits: FileEdit[]; shows: string }> = [
    {
      name: 'several edits apply in order, replace_all included',
      file: 'let a = 1\nlet b = 1\nlet c = 1\n',
      edits: [
        { old_string: 'let a = 1', new_string: 'let a = 2', replace_all: false },
        { old_string: '= 1', new_string: '= 3', replace_all: true },
      ],
      shows: 'let a = 2\nlet b = 3\nlet c = 3\n',
    },
    {
      name: 'a missing file counts as empty',
      file: null,
      edits: [{ old_string: '', new_string: 'brand new\n', replace_all: false }],
      shows: 'brand new\n',
    },
    {
      name: 'CRLF line endings are read as LF',
      file: 'one\r\ntwo\r\n',
      edits: [{ old_string: 'two', new_string: 'TWO', replace_all: false }],
      shows: 'one\nTWO\n',
    },
  ]

  for (const row of proposals) {
    test(row.name, async () => {
      const ide = await connectIde()
      const filePath = row.file === null ? join(workdir, 'absent.ts') : sourceFile('given.ts', row.file)

      await openDialog({ servers: [ide.connection], filePath, edits: row.edits })
      await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)

      expect(ide.asked('openDiff')[0]!.args.new_file_contents).toBe(row.shows)
    })
  }

  test('a relative path is read from the session directory, and sent absolute', async () => {
    const ide = await connectIde()
    mkdirSync(join(workdir, 'src'))
    const absolute = sourceFile('src/rel.ts', THREE)
    setCwdState(workdir)

    const { decisions } = await openDialog({ servers: [ide.connection], filePath: 'src/rel.ts', edits: BETA_UP })
    await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)
    expect(ide.asked('openDiff')[0]!.args).toMatchObject({ old_file_path: absolute, new_file_path: absolute })

    ide.answer(text('TAB_CLOSED'))
    await until('a decision', () => decisions.length === 1)
    expect(decisions[0]!.input.file_path).toBe('src/rel.ts')
  })

  test('each dialog gets its own tab name, and later props do not reopen it', async () => {
    const ide = await connectIde()
    const filePath = sourceFile('twice.ts', THREE)

    const first = await openDialog({ servers: [ide.connection], filePath, edits: BETA_UP })
    await openDialog({ servers: [ide.connection], filePath, edits: BETA_UP })
    await until('both diffs', () => ide.asked('openDiff').length === 2)

    first.host.rerender({
      ...first.props,
      edits: [{ old_string: 'gamma', new_string: 'GAMMA', replace_all: false }],
    })
    await Bun.sleep(150)

    const names = ide.asked('openDiff').map(request => request.args.tab_name)
    expect(names).toHaveLength(2)
    expect(names[0]).not.toBe(names[1])
  })
})

describe("the IDE's answer", () => {
  const originalEdits = BETA_UP
  const answers: Array<{
    name: string
    answer: CallToolResult
    option: PermissionOption['type'] | null
    edits?: FileEdit[]
  }> = [
    {
      name: 'saved with the user’s own changes: accept once, edits rebuilt from the saved text',
      answer: text('FILE_SAVED', 'alpha\nBETA!\ngamma\ndelta'),
      option: 'accept-once',
      edits: [{ old_string: THREE, new_string: 'alpha\nBETA!\ngamma\ndelta', replace_all: false }],
    },
    {
      name: 'tab closed: accept once, edits rebuilt from the proposal',
      answer: text('TAB_CLOSED'),
      option: 'accept-once',
      edits: [{ old_string: THREE, new_string: 'alpha\nBETA\ngamma', replace_all: false }],
    },
    {
      name: 'rejected: reject, with the edits as proposed',
      answer: text('DIFF_REJECTED'),
      option: 'reject',
      edits: originalEdits,
    },
    {
      name: 'saved unchanged from the original: reject, with the edits as proposed',
      answer: text('FILE_SAVED', THREE),
      option: 'reject',
      edits: originalEdits,
    },
    { name: 'an unknown word: no decision, an error', answer: text('SOMETHING_ELSE'), option: null },
    { name: 'saved without the text: no decision, an error', answer: text('FILE_SAVED'), option: null },
    { name: 'no content at all: no decision, an error', answer: { content: [] }, option: null },
    {
      name: 'a tool error: no decision, an error',
      answer: { ...text('diff view crashed'), isError: true },
      option: null,
    },
    {
      name: 'structured content: no decision, an error',
      answer: { content: [], structuredContent: { result: 'TAB_CLOSED' } },
      option: null,
    },
  ]

  for (const row of answers) {
    test(row.name, async () => {
      const ide = await connectIde()
      const filePath = sourceFile('answer.ts', THREE)

      const { host, decisions } = await openDialog({ servers: [ide.connection], filePath, edits: originalEdits })
      await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)
      const tabName = ide.asked('openDiff')[0]!.args.tab_name
      ide.answer(row.answer)

      await until('the tab to be closed', () => ide.asked('close_tab').length > 0)
      if (row.option) await until('a decision', () => decisions.length === 1)
      else await until('the error', () => host.current().hasError)
      await Bun.sleep(50)

      expect(ide.asked('close_tab').every(request => request.args.tab_name === tabName)).toBe(true)
      expect(ide.requests.filter(request => request.tool !== 'close_tab')).toHaveLength(1)
      if (row.option) {
        expect(decisions).toEqual([{ option: { type: row.option }, input: { file_path: filePath, edits: row.edits! } }])
        expect(host.current()).toMatchObject({ showingDiffInIDE: true, hasError: false })
      } else {
        expect(decisions).toEqual([])
        expect(host.current()).toMatchObject({ showingDiffInIDE: false, hasError: true })
      }
    })
  }

  test('in multiple mode each changed region comes back as its own edit, with 3 lines of context', async () => {
    const ide = await connectIde()
    const lines = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`)
    const filePath = sourceFile('many.ts', lines.join('\n'))

    const { decisions } = await openDialog({
      servers: [ide.connection],
      filePath,
      edits: [
        { old_string: 'row 2\n', new_string: 'ROW 2\n', replace_all: false },
        { old_string: 'row 11\n', new_string: 'ROW 11\n', replace_all: false },
      ],
      mode: 'multiple',
    })
    await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)
    ide.answer(text('TAB_CLOSED'))
    await until('a decision', () => decisions.length === 1)

    expect(decisions[0]!.input.edits).toEqual([
      { old_string: 'row 1\nrow 2\nrow 3\nrow 4\nrow 5', new_string: 'row 1\nROW 2\nrow 3\nrow 4\nrow 5', replace_all: false },
      { old_string: 'row 8\nrow 9\nrow 10\nrow 11\nrow 12', new_string: 'row 8\nrow 9\nrow 10\nROW 11\nrow 12', replace_all: false },
    ])
  })
})

describe('failures and the dialog going away', () => {
  test('an edit that does not apply is an error, and no diff is opened', async () => {
    const ide = await connectIde()
    const filePath = sourceFile('stale.ts', THREE)

    const { host, decisions } = await openDialog({
      servers: [ide.connection],
      filePath,
      edits: [{ old_string: 'delta', new_string: 'DELTA', replace_all: false }],
    })
    await until('the error', () => host.current().hasError)
    await Bun.sleep(50)

    expect(ide.asked('openDiff')).toEqual([])
    expect(decisions).toEqual([])
    expect(host.current()).toMatchObject({ showingDiffInIDE: false, hasError: true })
  })

  test('a path that cannot be read as a file is an error, and the IDE hears nothing', async () => {
    const ide = await connectIde()
    const folder = join(workdir, 'a-folder')
    mkdirSync(folder)

    const { host } = await openDialog({ servers: [ide.connection], filePath: folder, edits: BETA_UP })
    await until('the error', () => host.current().hasError)
    await Bun.sleep(50)

    expect(ide.requests).toEqual([])
    expect(host.current().showingDiffInIDE).toBe(false)
  })

  test('an empty path (a tool with no IDE diff) never opens a diff', async () => {
    const ide = await connectIde()
    setCwdState(workdir)

    await openDialog({ servers: [ide.connection], filePath: '', edits: [] })
    await Bun.sleep(200)

    expect(ide.asked('openDiff')).toEqual([])
  })

  test('cancelling the tool call closes the tab; an answer after unmount decides nothing', async () => {
    const ide = await connectIde()
    const filePath = sourceFile('cancel.ts', THREE)

    const { host, decisions, abortController } = await openDialog({
      servers: [ide.connection],
      filePath,
      edits: BETA_UP,
    })
    await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)
    const tabName = ide.asked('openDiff')[0]!.args.tab_name

    abortController.abort()
    await until('the tab to be closed', () => ide.asked('close_tab').length === 1)
    expect(ide.asked('close_tab')[0]!.args).toEqual({ tab_name: tabName })

    host.stop()
    ide.answer(text('TAB_CLOSED'))
    await Bun.sleep(150)
    expect(decisions).toEqual([])
  })

  test('the process getting ready to exit closes the open tab', async () => {
    const ide = await connectIde()
    const filePath = sourceFile('exit.ts', THREE)

    await openDialog({ servers: [ide.connection], filePath, edits: BETA_UP })
    await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)
    const tabName = ide.asked('openDiff')[0]!.args.tab_name

    process.emit('beforeExit', 0)
    await until('the tab to be closed', () => ide.asked('close_tab').length === 1)
    expect(ide.asked('close_tab')[0]!.args).toEqual({ tab_name: tabName })
  })

  test('an answer that arrives after the dialog unmounted decides nothing', async () => {
    const ide = await connectIde()
    const filePath = sourceFile('late.ts', THREE)

    const { host, decisions } = await openDialog({ servers: [ide.connection], filePath, edits: BETA_UP })
    await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)
    host.stop()
    ide.answer(text('FILE_SAVED', 'alpha\nlate\ngamma'))
    await until('the tab to be closed', () => ide.asked('close_tab').length > 0)
    await Bun.sleep(100)

    expect(decisions).toEqual([])
  })

  test('closeTabInIDE closes this dialog’s tab, and does nothing without an IDE', async () => {
    const ide = await connectIde()
    const filePath = sourceFile('close.ts', THREE)

    const withIde = await openDialog({ servers: [ide.connection], filePath, edits: BETA_UP })
    await until('the IDE to be asked', () => ide.asked('openDiff').length === 1)
    const tabName = ide.asked('openDiff')[0]!.args.tab_name
    await expect(withIde.host.current().closeTabInIDE()).resolves.toBeUndefined()
    expect(ide.asked('close_tab')).toEqual([{ tool: 'close_tab', args: { tab_name: tabName } }])

    const without = await openDialog({ servers: [], filePath, edits: BETA_UP })
    await expect(without.host.current().closeTabInIDE()).resolves.toBeUndefined()
    expect(ide.asked('close_tab')).toHaveLength(1)
  })
})
