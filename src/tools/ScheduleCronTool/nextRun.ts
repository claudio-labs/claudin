// When the session scheduler will fire a job, jitter included — the time to
// tell the user, since a recurring job can run up to 15 minutes after the
// minute its cron names. Same helpers and anchors as cronScheduler.ts's first
// sight (the REPL passes no jitter config, so the default applies).

import {
  type CronTask,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from 'src/agent/tasks/cronTasks.js'

export type CronRunAnchor = Pick<CronTask, 'id' | 'cron' | 'createdAt' | 'recurring' | 'lastFiredAt'>

export function nextRunMs(task: CronRunAnchor, nowMs: number): number | null {
  if (!task.recurring) return oneShotJitteredNextCronRunMs(task.cron, task.createdAt, task.id)
  const anchored = jitteredNextCronRunMs(task.cron, task.lastFiredAt ?? task.createdAt, task.id)
  // A session task's fires are not written back, so its anchor goes stale;
  // the scheduler re-anchors at each fire, which `now` stands in for.
  if (anchored !== null && anchored >= nowMs) return anchored
  return jitteredNextCronRunMs(task.cron, nowMs, task.id)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local time, the zone cron expressions are evaluated in: `2026-11-01 09:13`. */
export function formatRunTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The formatted next run, or undefined when the cron never matches again. */
export function describeNextRun(task: CronRunAnchor, nowMs: number): string | undefined {
  const next = nextRunMs(task, nowMs)
  return next === null ? undefined : formatRunTime(next)
}
