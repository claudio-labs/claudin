/**
 * The git status snapshot reaches the model once per conversation, as an
 * attachment. The system context leaves out its own entry under this key, so
 * the snapshot is not sent twice.
 */
export const GIT_STATUS_CONTEXT_KEY = 'gitStatus'

export type GitStatusDelta = { content: string }

type TranscriptEntry = { type: string; attachment?: { type: string } }

const ANNOUNCEMENT = 'git_status_delta'

function announcesStatus(entry: TranscriptEntry): boolean {
  return entry.type === 'attachment' && entry.attachment?.type === ANNOUNCEMENT
}

/**
 * The snapshot to announce, or null once one has been announced. A later
 * snapshot that differs is not announced either: the first one stands for the
 * conversation, and nothing is compared between the two.
 */
export function getGitStatusDelta(
  currentGitStatus: string | null | undefined,
  messages: readonly TranscriptEntry[],
): GitStatusDelta | null {
  if (!currentGitStatus || messages.some(announcesStatus)) return null
  return { content: currentGitStatus }
}
