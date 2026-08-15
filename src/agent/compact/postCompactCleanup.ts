import { feature } from 'bun:bundle'
import type { QuerySource } from 'src/agent/prompts/querySource.js'
import { clearSystemPromptSections } from 'src/agent/prompts/systemPromptSections.js'
import { getUserContext } from 'src/agent/context.js'
import type { Message } from 'src/shared/types/message.js'
import { clearSpeculativeChecks } from 'src/tools/BashTool/bashPermissions.js'
import { resetSentBashGitInstructions } from 'src/agent/attachments/attachments.js'
import { clearClassifierApprovals } from 'src/permissions/classifierApprovals.js'
import { resetGetMemoryFilesCache } from 'src/memory/instructions/claudemd.js'
import {
  type ContentReplacementState,
  reconstructContentReplacementState,
} from 'src/agent/tools/toolResultStorage.js'
import { resetPromptCacheBreakDetection } from 'src/providers/cache/promptCacheBreakDetection.js'
import { clearAllSessions } from 'src/providers/transport/sessionIngress.js'
import { diagnosticTracker } from 'src/platform/diagnosticTracking.js'
import { clearSessionMessagesCache } from 'src/sessions/sessionStorage.js'
import { clearBetaTracingState } from 'src/platform/telemetry/betaSessionTracing.js'
import { resetMicrocompactState } from 'src/agent/compact/microCompact.js'
import {
  bumpStandDownEpoch,
  pruneStaleClippedIds,
  pruneOrphanClippedIds,
} from 'src/agent/compact/stableStubState.js'
import { clearSkippedTimestamps } from 'src/agent/history.js'

/**
 * Run cleanup of caches and tracking state after compaction.
 * Call this after both auto-compact and manual /compact to free memory
 * held by tracking structures that are invalidated by compaction.
 *
 * Note: We intentionally do NOT clear invoked skill content here.
 * Skill content must survive across multiple compactions so that
 * createSkillAttachmentIfNeeded() can include the full skill text
 * in subsequent compaction attachments.
 *
 * querySource: pass the compacting query's source so we can skip
 * resets that would clobber main-thread module-level state. Subagents
 * (agent:*) run in the same process and share module-level state
 * (context-collapse store, getMemoryFiles one-shot hook flag,
 * getUserContext cache); resetting those when a SUBAGENT compacts
 * would corrupt the MAIN thread's state. All compaction callers should
 * pass querySource — undefined is only safe for callers that are
 * genuinely main-thread-only (/compact, /clear).
 */
