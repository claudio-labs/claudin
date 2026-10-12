/**
 * The injection → gate round trip for a file the harness hands to the model
 * in a form that differs from disk (frontmatter stripped, HTML comments
 * stripped, MEMORY.md truncated).
 *
 * The entry `memoryFilesToAttachments` seeds is a read of the file: 8 of 65
 * read-gate refusals in the 2026-08/09 corpus were Edits of such a file, each
 * answered by a view='full' re-read of a file the model had just been shown.
 * Patch (since 2026-09-24) and Edit (since 2026-10-12) take any read, so the
 * entry's presence is all they need; Write, which replaces the file, does not
 * take it.
 */
import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/messages.js'
import { memoryFilesToAttachments } from 'src/agent/attachments/memory.js'
import { satisfiesReadGate } from 'src/tools/shared/readBeforeEditMessages.js'

const RULE_PATH = '/repo/.claudin/rules/fixture-rule.md'
const RAW = '---\npaths: src/**\n---\n# Fixture rule\n\nThe greeting word is: BANANA.\n'
const SHOWN = '# Fixture rule\n\nThe greeting word is: BANANA.'

function strippedRule(): MemoryFileInfo {
  return {
    path: RULE_PATH,
    type: 'Project',
    content: SHOWN,
    contentDiffersFromDisk: true,
    rawContent: RAW,
  }
}

function makeContext(): ToolUseContext {
  return {
    readFileState: new FileStateCache(100, 10_000_000),
    loadedNestedMemoryPaths: new Set<string>(),
  } as unknown as ToolUseContext
}

describe('an injected file: a read for an in-place write, not for Write', () => {
  test('the entry carries the raw file, as a partial view', () => {
    const context = makeContext()
    const attachments = memoryFilesToAttachments(
      [strippedRule()],
      context,
      '/repo/src/a.ts',
    )
    // What actually went to the model is the stripped body…
    const wire = attachments
      .flatMap(a => normalizeAttachmentForAPI(a))
      .map(m => JSON.stringify(m.message.content))
      .join('\n')
    expect(wire).toContain('BANANA')
    expect(wire).not.toContain('paths: src/**')

    // …and the entry holds the raw bytes getChangedFiles diffs, marked as a
    // view the model did not see whole.
    const entry = context.readFileState.get(RULE_PATH)!
    expect(entry.content).toBe(RAW)
    expect(entry.isPartialView).toBe(true)
  })

  test('an in-place write takes the entry, Write does not', () => {
    const context = makeContext()
    memoryFilesToAttachments([strippedRule()], context, '/repo/src/a.ts')
    const entry = context.readFileState.get(RULE_PATH)!

    // Patch and Edit ask only that the entry exists.
    expect(context.readFileState.has(RULE_PATH)).toBe(true)
    // Write replaces the file; written back from the stripped view it would
    // lose its frontmatter.
    expect(satisfiesReadGate(entry)).toBe(false)
  })

  test('a file injected verbatim is an ordinary whole-file entry', () => {
    const context = makeContext()
    memoryFilesToAttachments(
      [{ path: RULE_PATH, type: 'Project', content: SHOWN }],
      context,
      '/repo/src/a.ts',
    )
    const entry = context.readFileState.get(RULE_PATH)!
    expect(entry.isPartialView).toBeFalsy()
    expect(satisfiesReadGate(entry)).toBe(true)
  })
})
