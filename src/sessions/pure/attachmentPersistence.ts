import type { Attachment } from 'src/agent/attachments/attachments.js'

/**
 * Which attachments the transcript keeps.
 *
 * Every attachment is rendered into each request after it arrives
 * (`normalizeAttachmentForAPI`), so it is part of the prompt-cache prefix. A
 * resumed process rebuilds its requests from the transcript, and one dropped
 * block makes everything after it a cache miss: with only
 * `deferred_tools_delta` kept, a `--resume` read back 40% of the cached prefix
 * and re-wrote the rest (2026-09-23, scripts/bench/ab/session-cache-ab.ts).
 * The model also lost what it had been shown — rules, @-mentioned files, hook
 * context, queued prompts.
 *
 * So a type is kept whenever its renderer can produce bytes, even if only for
 * some payloads or under a flag. `skip` is for the types that render nothing
 * for any payload: keeping them would only grow the file.
 *
 * A Record over the whole union, so a new attachment type does not compile
 * until it is classified here.
 */
export const ATTACHMENT_PERSISTENCE: Readonly<Record<Attachment['type'], 'persist' | 'skip'>> = {
  file: 'persist',
  compact_file_reference: 'persist',
  pdf_reference: 'persist',
  already_read_file: 'skip',
  edited_text_file: 'persist',
  edited_image_file: 'skip',
  directory: 'persist',
  selected_lines_in_ide: 'persist',
  opened_file_in_ide: 'persist',
  todo_reminder: 'persist',
  task_reminder: 'persist',
  nested_memory: 'persist',
  // Built by the UI from consecutive nested_memory messages; never recorded.
  nested_memory_batch: 'skip',
  dynamic_skill: 'skip',
  skill_listing: 'persist',
  bash_git_instructions: 'persist',
  skill_discovery: 'skip',
  queued_command: 'persist',
  output_style: 'persist',
  diagnostics: 'persist',
  plan_mode: 'persist',
  plan_mode_reentry: 'persist',
  plan_mode_exit: 'persist',
  auto_mode: 'persist',
  auto_mode_exit: 'persist',
  critical_system_reminder: 'persist',
  plan_file_reference: 'persist',
  mcp_resource: 'persist',
  command_permissions: 'skip',
  agent_mention: 'persist',
  task_status: 'persist',
  container_transition: 'persist',
  async_hook_response: 'persist',
  token_usage: 'persist',
  budget_usd: 'persist',
  output_token_usage: 'persist',
  structured_output: 'skip',
  // Rendered only while agent swarms are enabled.
  teammate_mailbox: 'persist',
  team_context: 'persist',
  hook_cancelled: 'skip',
  hook_blocking_error: 'persist',
  hook_non_blocking_error: 'skip',
  hook_error_during_execution: 'skip',
  hook_stopped_continuation: 'persist',
  // Rendered for SessionStart and UserPromptSubmit hooks only.
  hook_success: 'persist',
  hook_additional_context: 'persist',
  hook_system_message: 'skip',
  hook_permission_decision: 'skip',
  invoked_skills: 'persist',
  max_turns_reached: 'skip',
  current_session_memory: 'skip',
  teammate_shutdown_batch: 'skip',
  compaction_reminder: 'persist',
  context_efficiency: 'skip',
  date_change: 'persist',
  ultrathink_effort: 'persist',
  deferred_tools_delta: 'persist',
  agent_listing_delta: 'persist',
  mcp_instructions_delta: 'persist',
  claude_md_delta: 'persist',
  memory_index: 'skip',
  git_status_delta: 'persist',
  todo_reminder_delta: 'persist',
  task_reconcile: 'persist',
  companion_intro: 'persist',
  bagel_console: 'skip',
}

export function shouldPersistAttachment(type: Attachment['type']): boolean {
  return ATTACHMENT_PERSISTENCE[type] === 'persist'
}
