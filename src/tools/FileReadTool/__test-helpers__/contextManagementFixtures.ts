/**
 * Test fixtures for assistant messages carrying context_management
 * applied_edits — shared by the serverClearingDetection scanner tests and
 * the FileReadTool dedup integration tests so the message shape evolves in
 * one place.
 */

export type AppliedEditFixture = {
  type?: string
  cleared_tool_uses?: number
  [key: string]: unknown
}

/** Assistant message with the given applied_edits (undefined = no
 *  context_management field at all). */
export function assistantWithAppliedEdits(
  edits: AppliedEditFixture[] | undefined,
): unknown {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      ...(edits !== undefined && {
        context_management: { applied_edits: edits },
      }),
    },
  }
}

/** Assistant message with one applied clear_tool_uses edit. */
export function assistantWithClearing(clearedToolUses: number): unknown {
  return assistantWithAppliedEdits([
    {
      type: 'clear_tool_uses_20250919',
      cleared_tool_uses: clearedToolUses,
      cleared_input_tokens: 12345,
    },
  ])
}
