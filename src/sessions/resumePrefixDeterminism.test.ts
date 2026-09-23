// A resumed session must re-send the bytes the previous process sent.
//
// The prompt cache is a prefix match: the first request after `--resume` only
// reads back what it reproduces byte for byte, and writes everything after the
// first difference again. Measured 2026-09-23 with the transcript dropping its
// attachments: 40% of the cached prefix read back, 38k tokens re-written on
// the resume turn (scripts/bench/ab/session-cache-ab.ts;
// scripts/bench/ab/resume-wire-probe.ts shows the diverging bytes).
//
// These tests render one history twice — as the live process sent it, and as
// the next process rebuilds it from the transcript — and compare what reaches
// the API.

import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import {
  type Attachment,
  createAttachmentMessage,
} from 'src/agent/attachments/attachments.js'
import { getPlanModeAttachments } from 'src/agent/attachments/lifecycle.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from 'src/agent/messages/messages.js'
import { deserializeMessages } from 'src/sessions/conversationRecovery.js'
import { buildConversationChain } from 'src/sessions/resume/chain.js'
import { cleanMessagesForLogging, removeExtraFields } from 'src/sessions/sessionStorage.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'
import type { AssistantMessage, Message } from 'src/shared/types/message.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import {
  _resetReadReminderStateForTesting,
  _setMitigationModelResolverForTesting,
  maybeFlagReadReminder,
  snapshotReadResultText,
} from 'src/tools/FileReadTool/resultContent.js'
import type { Output as ReadOutput } from 'src/tools/FileReadTool/schemas.js'

// Every real request starts with this block (prependUserContext), which does
// nothing under NODE_ENV=test — so it is added here. It is load-bearing: the
// `\n` that mergeUserMessages appends at a text seam lands on whichever block
// precedes it, so dropping a neighbour changes the bytes of the block that
// stayed.
const CURRENT_DATE = createUserMessage({
  content:
    "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-09-23.\n</system-reminder>\n",
  isMeta: true,
})

function sentToAPI(history: Message[]): unknown[] {
  return normalizeMessagesForAPI([CURRENT_DATE, ...history]).map(m => ({
    role: m.message.role,
    content: m.message.content,
  }))
}

function resumedFromTranscript(history: Message[]): Message[] {
  const onDisk = JSON.parse(JSON.stringify(cleanMessagesForLogging(history)))
  return deserializeMessages(onDisk)
}

// The same round trip through the parentUuid links insertMessageChain
// (src/sessions/persistence/project.ts) writes: each entry hangs off the one
// written before it, except a tool_result, which is re-parented to the
// one-block assistant that issued its tool_use. Resume walks that graph back
// from the leaf, and anything around a tool call can end up off the branch it
// takes — invisible to resumedFromTranscript, which never builds the links.
function resumedThroughChain(history: Message[]): Message[] {
  const written = JSON.parse(JSON.stringify(cleanMessagesForLogging(history))) as TranscriptMessage[]
  const byUuid = new Map<UUID, TranscriptMessage>()
  let previous: UUID | null = null
  for (const m of written) {
    const source = m.type === 'user' ? m.sourceToolAssistantUUID : undefined
    byUuid.set(m.uuid, { ...m, parentUuid: source ?? previous, isSidechain: false })
    previous = m.uuid
  }
  const leaf = byUuid.get(written.at(-1)!.uuid)!
  return deserializeMessages(removeExtraFields(buildConversationChain(byUuid, leaf)))
}

const attachment = (a: Attachment): Message => createAttachmentMessage(a)

// Parallel tool_use blocks stream as one assistant message each, sharing the
// API message id.
function readCall(toolUseId: string, filePath: string, messageId?: string): AssistantMessage {
  const m = createAssistantMessage({
    content: [{ type: 'tool_use' as const, id: toolUseId, name: 'Read', input: { file_path: filePath } }],
  })
  if (messageId) m.message.id = messageId
  return m
}
const readResult = (call: AssistantMessage, toolUseId: string, content: string): Message =>
  createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    sourceToolAssistantUUID: call.uuid,
  })
const hookContext = (toolUseId: string, hookEvent: 'PreToolUse' | 'PostToolUse', text: string): Message =>
  attachment({ type: 'hook_additional_context', content: [text], hookName: `${hookEvent}:Read`, toolUseID: toolUseId, hookEvent })

