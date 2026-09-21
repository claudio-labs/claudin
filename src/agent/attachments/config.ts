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
