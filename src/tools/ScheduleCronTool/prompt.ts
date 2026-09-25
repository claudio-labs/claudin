import { feature } from 'bun:bundle'
import { DEFAULT_CRON_JITTER_CONFIG } from 'src/agent/tasks/cronTasks.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

export const DEFAULT_MAX_AGE_DAYS =
  DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs / (24 * 60 * 60 * 1000)

/**
 * Unified gate for the cron scheduling system.
 *
 * Open builds (USER_TYPE !== 'ant') enable cron unconditionally — the
 * cron tools and /loop skill are registered without the AGENT_TRIGGERS
 * build flag, so this gate is the sole runtime switch. Set the env var
 * `CLAUDIN_DISABLE_CRON=1` to turn it off locally.
 */
export function isKairosCronEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_CRON)) return false
  // Claudin open builds do not rely on Anthropic's internal runtime gates.
  // Expose cron support by default unless explicitly disabled.
  return true
}

export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

export const CRON_CREATE_DESCRIPTION =
  'Schedule a prompt to run at a future time — either recurring on a cron schedule, or once at a specific time. Pass durable: true to persist to .claudin/scheduled_tasks.json; otherwise session-only.'

export function buildCronCreatePrompt(): string {
  return `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

When the request is approximate ("around 9am", "hourly"), pick a minute that is NOT 0 or 30 — every user otherwise lands on the same instant. E.g., "around 9" → "57 8 * * *". Use 0/30 only when the user names that exact time.

## Durability

By default (durable: false) the job lives only in this Claude session — nothing is written to disk, and the job is gone when Claude exits. Pass durable: true to write to .claudin/scheduled_tasks.json so the job survives restarts. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" / "check back in an hour" requests should stay session-only.

## Runtime behavior

Jobs only fire while the REPL is idle. Durable jobs persist to .claudin/scheduled_tasks.json and survive session restarts — on next launch they resume automatically. One-shot durable tasks that were missed while the REPL was closed are surfaced for catch-up. Session-only jobs die with the process. Scheduler adds small deterministic jitter (recurring: up to 10% late, max 15 min; one-shot on :00/:30: up to 90 s early). Recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days — tell the user about this limit.

Returns a job ID you can pass to ${CRON_DELETE_TOOL_NAME}.`
}

export const CRON_DELETE_DESCRIPTION = 'Cancel a scheduled cron job by ID'
export const CRON_DELETE_PROMPT = `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from .claudin/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).`

export const CRON_LIST_DESCRIPTION = 'List scheduled cron jobs'
export const CRON_LIST_PROMPT = `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME}, both durable (.claudin/scheduled_tasks.json) and session-only.`
