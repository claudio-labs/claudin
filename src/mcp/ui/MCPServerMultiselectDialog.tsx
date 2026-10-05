import React, { useRef } from 'react'
import { type ApprovalAnswer, applyApprovalAnswer } from 'src/mcp/approval/answer.js'
import { MCPServerDialogCopy } from 'src/mcp/ui/MCPServerDialogCopy.js'
import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js'
import { SelectMulti } from 'src/terminal/custom-select/SelectMulti.js'
import { Byline } from 'src/terminal/design-system/Byline.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js'
import { Box, Text } from 'src/terminal/ink.js'

export type MCPServerMultiselectDialogProps = {
  serverNames: string[]
  onDone(): void
}

/** Ticked names are approved and the rest rejected, both in the order listed. */
function answerForTicked(serverNames: readonly string[], ticked: readonly string[]): ApprovalAnswer {
  const on = new Set(ticked)
  return {
    approve: serverNames.filter(name => on.has(name)),
    reject: serverNames.filter(name => !on.has(name)),
    enableAll: false,
  }
}

export function MCPServerMultiselectDialog({ serverNames, onDone }: MCPServerMultiselectDialogProps): React.ReactNode {
  // The dialog stays mounted until the caller renders what comes next, so a
  // later key must not answer a second time.
  const answered = useRef(false)

  const finish = (answer: ApprovalAnswer) => {
    if (answered.current) return
    answered.current = true
    applyApprovalAnswer(answer)
    onDone()
  }
  const submit = (ticked: string[]) => finish(answerForTicked(serverNames, ticked))
  const rejectAll = () => finish(answerForTicked(serverNames, []))

  return (
    <>
      <Dialog
        title={`${serverNames.length} new MCP servers found in .mcp.json`}
        subtitle="Select any you wish to enable."
        color="warning"
        onCancel={rejectAll}
        hideInputGuide
      >
        <MCPServerDialogCopy />
        <SelectMulti
          options={serverNames.map(name => ({ label: name, value: name }))}
          defaultValue={serverNames}
          onSubmit={submit}
          onCancel={rejectAll}
          hideIndexes
        />
      </Dialog>
      <Box paddingX={1}>
        <Text dimColor>
          <Byline>
            <KeyboardShortcutHint shortcut="Space" action="select" />
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="reject all" />
          </Byline>
        </Text>
      </Box>
    </>
  )
}
