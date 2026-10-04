/**
 * Rig for the permissions/toolDialogs characterization suites (Fallback,
 * Skill, WebFetch, Monitor). Each dialog is reached the way the REPL reaches
 * it: a request is handed to `PermissionRequest`, which picks the dialog for
 * the tool. Everything the dialog tells its caller lands in one ordered log,
 * so a test can say both what an answer reported and what it did not.
 *
 * Mounting, keys and the isolated config home come from the promptFrame rig.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { createAssistantMessage } from 'src/agent/messages/factories.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { PermissionRequest, type ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { WorkerBadgeProps } from 'src/permissions/ui/WorkerBadge.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import { mount, type Screen } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

/** One entry per callback, in the order they fired. */
export type Call =
  | { to: 'allow'; args: unknown[] }
  | { to: 'reject'; args: unknown[] }
  | { to: 'caller.done' }
  | { to: 'caller.reject' }
  | { to: 'abort' }

export type Ask = {
  tool: Tool
  input: Record<string, unknown>
  description?: string
  permissionResult?: PermissionDecision
  workerBadge?: WorkerBadgeProps
  verbose?: boolean
  columns?: number
}

export type Asked = { screen: Screen; calls: Call[] }

function bareContext(): ToolUseContext {
  let state = {} as ReturnType<ToolUseContext['getAppState']>
  return {
    abortController: new AbortController(),
    options: { tools: [], commands: [], mcpClients: [], isNonInteractiveSession: false, verbose: false, debug: false, mainLoopModel: 'test-model' },
    setInProgressToolUseIDs: () => {},
    getAppState: () => state,
    setAppState: (next: (prev: typeof state) => typeof state) => {
      state = next(state)
    },
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

/** Mounts `PermissionRequest` for one request and waits for the dialog's first paint. */
export async function ask(spec: Ask): Promise<Asked> {
  const calls: Call[] = []
  const confirm = {
    assistantMessage: createAssistantMessage({ content: 'about to use a tool' }),
    tool: spec.tool,
    description: spec.description ?? 'what the tool is about to do',
    input: spec.input,
    toolUseContext: bareContext(),
    toolUseID: 'toolu_dialogs_1',
    permissionResult: spec.permissionResult ?? { behavior: 'ask', message: 'confirm first' },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: () => {},
    onAbort: () => calls.push({ to: 'abort' }),
    onAllow: (...args: unknown[]) => calls.push({ to: 'allow', args }),
    onReject: (...args: unknown[]) => calls.push({ to: 'reject', args }),
    recheckPermission: async () => {},
  } as unknown as ToolUseConfirm
  const screen = await mount(
    <PermissionRequest
      toolUseConfirm={confirm}
      toolUseContext={confirm.toolUseContext}
      onDone={() => calls.push({ to: 'caller.done' })}
      onReject={() => calls.push({ to: 'caller.reject' })}
      verbose={spec.verbose ?? false}
      workerBadge={spec.workerBadge}
    />,
    { columns: spec.columns ?? 120, ready: frame => frame.includes('Esc') || frame.includes('No') },
  )
  return { screen, calls }
}

/** Presses the keys, then gives the last answer time to land. */
export async function answer(asked: Asked, keys: string[]): Promise<Call[]> {
  await asked.screen.press(...keys)
  await Bun.sleep(120)
  return asked.calls
}

/** Turns on the managed setting that keeps permission rules to the policy. */
export function managedRulesOnly(home: string): void {
  const managed = join(home, 'managed')
  mkdirSync(managed, { recursive: true })
  writeFileSync(join(managed, 'managed-settings.json'), JSON.stringify({ allowManagedPermissionRulesOnly: true }))
  resetSettingsCache()
}

/** The `addRules` update an allow-always answer is expected to carry. */
export function allowRule(toolName: string, ruleContent?: string) {
  const rule = ruleContent === undefined ? { toolName } : { toolName, ruleContent }
  return { type: 'addRules', rules: [rule], behavior: 'allow', destination: 'localSettings' }
}

/** The calls a deny makes, with the request's reject arguments given. */
export const denied = (...rejectArgs: unknown[]): Call[] => [
  { to: 'reject', args: rejectArgs },
  { to: 'caller.reject' },
  { to: 'caller.done' },
]

/** The calls an allow makes, with the request's allow arguments given. */
export const allowed = (...allowArgs: unknown[]): Call[] => [{ to: 'allow', args: allowArgs }, { to: 'caller.done' }]

/** The screen's non-blank lines, trimmed. */
export const shown = (frame: string): string[] =>
  frame
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
