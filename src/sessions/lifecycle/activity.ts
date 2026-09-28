/**
 * Work in flight (a model call, a tool run), counted per reason. While there
 * is some and a remote transport has registered its keep-alive, a heartbeat
 * keeps the remote container from being reclaimed as idle.
 */
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

export type SessionActivityReason = 'api_call' | 'tool_exec'

const HEARTBEAT_PERIOD_MS = 30_000
/** How long the session stays quiet before it is noted as idle. */
const IDLE_NOTE_DELAY_MS = 30_000

/** Only reasons with work in flight have an entry, so the counts never go below zero. */
const inFlight = new Map<SessionActivityReason, number>()
/** When the count last left zero; null while nothing is in flight. */
let busySince: number | null = null
let keepAlive: (() => void) | null = null
let heartbeat: ReturnType<typeof setInterval> | undefined
let idleNote: ReturnType<typeof setTimeout> | undefined
let shutdownReportRegistered = false

export function startSessionActivity(reason: SessionActivityReason): void {
  if (inFlightCount() === 0) busySince = Date.now()
  inFlight.set(reason, (inFlight.get(reason) ?? 0) + 1)
  cancelIdleNote()
  startHeartbeatIfDue()
  reportAtShutdown()
}

export function stopSessionActivity(reason: SessionActivityReason): void {
  const count = inFlight.get(reason) ?? 0
  if (count === 0) return
  if (count > 1) inFlight.set(reason, count - 1)
  else inFlight.delete(reason)
  if (inFlightCount() > 0) return
  busySince = null
  stopHeartbeat()
  scheduleIdleNote()
}

export function registerSessionActivityCallback(callback: () => void): void {
  keepAlive = callback
  startHeartbeatIfDue()
}

export function unregisterSessionActivityCallback(): void {
  keepAlive = null
  stopHeartbeat()
  cancelIdleNote()
}

export function sendSessionActivitySignal(): void {
  if (keepAlivesOn()) keepAlive?.()
}

export function isSessionActivityTrackingActive(): boolean {
  return keepAlive !== null
}

function inFlightCount(): number {
  let total = 0
  for (const count of inFlight.values()) total += count
  return total
}

/** Read at each use: a remote host switches keep-alives on through its environment. */
function keepAlivesOn(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES)
}

function startHeartbeatIfDue(): void {
  if (heartbeat !== undefined || keepAlive === null || inFlightCount() === 0) return
  // The global timer, looked up now, so that a test's fake clock can drive it.
  heartbeat = setInterval(beat, HEARTBEAT_PERIOD_MS)
  heartbeat.unref?.()
}

function beat(): void {
  logForDiagnosticsNoPII('debug', 'session_keepalive_heartbeat', { refcount: inFlightCount() })
  if (keepAlivesOn()) keepAlive?.()
}

function stopHeartbeat(): void {
  if (heartbeat === undefined) return
  clearInterval(heartbeat)
  heartbeat = undefined
}

function scheduleIdleNote(): void {
  if (keepAlive === null) return
  cancelIdleNote()
  idleNote = setTimeout(() => {
    idleNote = undefined
    logForDiagnosticsNoPII('info', 'session_idle_30s')
  }, IDLE_NOTE_DELAY_MS)
  idleNote.unref?.()
}

function cancelIdleNote(): void {
  if (idleNote === undefined) return
  clearTimeout(idleNote)
  idleNote = undefined
}

function reportAtShutdown(): void {
  if (shutdownReportRegistered) return
  shutdownReportRegistered = true
  registerCleanup(async () => logForDiagnosticsNoPII('info', 'session_activity_at_shutdown', shutdownReport()))
}

/** The work still in flight, per reason, and how long the oldest of it has been running. */
function shutdownReport(): Record<string, unknown> {
  return {
    refcount: inFlightCount(),
    active: Object.fromEntries(inFlight),
    oldest_activity_ms: busySince === null ? null : Date.now() - busySince,
  }
}
