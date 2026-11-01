// The next run the cron tools report, in local time — the time to tell the
// user, since a recurring job can run up to 15 minutes after the minute its
// cron names. When it fires is the scheduler's rule (cronTasks.ts
// nextFireMs); the REPL passes no jitter config, so the default applies.

import { type CronFireAnchor, nextFireMs } from 'src/agent/tasks/cronTasks.js'

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local time, the zone cron expressions are evaluated in: `2026-11-01 09:13`. */
export function formatRunTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The formatted next run, or undefined when the cron never matches again. */
export function describeNextRun(task: CronFireAnchor, nowMs: number): string | undefined {
  const next = nextFireMs(task, nowMs)
  return next === null ? undefined : formatRunTime(next)
}
