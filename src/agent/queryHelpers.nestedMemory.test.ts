import { describe, expect, test } from 'bun:test'
import { createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import { memoryFilesToAttachments } from 'src/agent/attachments/memory.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { QueryEngine, type QueryEngineConfig } from 'src/agent/QueryEngine.js'
import { extractNestedMemoryPathsFromMessages } from 'src/agent/queryHelpers.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import type { Message } from 'src/shared/types/message.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

// Now that the transcript keeps nested_memory attachments, a resumed history
// carries the rules it already showed the model. The dedup set that stops a
// second injection lives per engine and starts empty — so without seeding it,
// the next Read that matches the rule appends it to the history again.

const RULE_PATH = '/repo/.claudin/rules/typescript.md'
const RULE: MemoryFileInfo = { path: RULE_PATH, type: 'Project', content: 'Prefer named exports.' }

function resumedHistory(): Message[] {
  return [
    createUserMessage({ content: 'Read src/quote.ts' }),
    createAttachmentMessage({
      type: 'nested_memory',
      path: RULE_PATH,
      displayPath: '.claudin/rules/typescript.md',
      content: RULE,
    }),
  ]
}

function contextWith(loaded: Set<string>): ToolUseContext {
  return {
    loadedNestedMemoryPaths: loaded,
    readFileState: createFileStateCacheWithSizeLimit(10),
  } as unknown as ToolUseContext
}

describe('nested_memory dedup after resume', () => {
  test('a rule already in the history is not injected again', () => {
    const seeded = extractNestedMemoryPathsFromMessages(resumedHistory())
    expect(memoryFilesToAttachments([RULE], contextWith(seeded))).toEqual([])
  })

  test('an unseeded set would inject it a second time', () => {
    // The failure the seeding prevents — proves the test above can go red.
    expect(memoryFilesToAttachments([RULE], contextWith(new Set()))).toHaveLength(1)
  })

  test('QueryEngine seeds the set from the history it starts with', () => {
    const engine = new QueryEngine({
      initialMessages: resumedHistory(),
      readFileCache: createFileStateCacheWithSizeLimit(10),
    } as unknown as QueryEngineConfig)
    const loaded = (engine as unknown as { loadedNestedMemoryPaths: Set<string> }).loadedNestedMemoryPaths
    expect([...loaded]).toEqual([RULE_PATH])
  })
})
