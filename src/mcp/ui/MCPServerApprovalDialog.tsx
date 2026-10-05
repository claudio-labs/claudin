import React, { useRef } from 'react'
import { type ApprovalAnswer, applyApprovalAnswer } from 'src/mcp/approval/answer.js'
import { MCPServerDialogCopy } from 'src/mcp/ui/MCPServerDialogCopy.js'
import { type OptionWithDescription, Select } from 'src/terminal/custom-select/index.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'

export type MCPServerApprovalDialogProps = {
  serverName: string
  onDone(): void
}

type Choice = 'this-and-future' | 'this-only' | 'reject'

const CHOICES: OptionWithDescription<Choice>[] = [
  { label: 'Use this and all future MCP servers in this project', value: 'this-and-future' },
  { label: 'Use this MCP server', value: 'this-only' },
  { label: 'Continue without using this MCP server', value: 'reject' },
]

function answerForChoice(choice: Choice, serverName: string): ApprovalAnswer {
  switch (choice) {
    case 'this-and-future':
      return { approve: [serverName], reject: [], enableAll: true }
    case 'this-only':
      return { approve: [serverName], reject: [], enableAll: false }
    case 'reject':
      return { approve: [], reject: [serverName], enableAll: false }
  }
}

export function MCPServerApprovalDialog({ serverName, onDone }: MCPServerApprovalDialogProps): React.ReactNode {
  // The dialog stays mounted until the caller renders what comes next, so a
  // later key must not answer a second time.
  const answered = useRef(false)

  const answer = (choice: Choice) => {
    if (answered.current) return
    answered.current = true
    applyApprovalAnswer(answerForChoice(choice, serverName))
    onDone()
  }
  const reject = () => answer('reject')

  return (
    <Dialog title={`New MCP server found in .mcp.json: ${serverName}`} color="warning" onCancel={reject}>
      <MCPServerDialogCopy />
      <Select options={CHOICES} onChange={answer} onCancel={reject} />
    </Dialog>
  )
}
