/**
 * What a settled batch does. The ConfigChange hooks may veto it; otherwise
 * every cache a skill or command listing is read from is dropped, and only
 * then are the subscribers told, so whatever they read is fresh.
 */
import type { ChangedFiles } from 'src/skills/changeDetection/changeBatch.js'

export type ReloadDeps = {
  /** Runs the ConfigChange hooks for source `skills`; true when one of them blocks. */
  isBlockedByHooks: (changedFile: string) => Promise<boolean>
  /** The skill and command listings, and the record of skills announced to the model. */
  dropSkillCaches: () => void
  notifySubscribers: () => void
}

export async function reloadSkills(changed: ChangedFiles, deps: ReloadDeps): Promise<void> {
  // The hooks run once per batch, naming the first change that counted. A
  // vetoed batch is dropped, not retried: the next change reloads everything.
  if (await deps.isBlockedByHooks(changed[0])) return
  deps.dropSkillCaches()
  deps.notifySubscribers()
}
