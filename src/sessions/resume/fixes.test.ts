/**
 * The four "fix" decisions of the `sessions/resume` spec, each pinned here
 * because the characterization suites hold the behaviour as it was.
 */
import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { useRestoreSandbox } from 'src/sessions/__testutils__/restoreHarness.js'
import { id, jsonl, type Line, prompt, reply, second, textOf } from 'src/sessions/__testutils__/resumeTranscripts.js'
import { deserializeMessages, loadConversationForResume } from 'src/sessions/conversationRecovery.js'
import { checkCrossProjectResume } from 'src/sessions/crossProjectResume.js'
import { findLatestMessage } from 'src/sessions/sessionStorage.js'
import type { LogOption } from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'

const sandbox = useRestoreSandbox()

const OWN = '5e55104e-0000-4000-8000-0000000000f1' as UUID

function looseFile(lines: Line[]): string {
  const dir = join(sandbox.root, 'loose')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'resume-me.jsonl')
  writeFileSync(path, jsonl(lines))
  return path
}

describe('fix 1: on a timestamp tie, the entry written later wins', () => {
  test('findLatestMessage takes the later of two entries sharing the latest stamp', () => {
    const tied = [
      { uuid: 'written-first', timestamp: second(5) },
      { uuid: 'older', timestamp: second(1) },
      { uuid: 'written-last', timestamp: second(5) },
    ]
    expect(findLatestMessage(tied, () => true)?.uuid).toBe('written-last')
  })

  test('a path resume takes the later of two tips sharing a stamp', async () => {
    const path = looseFile([
      prompt(id(1), 'Which branch?', { session: OWN, at: 1 }),
      reply(id(2), 'The first answer', { session: OWN, parent: id(1), at: 2 }),
      reply(id(3), 'The answer written last', { session: OWN, parent: id(1), at: 2 }),
    ])
    const loaded = (await loadConversationForResume(OWN, path))!
    expect(loaded.messages.map(textOf)).toEqual(['Which branch?', 'The answer written last'])
  })

  test('a path resume never takes a tip stamped at the epoch', async () => {
    const path = looseFile([prompt(id(1), 'Stamped at the epoch', { session: OWN, more: { timestamp: new Date(0).toISOString() } })])
    const loaded = (await loadConversationForResume(OWN, path))!
    expect(loaded.messages).toEqual([])
    expect(loaded.sessionId).toBeUndefined()
  })
})

describe('fixes 2 and 4: the command that resumes a session from another directory', () => {
  const SESSION = '0b5e55ed-0000-4000-8000-0000000000f2'
  const RESUME = /^cd \S+ && (\S+) --resume (.+)$/
  const commandFor = (fields: Partial<LogOption>) => {
    const log = { messages: [], sessionId: SESSION, projectPath: '/other/project', ...fields } as LogOption
    return (checkCrossProjectResume(log, true, []) as { command: string }).command
  }

  test('launches claudin', () => {
    expect(commandFor({}).match(RESUME)![1]).toBe('claudin')
  })

  test('a uuid session id quotes to itself', () => {
    expect(commandFor({}).match(RESUME)![2]).toBe(SESSION)
  })

  test('a session id read from a transcript is shell-quoted, so the shell runs nothing in it', () => {
    const marker = join(sandbox.root, 'pwned')
    const hostile = `x'; touch ${marker}; echo "$(touch ${marker})" && touch ${marker}`
    const command = commandFor({ sessionId: undefined, messages: [{ sessionId: hostile }] as never })
    const quoted = command.match(RESUME)![2]!
    const shell = Bun.spawnSync(['bash', '-c', `printf '%s' ${quoted}`])
    expect(shell.stdout.toString()).toBe(hostile)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('fix 3: deserializeMessages leaves the caller’s messages as they were', () => {
  const inputs: Array<{ name: string; message: () => Message }> = [
    { name: 'an unknown permission mode', message: () => createUserMessage({ content: 'from a newer build', permissionMode: 'turbo' as never }) },
    {
      name: 'a legacy tool name',
      message: () => createAssistantMessage({ content: [{ type: 'tool_use', id: 'c1', name: 'apply_patch', input: {} }] as never }),
    },
    {
      name: 'a legacy attachment kind',
      message: () => createAttachmentMessage({ type: 'new_file', filename: join(sandbox.projectDir, 'a.ts'), content: 'x' } as never),
    },
  ]
  for (const input of inputs) {
    test(input.name, () => {
      const message = input.message()
      const written = JSON.stringify(message)
      const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] })
      deserializeMessages([createUserMessage({ content: 'go' }), message, result, createAssistantMessage({ content: 'done' })])
      expect(JSON.stringify(message)).toBe(written)
    })
  }

  test('the copy handed back has the unknown mode cleared', () => {
    const unknown = createUserMessage({ content: 'from a newer build', permissionMode: 'turbo' as never })
    const [readied] = deserializeMessages([unknown, createAssistantMessage({ content: 'ok' })])
    expect((readied as { permissionMode?: string }).permissionMode).toBeUndefined()
    expect(unknown.permissionMode as string).toBe('turbo')
  })
})
