// Reconstructed from its use sites: the original module was not carried into
// this fork, yet ~23 type-only imports reference it.
//
// `QuerySource` tags *what* triggered a model call. It rides along on every
// request (`services/api/claude/*`), decides 529-retry eligibility
// (`services/api/withRetry.ts`), gates prompt-cache-break tracking
// (`services/api/promptCacheBreakDetection.ts`), and is the key compaction
// uses to tell the main thread apart from a side query.
//
// The literals below were collected by sweeping every string that flows into a
// `querySource` field, is compared against one, or is a member of a
// `Set<QuerySource>`. The three parametric families are template literal types
// because they are built by interpolation at
// `src/agent/promptCategory.ts:23,47`.

/**
 * A call originating from an agent. `agent:custom` and `agent:default` are
 * built by `getQuerySourceForAgent`; `agent:builtin:<AgentType>` names a
 * built-in agent (`agent:builtin:Explore`, `agent:builtin:fork`).
 * `agent:builtin` on its own is the prefix `promptCacheBreakDetection.ts` and
 * `withRetry.ts` match against.
 */
type AgentQuerySource = `agent:${string}`

/**
 * The REPL main thread. Plain when the default output style is active, or
 * suffixed with the style name — `repl_main_thread:outputStyle:Explanatory`,
 * `…:Learning`, `…:custom`.
 */
type ReplQuerySource =
  | 'repl'
  | 'repl_main_thread'
  | `repl_main_thread:outputStyle:${string}`

/** Everything else: background jobs, classifiers and one-shot side queries. */
type InternalQuerySource =
  | 'agent_creation'
  | 'agent_summary'
  | 'auto_dream'
  | 'auto_mode'
  | 'auto_mode_critique'
  | 'auto_mode_setup'
  | 'away_summary'
  | 'bash_classifier'
  | 'bash_extract_prefix'
  | 'compact'
  | 'extract_memories'
  | 'feedback'
  | 'generate_session_title'
  | 'hook_agent'
  | 'hook_prompt'
  | 'insights'
  | 'magic_docs'
  // The context-collapse agent. Compared against by name in
  // `services/compact/autoCompact.ts` so its own context blow-up is handled
  // differently from the main thread's.
  | 'marble_origami'
  | 'mcp_datetime_parse'
  | 'memdir_relevance'
  | 'model_validation'
  | 'permission_explainer'
  | 'prompt_suggestion'
  | 'rename_generate_name'
  | 'sdk'
  | 'session_memory'
  | 'session_search'
  | 'side_question'
  // The analysis pass and the apply pass are separate sources: the first is
  // the `ApiQueryHookConfig.name` in `utils/hooks/skillImprovement.ts`, the
  // second tags the query that writes the change.
  | 'skill_improvement'
  | 'skill_improvement_apply'
  | 'speculation'
  | 'teleport_generate_title'
  | 'tool_use_summary_generation'
  | 'web_fetch_apply'
  | 'web_search_tool'

export type QuerySource =
  | AgentQuerySource
  | ReplQuerySource
  | InternalQuerySource
