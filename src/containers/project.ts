// Scopes a `docker ps` snapshot to the project the session is working in.
//
// The panel deliberately never lists the whole machine: on a dev box that means
// a footer full of unrelated stacks. When nothing matches, the answer is an
// empty list, never the unfiltered one.

import { sep } from 'node:path'
import type { ContainerInfo } from 'src/containers/types.js'

/** Compose derives a default project name from the directory basename:
 * lowercased, with everything outside [a-z0-9_-] dropped. */
const NON_PROJECT_CHARS_RE = /[^a-z0-9_-]/g
const LEADING_NON_ALNUM_RE = /^[^a-z0-9]+/

export function defaultProjectName(dir: string): string {
  const base = dir.split(sep).filter(Boolean).pop() ?? ''
  return base
    .toLowerCase()
    .replace(NON_PROJECT_CHARS_RE, '')
    .replace(LEADING_NON_ALNUM_RE, '')
}

/** True when `child` is `parent` or sits underneath it. */
function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true
  const normalized = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(normalized)
}

/**
 * Containers belonging to the stack rooted at `cwd`.
 *
 * Primary key is `com.docker.compose.project.working_dir`, which compose sets
 * to the directory the stack was brought up from — so running from a
 * subdirectory of the repo still matches. The project-name fallback covers a
 * container whose working_dir label is missing (older compose) but whose
 * project name is still the conventional one.
 *
 * A plain `docker run` container carries neither label and is therefore never
 * matched. That is a deliberate omission, not a bug: there is no reliable way
 * to attribute it to a directory.
 */
export function filterToProject(
  containers: readonly ContainerInfo[],
  cwd: string,
): ContainerInfo[] {
  const byWorkingDir = containers.filter(
    c => c.workingDir !== null && isWithin(c.workingDir, cwd),
  )
  if (byWorkingDir.length > 0) return byWorkingDir

  const fallbackName = defaultProjectName(cwd)
  if (!fallbackName) return []
  return containers.filter(
    c => c.workingDir === null && c.project === fallbackName,
  )
}

/** The distinct compose projects present in a filtered snapshot. A repo with a
 * dev and a test compose file legitimately has more than one. */
export function projectsIn(containers: readonly ContainerInfo[]): string[] {
  const seen = new Set<string>()
  for (const c of containers) if (c.project) seen.add(c.project)
  return [...seen].sort()
}
