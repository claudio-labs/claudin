/**
 * Rig for the permissions/fileDialogs characterization suites: the edit,
 * write, notebook and filesystem dialogs, reached through `PermissionRequest`
 * the way the REPL reaches them.
 *
 * It differs from the toolDialogs rig in two ways the file dialogs need: the
 * session's permission context can be set (mode, extra working directories),
 * and the request can carry MCP servers, so a stand-in IDE can be connected.
 * The IDE is the only thing faked: a real MCP server on the SDK's in-memory
 * transport, answering the diff tab the way the editor extension would.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import * as React from 'react'
import { createAssistantMessage } from 'src/agent/messages/factories.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { PermissionRequest, type ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { WorkerBadgeProps } from 'src/permissions/ui/WorkerBadge.js'
import type { Call } from 'src/permissions/ui/__testutils__/toolDialogRig.js'
import { mount, type Screen } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { setCwdState } from 'src/platform/bootstrap/state.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getEmptyToolPermissionContext, type Tool, type ToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'

export type FileAsk = {
  tool: Tool
  input: Record<string, unknown>
  /** Overrides on the session's permission context. */
  permissions?: Partial<ToolPermissionContext>
  servers?: MCPServerConnection[]
  workerBadge?: WorkerBadgeProps
  verbose?: boolean
  columns?: number
  /** The component to mount instead of `PermissionRequest` (a dialog the router never picks for this tool). */
  direct?: React.ComponentType<React.ComponentProps<typeof PermissionRequest>>
}

/** `calls` is the ledger of `Call` entries, typed loosely so tests can compare it with plain arrays. */
export type FileAsked = { screen: Screen; calls: unknown[]; confirm: ToolUseConfirm }

/** Puts the shell's working directory where the session started, as at launch. */
export function startIn(dir: string): void {
  setCwdState(dir)
}

export function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

export async function askFile(spec: FileAsk): Promise<FileAsked> {
  const calls: Call[] = []
  const context = {
    abortController: new AbortController(),
    options: { tools: [], commands: [], mcpClients: spec.servers ?? [], isNonInteractiveSession: false, verbose: false, debug: false, mainLoopModel: 'test-model' },
    setInProgressToolUseIDs: () => {},
    getAppState: () => ({}),
    setAppState: () => {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
  const confirm = {
    assistantMessage: createAssistantMessage({ content: 'touching a file' }),
    tool: spec.tool,
    description: 'a file change',
    input: spec.input,
    toolUseContext: context,
    toolUseID: 'toolu_file_dialog',
    permissionResult: { behavior: 'ask', message: 'needs a yes' },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: () => {},
    onAbort: () => calls.push({ to: 'abort' }),
    onAllow: (...args: unknown[]) => calls.push({ to: 'allow', args }),
    onReject: (...args: unknown[]) => calls.push({ to: 'reject', args }),
    recheckPermission: async () => {},
  } as unknown as ToolUseConfirm
  const Shown = spec.direct ?? PermissionRequest
  const permissions: ToolPermissionContext = { ...getEmptyToolPermissionContext(), ...spec.permissions }
  const screen = await mount(
    <Shown
      toolUseConfirm={confirm}
      toolUseContext={context}
      onDone={() => calls.push({ to: 'caller.done' })}
      onReject={() => calls.push({ to: 'caller.reject' })}
      verbose={spec.verbose ?? false}
      workerBadge={spec.workerBadge}
    />,
    {
      columns: spec.columns ?? 100,
      appState: { toolPermissionContext: permissions } as Partial<AppState>,
      ready: frame => frame.includes('Esc') || frame.includes('No'),
    },
  )
  return { screen, calls, confirm }
}

/** Presses the keys, then waits for the answer to land. */
export async function reply(asked: FileAsked, keys: string[]): Promise<unknown[]> {
  await asked.screen.press(...keys)
  await Bun.sleep(150)
  return asked.calls
}

/** What an allow reports, in order: the caller first, then the request. */
export const allowedWith = (input: unknown, updates: unknown[], note?: string): Call[] => [
  { to: 'caller.done' },
  { to: 'allow', args: [input, updates, note] },
]

/** What a deny reports, in order. */
export const deniedWith = (note?: string): Call[] => [{ to: 'caller.done' }, { to: 'caller.reject' }, { to: 'reject', args: [note] }]

// --- the stand-in IDE -----------------------------------------------------------

export type IdeCall = { name: string; args: Record<string, unknown> }

export type StandInIde = {
  /** The server entry the session would hold for the IDE. */
  server: MCPServerConnection
  /** Every tool the dialog called on the IDE, in order. */
  seen: IdeCall[]
  /** Resolves the oldest open diff tab with the editor's answer. */
  settle: (result: CallToolResult) => void
  /** Waits until the dialog has asked the editor to open its diff tab. */
  opened: () => Promise<IdeCall>
}

const running: Client[] = []
afterEach(async () => {
  while (running.length > 0) await running.pop()!.close()
})

export async function standInIde(ideName = 'Stand-in Editor'): Promise<StandInIde> {
  const seen: IdeCall[] = []
  const pending: Array<(result: CallToolResult) => void> = []
  const mcp = new Server({ name: 'stand-in-ide', version: '0.0.1' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    seen.push({ name: params.name, args: params.arguments ?? {} })
    if (params.name === 'openDiff') return await new Promise<CallToolResult>(done => pending.push(done))
    return { content: [] }
  })
  const client = new Client({ name: 'file-dialogs', version: '0.0.1' })
  const [near, far] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(far), client.connect(near)])
  running.push(client)
  const server = {
    type: 'connected',
    name: 'ide',
    client,
    capabilities: { tools: {} },
    config: { type: 'ws-ide', ideName, url: 'ws://127.0.0.1:9', scope: 'dynamic' },
    cleanup: async () => {},
  } as unknown as MCPServerConnection
  return {
    server,
    seen,
    settle: result => {
      const next = pending.shift()
      if (!next) throw new Error('the IDE has no diff tab open')
      next(result)
    },
    opened: async () => {
      const deadline = Date.now() + 8_000
      for (;;) {
        const call = seen.find(entry => entry.name === 'openDiff')
        if (call && pending.length > 0) return call
        if (Date.now() > deadline) throw new Error('the dialog never opened a diff in the IDE')
        await Bun.sleep(15)
      }
    },
  }
}

/** The numbered option lines of a frame, trimmed. */
export const choices = (frame: string): string[] =>
  frame
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(❯ )?\d\./.test(line))

/** The line under the options: the cancel hint. */
export const hintLine = (frame: string): string | undefined =>
  frame
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('Esc to cancel'))

export const SHIFT_TAB = '\x1B[Z'

/** The editor's answer, as text blocks. */
export const ideSays = (...texts: string[]): CallToolResult => ({ content: texts.map(text => ({ type: 'text' as const, text })) })