const RULE_PATH = '/repo/.claudin/rules/typescript.md'

// One finished turn, in the order the live process records it: the prompt,
// the startup reminders, a Read, a path-scoped rule loaded by that Read, and
// the final reply.
function finishedTurn(): Message[] {
  return [
    createUserMessage({ content: 'Read the main files and tell me what this project does.' }),
    attachment({
      type: 'deferred_tools_delta',
      addedNames: ['WebFetch'],
      addedLines: ['WebFetch'],
      removedNames: [],
    }),
    attachment({
      type: 'agent_listing_delta',
      addedTypes: ['Code'],
      addedLines: ['- Code: General-purpose agent.'],
      removedTypes: [],
      isInitial: true,
      showConcurrencyNote: true,
    }),
    attachment({ type: 'git_status_delta', content: 'Current branch: master\n\nStatus:\n(clean)' }),
    attachment({
      type: 'skill_listing',
      content: '- verify: Verify a change works.',
      skillCount: 1,
      isInitial: true,
    }),
    attachment({
      type: 'bash_git_instructions',
      content: '# Committing changes with git\n\nOnly create commits when the user asks for one.',
    }),
    createAssistantMessage({
      content: [
        { type: 'tool_use' as const, id: 'toolu_01', name: 'Read', input: { file_path: '/repo/src/quote.ts' } },
      ],
    }),
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '1→export function quote() {}' }],
    }),
    attachment({
      type: 'nested_memory',
      path: RULE_PATH,
      displayPath: '.claudin/rules/typescript.md',
      content: { path: RULE_PATH, type: 'Project', content: 'Prefer named exports.', globs: ['src/**/*.ts'] },
    }),
    createAssistantMessage({ content: 'It prices shopping carts.' }),
  ]
}

describe('resume re-sends the prefix the previous process sent', () => {
  test('a finished turn renders the same API messages after a transcript round trip', () => {
    const live = finishedTurn()
    expect(JSON.stringify(sentToAPI(resumedFromTranscript(live)))).toBe(JSON.stringify(sentToAPI(live)))
  })

  test('the startup reminders stay in the first user message', () => {
    // The narrower statement of the same contract, so a failure names the
    // block that moved instead of printing two whole requests.
    const [first] = sentToAPI(resumedFromTranscript(finishedTurn())) as Array<{
      content: Array<{ type: string; text?: string }>
    }>
    const texts = first!.content.map(b => b.text ?? '')
    for (const marker of [
      'The following deferred tools are now available',
      'Available agent types for the Agent tool',
      '# gitStatus',
      'The following skills are available',
      '# Committing changes with git',
    ]) {
      expect(texts.some(t => t.includes(marker))).toBe(true)
    }
  })

  test('a rule folded into a tool result is still there after resume', () => {
    const rendered = JSON.stringify(sentToAPI(resumedFromTranscript(finishedTurn())))
    expect(rendered).toContain(`Contents of ${RULE_PATH}`)
  })
})

describe('hook output recorded around a tool call survives resume', () => {
  // Live, hook output is folded into the tool_result it follows, so losing one
  // entry changes the bytes of that block and misses the cache from there on.

  test('PreToolUse output written between the tool_use and its result', () => {
    const call = readCall('toolu_01', '/repo/src/quote.ts')
    const live = [
      createUserMessage({ content: 'What does quote.ts export?' }),
      call,
      hookContext('toolu_01', 'PreToolUse', 'quote.ts is generated; do not edit it.'),
      readResult(call, 'toolu_01', '1→export function quote() {}'),
      createAssistantMessage({ content: 'It exports quote().' }),
    ]
    expect(JSON.stringify(sentToAPI(resumedThroughChain(live)))).toBe(JSON.stringify(sentToAPI(live)))
  })

  test('PostToolUse output of each parallel tool, not only the last one written', () => {
    const readA = readCall('toolu_A', '/repo/src/a.ts', 'msg_parallel')
    const readB = readCall('toolu_B', '/repo/src/b.ts', 'msg_parallel')
    const live = [
      createUserMessage({ content: 'Compare a.ts and b.ts.' }),
      readA,
      readB,
      readResult(readA, 'toolu_A', '1→export const a = 1'),
      hookContext('toolu_A', 'PostToolUse', 'a.ts is owned by the billing team.'),
      readResult(readB, 'toolu_B', '1→export const b = 2'),
      hookContext('toolu_B', 'PostToolUse', 'b.ts is owned by the search team.'),
      createAssistantMessage({ content: 'Both export one constant.' }),
    ]
    expect(JSON.stringify(sentToAPI(resumedThroughChain(live)))).toBe(JSON.stringify(sentToAPI(live)))
  })
})

