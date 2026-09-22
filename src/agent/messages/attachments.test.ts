/**
 * Characterization tests for attachments bucket of src/agent/messages/messages.ts.
 * See normalize.test.ts header for context (ROADMAP 11a).
 *
 * Strategy: cover a representative cross-section of `normalizeAttachmentForAPI`
 * cases — one simple text attachment, one memory file, one passthrough that
 * returns []. The full switch has ~50 cases; this test freezes only the ones
 * most likely to break across the file split.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { normalizeAttachmentForAPI } from 'src/agent/messages/messages.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import { normalizeForSnapshot } from 'src/agent/messages/__test-helpers__/snapshot.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

describe('normalizeAttachmentForAPI', () => {
  test('edited_text_file wraps a meta user message in system-reminder', () => {
    const out = normalizeAttachmentForAPI({
      type: 'edited_text_file',
      filename: 'src/foo.ts',
      snippet: '1 | const x = 1\n',
    } as any)
    expect(out).toHaveLength(1)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('nested_memory wraps memory content in system-reminder', () => {
    const out = normalizeAttachmentForAPI({
      type: 'nested_memory',
      content: { path: 'memory/foo.md', content: 'remembered fact' },
    } as any)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('dynamic_skill returns no messages (UI-only)', () => {
    const out = normalizeAttachmentForAPI({
      type: 'dynamic_skill',
      name: 'pdf',
    } as any)
    expect(out).toEqual([])
  })

  test('memory_index costs nothing on the wire', () => {
    // Pins the contract, not the case: this switch falls through to a
    // fail-open tail that logs an unknown type and returns [] anyway, so
    // deleting the case changes nothing observable here (agent-safety.md §4).
    // What it does catch is the case ever starting to emit content — the
    // indexes already ship inside claude_md_delta, and announcing them here
    // would send the whole body a second time.
    const out = normalizeAttachmentForAPI({
      type: 'memory_index',
      indexes: [
        {
          path: '/repo/.claudin/memory/MEMORY.md',
          displayPath: '.claudin/memory/MEMORY.md',
          kind: 'auto',
          entryCount: 16,
          totalEntryCount: 16,
        },
      ],
    } as any)
    expect(out).toEqual([])
  })

  test('skill_listing without content returns no messages', () => {
    const out = normalizeAttachmentForAPI({
      type: 'skill_listing',
      content: '',
    } as any)
    expect(out).toEqual([])
  })

  test('skill_listing with content wraps a meta user message', () => {
    const out = normalizeAttachmentForAPI({
      type: 'skill_listing',
      content: '- foo: a skill',
    } as any)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('a legacy relevant_memories attachment from an old transcript costs nothing and does not throw', () => {
    // The per-turn relevance recall was deleted along with its attachment
    // type, but a session recorded while it was on still carries one on
    // --resume. Pins the contract (nothing reaches the model, nothing
    // throws), not the LEGACY_ATTACHMENT_TYPES entry: the fail-open tail
    // returns [] for any unknown type, and the entry only keeps it out of
    // the error log — which is a no-op in this build (agent-safety.md §4).
    const legacy = {
      type: 'relevant_memories',
      memories: [
        {
          path: 'memory/a.md',
          mtimeMs: 1700000000000,
          header: 'Contents of memory/a.md:',
          content: 'fact A',
        },
      ],
    } as unknown as Parameters<typeof normalizeAttachmentForAPI>[0]
    expect(() => normalizeAttachmentForAPI(legacy)).not.toThrow()
    expect(normalizeAttachmentForAPI(legacy)).toEqual([])
  })

  test('task_status running local_bash includes command and TaskStop hint', () => {
    const out = normalizeAttachmentForAPI({
      type: 'task_status',
      taskId: 'bash_abc',
      taskType: 'local_bash',
      status: 'running',
      description: 'dev server',
      deltaSummary: null,
      outputFilePath: '/tmp/bash_abc.log',
      command: 'bun run dev:grpc',
    } as any)
    expect(out).toHaveLength(1)
    const text = (out[0]!.message.content as any).toString()
    expect(text).toContain('Background shell')
    expect(text).toContain('bash_abc')
    expect(text).toContain('bun run dev:grpc')
    expect(text).toContain('TaskStop')
    expect(text).toContain('Do NOT spawn a duplicate')
  })

  test('task_status running local_agent keeps agent wording', () => {
    const out = normalizeAttachmentForAPI({
      type: 'task_status',
      taskId: 'agent_xyz',
      taskType: 'local_agent',
      status: 'running',
      description: 'explore auth',
      deltaSummary: 'found 3 files',
      outputFilePath: '/tmp/agent_xyz.log',
    } as any)
    expect(out).toHaveLength(1)
    const text = (out[0]!.message.content as any).toString()
    expect(text).toContain('Background agent')
    expect(text).toContain('agent_xyz')
    expect(text).toContain('explore auth')
    expect(text).toContain('Progress: found 3 files')
    expect(text).not.toContain('TaskStop')
  })

  // The reminder is the only mid-turn signal about the task list, and it used
  // to show the list without asking for anything.
  describe('todo_reminder_delta asks for an update while work is open', () => {
    const render = (snapshot: Array<{ id: string; status: string }>): string => {
      const out = normalizeAttachmentForAPI({
        type: 'todo_reminder_delta',
        added: snapshot.map(s => ({ ...s, text: `task ${s.id}` })),
        statusChanged: [],
        removedIds: [],
        isInitial: true,
        snapshot,
      } as any)
      expect(out).toHaveLength(1)
      return (out[0]!.message.content as any).toString()
    }

    test('asks when a task is still open', () => {
      const text = render([
        { id: '1', status: 'completed' },
        { id: '2', status: 'pending' },
      ])
      expect(text).toContain('Keep this list current as you work')
    })

    test('stays a plain state dump once everything is completed', () => {
      const text = render([
        { id: '1', status: 'completed' },
        { id: '2', status: 'completed' },
      ])
      expect(text).toContain('Current task list')
      expect(text).not.toContain('Keep this list current')
    })

    test('never tells the model to hide the reminder', () => {
      // An earlier reminder paired instructions with a gag order and the model
      // reported it to the user as injected text. Don't reintroduce that.
      const text = render([{ id: '1', status: 'in_progress' }])
      expect(text).not.toContain('never mention')
      expect(text).not.toContain('do not mention')
    })
  })
})
