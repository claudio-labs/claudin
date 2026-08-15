import { describe, expect, test } from 'bun:test'
import { createAttachmentMessage } from 'src/services/attachments/attachments.js'
import type { Attachment } from 'src/services/attachments/attachments.js'

// Enumerated set of every discriminant in the Attachment union. The
// `satisfies` clause below pairs this tuple with `Attachment['type']`,
// so adding/removing/renaming a variant in attachments.ts without
// updating this list is a compile-time error — the safety net we want
// during the split.
const ALL_ATTACHMENT_TYPES = [
  'file',
  'compact_file_reference',
  'pdf_reference',
  'already_read_file',
  'edited_text_file',
  'edited_image_file',
  'directory',
  'selected_lines_in_ide',
  'opened_file_in_ide',
  'todo_reminder',
  'task_reminder',
  'nested_memory',
  'relevant_memories',
  'dynamic_skill',
  'skill_listing',
  'bash_git_instructions',
  'skill_discovery',
  'queued_command',
  'output_style',
  'diagnostics',
  'plan_mode',
  'plan_mode_reentry',
  'plan_mode_exit',
  'auto_mode',
  'auto_mode_exit',
  'critical_system_reminder',
  'plan_file_reference',
  'mcp_resource',
  'command_permissions',
  'agent_mention',
  'task_status',
  'async_hook_response',
  'token_usage',
  'budget_usd',
  'output_token_usage',
  'structured_output',
  'teammate_mailbox',
  'team_context',
  'hook_cancelled',
  'hook_blocking_error',
  'hook_non_blocking_error',
  'hook_error_during_execution',
  'hook_stopped_continuation',
  'hook_success',
  'hook_additional_context',
  'hook_system_message',
  'hook_permission_decision',
  'invoked_skills',
  'verify_plan_reminder',
  'max_turns_reached',
  'current_session_memory',
  'teammate_shutdown_batch',
  'compaction_reminder',
  'context_efficiency',
  'date_change',
  'ultrathink_effort',
  'deferred_tools_delta',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'claude_md_delta',
  'git_status_delta',
  'todo_reminder_delta',
  'task_reconcile',
  'companion_intro',
  'bagel_console',
] as const satisfies readonly Attachment['type'][]

// Compile-time exhaustiveness: this assignment fails to type-check if any
// Attachment['type'] is missing from the tuple above.
type _Exhaustive = Exclude<Attachment['type'], (typeof ALL_ATTACHMENT_TYPES)[number]>
const _exhaustivenessCheck: _Exhaustive extends never ? true : false = true
void _exhaustivenessCheck

describe('Attachment union exhaustiveness', () => {
  test('snapshot of all attachment type discriminants (sorted)', () => {
    const sorted = [...ALL_ATTACHMENT_TYPES].sort()
    expect(sorted).toMatchSnapshot()
  })

  test('all discriminants are unique', () => {
    expect(new Set(ALL_ATTACHMENT_TYPES).size).toBe(ALL_ATTACHMENT_TYPES.length)
  })
})

describe('createAttachmentMessage', () => {
  test.each(ALL_ATTACHMENT_TYPES.map(t => [t] as const))(
    'wraps "%s" attachment preserving discriminant and shape',
    discriminant => {
      const attachment = { type: discriminant } as unknown as Attachment
      const message = createAttachmentMessage(attachment)

      expect(message.type).toBe('attachment')
      expect(message.attachment).toBe(attachment)
      expect(message.attachment.type).toBe(discriminant)
      expect(typeof message.uuid).toBe('string')
      expect(message.uuid.length).toBeGreaterThan(0)
      expect(typeof message.timestamp).toBe('string')
      expect(() => new Date(message.timestamp).toISOString()).not.toThrow()
    },
  )

  test('generates a unique uuid per invocation', () => {
    const attachment = { type: 'auto_mode_exit' } as unknown as Attachment
    const a = createAttachmentMessage(attachment)
    const b = createAttachmentMessage(attachment)
    expect(a.uuid).not.toBe(b.uuid)
  })
})