describe('reminders render what they were created with, not live state', () => {
  // Render, persist, change the state the renderer reads, render the
  // persisted copy: a resumed process may run under a different flag, model
  // or config than the one that sent the reminder, and must still re-send it.
  // Each also checks the snapshot against the live renderer at creation, or
  // a snapshot that drifted would pass by being equally wrong both times.
  const turn = (prompt: string, reminder: Attachment, reply: string): Message[] => [
    createUserMessage({ content: prompt }),
    attachment(reminder),
    createAssistantMessage({ content: reply }),
  ]
  const withoutSnapshot = (a: Attachment): Attachment => {
    const { rendered: _, ...rest } = a as Attachment & { rendered?: string }
    return rest as Attachment
  }

  test('plan_mode', async () => {
    const saved = process.env.CLAUDIN_PLAN_MODE_INTERVIEW_PHASE
    try {
      process.env.CLAUDIN_PLAN_MODE_INTERVIEW_PHASE = '1'
      const inPlanMode = {
        agentId: undefined,
        getAppState: () => ({ toolPermissionContext: { mode: 'plan' } }),
      } as unknown as ToolUseContext
      const planMode = (await getPlanModeAttachments([], inPlanMode)).find(a => a.type === 'plan_mode')!
      const live = turn('Plan the cache refactor.', planMode, 'Reading the cache policy first.')
      const sent = JSON.stringify(sentToAPI(live))
      expect(JSON.stringify(sentToAPI(turn('Plan the cache refactor.', withoutSnapshot(planMode), 'Reading the cache policy first.')))).toBe(sent)

      const resumed = resumedFromTranscript(live)
      // Which workflow the reminder describes is read on every render.
      process.env.CLAUDIN_PLAN_MODE_INTERVIEW_PHASE = '0'
      expect(JSON.stringify(sentToAPI(resumed))).toBe(sent)
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_PLAN_MODE_INTERVIEW_PHASE
      else process.env.CLAUDIN_PLAN_MODE_INTERVIEW_PHASE = saved
    }
  })

  test('an @-mentioned file', () => {
    // The Read block carries a once-per-agent reminder keyed on the result
    // OBJECT, gated on the live model — a transcript round trip loses the
    // first, and a resume under another model flips the second.
    const FILE = '/repo/src/quote.ts'
    _resetReadReminderStateForTesting()
    _setMitigationModelResolverForTesting(() => 'claude-sonnet-5')
    try {
      const data: ReadOutput = {
        type: 'text',
        file: { filePath: FILE, content: 'export function quote() {}', numLines: 1, startLine: 1, totalLines: 1 },
      }
      // What FileReadTool.call() does for the read behind an @-mention.
      maybeFlagReadReminder(data, { agentId: undefined })
      // The snapshot is taken where the attachment is created, while the
      // result still has its identity.
      const mentioned: Attachment = {
        type: 'file',
        filename: FILE,
        content: data,
        displayPath: 'src/quote.ts',
        rendered: snapshotReadResultText(data),
      }
      const live = turn('What does @src/quote.ts do?', mentioned, 'It formats a price.')
      const sent = JSON.stringify(sentToAPI(live))
      expect(sent).toContain('consider whether it would be considered malware')
      expect(JSON.stringify(sentToAPI(turn('What does @src/quote.ts do?', withoutSnapshot(mentioned), 'It formats a price.')))).toBe(sent)

      const resumed = resumedFromTranscript(live)
      _setMitigationModelResolverForTesting(() => 'claude-opus-5-5')
      expect(JSON.stringify(sentToAPI(resumed))).toBe(sent)
    } finally {
      _setMitigationModelResolverForTesting(undefined)
      _resetReadReminderStateForTesting()
    }
  })
})
