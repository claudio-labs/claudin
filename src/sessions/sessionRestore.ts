// Rebuilding a session from its transcript. Callers import from this path;
// the code is in lifecycle/restore/.
export {
  computeStandaloneAgentContext,
  restoreAgentFromSession,
} from 'src/sessions/lifecycle/restore/agent.js'
export { processResumedConversation } from 'src/sessions/lifecycle/restore/processResumedConversation.js'
export { restoreSessionStateFromLog } from 'src/sessions/lifecycle/restore/transcriptState.js'
export type { ProcessedResume } from 'src/sessions/lifecycle/restore/types.js'
export {
  exitRestoredWorktree,
  restoreWorktreeForResume,
} from 'src/sessions/lifecycle/restore/worktree.js'
