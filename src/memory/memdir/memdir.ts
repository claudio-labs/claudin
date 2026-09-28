/**
 * The memory directory's index and prompts: the `MEMORY.md` caps and how an
 * oversized index is cut, the directory helpers, the memory texts of the
 * system prompt and `loadMemoryPrompt`, which picks among them.
 */
export {
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/entrypoint/limits.js'
export {
  type EntrypointTruncation,
  truncateEntrypointContent,
} from 'src/memory/memdir/entrypoint/truncation.js'
export { countIndexEntries } from 'src/memory/memdir/entrypoint/indexEntries.js'
export {
  areMemoryIndexesEmpty,
  ensureMemoryDirExists,
  hasExistingMemories,
} from 'src/memory/memdir/directory/memoryDirectory.js'
export {
  DIR_EXISTS_GUIDANCE,
  DIRS_EXIST_GUIDANCE,
} from 'src/memory/memdir/prompt/dirGuidance.js'
export { buildSearchingPastContextSection } from 'src/memory/memdir/prompt/pastContextSearch.js'
export {
  buildMemoryLines,
  buildMemoryStubLines,
} from 'src/memory/memdir/prompt/privateMemoryPrompt.js'
export { buildMemoryPrompt } from 'src/memory/memdir/prompt/agentMemoryPrompt.js'
export { loadMemoryPrompt } from 'src/memory/memdir/prompt/memoryPromptDispatch.js'
export { isLeanMemoryPromptEnabled } from 'src/memory/memdir/switches/promptSwitches.js'
