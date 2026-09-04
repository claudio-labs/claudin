/**
 * The injection → gate round trip for a file the harness hands to the model
 * in a form that differs from disk (frontmatter stripped, HTML comments
 * stripped, MEMORY.md truncated).
 *
 * The entry `memoryFilesToAttachments` seeds must let Edit/apply_patch work
 * from exactly the text that reached the model, and nothing else: 8 of 65
 * read-gate refusals in the 2026-08/09 corpus were Edits of such a file, each
 * answered by a view='full' re-read of a file the model had just been shown.
 */
import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/messages.js'
import { memoryFilesToAttachments } from 'src/agent/attachments/memory.js'
import {
  satisfiesLineScopedReadGate,
  satisfiesReadGate,
  seenRegionCovers,
  seenRegionCoversText,
} from 'src/tools/shared/readBeforeEditMessages.js'

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

describe('an injected file: what the model saw is what it may edit', () => {
  test('the entry carries the raw file AND the shown text', () => {
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

    // …and the entry says so, next to the raw bytes getChangedFiles diffs.
    const entry = context.readFileState.get(RULE_PATH)!
    expect(entry.content).toBe(RAW)
    expect(entry.isPartialView).toBe(true)
    expect(entry.injectedView).toBe(SHOWN)
  })

  test('Edit and apply_patch pass on the shown text, Write does not', () => {
    const context = makeContext()
    memoryFilesToAttachments([strippedRule()], context, '/repo/src/a.ts')
    const entry = context.readFileState.get(RULE_PATH)!

    expect(satisfiesLineScopedReadGate(entry)).toBe(true)
    expect(seenRegionCoversText(entry, 'BANANA')).toBe(true)
    expect(seenRegionCovers(entry, ['The greeting word is: BANANA.'])).toBe(
      true,
    )
    // The frontmatter is on disk but was never shown.
    expect(seenRegionCoversText(entry, 'paths: src/**')).toBe(false)
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
    expect(entry.injectedView).toBeUndefined()
    expect(satisfiesReadGate(entry)).toBe(true)
  })
})
