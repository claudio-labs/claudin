/**
 * What the permissions/modeDialogs suites share: a plan-tool request whose
 * answers are written down in a ledger, the session plan file, and the
 * session-wide flags a mode change raises.
 *
 * The dialogs themselves are mounted through promptFrameRig, which gives
 * every test its own config home and project directory.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import * as React from 'react'
import { createAssistantMessage } from 'src/agent/messages/factories.js'
import { getPlanFilePath } from 'src/agent/plans/plans.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import {
  hasExitedPlanModeInSession,
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from 'src/platform/bootstrap/state.js'
import { Box, Text } from 'src/terminal/ink.js'
import instances from 'src/terminal/ink/instances.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import { EnterPlanModeTool } from 'src/tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'

/** One thing the dialog told its caller, in the order it happened. */
export type Entry =
  | { to: 'request'; call: 'allow'; input: unknown; updates: unknown; feedback: unknown }
  | { to: 'request'; call: 'reject'; args: unknown[] }
  | { to: 'caller'; call: 'done' | 'reject' }

export type Ledger = Entry[]

/** The three process-wide flags a plan exit can raise, read together. */
export function sessionFlags() {
  return {
    exitedPlan: hasExitedPlanModeInSession(),
    planExitNotice: needsPlanModeExitAttachment(),
    autoExitNotice: needsAutoModeExitAttachment(),
  }
}

const SESSION_FLAG_SETTERS = [setHasExitedPlanMode, setNeedsPlanModeExitAttachment, setNeedsAutoModeExitAttachment]

/** Every test starts with the three flags down. */
export function lowerSessionFlags(): void {
  SESSION_FLAG_SETTERS.forEach(set => set(false))
}

type RequestShape = {
  tool?: Tool
  /** The tool input as the model sent it. */
  input?: { [field: string]: unknown }
  /** Token usage on the assistant message that made the request. */
  usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
}

export function planRequest(ledger: Ledger, shape: RequestShape = {}): ToolUseConfirm {
  const context = { abortController: new AbortController(), options: { tools: [] } } as unknown as ToolUseContext
  return {
    assistantMessage: createAssistantMessage({ content: 'plan is ready', usage: shape.usage as never }),
    tool: shape.tool ?? (ExitPlanModeV2Tool as unknown as Tool),
    description: 'the plan',
    input: shape.input ?? {},
    toolUseContext: context,
    toolUseID: 'toolu_mode_dialog',
    permissionResult: { behavior: 'ask', message: 'plan needs approval' },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: () => {},
    onAbort: () => {},
    onAllow: (input: unknown, updates: unknown, feedback?: unknown) =>
      ledger.push({ to: 'request', call: 'allow', input, updates, feedback }),
    onReject: (...args: unknown[]) => ledger.push({ to: 'request', call: 'reject', args }),
    recheckPermission: async () => {},
  } as unknown as ToolUseConfirm
}

export function enterPlanRequest(ledger: Ledger): ToolUseConfirm {
  return planRequest(ledger, { tool: EnterPlanModeTool as unknown as Tool })
}

/** The props every permission component takes, with the caller's two callbacks logged. */
export function callerProps(ledger: Ledger, confirm: ToolUseConfirm) {
  return {
    toolUseConfirm: confirm,
    toolUseContext: confirm.toolUseContext,
    onDone: () => ledger.push({ to: 'caller', call: 'done' }),
    onReject: () => ledger.push({ to: 'caller', call: 'reject' }),
    verbose: false,
    workerBadge: undefined,
  }
}

/** Writes the session's plan file, where the plan tool would have left it. */
export function writePlan(text: string): string {
  const path = getPlanFilePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/**
 * The external editor hands the terminal over through the Ink instance that
 * owns the process's stdout. In the app that is the only instance; in a test
 * the dialog runs on a fake terminal, so its instance is registered under
 * stdout for as long as the editor may run. Returns the undo.
 */
export function lendTerminalToEditor(): () => void {
  const fake = [...instances.entries()].findLast(([out]) => out !== process.stdout)
  if (!fake) throw new Error('no dialog is mounted on a fake terminal')
  const before = instances.get(process.stdout)
  instances.set(process.stdout, fake[1])
  return () => {
    if (before) instances.set(process.stdout, before)
    else instances.delete(process.stdout)
  }
}

/** An executable that stands in for $VISUAL, running `body` with the file as $1. */
export function fakeEditor(dir: string, body: string): string {
  const path = join(dir, 'plan-editor')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A 1x1 PNG, as a terminal would paste its path. */
export function pngOnDisk(dir: string): string {
  const path = join(dir, 'screenshot.png')
  writeFileSync(path, Buffer.from(ONE_PIXEL_PNG, 'base64'))
  return path
}
export const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Bracketed paste, the way a terminal delivers a dragged or pasted path. */
export const pasted = (text: string) => `\x1b[200~${text}\x1b[201~`

/**
 * A host for the fullscreen layout's sticky footer: whatever the dialog hands
 * to `setStickyFooter` is drawn under it, the way the layout would.
 */
export function StickyHost({ render }: { render: (setFooter: (node: React.ReactNode | null) => void) => React.ReactNode }) {
  const [footer, setFooter] = React.useState<React.ReactNode | null>(null)
  const stable = React.useCallback((node: React.ReactNode | null) => setFooter(node), [])
  // The marker keeps a frame painted after the dialog and its footer are gone.
  return (
    <Box flexDirection="column">
      {render(stable)}
      <Text>[layout bottom]</Text>
      {footer}
    </Box>
  )
}
