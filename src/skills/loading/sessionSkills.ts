/**
 * The session's dynamic skills, and the only owner of the state behind them:
 * the path-scoped skills held back from the listing, the names activated so
 * far, the skills found under touched files or activated, and the skill
 * directories already checked.
 */
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import { createSignal } from 'src/shared/signal.js'
import type { Command } from 'src/shared/types/command.js'
import { createPathScope, toScopePath } from 'src/skills/loading/pathScope.js'
import type { SkillCommand } from 'src/skills/loading/skillCommand.js'

type HeldSkill = {
  command: SkillCommand
  isInScope: (scopePath: string) => boolean
}

const heldSkills = new Map<string, HeldSkill>()
/** Listed normally by later loads, until the held skills are dropped. */
const activatedNames = new Set<string>()
const dynamicSkills = new Map<string, Command>()
/** Each `.claudin/skills` candidate, whether it existed or not. */
const checkedSkillDirs = new Set<string>()
const dynamicSkillsLoaded = createSignal()

// -- Path-scoped skills

export function holdPathScopedSkill(
  command: SkillCommand,
  patterns: readonly string[],
): void {
  heldSkills.set(command.name, { command, isInScope: createPathScope(patterns) })
}

export function wasActivated(skillName: string): boolean {
  return activatedNames.has(skillName)
}

export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (heldSkills.size === 0) return []
  const scopePaths = filePaths
    .map(filePath => toScopePath(filePath, cwd))
    .filter((scopePath): scopePath is string => scopePath !== undefined)
  const activated: string[] = []
  for (const [name, held] of heldSkills) {
    if (!scopePaths.some(held.isInScope)) continue
    heldSkills.delete(name)
    activatedNames.add(name)
    dynamicSkills.set(name, held.command)
    activated.push(name)
  }
  if (activated.length > 0) {
    logForDebugging(`[skills] activated ${activated.join(', ')} for ${filePaths.join(', ')}`)
    dynamicSkillsLoaded.emit()
  }
  return activated
}

/** The listing's share of the session state; the next listing rebuilds it. */
export function forgetPathScopedSkills(): void {
  heldSkills.clear()
  activatedNames.clear()
}

// -- Dynamic skills

/** A skill replaces a dynamic skill of the same name. */
export function addDynamicSkills(skills: readonly Command[]): void {
  for (const skill of skills) dynamicSkills.set(skill.name, skill)
  dynamicSkillsLoaded.emit()
}

export function getDynamicSkills(): Command[] {
  return [...dynamicSkills.values()]
}

/** True the first time; a candidate is checked once, found or not. */
export function claimSkillDirCandidate(skillsDir: string): boolean {
  if (checkedSkillDirs.has(skillsDir)) return false
  checkedSkillDirs.add(skillsDir)
  return true
}

export function clearDynamicSkills(): void {
  dynamicSkills.clear()
  checkedSkillDirs.clear()
  forgetPathScopedSkills()
}

// -- The loaded signal

/** Called after each change to the dynamic skills; returns the unsubscribe. */
export function onDynamicSkillsLoaded(callback: () => void): () => void {
  return dynamicSkillsLoaded.subscribe(() => {
    // Contained: the other listeners still run, and the load that fired the
    // signal still succeeds.
    try {
      callback()
    } catch (error) {
      logError(error)
    }
  })
}
