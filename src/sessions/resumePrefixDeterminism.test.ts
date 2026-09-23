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
import {
  type Attachment,
  createAttachmentMessage,
} from 'src/agent/attachments/attachments.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from 'src/agent/messages/messages.js'
import { deserializeMessages } from 'src/sessions/conversationRecovery.js'
import { cleanMessagesForLogging } from 'src/sessions/sessionStorage.js'
import type { Message } from 'src/shared/types/message.js'

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

const attachment = (a: Attachment): Message => createAttachmentMessage(a)

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
