/**
 * The foreground moving straight from one agent task to another: the main
 * view must show the second task's messages even when both have as many.
 */
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import React from 'react'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { registerAgentForeground } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import { agent } from 'src/sessions/__testutils__/restoreHarness.js'
import { useSessionBackgrounding } from 'src/sessions/hooks/useSessionBackgrounding.js'
import { mountInApp, type Picker, useResumeWorld } from 'src/sessions/ui/__testutils__/resumeRig.js'
import type { Message } from 'src/shared/types/message.js'

const TIMEOUT = 20_000
useResumeWorld()

function foregroundAgent(app: Picker, texts: string[]): { taskId: string; uuids: string[] } {
  const { taskId } = registerAgentForeground({
    agentId: `a${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    description: 'at work',
    prompt: 'Look into the parser.',
    selectedAgent: agent('helper'),
    setAppState: app.setState,
  })
  const messages = texts.map(content => createUserMessage({ content }))
  app.setState(prev => ({
    ...prev,
    tasks: { ...prev.tasks, [taskId]: { ...prev.tasks[taskId]!, messages } as never },
  }))
  return { taskId, uuids: messages.map(message => message.uuid) }
}

describe('useSessionBackgrounding', () => {
  test('switching the foreground from one agent to another sends the second one in full, whatever its count', async () => {
    const sent: string[][] = []
    const props = {
      setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => {
        if (typeof messages !== 'function') sent.push(messages.map(message => message.uuid))
      },
      setIsLoading: () => undefined,
      resetLoadingState: () => undefined,
      setAbortController: () => undefined,
      onBackgroundQuery: () => undefined,
    }
    function Host(): null {
      useSessionBackgrounding(props)
      return null
    }
    const app = await mountInApp(<Host />)
    await Bun.sleep(100)
    const first = foregroundAgent(app, ['one', 'two'])
    const second = foregroundAgent(app, ['three', 'four'])

    app.setState(prev => ({ ...prev, foregroundedTaskId: first.taskId }))
    await Bun.sleep(80)
    app.setState(prev => ({ ...prev, foregroundedTaskId: second.taskId }))
    await Bun.sleep(80)
    expect(sent).toEqual([first.uuids, second.uuids])
  }, TIMEOUT)
})
