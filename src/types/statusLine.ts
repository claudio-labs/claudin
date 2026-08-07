// Reconstructed from its use sites: the original module was not carried into
// this fork. The shape is taken from `buildStatusLineCommandInput` in
// `src/components/StatusLine.tsx`, which builds the whole object, and is
// consumed by `executeStatusLineCommand` in `src/utils/hooks/replHooks.ts`.
//
// This is a public contract: the object is JSON-serialised and handed to the
// user's `statusLine` command on stdin, so the snake_case field names are part
// of the API and must not be renamed.

/**
 * Fields every hook payload carries, produced by `createBaseHookInput()`
 * in `src/utils/hooks/shared.ts`.
 */
type BaseHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
}

/** One rate-limit window, as a percentage plus its reset timestamp. */
type RateLimitWindow = {
  used_percentage: number
  /** Unix epoch seconds, straight from the `anthropic-ratelimit-*` header. */
  resets_at: number
}

export type StatusLineCommandInput = BaseHookInput & {
  /** Session title, omitted when the session has not been named. */
  session_name?: string
  model: {
    id: string
    display_name: string
  }
  workspace: {
    current_dir: string
    project_dir: string
    added_dirs: string[]
  }
  version: string
  output_style: {
    name: string
  }
  cost: {
    total_cost_usd: number
    total_duration_ms: number
    total_api_duration_ms: number
    total_lines_added: number
    total_lines_removed: number
  }
  context_window: {
    total_input_tokens: number
    total_output_tokens: number
    context_window_size: number
    /** Null until the first assistant message reports usage. */
    current_usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    } | null
    /** Null alongside `current_usage`, before the first usage report. */
    used_percentage: number | null
    remaining_percentage: number | null
  }
  exceeds_200k_tokens: boolean
  /** Omitted entirely when neither window has been reported yet. */
  rate_limits?: {
    five_hour?: RateLimitWindow
    seven_day?: RateLimitWindow
  }
  /** Only present while vim mode is enabled. */
  vim?: {
    mode: string
  }
  /** Only present in an `--agent` session. */
  agent?: {
    name: string
  }
  /** Only present in remote mode. */
  remote?: {
    session_id: string
  }
  /** Only present when the session runs inside a worktree. */
  worktree?: {
    name: string
    path: string
    /** Absent for a detached HEAD — the session record leaves it unset. */
    branch?: string
    original_cwd: string
    original_branch?: string
  }
}
