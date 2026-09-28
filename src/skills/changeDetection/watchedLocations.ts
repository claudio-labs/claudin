/**
 * The directories the detector watches: the skills and legacy commands of
 * the user and of the project, and the skills of every additional directory.
 * They are worked out once per start, so a location that does not exist then
 * stays unwatched even after it is created.
 */
import { resolve } from 'path'

type LocationInputs = {
  /** `CLAUDIN_CONFIG_DIR`, or `~/.claudin`. */
  configHome: string
  /** What the project's `.claudin/` is resolved against. */
  cwd: string
  /** The `--add-dir` list. */
  additionalDirectories: readonly string[]
  exists: (path: string) => Promise<boolean>
}

const PROJECT_CONFIG_DIR = '.claudin'

/** Absolute, each once, and only the ones that exist. */
export async function findWatchedLocations(inputs: LocationInputs): Promise<string[]> {
  const candidates = candidateLocations(inputs)
  const present = await Promise.all(candidates.map(candidate => inputs.exists(candidate)))
  return candidates.filter((_, index) => present[index])
}

function candidateLocations({ configHome, cwd, additionalDirectories }: LocationInputs): string[] {
  const candidates = [
    resolve(cwd, configHome, 'skills'),
    resolve(cwd, configHome, 'commands'),
    resolve(cwd, PROJECT_CONFIG_DIR, 'skills'),
    resolve(cwd, PROJECT_CONFIG_DIR, 'commands'),
    // An additional directory lends its skills only, never its commands.
    ...additionalDirectories.map(dir => resolve(cwd, dir, PROJECT_CONFIG_DIR, 'skills')),
  ]
  // The project can be the config home's parent, or one of the additional directories.
  return [...new Set(candidates)]
}
