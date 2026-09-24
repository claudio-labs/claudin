import React from 'react'
import { MessageResponse } from 'src/agent/ui/MessageResponse.js'
import { Text } from 'src/terminal/ink.js'
import type { Output } from 'src/tools/ListAgentsTool/ListAgentsTool.js'

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  const parts = [
    output.subagents.length > 0 ? count(output.subagents.length, 'subagent') : '',
    output.teammates.length > 0 ? count(output.teammates.length, 'teammate') : '',
    output.peers.length > 0 ? count(output.peers.length, 'other session') : '',
  ].filter(Boolean)
  return (
    <MessageResponse>
      <Text dimColor>{parts.length > 0 ? parts.join(', ') : 'No agents to message'}</Text>
    </MessageResponse>
  )
}
