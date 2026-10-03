import { formatRelativeTimeAgo } from 'src/shared/text/format.js'

export type DreamStatusInput = {
  enabled: boolean
  running: boolean
  /** `null` until the stamp has been read, `0` when no consolidation was ever recorded. */
  lastRunAt: number | null
}

const defaultAgo = (at: number): string => formatRelativeTimeAgo(new Date(at))

/** What follows `Auto-dream: on|off`, e.g. ` · last ran 3 hours ago · /dream to run`. */
export function describeDreamStatus(
  { enabled, running, lastRunAt }: DreamStatusInput,
  ago: (at: number) => string = defaultAgo,
): string {
  const parts: string[] = []
  if (running) parts.push('running')
  else if (lastRunAt === 0) parts.push('never')
  else if (lastRunAt !== null) parts.push(`last ran ${ago(lastRunAt)}`)
  if (enabled && !running) parts.push('/dream to run')
  return parts.map(part => ` · ${part}`).join('')
}
