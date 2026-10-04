/**
 * The desktop notification a permission request leaves behind when the user
 * does not answer. Only the hand-off is replaced: the hook that turns a
 * message into a terminal or OS notification after an idle spell, which
 * stays silent under the test runner. What is checked is the message and
 * the notification type PermissionRequest hands it.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { z } from 'zod/v4'

type Notice = [message: string, kind: string]
const notices: Notice[] = []

const realNotifier = { ...(await import('src/platform/notifications/useNotifyAfterTimeout.js')) }
mock.module('src/platform/notifications/useNotifyAfterTimeout.js', () => ({
  ...realNotifier,
  useNotifyAfterTimeout: (message: string, kind: string) => {
    notices.push([message, kind])
  },
}))
afterAll(() => {
  mock.module('src/platform/notifications/useNotifyAfterTimeout.js', () => realNotifier)
})

const { createAssistantMessage } = await import('src/agent/messages/factories.js')
const { PermissionRequest } = await import('src/permissions/ui/PermissionRequest.js')
const { EnterPlanModeTool } = await import('src/tools/EnterPlanModeTool/EnterPlanModeTool.js')
const { ExitPlanModeV2Tool } = await import('src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js')
const { mount, SLOW } = await import('src/permissions/ui/__testutils__/promptFrameRig.js')
type Tool = import('src/tools/Tool.js').Tool
type ToolUseConfirm = import('src/permissions/ui/PermissionRequest.js').ToolUseConfirm

function toolNamed(shown: string): Tool {
  return {
    name: 'mcp__notes__append',
    isMcp: true,
    inputSchema: z.object({}),
    userFacingName: () => shown,
    renderToolUseMessage: () => 'append',
    isReadOnly: () => false,
  } as unknown as Tool
}

async function notified(tool: Tool, input: Record<string, unknown> = {}): Promise<Notice[]> {
  notices.length = 0
  const toolUseContext = {
    options: { tools: [], commands: [], mcpClients: [], isNonInteractiveSession: false },
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
  } as never
  const confirm = {
    assistantMessage: createAssistantMessage({ content: 'working' }),
    tool,
    description: 'append a line',
    input,
    toolUseContext,
    toolUseID: 'toolu_notify',
    permissionResult: { behavior: 'ask', message: 'asking' },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: () => {},
    onAbort: () => {},
    onAllow: () => {},
    onReject: () => {},
    recheckPermission: async () => {},
  } as unknown as ToolUseConfirm
  const screen = await mount(
    <PermissionRequest toolUseConfirm={confirm} toolUseContext={toolUseContext} onDone={() => {}} onReject={() => {}} verbose={false} workerBadge={undefined} />,
  )
  await screen.close()
  return [...new Set(notices.map(notice => JSON.stringify(notice)))].map(notice => JSON.parse(notice) as Notice)
}

describe('PermissionRequest: the notification for an unanswered request', () => {
  const rows: Array<[string, () => Tool, Record<string, unknown>, string]> = [
    ['leaving plan mode', () => ExitPlanModeV2Tool, { plan: 'the plan' }, 'Claudin needs your approval for the plan'],
    ['entering plan mode', () => EnterPlanModeTool, {}, 'Claudin wants to enter plan mode'],
    ['a tool with a name', () => toolNamed('notes - append (MCP)'), {}, 'Claude needs your permission to use notes - append (MCP)'],
    ['a tool whose name is empty', () => toolNamed(''), {}, 'Claudin needs your attention'],
    ['a tool whose name is blank', () => toolNamed('   '), {}, 'Claudin needs your attention'],
  ]
  for (const [name, tool, input, message] of rows) {
    test(
      `${name}: "${message}", as a permission prompt`,
      async () => {
        expect(await notified(tool(), input)).toEqual([[message, 'permission_prompt']])
      },
      SLOW,
    )
  }
})
