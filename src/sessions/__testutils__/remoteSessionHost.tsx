/**
 * Mounts `useRemoteSession` the way the REPL does, with every setter it takes
 * recorded, against a `FakeSessionsApi`. Also the SDK frames the suites send
 * down the socket.
 */
import React from 'react'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { RemoteSessionConfig } from 'src/platform/remote/RemoteSessionManager.js'
import { useRemoteSession } from 'src/sessions/hooks/useRemoteSession.js'
import {
  cell,
  type Cell,
  type FakeSessionsApi,
  type HookUnderTest,
  mountHook,
  waitFor,
} from 'src/sessions/__testutils__/remoteRig.js'
import type { SpinnerMode } from 'src/terminal/spinner/types.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { Tool } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'
import type { StreamingToolUse } from 'src/agent/messages/messages.js'

export const SESSION = 'session_01remote'
export const ORG = 'org-7f3c'
export const SOCKET_TOKEN = 'socket-token-1'

type Hook = ReturnType<typeof useRemoteSession>
type Props = Parameters<typeof useRemoteSession>[0]

export type RemoteHost = {
  hook: HookUnderTest<Props, Hook>
  props: Props
  messages: Cell<Message[]>
  loading: Cell<boolean | undefined>
  queue: Cell<ToolUseConfirm[]>
  streaming: Cell<StreamingToolUse[]>
  mode: Cell<SpinnerMode | undefined>
  inFlight: Cell<Set<string>>
  /** Each slash-command list the hook handed to onInit. */
  inits: string[][]
  /** The latest remote connection status in app state. */
  status: () => AppState['remoteConnectionStatus'] | undefined
  /** The latest remote background task count in app state. */
  taskCount: () => number | undefined
}

export type RemoteOptions = {
  /** null mounts the hook outside remote mode. */
  config?: Partial<RemoteSessionConfig> | null
  tools?: Tool[]
  /** Pass setStreamingToolUses and setStreamMode (default true). */
  streaming?: boolean
  /** Pass setInProgressToolUseIDs (default true). */
  inFlight?: boolean
  /** Pass onInit (default true). */
  onInit?: boolean
}

export function remoteConfig(overrides: Partial<RemoteSessionConfig> = {}): RemoteSessionConfig {
  return {
    sessionId: SESSION,
    orgUuid: ORG,
    getAccessToken: () => SOCKET_TOKEN,
    hasInitialPrompt: true,
    ...overrides,
  }
}

export async function mountRemote(options: RemoteOptions = {}): Promise<RemoteHost> {
  const messages = cell<Message[]>([])
  const loading = cell<boolean | undefined>(undefined)
  const queue = cell<ToolUseConfirm[]>([])
  const streaming = cell<StreamingToolUse[]>([])
  const mode = cell<SpinnerMode | undefined>(undefined)
  const inFlight = cell<Set<string>>(new Set())
  const inits: string[][] = []
  const states: AppState[] = []
  const props: Props = {
    config: options.config === null ? undefined : remoteConfig(options.config ?? {}),
    setMessages: messages.set,
    setIsLoading: loading.set,
    setToolUseConfirmQueue: queue.set,
    tools: options.tools ?? [],
    ...(options.onInit === false ? {} : { onInit: (commands: string[]) => inits.push(commands) }),
    ...(options.streaming === false
      ? {}
      : {
          setStreamingToolUses: streaming.set,
          setStreamMode: mode.set as Props['setStreamMode'],
        }),
    ...(options.inFlight === false ? {} : { setInProgressToolUseIDs: inFlight.set }),
  }
  const hook = await mountHook(useRemoteSession, props, child => (
    <AppStateProvider onChangeAppState={({ newState }) => states.push(newState)}>
      {child}
    </AppStateProvider>
  ))
  return {
    hook,
    props,
    messages,
    loading,
    queue,
    streaming,
    mode,
    inFlight,
    inits,
    status: () => states.at(-1)?.remoteConnectionStatus,
    taskCount: () => states.at(-1)?.remoteBackgroundTaskCount,
  }
}

/** Mounts in remote mode and waits until the socket is up. */
export async function connectRemote(
  api: FakeSessionsApi,
  options: RemoteOptions = {},
): Promise<RemoteHost> {
  const host = await mountRemote(options)
  await waitFor(() => api.openSockets === 1 && host.status() === 'connected')
  return host
}

// --- SDK frames -------------------------------------------------------------

let serial = 0
const nextUuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`
const envelope = (type: string, uuid: string) => ({ type, uuid, session_id: SESSION, parent_tool_use_id: null })

export const frames = {
  assistant: (blocks: unknown[], uuid = nextUuid()) => ({
    type: 'assistant',
    uuid,
    session_id: SESSION,
    parent_tool_use_id: null,
    message: {
      id: `msg_${uuid.slice(-4)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: blocks,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }),
  user: (content: unknown, uuid = nextUuid()) => ({
    ...envelope('user', uuid),
    message: { content, role: 'user' },
  }),
  toolResult: (toolUseId: string, uuid = nextUuid()) =>
    frames.user([{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }], uuid),
  result: (subtype: string, errors?: string[]) => ({
    type: 'result',
    subtype,
    uuid: nextUuid(),
    session_id: SESSION,
    is_error: subtype !== 'success',
    ...(errors ? { errors } : {}),
  }),
  init: (slashCommands: string[], model = 'claude-test') => ({
    type: 'system',
    subtype: 'init',
    uuid: nextUuid(),
    session_id: SESSION,
    model,
    slash_commands: slashCommands,
    tools: [],
    cwd: '/remote',
  }),
  system: (subtype: string, extra: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype,
    uuid: nextUuid(),
    session_id: SESSION,
    ...extra,
  }),
  stream: (event: unknown) => ({
    type: 'stream_event',
    uuid: nextUuid(),
    session_id: SESSION,
    parent_tool_use_id: null,
    event,
  }),
  canUseTool: (requestId: string, request: Record<string, unknown>) => ({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', ...request },
  }),
  cancel: (requestId: string) => ({ type: 'control_cancel_request', request_id: requestId }),
}

/** A tool the local CLI has, by name only. */
export function localTool(name: string): Tool {
  return { name, userFacingName: () => `local ${name}` } as unknown as Tool
}
