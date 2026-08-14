export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  // TodoV2 (Task* tools) gets its own, much shorter fuse. These counters are
  // assistant messages, not user turns, and the attachment pipeline re-runs
  // after every batch of tool results — so this fires *during* a long
  // implementation turn, which is exactly when a plan-seeded checklist goes
  // stale on screen. 10 was long enough that the list sat wrong for most of
  // the turn. The legacy TodoWrite path keeps TURNS_SINCE_WRITE so the change
  // stays on the lane being fixed.
  TASK_TURNS_SINCE_WRITE: 4,
  TURNS_BETWEEN_REMINDERS: 10,
  // Must move together with TASK_TURNS_SINCE_WRITE. With no reminder yet in
  // the transcript, getTaskReminderTurnCounts reports the total assistant
  // count as "turns since last reminder", so this gate applies to the FIRST
  // reminder too — leaving it at 10 made lowering the other threshold a no-op
  // (proved by a test that expected a reminder at 4 and got nothing).
  TASK_TURNS_BETWEEN_REMINDERS: 4,
} as const

export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  // Full reminder fires only on the FIRST plan-mode attachment of a given
  // plan-mode session (counter resets on plan_mode_exit; subagent path
  // independently always-fulls via getPlanModeV2SubAgentInstructions).
  // Sparse (~111 tokens) repeats every 5 turns and re-states the load-bearing
  // "read-only except plan file" + ExitPlanMode contract. Saves ~900 tokens
  // per recurring full reminder avoided in long planning sessions.
  FULL_REMINDER_EVERY_N_ATTACHMENTS: Number.MAX_SAFE_INTEGER,
} as const

export const AUTO_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

// Line cap alone doesn't bound size (200 × 500-char lines = 100KB).  The
// surfacer injects up to 5 files per turn via <system-reminder>, bypassing
// the per-message tool-result budget, so a tight per-file byte cap keeps
// aggregate injection bounded (5 × 4KB = 20KB/turn).  Enforced via
// readFileInRange's truncateOnByteLimit option.  Truncation means the
// most-relevant memory still surfaces: the frontmatter + opening context
// is usually what matters.
export const MAX_MEMORY_LINES = 200
export const MAX_MEMORY_BYTES = 4096

export const RELEVANT_MEMORIES_CONFIG = {
  // Per-turn cap (5 × 4KB = 20KB) bounds a single injection, but over a
  // long session the selector keeps surfacing distinct files — ~26K tokens/
  // session observed in prod.  Cap the cumulative bytes: once hit, stop
  // prefetching entirely.  Budget is ~3 full injections; after that the
  // most-relevant memories are already in context.  Scanning messages
  // (rather than tracking in toolUseContext) means compact naturally
  // resets the counter — old attachments are gone from context, so
  // re-surfacing is valid.
  MAX_SESSION_BYTES: 60 * 1024,
} as const

export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10,
} as const
