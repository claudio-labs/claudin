import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deserializeMessagesWithInterruptDetection,
  loadConversationForResume,
  ResumeTranscriptTooLargeError,
  restoreSkillStateFromMessages,
} from 'src/sessions/conversationRecovery.js'
import {
  createAttachmentMessage,
  getBashGitInstructionsAttachment,
  resetSentBashGitInstructions,
} from 'src/agent/attachments/attachments.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import {
  APPLY_PATCH_TOOL_NAME,
  LEGACY_APPLY_PATCH_TOOL_NAME,
} from 'src/tools/ApplyPatchTool/prompt.js'

const tempDirs: string[] = []
const originalSimple = process.env.CLAUDIN_SIMPLE
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
  const dir = await mkdtemp(join(tmpdir(), 'claudin-conversation-recovery-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'resume.jsonl')
  await writeFile(filePath, `${JSON.stringify(entry)}\n`)
  return filePath
}

afterEach(async () => {
  process.env.CLAUDIN_SIMPLE = originalSimple
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

test('loadConversationForResume accepts a small transcript from jsonl path', async () => {
  process.env.CLAUDIN_SIMPLE = '1'
  const path = await writeJsonl(user(id(1), 'hello'))

  const result = await loadConversationForResume('fixture', path)
  expect(result).not.toBeNull()
  expect(result?.sessionId).toBe(sessionId)
  expect(result?.messages.length).toBeGreaterThan(0)
})

test('loadConversationForResume rejects oversized reconstructed transcripts', async () => {
  process.env.CLAUDIN_SIMPLE = '1'
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

test('a hook attachment after a tool result still reads as an interrupted turn', () => {
  const result = deserializeMessagesWithInterruptDetection([
    createUserMessage({ content: 'hi' }),
    createAssistantMessage({
      content: [{ type: 'tool_use' as const, id: 'toolu_01', name: 'Read', input: { file_path: '/a' } }],
    }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'x' }] }),
    createAttachmentMessage({
      type: 'hook_success',
      hookName: 'PostToolUse',
      hookEvent: 'PostToolUse',
      toolUseID: 'toolu_01',
      content: '',
    }),
  ])

  expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
  const continuation = result.turnInterruptionState as { message: { message: { content: unknown } } }
  expect(JSON.stringify(continuation.message.message.content)).toContain('Continue from where you left off.')
})

// A session recorded before the rename carries `apply_patch` tool_uses. The
// request path maps them through the tool's alias; the in-memory readers (the
// read-state rebuild, /diff, the write collapse) compare names and need the
// new one.
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

// Resume drops thinking for every provider outside the Anthropic family
// (firstParty, Bedrock, Vertex, Foundry keep it). Providers are switched through
// the real resolver: under bun test the global config lives in memory.
describe('thinking on resume, per provider', () => {
  function useProfile(profile: ProviderProfile): void {
    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [profile],
      activeProviderProfileId: profile.id,
    }))
    invalidateActiveProviderCache()
  }

  afterEach(() => {
    resetGlobalConfigForTests()
    invalidateActiveProviderCache()
  })

  function transcript() {
    const split = createAssistantMessage({ content: 'second half' })
    const thinkingHalf = createAssistantMessage({
      content: [{ type: 'thinking', thinking: 'paired', signature: 'sig-2' }] as never,
    })
    // Streaming persists one message per block under the same message.id; the
    // thinking-only half survives the orphan filter because its sibling has text.
    thinkingHalf.message.id = split.message.id
    return [
      createUserMessage({ content: 'hi' }),
      createAssistantMessage({
        content: [
          { type: 'thinking', thinking: 'deep', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'answer', citations: [] },
        ] as never,
      }),
      createUserMessage({ content: 'more' }),
      thinkingHalf,
      split,
    ]
  }

  function assistantBlockTypes(profile: ProviderProfile): string[][] {
    useProfile(profile)
    return deserializeMessagesWithInterruptDetection(transcript())
      .messages.filter(m => m.type === 'assistant')
      .map(m => (m.message.content as Array<{ type: string }>).map(block => block.type))
  }

  test('an OpenAI-compatible provider loses thinking, redacted thinking and thinking-only halves', () => {
    expect(
      assistantBlockTypes({
        id: 'r-openai',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.6-terra',
      }),
    ).toEqual([['text'], ['text']])
  })

  test('the Codex backend loses the thinking it did not produce', () => {
    expect(
      assistantBlockTypes({
        id: 'r-codex',
        name: 'Codex',
        provider: 'openai',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        model: 'codexplan',
      }),
    ).toEqual([['text'], ['text']])
  })

  test.each([
    { id: 'r-anthropic', name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
    { id: 'r-bedrock', name: 'Bedrock', provider: 'bedrock', baseUrl: 'https://bedrock.example', model: 'claude-opus-5-5' },
  ] as ProviderProfile[])('$name keeps every block', profile => {
    expect(assistantBlockTypes(profile)).toEqual([['thinking', 'redacted_thinking', 'text'], ['thinking'], ['text']])
  })

  // A Codex reasoning item is replayed on every request (codex/items.ts), so a
  // resumed Codex session must still hold it, or the -c turn would send a
  // shorter history than the turn before it and miss the cache.
  describe('Codex reasoning items', () => {
    const codexReasoning = {
      type: 'thinking',
      thinking: '',
      signature: '',
      codex: { id: 'rs_1', encrypted_content: 'enc-1' },
    }
    const codexText = { type: 'text', text: 'Reading.', citations: [], codex: { id: 'msg_1', phase: 'commentary' } }

    function codexTranscriptBlocks(profile: ProviderProfile): unknown[][] {
      useProfile(profile)
      return deserializeMessagesWithInterruptDetection([
        createUserMessage({ content: 'hi' }),
        createAssistantMessage({
          content: [{ type: 'thinking', thinking: 'anthropic', signature: 'sig' }, codexReasoning, codexText] as never,
        }),
      ])
        .messages.filter(m => m.type === 'assistant')
        .map(m => m.message.content as unknown[])
    }

    const CODEX_OAUTH: ProviderProfile = {
      id: 'r-codex',
      name: 'Codex',
      provider: 'openai',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'codexplan',
    }

    test('survive a resume on the Codex backend, even under a model that is not an alias', () => {
      expect(codexTranscriptBlocks(CODEX_OAUTH)).toEqual([[codexReasoning, codexText]])
      expect(codexTranscriptBlocks({ ...CODEX_OAUTH, id: 'r-codex-model', model: 'gpt-5.6-terra' })).toEqual([
        [codexReasoning, codexText],
      ])
    })

    test('are stripped like any thinking everywhere else, and with the killswitch off', () => {
      expect(
        codexTranscriptBlocks({
          id: 'r-openai',
          name: 'OpenAI',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.6-terra',
        }),
      ).toEqual([[codexText]])

      const original = process.env.CLAUDIN_CODEX_REASONING_REPLAY
      process.env.CLAUDIN_CODEX_REASONING_REPLAY = '0'
      try {
        expect(codexTranscriptBlocks(CODEX_OAUTH)).toEqual([[codexText]])
      } finally {
        if (original === undefined) delete process.env.CLAUDIN_CODEX_REASONING_REPLAY
        else process.env.CLAUDIN_CODEX_REASONING_REPLAY = original
      }
    })
  })
})
