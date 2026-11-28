// What a monitor_mcp task tells the model when it ends, and the words the UI
// uses for its two kinds. Pure, so every wording is pinned without a store.

import type { MonitorMcpKind, MonitorMcpTaskState } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { MonitorMcpEndStatus } from 'src/agent/tasks/MonitorMcpTask/transitions.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from 'src/shared/constants/xml.js'
import { escapeXml } from 'src/shared/data/xml.js'
import type { QueuePriority } from 'src/shared/types/textInputTypes.js'

/** The kind as the detail view names it. */
export function monitorMcpKindLabel(kind: MonitorMcpKind): string {
  return kind === 'call' ? 'MCP task' : 'events monitor'
}

/**
 * The tasks dialog's heading over the monitor_mcp rows. A task from before
 * the kinds existed reads as an events monitor.
 */
export function monitorMcpSectionLabel(kinds: ReadonlyArray<MonitorMcpKind | undefined>): string {
  const calls = kinds.filter(kind => kind === 'call').length
  if (calls === 0) return 'Monitors'
  return calls === kinds.length ? 'MCP tasks' : 'Monitors and MCP tasks'
}

/**
 * A finished tool call waits for the turn to end, like a background shell;
 * an event stream ending is news the model is watching for, like Monitor.
 */
export function monitorMcpNotificationPriority(kind: MonitorMcpKind): QueuePriority {
  return kind === 'call' ? 'later' : 'next'
}

export type MonitorMcpResult = { status: MonitorMcpEndStatus; summary: string }

type NotifiedTask = Pick<
  MonitorMcpTaskState,
  'id' | 'toolUseId' | 'outputFile' | 'kind' | 'serverName' | 'description'
>

/** The one-line summary: what ended, on which server, and how. */
export function monitorMcpSummary(task: NotifiedTask, result: MonitorMcpResult): string {
  const subject = task.kind === 'call' ? 'MCP task' : 'MCP events monitor'
  const verb = result.status === 'failed' ? 'failed' : task.kind === 'call' ? 'completed' : 'ended'
  const head = `${subject} "${task.description}" on server "${task.serverName}" ${verb}`
  const detail = result.summary.trim()
  return detail ? `${head}: ${detail}` : head
}

/** The `<task-notification>` the model reads, in the background-shell shape. */
export function formatMonitorMcpNotification(task: NotifiedTask, result: MonitorMcpResult): string {
  const toolUseIdLine = task.toolUseId ? `\n<${TOOL_USE_ID_TAG}>${task.toolUseId}</${TOOL_USE_ID_TAG}>` : ''
  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${task.id}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>monitor_mcp</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${task.outputFile}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${result.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(monitorMcpSummary(task, result))}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
}
