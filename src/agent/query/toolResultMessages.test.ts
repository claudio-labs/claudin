import { afterAll, describe, expect, test } from 'bun:test'
import { createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import {
  createAssistantMessage,
  createProgressMessage,
  createSystemMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from 'src/agent/messages/messages.js'
import { toolMessagesForNextRequest } from 'src/agent/query/toolResultMessages.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import type { Message, UserMessage } from 'src/shared/types/message.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

const SKILL_BODY =
  'Base directory for this skill: /repo/.claudin/skills/demo\n\n# Demo\n\nRun the checks in order.\n'

function toolUse(id: string, name: string, input: object = {}): Message {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input } as never],
  })
}

function toolResult(id: string, content: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  })
}

function progress(id: string): Message {
  return createProgressMessage({
    toolUseID: id,
    parentToolUseID: id,
    data: { type: 'bash_progress' } as never,
  })
}

/** The bytes the API gets for each message, role + content. */
function wire(messages: Message[]): string[] {
  return normalizeMessagesForAPI(messages).map(m =>
    JSON.stringify({ role: m.message.role, content: m.message.content }),
  )
}

/**
 * The request the turn sends right after the tools ran (what query.ts keeps
 * through toolMessagesForNextRequest) against the request the next turn sends
 * for the same history (the raw messages the REPL and the transcript hold,
 * then the final reply and a new prompt). The first must be a byte-identical
 * prefix of the second, message by message: Opus 5.5 drops every thinking
 * block whose preceding bytes changed, and the prefix is written again.
 */
function renderBothWays(prefix: Message[], yielded: Message[]) {
  const inTurn = wire([...prefix, ...yielded.flatMap(toolMessagesForNextRequest)])
  const nextTurn = wire([
    ...prefix,
    ...yielded,
    createAssistantMessage({ content: 'Done.' }),
    createUserMessage({ content: 'thanks' }),
  ])
  return { inTurn, nextTurn }
}

describe('toolMessagesForNextRequest', () => {
  test('keeps user and attachment messages unchanged, drops the rest', () => {
    const tr = toolResult('toolu_1', 'ok')
    const attachment = createAttachmentMessage({
      type: 'task_reconcile',
      reason: 'orphan_in_progress',
      stale: [{ id: '1', subject: 'Run checks', status: 'in_progress' }],
      signature: '1:in_progress',
    })
    expect(toolMessagesForNextRequest(tr)[0]).toBe(tr)
    expect(toolMessagesForNextRequest(attachment)[0]).toBe(attachment)
    expect(toolMessagesForNextRequest(progress('toolu_1'))).toEqual([])
    expect(
      toolMessagesForNextRequest(createSystemMessage('Args from unknown skill: x', 'warning')),
    ).toEqual([])
  })
})

describe('a turn renders the tool results the way the next turn does', () => {
  const prefix: Message[] = [
    createUserMessage({ content: 'Run the demo checks.' }),
    toolUse('toolu_bash', 'Bash', { command: 'ls' }),
    toolResult('toolu_bash', 'README.md'),
    toolUse('toolu_skill', 'Skill', { skill: 'demo' }),
  ]

  test('a Skill whose prompt command emitted a turn-start attachment', () => {
    const yielded: Message[] = [
      progress('toolu_skill'),
      toolResult('toolu_skill', 'Launching skill: demo'),
      createUserMessage({ content: [{ type: 'text', text: SKILL_BODY }], isMeta: true }),
      createAttachmentMessage({
        type: 'task_reconcile',
        reason: 'orphan_in_progress',
        stale: [{ id: '1', subject: 'Run checks', status: 'in_progress' }],
        signature: '1:in_progress',
      }),
      createSystemMessage('Args from unknown skill: x', 'warning'),
    ]
    const { inTurn, nextTurn } = renderBothWays(prefix, yielded)

    // Precondition: the next turn moves the reminder INTO the tool_result,
    // ahead of the skill body. Without that move there is nothing to diverge.
    const group = JSON.parse(nextTurn[inTurn.length - 1]!) as {
      content: Array<{ type: string; content?: string; text?: string }>
    }
    expect(group.content[0]!.type).toBe('tool_result')
    expect(group.content[0]!.content).toContain('<system-reminder>')
    expect(group.content.at(-1)!.text).toStartWith('Base directory for this skill')

    expect(nextTurn.slice(0, inTurn.length)).toEqual(inTurn)
  })

  test('a PostToolUse hook that added context to a tool result', () => {
    const yielded: Message[] = [
      toolResult('toolu_skill', 'built in 1.2s'),
      createAttachmentMessage({
        type: 'hook_additional_context',
        content: ['lint passed'],
        hookName: 'PostToolUse:Skill',
        toolUseID: 'toolu_skill',
        hookEvent: 'PostToolUse',
      }),
    ]
    const { inTurn, nextTurn } = renderBothWays(prefix, yielded)

    const group = JSON.parse(nextTurn[inTurn.length - 1]!) as {
      content: Array<{ type: string; content?: string }>
    }
    expect(group.content).toHaveLength(1)
    expect(group.content[0]!.content).toContain('lint passed')

    expect(nextTurn.slice(0, inTurn.length)).toEqual(inTurn)
  })
})
