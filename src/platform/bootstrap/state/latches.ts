/**
 * Session-scoped latches and caches — the sticky bits.
 *
 * Almost everything here exists to keep the prompt cache warm: a value is
 * evaluated once, latched, and deliberately never re-evaluated mid-session
 * because flipping it would bust a ~20-70K token cache prefix. The system
 * prompt section cache, the emitted-date marker and the channel allowlist ride
 * along because they share that once-per-session shape.
 *
 * clearBetaHeaderLatches is called from session.ts at every conversation
 * switch, so this module must not import session.ts back.
 */
import {
  notifyRuntimeStateListeners,
  STATE,
} from 'src/platform/bootstrap/state/store.js'
import type { ChannelEntry } from 'src/platform/bootstrap/state/types.js'

// System prompt section accessors

export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}

// Last emitted date accessors (for detecting midnight date changes)

export function getLastEmittedDate(): string | null {
  return STATE.lastEmittedDate
}

export function setLastEmittedDate(date: string | null): void {
  STATE.lastEmittedDate = date
}

export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return STATE.additionalDirectoriesForClaudeMd
}

export function setAdditionalDirectoriesForClaudeMd(
  directories: string[],
): void {
  STATE.additionalDirectoriesForClaudeMd = directories
}

export function getAllowedChannels(): ChannelEntry[] {
  return STATE.allowedChannels
}

export function setAllowedChannels(entries: ChannelEntry[]): void {
  STATE.allowedChannels = entries
  notifyRuntimeStateListeners()
}

export function getHasDevChannels(): boolean {
  return STATE.hasDevChannels
}

export function setHasDevChannels(value: boolean): void {
  STATE.hasDevChannels = value
}

export function getLargeSystemPromptDetected(): boolean | null {
  return STATE.largeSystemPromptDetected
}

export function setLargeSystemPromptDetected(v: boolean | null): void {
  STATE.largeSystemPromptDetected = v
}

export function getAfkModeHeaderLatched(): boolean | null {
  return STATE.afkModeHeaderLatched
}

export function setAfkModeHeaderLatched(v: boolean): void {
  STATE.afkModeHeaderLatched = v
}

export function getFastModeHeaderLatched(): boolean | null {
  return STATE.fastModeHeaderLatched
}

export function setFastModeHeaderLatched(v: boolean): void {
  STATE.fastModeHeaderLatched = v
}

export function getThinkingClearLatched(): boolean | null {
  return STATE.thinkingClearLatched
}

export function setThinkingClearLatched(v: boolean): void {
  STATE.thinkingClearLatched = v
}

/** True when the named LSP tool was already sent deferred this session. */
export function isLspDeferLatched(toolName: string): boolean {
  return STATE.lspDeferLatchedTools?.has(toolName) ?? false
}

/** Record that the named LSP tool was sent with defer_loading: true. */
export function latchLspDefer(toolName: string): void {
  if (!STATE.lspDeferLatchedTools) {
    STATE.lspDeferLatchedTools = new Set()
  }
  STATE.lspDeferLatchedTools.add(toolName)
}

/** True when this session is latched to the legacy deferred-tools prepend. */
export function getDeferredDeltaLegacySession(): boolean {
  return STATE.deferredDeltaLegacySession
}

export function setDeferredDeltaLegacySession(v: boolean): void {
  STATE.deferredDeltaLegacySession = v
}

/**
 * Reset beta header latches to null. Called on /clear and /compact so a
 * fresh conversation gets fresh header evaluation.
 */
export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.thinkingClearLatched = null
  STATE.lspDeferLatchedTools = null
  // /clear empties the history and /compact rewrites it (cache cold either
  // way) — switching a legacy-latched session to delta here is free.
  STATE.deferredDeltaLegacySession = false
}

/**
 * Reference point separating "this conversation's live turns" from
 * "history written by a previous process or conversation". Process start
 * until the first session switch; bumped to Date.now() at every switch
 * (the sessionSwitched funnel). Consumed by the deferred-delta legacy
 * latch (toolSearch.ts) as the resume-point anchor of its warm-cache scan.
 */
export function getSessionEpochMs(): number {
  return STATE.sessionEpochMs
}

export function getPromptId(): string | null {
  return STATE.promptId
}

export function setPromptId(id: string | null): void {
  STATE.promptId = id
}

// Stub for feature-gated REPL bridge (not available in open build)
export function isReplBridgeActive(): boolean {
  return false
}

export function getReplBridgeHandle(): null {
  return null
}
