import { expect, test } from 'bun:test'

import {
  deserializeMessagesWithInterruptDetection,
  restoreSkillStateFromMessages,
} from 'src/sessions/conversationRecovery.js'
import {
  createAttachmentMessage,
  getBashGitInstructionsAttachment,
  resetSentBashGitInstructions,
} from 'src/agent/attachments/attachments.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import {
  APPLY_PATCH_TOOL_NAME,
  LEGACY_APPLY_PATCH_TOOL_NAME,
} from 'src/tools/ApplyPatchTool/prompt.js'

test('restoreSkillStateFromMessages arms the bash_git_instructions suppress latch', async () => {
  // Clean slate — process-local state from earlier tests would falsely
  // satisfy the assertion via the per-agent dedup path.
  resetSentBashGitInstructions()

  // Pin env so getBashGitInstructionsAttachment exercises the real branches
  // (NODE_ENV=test would early-return).
  const originalNodeEnv = process.env.NODE_ENV
  const originalDisable = process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS
  process.env.NODE_ENV = 'production'
  process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = 'false'

  const messagesWithBash = [
    {
      type: 'attachment',
      attachment: { type: 'bash_git_instructions', content: 'git protocol body' },
    },
  ] as unknown as Parameters<typeof restoreSkillStateFromMessages>[0]

  restoreSkillStateFromMessages(messagesWithBash)

  // Latch should now be armed: the next emission attempt returns []
  // even though we haven't sent before.
  const ctx = {
    options: { tools: [{ name: BASH_TOOL_NAME }] },
  } as unknown as ToolUseContext
  const result = await getBashGitInstructionsAttachment(ctx)

  // Restore env before any assertion that could throw mid-test.
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalDisable === undefined) delete process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS
  else process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = originalDisable

  expect(result).toEqual([])

  // After the latch consumes the suppression, a fresh agent still gets the
  // body (one-shot semantics) — but we already verified that contract in
  // attachments.test.ts; here we only care that the latch armed.
})

// Stop hooks record their output AFTER the final reply. Now that the transcript
// keeps attachments, that output is the last thing on disk — and must not make
// resume append "Continue from where you left off." to a turn that finished.
test('a Stop hook attachment after the final reply is not an interrupted turn', () => {
  const result = deserializeMessagesWithInterruptDetection([
    createUserMessage({ content: 'hi' }),
    createAssistantMessage({ content: 'hello' }),
    createAttachmentMessage({
      type: 'hook_success',
      hookName: 'Stop',
      hookEvent: 'Stop',
      toolUseID: 'stop-hook',
      content: '',
    }),
  ])

  expect(result.turnInterruptionState).toEqual({ kind: 'none' })
  expect(result.messages.at(-1)?.type).toBe('attachment')
})

test('a resumed transcript calls the renamed patch tool by its new name', () => {
  const patch = { patchText: '*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch' }
  const result = deserializeMessagesWithInterruptDetection([
    createUserMessage({ content: 'hi' }),
    createAssistantMessage({
      content: [
        { type: 'tool_use' as const, id: 'toolu_01', name: LEGACY_APPLY_PATCH_TOOL_NAME, input: patch },
      ],
    }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }] }),
    createAssistantMessage({ content: 'done' }),
  ])

  const toolUses = result.messages.flatMap(m =>
    m.type === 'assistant' && Array.isArray(m.message.content)
      ? m.message.content.filter(b => b.type === 'tool_use')
      : [],
  )
  expect(toolUses.map(b => (b as { name: string }).name)).toEqual([APPLY_PATCH_TOOL_NAME])
  expect((toolUses[0] as { input: unknown }).input).toEqual(patch)
})