export function runPostCompactCleanup(
  querySource?: QuerySource,
  messages?: Message[],
  contentReplacementState?: ContentReplacementState,
): void {
  // Subagents (agent:*) run in the same process and share module-level
  // state with the main thread. Only reset main-thread module-level state
  // (context-collapse, memory file cache) for main-thread compacts.
  // Same startsWith pattern as isMainThread (index.ts:188).
  const isMainThreadCompact =
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'

  // MAIN-THREAD ONLY, same authority argument as the orphan sweep below:
  // resetMicrocompactState → resetClippedIds wipes the ENTIRE current
  // registry key, and an ordinary Agent/fork sub-agent shares the main
  // thread's key (getAgentId() is blind to it) while compacting only its OWN
  // transcript — the "same history" premise in resetMicrocompactState's doc
  // does not hold for it, so an unguarded call deletes the parent's LIVE
  // pins, spent memory and clipped ids. This gate closes the fork-autocompact
  // hazard stableStubState's resetClippedIds comment used to document as
  // unguarded. (Swarm teammates reset their OWN key from their own compact /
  // cleanup in inProcessRunner.)
  if (isMainThreadCompact) {
    resetMicrocompactState()
    // Same gate, same authority argument, different state: FileReadTool's
    // stand-down stops re-sending a range by leaving a sticky "outline
    // already served" marker on the readFileState entry. That marker is
    // correct only while the context pressure that clipped the body is still
    // there. Compaction removes it — and rewrites the transcript out from
    // under the model — so the next read of that range deserves a real body
    // again. Bumping the epoch expires every marker at once without needing
    // access to readFileState, which this function does not have.
    //
    // Main-thread only for the same reason as the sweeps: a fork sub-agent
    // shares the main registry key, and its compact says nothing about the
    // parent's context pressure. The cost of NOT bumping for a sub-agent is
    // that its own markers outlive its compact, bounded by mtime, Edit/Write
    // and the entry's own LRU eviction.
    bumpStandDownEpoch()
  }

  // Rebuild ContentReplacementState to release entries for compacted-away
  // messages. Without this, seenIds and replacements grow monotonically
  // because stubbing/compaction removes messages from the array but never
  // removes their tracking entries. Mutating in-place preserves the
  // reference held by contentReplacementStateRef in the REPL.
  if (messages && contentReplacementState) {
    const rebuilt = reconstructContentReplacementState(
      messages,
      [],
      contentReplacementState.replacements,
    )
    contentReplacementState.seenIds = rebuilt.seenIds
    contentReplacementState.replacements = rebuilt.replacements
  }

  // Remove perKeyClippedIds entries for sessions/agents whose messages
  // no longer exist (compacted away or session switched).
  pruneStaleClippedIds()

  // Prune clipped IDs from the current key that reference messages
  // removed by compaction. MAIN-THREAD ONLY: an in-process sub-agent
  // (Agent/fork) shares the main registry key — getAgentId() is blind to it,
  // see stableStubState's ownership caveat — but its post-compact transcript
  // holds none of the parent's ids, so sweeping against it would delete the
  // parent's LIVE pins, spent memory and clipped ids as false orphans. The
  // sub-agent's own ids under the shared key never merge back into the
  // parent transcript, so the next main-thread compact prunes them with
  // authority; MAX_SHIELDED_PASSES bounds them meanwhile.
  if (messages && isMainThreadCompact) {
    pruneOrphanClippedIds(messages)
  }
  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('src/agent/contextCollapse/index.js') as typeof import('src/agent/contextCollapse/index.js')
      ).resetContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  if (isMainThreadCompact) {
    // getUserContext is a memoized outer layer wrapping getClaudeMds() →
    // getMemoryFiles(). If only the inner getMemoryFiles cache is cleared,
    // the next turn hits the getUserContext cache and never reaches
    // getMemoryFiles(), so the armed InstructionsLoaded hook never fires.
    // Manual /compact already clears this explicitly at its call sites;
    // auto-compact and reactive-compact did not — this centralizes the
    // clear so all compaction paths behave consistently.
    getUserContext.cache.clear?.()
    resetGetMemoryFilesCache('compact')
  }
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // Intentionally NOT calling resetSentSkillNames(): re-injecting the full
  // skill_listing (~4K tokens) post-compact is pure cache_creation. The
  // model still has SkillTool in schema, invoked_skills preserves used
  // skills, and dynamic additions are handled by skillChangeDetector /
  // cacheUtils resets. See compactConversation() for full rationale.
  //
  // Bash git/PR instructions DO need a reset: stripReinjectedAttachments
  // removes them from the summarizer input (compact.ts), and unlike
  // skill_listing there's no fallback path — the body lives only in this
  // attachment. Without resetting, the compacted conversation loses the
  // protocol entirely on the next git turn.
  //
  // Reset is gated and per-agent: only the main-thread slot ('') is cleared
  // when the main thread compacts, so a subagent compact can't wipe the
  // main thread's already-sent mark and force a 3.5KB re-injection there.
  // Subagent compact does NOT clear its own slot — accepting that the
  // subagent loses access to the protocol post-compact in exchange for
  // never corrupting main-thread state. Subagents that need git protocol
  // post-compact are rare; main-thread cache stability is not.
  if (isMainThreadCompact) {
    resetSentBashGitInstructions('')
  }
  clearBetaTracingState()
  if (feature('COMMIT_ATTRIBUTION')) {
    void import('../attributionHooks.js').then(m =>
      m.sweepFileContentCache(),
    )
  }
  clearSessionMessagesCache()

  // Prompt-cache break detection holds diffable content hashes per source.
  // Entries for sources that only existed in the compacted-away prefix become
  // stale — they compare against a prefix the model no longer sees, so the
  // next turn always detects a "break" and forces a full cache miss.
  // Resetting lets the next turn rebuild from the actual post-compact state.
  resetPromptCacheBreakDetection()

  // Session ingress tracking (sequential-append dedup, last-UUID) accumulates
  // entries per session (including subagents). After compaction the
  // compacted-away messages are gone from the array but their ingress
  // metadata lingers, growing the map indefinitely. Clear to release them.
  clearAllSessions()

  // Diagnostic tracking holds per-file Maps (baseline, timestamps,
  // rightFileDiagnostics). Files edited before compaction leave stale
  // entries that grow unbounded. Reset lets the next turn rebuild from
  // the actual post-compact state.
  diagnosticTracker.reset()

  // Skipped timestamps reference history entries for messages that
  // no longer exist after compaction. Clear so they don't suppress
  // history reads for new entries with coinciding timestamps.
  clearSkippedTimestamps()

  // After clearing all the per-conversation caches above, hint V8 to mark-
  // sweep so dropped messages/tool-results are released back to the OS now
  // rather than waiting for the next allocation-driven GC. No-op unless
  // launched with --expose-gc (default in bin/claudin's re-exec path).
  // Safe to call on the main thread; subagent compacts share the heap so
  // they benefit too.
  globalThis.gc?.()
}
