/**
 * The three session-wide auto-mode switches. This module stays a leaf with no
 * imports: callers load it through a `feature()`-gated require, and a build
 * without the classifier drops it whole.
 */

type AutoModeSwitches = {
  /** Auto-mode semantics are in force (auto itself, or plan borrowing it). */
  active: boolean
  /** Auto was asked for at startup (flag, `--permission-mode` or settings). */
  askedAtStartup: boolean
  /** Latched by the startup gate check while settings disable auto mode. */
  circuitBroken: boolean
}

const ALL_OFF: Readonly<AutoModeSwitches> = Object.freeze({
  active: false,
  askedAtStartup: false,
  circuitBroken: false,
})

const switches: AutoModeSwitches = { ...ALL_OFF }

export function setAutoModeActive(active: boolean): void {
  switches.active = active
}

export function isAutoModeActive(): boolean {
  return switches.active
}

export function setAutoModeFlagCli(passed: boolean): void {
  switches.askedAtStartup = passed
}

export function getAutoModeFlagCli(): boolean {
  return switches.askedAtStartup
}

export function setAutoModeCircuitBroken(broken: boolean): void {
  switches.circuitBroken = broken
}

export function isAutoModeCircuitBroken(): boolean {
  return switches.circuitBroken
}

export function _resetForTesting(): void {
  Object.assign(switches, ALL_OFF)
}
