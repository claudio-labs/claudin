/**
 * Regression guard: a rule / nested CLAUDE.md file reaches the model
 * EXACTLY ONCE per session.
 *
 * WHY: `memory_delta` used to run alongside raw `nested_memory` — raw
 * announced the file on turn N and the delta re-announced the same full
 * body on turn N+1, so every rule was paid for twice. That lane is gone
 * and `memoryFilesToAttachments` is now the single producer. Its two
 * guards are what keep it single:
 *
 *   - `toolUseContext.loadedNestedMemoryPaths` — session-scoped, survives
 *     `readFileState` LRU eviction (see REPL.tsx's
 *     `loadedNestedMemoryPathsRef` comment).
 *   - `toolUseContext.readFileState` — the file-state cache, which also
 *     makes the model's copy visible to Edit/Write.
 *
 * The two are redundant in the happy path on purpose, so the happy-path
 * test alone cannot tell you either one works. Each guard therefore gets
 * a test that isolates it.
 *
 * We assert on RENDERED bytes (`normalizeAttachmentForAPI`, the function
 * that produces the literal `<system-reminder>` text the model receives),
 * not on attachment objects — a second copy that reached the wire through
 * a different attachment shape would still be a second copy.
 */
import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from 'src/Tool.js'
import type { MemoryFileInfo } from 'src/services/instructions/claudemd.js'
import { FileStateCache } from 'src/utils/fs/fileStateCache.js'
import { normalizeAttachmentForAPI } from 'src/services/messages/messages.js'
import type { Attachment } from 'src/services/attachments/types.js'
import { memoryFilesToAttachments } from 'src/services/attachments/memory.js'

// Long and unique so a partial re-emission (a truncated or re-wrapped
// second copy) cannot accidentally match, and so a stray substring
// elsewhere in the payload cannot inflate the count.
const SENTINEL =
  'ZZ_RULE_BODY_SENTINEL_7f3a91_do_not_repeat_this_string_anywhere_else_ZZ'
const RULE_PATH = '/repo/.claudin/rules/fixture-rule.md'

function ruleFile(path = RULE_PATH): MemoryFileInfo {
  return {
    path,
    type: 'Project',
    content: `# Fixture rule\n\n${SENTINEL}\n`,
  }
}

function makeContext(
  maxFileStateEntries = 100,
): ToolUseContext & { loadedNestedMemoryPaths: Set<string> } {
  return {
    readFileState: new FileStateCache(maxFileStateEntries, 10_000_000),
    loadedNestedMemoryPaths: new Set<string>(),
  } as unknown as ToolUseContext & { loadedNestedMemoryPaths: Set<string> }
}

/** The literal text these attachments contribute to the request. */
function render(attachments: Attachment[]): string {
  return attachments
    .flatMap(attachment => normalizeAttachmentForAPI(attachment))
    .map(message => {
      const { content } = message.message
      if (typeof content === 'string') return content
      return content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
    })
    .join('\n')
}

function countSentinel(text: string): number {
  return text.split(SENTINEL).length - 1
}

describe('nested memory: one copy per session', () => {
  test('three turns of the same rule render the body exactly once', () => {
    const context = makeContext()
    const turns = [1, 2, 3].map(() =>
      render(memoryFilesToAttachments([ruleFile()], context, '/repo/src/a.ts')),
    )

    // Turn 1 carries the body, in the raw `nested_memory` shape.
    expect(turns[0]).toContain(`Contents of ${RULE_PATH}:`)
    expect(countSentinel(turns[0]!)).toBe(1)

    // Turns 2 and 3 add nothing at all — not a shortened re-announcement,
    // not a "changed since last turn" header, nothing.
    expect(turns[1]).toBe('')
    expect(turns[2]).toBe('')

    expect(countSentinel(turns.join('\n'))).toBe(1)
  })

  test('loadedNestedMemoryPaths holds the line after readFileState evicts', () => {
    // Isolates the session-scoped guard. `readFileState` is a bounded LRU;
    // once the rule's entry is evicted, only `loadedNestedMemoryPaths`
    // stands between the next discovery cycle and a second full copy.
    const context = makeContext(2)
    const first = render(
      memoryFilesToAttachments([ruleFile()], context, '/repo/src/a.ts'),
    )
    expect(countSentinel(first)).toBe(1)

    // Push the rule out of the 2-entry file-state cache.
    for (const path of ['/repo/src/b.ts', '/repo/src/c.ts', '/repo/src/d.ts']) {
      context.readFileState.set(path, {
        content: 'unrelated',
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
      })
    }
    expect(context.readFileState.has(RULE_PATH)).toBe(false)

    const second = render(
      memoryFilesToAttachments([ruleFile()], context, '/repo/src/a.ts'),
    )
    expect(second).toBe('')
    expect(countSentinel(second)).toBe(0)
  })

  test('readFileState alone suppresses a repeat when the session set is lost', () => {
    // Isolates the other guard: a context whose `loadedNestedMemoryPaths`
    // is absent (the field is optional on ToolUseContext) must still not
    // double-announce, because readFileState already holds the entry.
    const context = makeContext()
    const first = render(
      memoryFilesToAttachments([ruleFile()], context, '/repo/src/a.ts'),
    )
    expect(countSentinel(first)).toBe(1)

    const withoutSessionSet = {
      readFileState: context.readFileState,
      loadedNestedMemoryPaths: undefined,
    } as unknown as ToolUseContext
    const second = render(
      memoryFilesToAttachments([ruleFile()], withoutSessionSet, '/repo/src/a.ts'),
    )
    expect(second).toBe('')
  })

  test('a fresh context re-announces the rule (post-compaction path)', () => {
    // `compact.ts` clears BOTH guards (`readFileState.clear()` +
    // `loadedNestedMemoryPaths.clear()`) because the summary replaced the
    // turn-1 attachment — the model no longer has the rule. Dedup must be
    // session-scoped, never permanent: nobody should "improve" it into a
    // process-wide set that silently starves the model after a compact.
    const before = render(
      memoryFilesToAttachments([ruleFile()], makeContext(), '/repo/src/a.ts'),
    )
    const afterCompact = render(
      memoryFilesToAttachments([ruleFile()], makeContext(), '/repo/src/a.ts'),
    )

    expect(countSentinel(before)).toBe(1)
    expect(countSentinel(afterCompact)).toBe(1)
    expect(afterCompact).toContain(`Contents of ${RULE_PATH}:`)
  })

  test('distinct rules are each announced once, not collapsed', () => {
    // Guards against a dedup that keys on something coarser than the path
    // (a per-turn flag, a "already sent some memory" boolean).
    const context = makeContext()
    const other = ruleFile('/repo/.claudin/rules/other-rule.md')
    const turn1 = render(
      memoryFilesToAttachments([ruleFile(), other], context, '/repo/src/a.ts'),
    )

    expect(turn1).toContain(`Contents of ${RULE_PATH}:`)
    expect(turn1).toContain('Contents of /repo/.claudin/rules/other-rule.md:')
    // Both bodies carry the sentinel, so two files → two occurrences.
    expect(countSentinel(turn1)).toBe(2)

    const turn2 = render(
      memoryFilesToAttachments([ruleFile(), other], context, '/repo/src/a.ts'),
    )
    expect(turn2).toBe('')
  })
})
