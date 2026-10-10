/**
 * The fresh-agent arm of the extraction (CLAUDIN_EXTRACT_MEMORIES_MODEL): which
 * messages it reads, and that its context reaches the model and effort it was
 * given rather than the session's.
 */
import { describe, expect, test } from 'bun:test'

import type { CacheSafeParams } from 'src/agent/coordinator/forkedAgent.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { selectTurnModel } from 'src/agent/query/turnModel.js'
import {
  freshAgentParams,
  messagesSinceCursor,
} from 'src/memory/extract/extractMemories.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'

function toolTurn(id: string): Message[] {
  return [
    createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] as never }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }], toolUseResult: 'x' }),
  ]
}

const first = createUserMessage({ content: 'first ask' })
const second = createUserMessage({ content: 'second ask' })
const answer1 = createAssistantMessage({ content: 'done 1' })
const answer2 = createAssistantMessage({ content: 'done 2' })
const conversation: Message[] = [first, ...toolTurn('t1'), answer1, second, ...toolTurn('t2'), answer2]

describe('messagesSinceCursor', () => {
  test('reads the whole conversation before the first extraction', () => {
    expect(messagesSinceCursor(conversation, undefined)).toEqual(conversation)
  })

  test('starts at the human turn after the cursor', () => {
    expect(messagesSinceCursor(conversation, answer1.uuid)[0]).toBe(second)
    expect(messagesSinceCursor(conversation, answer1.uuid)).toHaveLength(4)
  })

  test('never starts on a tool_result, even with the cursor mid-turn', () => {
    expect(messagesSinceCursor(conversation, first.uuid)[0]).toBe(second)
  })

  test('falls back to the whole conversation when the cursor is gone', () => {
    expect(messagesSinceCursor(conversation, 'compacted-away')).toEqual(conversation)
  })

  test('is empty when no human turn follows the cursor', () => {
    expect(messagesSinceCursor(conversation, answer2.uuid)).toEqual([])
  })
})

describe('freshAgentParams', () => {
  const state = {
    effortValue: 'medium',
    mainLoopModel: 'claude-opus-5-5',
    toolPermissionContext: { mode: 'default', shouldAvoidPermissionPrompts: false },
  } as unknown as AppState
  const parent = {
    options: { mainLoopModel: 'claude-opus-5-5', tools: [] },
    getAppState: () => state,
  } as unknown as ToolUseContext
  const params: CacheSafeParams = {
    systemPrompt: [] as never,
    userContext: {},
    systemContext: {},
    toolUseContext: parent,
    forkContextMessages: conversation,
  }
  const fresh = freshAgentParams(params, answer1.uuid, { model: 'claude-haiku-5-5', effortValue: 'high' })

  test('keeps the system prompt and tools, and reads only the messages since the cursor', () => {
    expect(fresh.cacheSafeParams.systemPrompt).toBe(params.systemPrompt)
    expect(fresh.cacheSafeParams.toolUseContext).toBe(parent)
    expect(fresh.cacheSafeParams.forkContextMessages[0]).toBe(second)
  })

  test('runs its turns on the given model, not the session one', () => {
    const model = selectTurnModel({
      agentType: fresh.overrides.agentType,
      agentModel: fresh.overrides.options!.mainLoopModel,
      sessionModel: 'claude-opus-5-5',
      permissionMode: 'default',
      exceeds200kTokens: false,
    })
    expect(model).toBe('claude-haiku-5-5')
  })

  test('runs at the given effort, without permission prompts', () => {
    const seen = fresh.overrides.getAppState!()
    expect(seen.effortValue).toBe('high')
    expect(seen.toolPermissionContext.shouldAvoidPermissionPrompts).toBe(true)
    expect(seen.toolPermissionContext.mode).toBe('default')
    expect(state.effortValue).toBe('medium')
  })
})
