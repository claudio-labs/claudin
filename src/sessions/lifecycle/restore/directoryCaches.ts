/**
 * The caches that answer for the working directory. Entering and leaving a
 * worktree both drop them through this one function, so that a cache added
 * later cannot be forgotten by one of the two moves.
 *
 * The plans directory is not among them: its memo is keyed by the session
 * root, which both moves set, so it follows the new directory by itself.
 */
import { clearSystemPromptSections } from 'src/agent/prompts/systemPromptSections.js'
import { invalidateAll as dropCachedToolResults } from 'src/agent/tools/toolResultCache.js'
import { clearMemoryFileCaches } from 'src/memory/instructions/claudemd.js'

export function dropDirectoryCaches(): void {
  // The new directory's AGENTS.md and other instruction files must be read.
  clearMemoryFileCaches()
  // The prompt sections, and with them the beta-header latches.
  clearSystemPromptSections()
  // Read, Glob, Grep and LSP results are keyed by relative paths, which now name other files.
  dropCachedToolResults()
}
