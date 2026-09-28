import { registerBatchSkill } from 'src/skills/bundled/batch.js'
import { registerCodeReviewSkill } from 'src/skills/bundled/code-review.js'
import { registerCreateSkill } from 'src/skills/bundled/create.js'
import { registerDebugSkill } from 'src/skills/bundled/debug.js'
import { registerFewerPermissionPromptsSkill } from 'src/skills/bundled/fewerPermissionPrompts.js'
import { registerLoopSkill } from 'src/skills/bundled/loop.js'
import { registerRefreshRulesSkill } from 'src/skills/bundled/refreshRules.js'
import { registerRunSkill } from 'src/skills/bundled/run.js'
import { registerSimplifySkill } from 'src/skills/bundled/simplify.js'
import { registerUpdateConfigSkill } from 'src/skills/bundled/updateConfig.js'
import { registerVerifySkill } from 'src/skills/bundled/verify.js'

/**
 * Every skill that ships inside the CLI, in the order the command list shows
 * them (it keeps registration order).
 *
 * `/loop` is registered even when cron is off: its `isEnabled` hides it then,
 * read at call time, and registering it unconditionally is also what keeps
 * its module in the bundle.
 */
const REGISTRATIONS: ReadonlyArray<() => void> = [
  registerUpdateConfigSkill,
  registerDebugSkill,
  registerCodeReviewSkill,
  registerBatchSkill,
  registerSimplifySkill,
  registerVerifySkill,
  registerRunSkill,
  registerFewerPermissionPromptsSkill,
  registerCreateSkill,
  registerRefreshRulesSkill,
  registerLoopSkill,
]

/** Registers the bundled skills; startup calls it once. */
export function initBundledSkills(): void {
  for (const register of REGISTRATIONS) register()
}
