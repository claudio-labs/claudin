/**
 * Skills directories nested below the cwd. The file tools look for them
 * above each file they read, edit or write, and load what they find as
 * dynamic skills.
 */
import { stat } from 'fs/promises'
import { dirname, join, sep } from 'path'

import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isFsInaccessible } from 'src/shared/errors.js'
import type { Command } from 'src/shared/types/command.js'
import {
  addDynamicSkills,
  claimSkillDirCandidate,
} from 'src/skills/loading/sessionSkills.js'
import {
  type LoadedSkill,
  readSkillsDirectory,
} from 'src/skills/loading/skillsDirectory.js'
import {
  allowsProjectSkills,
  readSourceGates,
} from 'src/skills/loading/sourceGates.js'
import { isPathGitignored } from 'src/vcs/git/gitignore.js'

type SkillDirDiscoveryDeps = {
  /** Whether git ignores `dir`; nothing is ignored outside a repository. */
  isGitignored: (dir: string, cwd: string) => Promise<boolean>
}

type Candidate = { dir: string; skillsDir: string }

const DISCOVERY_DEPS: SkillDirDiscoveryDeps = { isGitignored: isPathGitignored }

export function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  return discoverSkillDirs(filePaths, cwd, DISCOVERY_DEPS)
}

export async function addSkillDirectories(dirs: string[]): Promise<void> {
  // Nothing found means nothing to load, and no signal either.
  if (dirs.length === 0) return
  if (!allowsProjectSkills(readSourceGates())) {
    logForDebugging(
      `[skills] not loading ${dirs.join(', ')}: project skills are disabled or locked to plugins`,
    )
    return
  }
  const perDirectory = await Promise.all(
    dirs.map(dir => readSkillsDirectory(dir, 'projectSettings')),
  )
  addDynamicSkills(firstOfEachName(perDirectory.flat()))
}

async function discoverSkillDirs(
  filePaths: readonly string[],
  cwd: string,
  deps: SkillDirDiscoveryDeps,
): Promise<string[]> {
  const candidates = claimCandidates(filePaths, cwd)
  const usable = await Promise.all(
    candidates.map(candidate => isUsable(candidate, cwd, deps)),
  )
  return candidates
    .filter((_, index) => usable[index])
    .map(candidate => candidate.skillsDir)
    .sort((a, b) => depthOf(b) - depthOf(a))
}

/**
 * Claimed while listed, before any await, so that concurrent calls never
 * check a candidate twice.
 */
function claimCandidates(filePaths: readonly string[], cwd: string): Candidate[] {
  const cwdPrefix = cwd.endsWith(sep) ? cwd : cwd + sep
  const candidates: Candidate[] = []
  for (const filePath of filePaths) {
    for (const dir of directoriesBelow(dirname(filePath), cwdPrefix)) {
      const skillsDir = join(dir, '.claudin', 'skills')
      if (claimSkillDirCandidate(skillsDir)) candidates.push({ dir, skillsDir })
    }
  }
  return candidates
}

/**
 * `start` and its parents while they are strictly below the cwd. The cwd's
 * own skills directory is the listing's, so the walk stops before it.
 */
function directoriesBelow(start: string, cwdPrefix: string): string[] {
  const dirs: string[] = []
  let dir = start
  while (dir.startsWith(cwdPrefix) && dir !== cwdPrefix) {
    dirs.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

async function isUsable(
  candidate: Candidate,
  cwd: string,
  deps: SkillDirDiscoveryDeps,
): Promise<boolean> {
  if (!(await exists(candidate.skillsDir))) return false
  // A package under node_modules/ must not bring skills in. Outside a
  // repository this fails open; the trust dialog at invocation still applies.
  if (await deps.isGitignored(candidate.dir, cwd)) {
    logForDebugging(`[skills] skipping ${candidate.skillsDir}: git ignores ${candidate.dir}`)
    return false
  }
  return true
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (!isFsInaccessible(error)) {
      logForDebugging(`[skills] cannot check ${path}: ${errorMessage(error)}`)
    }
    return false
  }
}

function depthOf(path: string): number {
  return path.split(sep).length
}

/** Callers pass the deepest directory first, and on a name clash it wins. */
function firstOfEachName(skills: readonly LoadedSkill[]): Command[] {
  const byName = new Map<string, Command>()
  for (const { command } of skills) {
    if (!byName.has(command.name)) byName.set(command.name, command)
  }
  return [...byName.values()]
}
