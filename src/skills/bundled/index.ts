import { feature } from 'bun:bundle'
import { registerBatchSkill } from './batch.js'
import { registerCodeReviewSkill } from './code-review.js'
import { registerCreateSkill } from './create.js'
import { registerDebugSkill } from './debug.js'
import { registerFewerPermissionPromptsSkill } from './fewerPermissionPrompts.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerLoopSkill } from './loop.js'
import { registerRunSkill } from './run.js'
import { registerSimplifySkill } from './simplify.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
import { registerVerifySkill } from './verify.js'

/**
 * Initialize all bundled skills.
 * Called at startup to register skills that ship with the CLI.
 *
 * To add a new bundled skill:
 * 1. Create a new file in src/skills/bundled/ (e.g., myskill.ts)
 * 2. Export a register function that calls registerBundledSkill()
 * 3. Import and call that function here
 */
export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerDebugSkill()
  registerCodeReviewSkill()
  registerBatchSkill()
  // Ported from the upstream built-in skills. All provider-agnostic
  // (pure agent-loop behavior), so they register unconditionally.
  registerSimplifySkill()
  registerVerifySkill()
  registerRunSkill()
  registerFewerPermissionPromptsSkill()
  // Claudin-native: teaches the model to create/refine skills, rules, and
  // agents in the .claudin structure (project + global).
  registerCreateSkill()
  if (feature('KAIROS') || feature('KAIROS_DREAM')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerDreamSkill } = require('./dream.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerDreamSkill()
  }
  if (feature('REVIEW_ARTIFACT')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerHunterSkill } = require('./hunter.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerHunterSkill()
  }
  // /loop's isEnabled delegates to isKairosCronEnabled() — registered
  // unconditionally so the static import is bundled; visibility is gated
  // at runtime by the isEnabled callback.
  registerLoopSkill()
  if (feature('AGENT_TRIGGERS_REMOTE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      registerScheduleRemoteAgentsSkill,
    } = require('./scheduleRemoteAgents.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerScheduleRemoteAgentsSkill()
  }
  if (feature('BUILDING_CLAUDE_APPS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerClaudeApiSkill } = require('./claudeApi.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerClaudeApiSkill()
  }
  if (feature('RUN_SKILL_GENERATOR')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerRunSkillGeneratorSkill } = require('./runSkillGenerator.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerRunSkillGeneratorSkill()
  }
}
