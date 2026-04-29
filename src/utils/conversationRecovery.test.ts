import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadConversationForResume,
  ResumeTranscriptTooLargeError,
  restoreSkillStateFromMessages,
} from './conversationRecovery.js'
import {
  getBashGitInstructionsAttachment,
  resetSentBashGitInstructions,
} from './attachments.js'
import type { ToolUseContext } from '../Tool.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'

const tempDirs: string[] = []
const originalSimple = process.env.CLAUDE_CODE_SIMPLE
const sessionId = '00000000-0000-4000-8000-000000001999'
const ts = '2026-04-02T00:00:00.000Z'


function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function user(uuid: string, content: string) {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: ts,
    cwd: '/tmp',
    userType: 'external',
    sessionId,
    version: 'test',
    isSidechain: false,
    isMeta: false,
    message: {
      role: 'user',
      content,
    },
  }
}

async function writeJsonl(entry: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claudio-conversation-recovery-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'resume.jsonl')
  await writeFile(filePath, `${JSON.stringify(entry)}\n`)
  return filePath
}

afterEach(async () => {
  process.env.CLAUDE_CODE_SIMPLE = originalSimple
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

test('loadConversationForResume accepts a small transcript from jsonl path', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const path = await writeJsonl(user(id(1), 'hello'))

  const result = await loadConversationForResume('fixture', path)
  expect(result).not.toBeNull()
  expect(result?.sessionId).toBe(sessionId)
  expect(result?.messages.length).toBeGreaterThan(0)
})

test('loadConversationForResume rejects oversized reconstructed transcripts', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const hugeContent = 'x'.repeat(8 * 1024 * 1024 + 32 * 1024)
  const path = await writeJsonl(user(id(2), hugeContent))

  let caught: unknown
  try {
    await loadConversationForResume('fixture', path)
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(ResumeTranscriptTooLargeError)
  expect((caught as Error).message).toContain(
    'Reconstructed transcript is too large to resume safely',
  )
})

test('restoreSkillStateFromMessages arms the bash_git_instructions suppress latch', async () => {
  // Clean slate — process-local state from earlier tests would falsely
  // satisfy the assertion via the per-agent dedup path.
  resetSentBashGitInstructions()

  // Pin env so getBashGitInstructionsAttachment exercises the real branches
  // (NODE_ENV=test would early-return).
  const originalNodeEnv = process.env.NODE_ENV
  const originalDisable = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  process.env.NODE_ENV = 'production'
  process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = 'false'

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
  if (originalDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  else process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = originalDisable

  expect(result).toEqual([])

  // After the latch consumes the suppression, a fresh agent still gets the
  // body (one-shot semantics) — but we already verified that contract in
  // attachments.test.ts; here we only care that the latch armed.
})
