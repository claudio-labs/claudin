// Mounting the AskUserQuestion dialog on a real Ink root and driving it with
// keystrokes, for the suites that pin what reaches the model on submit.
//
// The dialog's answer is only observable through `toolUseConfirm.onAllow` /
// `onReject`, so the fake below records those calls instead of mocking a module.
//
// NOT a `.test` file — it exports helpers, it does not register tests.

import * as React from 'react'

import { AskUserQuestionPermissionRequest } from 'src/permissions/ui/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import {
  lastFrame,
  mountHook,
  waitForCondition,
} from 'src/providers/ui/__testutils__/inkHookHarness.js'
import { getCliHighlightPromise } from 'src/shared/text/cliHighlight.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type { Question } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'

export const KEY = {
  enter: '\r',
  up: '\x1B[A',
  down: '\x1B[B',
  right: '\x1B[C',
  left: '\x1B[D',
  tab: '\t',
  space: ' ',
} as const

export type AllowCall = {
  answers: Record<string, string>
  annotations?: Record<string, { preview?: string; notes?: string }>
}

export type AskDialog = {
  press: (...keys: string[]) => Promise<void>
  /** A bare ESC is the prefix of every escape sequence, so the input parser
   *  only resolves it as the Escape key after its sequence timeout. */
  pressEscape: () => Promise<void>
  frame: () => string
  /** Wait until the last frame contains `text`. */
  waitForText: (text: string) => Promise<void>
  allowed: AllowCall[]
  rejected: Array<string | undefined>
  doneCount: () => number
  cleanup: () => Promise<void>
}

export function question(over: Partial<Question> = {}): Question {
  return {
    question: 'Which one?',
    header: 'Pick',
    options: [
      { label: 'Alpha', description: 'first choice' },
      { label: 'Beta', description: 'second choice' },
    ],
    multiSelect: false,
    ...over,
  }
}

export async function mountAskDialog(
  questions: Question[],
  options?: { columns?: number; mode?: 'default' | 'plan' },
): Promise<AskDialog> {
  // The dialog suspends on the shared highlighter promise, and a keystroke sent
  // to the fallback is lost when the real body replaces it. Awaiting it is not
  // enough: `use()` still suspends once on a promise React has not tracked, so
  // mark it fulfilled the way React's own thenable tracking would.
  const highlighter = getCliHighlightPromise() as Promise<unknown> & {
    status?: string
    value?: unknown
  }
  const value = await highlighter
  if (highlighter.status === undefined) {
    highlighter.status = 'fulfilled'
    highlighter.value = value
  }

  const allowed: AllowCall[] = []
  const rejected: Array<string | undefined> = []
  let done = 0

  const toolUseConfirm = {
    input: { questions },
    description: '',
    toolUseID: 'toolu_test',
    permissionResult: { behavior: 'ask', message: 'Answer questions?' },
    permissionPromptStartTimeMs: 0,
    onUserInteraction() {},
    onAbort() {},
    onAllow(updatedInput: AllowCall) {
      allowed.push(updatedInput)
    },
    onReject(feedback?: string) {
      rejected.push(feedback)
    },
    async recheckPermission() {},
  } as unknown as ToolUseConfirm

  const base = getDefaultAppState()
  const initialState = {
    ...base,
    toolPermissionContext: {
      ...base.toolPermissionContext,
      mode: options?.mode ?? 'default',
    },
  }

  const mounted = await mountHook(
    <AppStateProvider initialState={initialState}>
      <KeybindingSetup>
        <AskUserQuestionPermissionRequest
          toolUseConfirm={toolUseConfirm}
          toolUseContext={{} as never}
          onDone={() => {
            done++
          }}
          onReject={() => {}}
          verbose={false}
          workerBadge={undefined}
        />
      </KeybindingSetup>
    </AppStateProvider>,
    { columns: options?.columns ?? 100 },
  )

  const frame = () => lastFrame(mounted.streams.getOutput())
  const waitForText = (text: string) =>
    waitForCondition(() => frame().includes(text), {
      timeoutMs: 3000,
      label: `"${text}" in the frame:\n${frame()}`,
    })

  await waitForText(questions[0]!.question)
  // The Select reports its initial focus from a passive effect, after the
  // first frame; a key sent before that commit sees no focused option.
  await Bun.sleep(50)

  return {
    press: async (...keys: string[]) => {
      for (const key of keys) {
        mounted.streams.stdin.write(key)
        await Bun.sleep(40)
      }
    },
    pressEscape: async () => {
      mounted.streams.stdin.write('\x1B')
      await Bun.sleep(300)
    },
    frame,
    waitForText,
    allowed,
    rejected,
    doneCount: () => done,
    cleanup: mounted.cleanup,
  }
}

export async function waitForAllow(dialog: AskDialog): Promise<AllowCall> {
  await waitForCondition(() => dialog.allowed.length > 0, {
    timeoutMs: 3000,
    label: `onAllow; frame:\n${dialog.frame()}`,
  })
  return dialog.allowed[0]!
}
