/**
 * JSON replacer for a size estimate that stringifies attachments, or messages
 * carrying them. It leaves out `rendered`: the text a file or plan_mode
 * attachment rendered to at creation (types.ts), kept so a resumed process
 * re-sends the bytes the live one sent (.claudin/rules/cache.md §7). An
 * estimate already stands for that text by the fields it renders from — a
 * file attachment's content is the same file again — so counting the
 * snapshot as well counts the attachment twice.
 *
 * Every estimate that stringifies attachments passes it: the post-compact
 * restore budget (postCompactAttachments.ts), the attachment row of /context
 * (analyzeContext.ts) and the transcript budget of prompt hooks
 * (transcriptTruncation.ts). No imports, so any of them can reach it without
 * a cycle.
 */
export function withoutRenderedSnapshot(key: string, value: unknown): unknown {
  return key === 'rendered' ? undefined : value
}
